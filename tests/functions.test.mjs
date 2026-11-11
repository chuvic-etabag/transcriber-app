/*
 * Tests for the Edge Functions (supabase/functions/) and supabase/setup_1.sql.
 *
 *   node tests/functions.test.mjs
 *
 * - The SQL runs in a throwaway PostgreSQL (needs PostgreSQL 14 or newer
 *   installed; the test starts and stops its own copy), with small stand-ins
 *   for Supabase's storage tables and roles.
 * - The functions run in Node with fetch() answered by stand-ins: the
 *   database calls go to that real PostgreSQL, storage is kept in memory, and
 *   Speechmatics answers with saved examples in its exact format.
 */
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = require('../transcript-format.js');
const B = require('./fixtures/speechmatics-builder.js');

const SUPABASE_URL = 'https://mgiwopbaglgzxeaowzzt.supabase.co';
const PAGE = 'https://chuvic-etabag.github.io';
const PG_PORT = 54329;

// ---------- A throwaway PostgreSQL ----------

function pgBin(name) {
  const dirs = fs.existsSync('/usr/lib/postgresql') ? fs.readdirSync('/usr/lib/postgresql').sort((a, b) => b - a) : [];
  for (const v of dirs) {
    const p = `/usr/lib/postgresql/${v}/bin/${name}`;
    if (fs.existsSync(p)) return p;
  }
  return name;
}

const pgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-pg-'));
const asPostgres = (args) => (process.getuid && process.getuid() === 0 ? ['runuser', ['-u', 'postgres', '--', ...args]] : [args[0], args.slice(1)]);

function startPostgres() {
  if (process.getuid && process.getuid() === 0) spawnSync('chown', ['postgres', pgDir]);
  let [cmd, args] = asPostgres([pgBin('initdb'), '-D', pgDir, '-A', 'trust', '-U', 'postgres', '--no-sync']);
  let r = spawnSync(cmd, args, { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'initdb: ' + r.stderr);
  [cmd, args] = asPostgres([pgBin('pg_ctl'), '-D', pgDir, '-w', '-l', path.join(pgDir, 'log.txt'),
    '-o', `-p ${PG_PORT} -k ${pgDir} -c listen_addresses=127.0.0.1 -c fsync=off`, 'start']);
  r = spawnSync(cmd, args, { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'pg_ctl: ' + r.stderr + r.stdout);
}

function stopPostgres() {
  const [cmd, args] = asPostgres([pgBin('pg_ctl'), '-D', pgDir, '-m', 'immediate', 'stop']);
  spawnSync(cmd, args);
  fs.rmSync(pgDir, { recursive: true, force: true });
}

/** Run SQL. vars become psql variables (use :'name' in the SQL). */
function sql(text, { vars = {}, role = null, allowError = false } = {}) {
  const args = ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', '-d', 'postgres', '-At', '-q', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const input = (role ? `set role ${role};\n` : '') + text;
  const r = spawnSync(pgBin('psql'), args, { input, encoding: 'utf8' });
  if (r.status !== 0 && !allowError) throw new Error('SQL failed: ' + r.stderr);
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

// The parts of Supabase that setup_1.sql expects to be there.
const SUPABASE_STANDINS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
    name text, owner uuid, created_at timestamptz default now(), metadata jsonb);
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`;

// ---------- Stand-ins for Supabase's web APIs and Speechmatics ----------

const VOID_FUNCTIONS = new Set(['transcriber_job_started', 'transcriber_job_failed', 'transcriber_job_update']);

const storage = new Map();      // path -> { size, created_at }
const calls = [];               // every outside call the functions make
const sm = {
  jobs: new Map(),              // id -> { status, duration, config }
  nextId: 1,
  failCreate: null,             // { status, body } to refuse the next job
  transcript: null              // what GET transcript returns
};

function json(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function rpcCall(name, args) {
  // Like PostgREST: named arguments, run as the role of the key (service_role).
  const vars = {};
  const parts = Object.entries(args).map(([k, v], i) => {
    if (v === null || v === undefined) return `${k} => null`;
    vars['a' + i] = String(v);
    return `${k} => :'a${i}'`;
  });
  const call = `public.${name}(${parts.join(', ')})`;
  const r = sql(VOID_FUNCTIONS.has(name) ? `select ${call};` : `select to_json(${call});`, { vars, role: 'service_role', allowError: true });
  if (!r.ok) return json(400, { message: r.err });
  return VOID_FUNCTIONS.has(name) ? new Response(null, { status: 204 }) : new Response(r.out || 'null', { status: 200 });
}

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  calls.push({ method, url: url.href, headers: Object.fromEntries(headers), body: init.body });

  if (url.origin === SUPABASE_URL) {
    assert.strictEqual(headers.get('apikey'), 'service-role-key', 'uses the service key');
    if (url.pathname.startsWith('/rest/v1/rpc/')) return rpcCall(url.pathname.split('/').pop(), JSON.parse(init.body));
    if (url.pathname === '/storage/v1/object/list/recordings') {
      const q = JSON.parse(init.body);
      const rows = [...storage.entries()]
        .filter(([p]) => p.startsWith(q.prefix + '/') && (!q.search || p.slice(q.prefix.length + 1).includes(q.search)))
        .map(([p, o]) => ({ name: p.slice(q.prefix.length + 1), id: 'id-' + p, created_at: o.created_at, metadata: { size: o.size, mimetype: 'audio/ogg' } }));
      return json(200, rows.slice(0, q.limit || 100));
    }
    if (url.pathname.startsWith('/storage/v1/object/sign/recordings/')) {
      const p = url.pathname.slice('/storage/v1/object/sign/recordings/'.length);
      if (!storage.has(p)) return json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      assert.ok(JSON.parse(init.body).expiresIn <= 3600, 'a short-lived link');
      return json(200, { signedURL: `/object/sign/recordings/${p}?token=signed-token` });
    }
    if (url.pathname === '/storage/v1/object/recordings' && method === 'DELETE') {
      const gone = JSON.parse(init.body).prefixes.filter((p) => storage.delete(p));
      return json(200, gone.map((p) => ({ name: p })));
    }
    return json(404, { message: 'unexpected Supabase call ' + url.pathname });
  }

  if (url.origin === 'https://asr.api.speechmatics.com') {
    assert.strictEqual(headers.get('authorization'), 'Bearer sm-secret-key');
    const p = url.pathname.replace('/v2', '');
    if (p === '/jobs' && method === 'POST') {
      if (sm.failCreate) { const f = sm.failCreate; sm.failCreate = null; return json(f.status, f.body); }
      assert.ok(init.body instanceof FormData, 'sent as a form, like the Speechmatics docs show');
      const config = JSON.parse(init.body.get('config'));
      const id = 'smjob' + String(sm.nextId++).padStart(5, '0');
      sm.jobs.set(id, { status: 'running', duration: null, config });
      return json(201, { id });
    }
    const m = p.match(/^\/jobs\/([^/]+)(\/transcript)?$/);
    if (m && method === 'GET') {
      const job = sm.jobs.get(m[1]);
      if (!job) return json(404, { code: 404, error: 'Job not found' });
      if (m[2]) {
        if (job.status !== 'done') return json(404, { code: 404, error: 'Job not found' });
        assert.strictEqual(url.searchParams.get('format'), 'json-v2');
        return json(200, sm.transcript);
      }
      return json(200, { job: { config: job.config, created_at: '2026-11-11T02:15:31.523Z', data_name: '',
        duration: job.duration, id: m[1], status: job.status, ...(job.errors ? { errors: job.errors } : {}) } });
    }
    return json(404, { error: 'unexpected Speechmatics call ' + p });
  }
  throw new TypeError('fetch failed: no network in tests (' + url.href + ')');
}

// ---------- Helpers ----------

let H;   // the handlers
const ask = async (fn, body, { origin = PAGE, method = 'POST' } = {}) => {
  const res = await H[fn](new Request(`${SUPABASE_URL}/functions/v1/x`, {
    method,
    headers: { 'content-type': 'application/json', origin, apikey: 'sb_publishable_test' },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined
  }));
  const text = await res.text();
  return { status: res.status, body: text && text !== 'ok' ? JSON.parse(text) : text, headers: res.headers };
};
const uuid = () => crypto.randomUUID();
const upload = (minutesOld = 0, size = 3_000_000) => {
  const p = `uploads/${uuid()}.ogg`;
  storage.set(p, { size, created_at: new Date(Date.now() - minutesOld * 60000).toISOString() });
  return p;
};
const smCreates = () => calls.filter((c) => c.method === 'POST' && c.url === 'https://asr.api.speechmatics.com/v2/jobs').length;
const resetDay = () => sql('delete from public.transcription_jobs;');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n       '));
  }
}

// ---------- Tests ----------

startPostgres();
try {
  sql(SUPABASE_STANDINS);
  const setup = fs.readFileSync(path.join(ROOT, 'supabase', 'setup_1.sql'), 'utf8');

  console.log('setup_1.sql');

  await test('runs cleanly, and running it a second time is safe', async () => {
    sql(setup);
    sql(setup);
    assert.strictEqual(sql("select public, file_size_limit, allowed_mime_types::text from storage.buckets where id = 'recordings'").out,
      'f|52428800|{audio/ogg}');
  });

  await test('the app (public key) can upload into uploads/ but cannot read, list, change or delete', async () => {
    const good = `uploads/${uuid()}.ogg`;
    assert.ok(sql(`insert into storage.objects (bucket_id, name) values ('recordings', '${good}');`, { role: 'anon' }).ok);
    for (const bad of ['other/x.ogg', `uploads/${uuid()}.mp3`, 'uploads/../secret.ogg', `uploads/x/${uuid()}.ogg`]) {
      const r = sql(`insert into storage.objects (bucket_id, name) values ('recordings', '${bad}');`, { role: 'anon', allowError: true });
      assert.ok(!r.ok && /row-level security/.test(r.err), bad + ': ' + r.err);
    }
    assert.ok(!sql(`insert into storage.objects (bucket_id, name) values ('other', '${good}');`, { role: 'anon', allowError: true }).ok);
    assert.strictEqual(sql('select count(*) from storage.objects;', { role: 'anon' }).out, '0', 'cannot list or read');
    sql(`update storage.objects set name = 'uploads/hacked.ogg';`, { role: 'anon' });
    sql('delete from storage.objects;', { role: 'anon' });
    assert.strictEqual(sql('select count(*) from storage.objects;').out, '1', 'nothing changed or deleted');
  });

  await test('the public key cannot see the jobs table or call the functions', async () => {
    for (const role of ['anon', 'authenticated']) {
      assert.match(sql('select * from public.transcription_jobs;', { role, allowError: true }).err, /permission denied/);
      assert.match(sql("select public.transcriber_used_seconds('Asia/Manila');", { role, allowError: true }).err, /permission denied/);
      assert.match(sql("select public.transcriber_begin_job('uploads/x.ogg', 1, 3600, 'Asia/Manila');", { role, allowError: true }).err, /permission denied/);
    }
    assert.strictEqual(sql("select public.transcriber_used_seconds('Asia/Manila');", { role: 'service_role' }).out, '0');
  });

  await test('two starts at the same moment cannot both slip past the limit', async () => {
    resetDay();
    sql("insert into public.transcription_jobs (day, object_path, claimed_seconds, status) values ((now() at time zone 'Asia/Manila')::date, 'uploads/old.ogg', 3540, 'saved');");
    // Two separate connections race; the lock makes them take turns.
    const race = (p) => new Promise((resolve) => {
      const child = spawn(pgBin('psql'), ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', '-At', '-q'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out.trim()));
      child.stdin.end(`set role service_role; begin; select public.transcriber_begin_job('${p}', 1800, 3600, 'Asia/Manila')->>'status'; select pg_sleep(0.3); commit;`);
    });
    const results = await Promise.all([race('uploads/a.ogg'), race('uploads/b.ogg')]);
    assert.deepStrictEqual(results.sort(), ['limit', 'ok'], results.join(','));
    resetDay();
  });

  console.log('Edge Functions');
  Object.assign(process.env, {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SPEECHMATICS_API_KEY: 'sm-secret-key'
  });
  globalThis.fetch = fakeFetch;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));   // the functions log problems for Supabase's logs
  H = await import(path.join(ROOT, 'supabase', 'functions', '_shared', 'handlers.js'));
  const settings = await import(path.join(ROOT, 'supabase', 'functions', '_shared', 'settings.js'));
  const LIMIT = settings.DAILY_LIMIT_MINUTES;

  await test('the daily limit is one setting, 60 minutes', async () => {
    assert.strictEqual(LIMIT, 60);
  });

  await test('every function file hands its requests to the shared code', async () => {
    for (const [name, fn] of [['check-limit', 'checkLimit'], ['start-job', 'startJob'], ['job-status', 'jobStatus'],
      ['job-result', 'jobResult'], ['delete-audio', 'deleteAudio']]) {
      const src = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', name, 'index.js'), 'utf8');
      assert.match(src, new RegExp(`Deno\\.serve\\(${fn}\\)`), name);
      assert.strictEqual(typeof H[fn], 'function');
      const toml = fs.readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8');
      assert.ok(toml.includes(`[functions.${name}]`) && toml.includes(`./functions/${name}/index.js`), name + ' in config.toml');
    }
  });

  await test('browser checks (CORS): the app page is allowed, other web sites are refused', async () => {
    const pre = await ask('startJob', null, { method: 'OPTIONS' });
    assert.strictEqual(pre.status, 200);
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), PAGE);
    assert.match(pre.headers.get('access-control-allow-headers'), /apikey/);
    const local = await ask('checkLimit', {}, { origin: 'http://localhost:8768' });
    assert.strictEqual(local.headers.get('access-control-allow-origin'), 'http://localhost:8768');
    const evil = await ask('startJob', { path: upload() }, { origin: 'https://evil.example' });
    assert.strictEqual(evil.status, 403);
    assert.strictEqual(smCreates(), 0);
  });

  await test('no secret ever goes back to the browser', async () => {
    resetDay();
    const r = await ask('startJob', { path: upload(), seconds: 30 });
    const all = JSON.stringify(r.body) + JSON.stringify(Object.fromEntries(r.headers));
    assert.ok(!all.includes('sm-secret-key') && !all.includes('service-role-key') && !all.includes('signed-token'), all);
  });

  await test('check-limit: open, with minutes used today', async () => {
    resetDay();
    const r = await ask('checkLimit');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { open: true, limitMinutes: 60, usedMinutes: 0 });
  });

  await test('start-job: refuses paths that are not app uploads, and uploads that are not finished', async () => {
    const before = smCreates();
    for (const bad of [undefined, '', 'uploads/x.ogg', '../etc/passwd', `other/${uuid()}.ogg`]) {
      const r = await ask('startJob', { path: bad, seconds: 10 });
      assert.strictEqual(r.status, 400, String(bad));
      assert.strictEqual(r.body.error, 'badRequest');
    }
    const r = await ask('startJob', { path: `uploads/${uuid()}.ogg`, seconds: 10 });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, 'notUploaded');
    assert.strictEqual(smCreates(), before);
  });

  let jobId, jobPath;
  await test('start-job: sends Speechmatics a short-lived signed link with the right settings', async () => {
    resetDay();
    calls.length = 0;
    jobPath = upload();
    const r = await ask('startJob', { path: jobPath, seconds: 754 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    jobId = r.body.jobId;
    assert.match(jobId, /^smjob\d+$/);
    const config = sm.jobs.get(jobId).config;
    assert.deepStrictEqual(config, {
      type: 'transcription',
      fetch_data: { url: `${SUPABASE_URL}/storage/v1/object/sign/recordings/${jobPath}?token=signed-token` },
      transcription_config: { language: 'en', operating_point: 'enhanced', diarization: 'speaker' }
    });
    assert.ok(!JSON.stringify(config).includes('remove_disfluencies'), 'disfluencies are not removed');
    const row = JSON.parse(sql(`select to_json(j) from public.transcription_jobs j where speechmatics_id = '${jobId}';`).out);
    assert.strictEqual(row.status, 'running');
    assert.strictEqual(row.claimed_seconds, 754);
    assert.strictEqual(row.object_path, jobPath);
  });

  await test('start-job again for the same upload: same job, not paid for twice', async () => {
    const before = smCreates();
    const r = await ask('startJob', { path: jobPath, seconds: 754 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.jobId, jobId);
    assert.strictEqual(r.body.reused, true);
    assert.strictEqual(smCreates(), before);
  });

  await test('job-status: running, then done with the length Speechmatics measured', async () => {
    let r = await ask('jobStatus', { jobId });
    assert.deepStrictEqual(r.body, { status: 'running', speechmaticsStatus: 'running', duration: null, errors: [] });
    sm.jobs.get(jobId).status = 'done';
    sm.jobs.get(jobId).duration = 812.4;
    r = await ask('jobStatus', { jobId });
    assert.strictEqual(r.body.status, 'done');
    assert.strictEqual(r.body.duration, 812);
    assert.strictEqual(sql(`select duration_seconds || '|' || status from public.transcription_jobs where speechmatics_id = '${jobId}';`).out, '812|done');
  });

  await test('job-result: the transcript in json-v2 form, with every word and time the app needs', async () => {
    const full = B.manyOverlaps();
    full.job.duration = 812.4;   // the same length the job reported
    sm.transcript = full;
    const r = await ask('jobResult', { jobId });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.format, '2.9');
    assert.strictEqual(r.body.results.length, full.results.length);
    const a = F.buildTurns(full), b = F.buildTurns(r.body);
    assert.deepStrictEqual(b.turns, a.turns, 'same transcript as from the full result');
    assert.ok(JSON.stringify(r.body).length < JSON.stringify(full).length, 'smaller to download');
  });

  await test('job-result before it is finished: "not ready"', async () => {
    const other = (await ask('startJob', { path: upload(), seconds: 5 })).body.jobId;
    const r = await ask('jobResult', { jobId: other });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'notReady');
  });

  await test('delete-audio: removes the upload; asking twice is fine', async () => {
    assert.ok(storage.has(jobPath));
    let r = await ask('deleteAudio', { jobId });
    assert.deepStrictEqual(r.body, { deleted: true });
    assert.ok(!storage.has(jobPath));
    r = await ask('deleteAudio', { jobId });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(sql(`select status || '|' || audio_deleted from public.transcription_jobs where speechmatics_id = '${jobId}';`).out, 'saved|true');
    // Still counted towards today: it was transcribed.
    assert.strictEqual((await ask('checkLimit')).body.usedMinutes, Math.floor((812 + 5) / 60));
  });

  await test('jobs this app did not start are refused', async () => {
    for (const id of ['notmine123', '', null, 'a/b', 'x'.repeat(100)]) {
      for (const fn of ['jobStatus', 'jobResult', 'deleteAudio']) {
        const r = await ask(fn, { jobId: id });
        assert.strictEqual(r.status, 404, fn + ' ' + id);
        assert.strictEqual(r.body.error, 'unknownJob');
      }
    }
  });

  await test(`daily limit: new jobs refused once ${LIMIT} minutes are used today, with a plain message`, async () => {
    resetDay();
    const before = smCreates();
    // 45 minutes, then 20 minutes: both start (still under 60 when each began), then the next is refused.
    assert.strictEqual((await ask('startJob', { path: upload(), seconds: 45 * 60 })).status, 200);
    assert.strictEqual((await ask('startJob', { path: upload(), seconds: 20 * 60 })).status, 200);
    const r = await ask('startJob', { path: upload(), seconds: 60 });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.error, 'dailyLimit');
    assert.match(r.body.message, /used up.*60 minutes.*try again tomorrow/i);
    assert.strictEqual(r.body.limitMinutes, 60);
    assert.strictEqual(smCreates(), before + 2, 'the third was never sent to Speechmatics');
    const c = await ask('checkLimit');
    assert.strictEqual(c.status, 429);
    assert.strictEqual(c.body.error, 'dailyLimit');
  });

  await test('daily limit uses the length Speechmatics measured, not just what the app said', async () => {
    resetDay();
    const id = (await ask('startJob', { path: upload(), seconds: 10 })).body.jobId;   // the app claims 10 seconds
    assert.strictEqual((await ask('checkLimit')).status, 200);
    sm.jobs.get(id).duration = 3700;                                                  // really an hour
    await ask('jobStatus', { jobId: id });
    assert.strictEqual((await ask('checkLimit')).status, 429);
    assert.strictEqual((await ask('startJob', { path: upload(), seconds: 10 })).status, 429);
  });

  await test('daily limit: only today counts (yesterday\'s minutes are not counted)', async () => {
    resetDay();
    sql("insert into public.transcription_jobs (day, object_path, claimed_seconds, status) values ((now() at time zone 'Asia/Manila')::date - 1, 'uploads/y.ogg', 99999, 'saved');");
    assert.strictEqual((await ask('checkLimit')).status, 200);
    assert.strictEqual((await ask('startJob', { path: upload(), seconds: 60 })).status, 200);
  });

  await test('Speechmatics refuses the job: plain error, nothing counted, and trying again works', async () => {
    resetDay();
    const p = upload();
    sm.failCreate = { status: 403, body: { code: 403, error: 'Forbidden', detail: 'Account has no credit' } };
    let r = await ask('startJob', { path: p, seconds: 600 });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.body.error, 'speechmatics');
    assert.ok(!JSON.stringify(r.body).includes('sm-secret-key'));
    assert.strictEqual((await ask('checkLimit')).body.usedMinutes, 0, 'not counted');
    r = await ask('startJob', { path: p, seconds: 600 });
    assert.strictEqual(r.status, 200);
  });

  await test('Speechmatics rejects a job part-way: "failed", and trying again starts a new job', async () => {
    resetDay();
    const p = upload();
    const first = (await ask('startJob', { path: p, seconds: 120 })).body.jobId;
    Object.assign(sm.jobs.get(first), { status: 'rejected', errors: [{ timestamp: '2026-11-11T02:16:00Z', message: 'Unable to fetch the audio' }] });
    const s = await ask('jobStatus', { jobId: first });
    assert.strictEqual(s.body.status, 'failed');
    assert.deepStrictEqual(s.body.errors, ['Unable to fetch the audio']);
    const again = await ask('startJob', { path: p, seconds: 120 });
    assert.strictEqual(again.status, 200);
    assert.notStrictEqual(again.body.jobId, first);
    assert.strictEqual((await ask('checkLimit')).body.usedMinutes, 2, 'the rejected job is not counted');
  });

  await test('a start already on its way: "busy" instead of a second job', async () => {
    resetDay();
    const p = upload();
    sql(`select public.transcriber_begin_job('${p}', 60, 3600, 'Asia/Manila');`, { role: 'service_role' });
    const r = await ask('startJob', { path: p, seconds: 60 });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'busy');
  });

  await test('uploads left over for more than a day are deleted', async () => {
    resetDay();
    const stale = upload(25 * 60);
    const fresh = upload(10);
    await ask('startJob', { path: upload(), seconds: 30 });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!storage.has(stale), 'old upload deleted');
    assert.ok(storage.has(fresh), 'recent upload kept');
  });

  await test('an upload over 50 MB is refused and deleted', async () => {
    resetDay();
    const p = upload(0, 60 * 1024 * 1024);
    const r = await ask('startJob', { path: p, seconds: 60 });
    assert.strictEqual(r.status, 413);
    assert.ok(!storage.has(p));
  });

  await test('no Speechmatics key on the server: says so, nothing counted', async () => {
    resetDay();
    delete process.env.SPEECHMATICS_API_KEY;
    try {
      const r = await ask('startJob', { path: upload(), seconds: 60 });
      assert.strictEqual(r.status, 500);
      assert.strictEqual(r.body.error, 'notSetUp');
      assert.strictEqual((await ask('checkLimit')).body.usedMinutes, 0);
    } finally {
      process.env.SPEECHMATICS_API_KEY = 'sm-secret-key';
    }
  });

  await test('only POST is accepted', async () => {
    const r = await H.checkLimit(new Request(`${SUPABASE_URL}/functions/v1/check-limit`, { method: 'GET', headers: { origin: PAGE } }));
    assert.strictEqual(r.status, 405);
  });
} finally {
  stopPostgres();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
