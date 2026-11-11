/*
 * A pretend Supabase for the browser tests (file.test.js, folder.test.js):
 * sign-in by email link, the "transcripts" table with its per-person rules,
 * Storage (resumable uploads, play links, deleting), and the Edge Functions
 * with a pretend Speechmatics behind them. The real Supabase and Speechmatics
 * cannot be reached from the build machine.
 *
 * It answers in the same shapes the real services use, and the app talks to it
 * through the real Supabase JavaScript library, so the requests are the real ones.
 *
 *   const fake = require('./fake-supabase');
 *   let server = fake.freshServer();
 *   await context.route(fake.SUPABASE + '/**', fake.makeRoute(() => server, ORIGIN));
 *   await context.addInitScript(fake.signedInScript(fake.CHU));   // start signed in
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SUPABASE = 'https://mgiwopbaglgzxeaowzzt.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_BZjwO2iS-yPbM-MBotusbQ_3lIVcMAS';
const STORAGE_KEY = 'sb-mgiwopbaglgzxeaowzzt-auth-token';
const FIX = path.join(__dirname, 'fixtures', 'speechmatics');
const saved = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));

const CHU = { id: '11111111-1111-4111-8111-111111111111', email: 'chuvicame@gmail.com' };
const TESTER = { id: '22222222-2222-4222-8222-222222222222', email: 'tester@example.com' };
const PEOPLE = [CHU, TESTER];

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** A sign-in token shaped like Supabase's (a JWT), naming the person. */
function tokenFor(user, n = 1) {
  const now = Math.floor(Date.now() / 1000);
  return [b64url({ alg: 'HS256', typ: 'JWT' }),
    b64url({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600, n }),
    'signature'].join('.');
}

function userJson(user) {
  return {
    id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email,
    email_confirmed_at: '2026-11-11T01:00:00Z', confirmed_at: '2026-11-11T01:00:00Z', last_sign_in_at: '2026-11-11T01:00:00Z',
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [],
    created_at: '2026-11-11T01:00:00Z', updated_at: '2026-11-11T01:00:00Z'
  };
}

function sessionFor(user, n = 1) {
  const now = Math.floor(Date.now() / 1000);
  return { access_token: tokenFor(user, n), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600,
    refresh_token: 'refresh-' + user.id + '-' + n, user: userJson(user) };
}

/** Who a request's sign-in token names, or null (the publishable key alone is nobody). */
function personOf(headers) {
  const m = /^Bearer\s+(.+)$/i.exec(headers.authorization || '');
  if (!m || m[1].startsWith('sb_')) return null;
  try {
    const claims = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString());
    return PEOPLE.find((p) => p.id === claims.sub) || null;
  } catch (e) { return null; }
}

/** Put a sign-in on the page before it loads, as if this person signed in earlier on this device. */
function signedInScript(user) {
  return `
    try {
      if (!localStorage.getItem('__test_signed_in')) {
        localStorage.setItem('__test_signed_in', '1');
        localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(sessionFor(user)))});
      }
    } catch (e) {}
  `;
}

/** The address the email's sign-in link lands on (what Supabase sends the browser back to). */
function linkLanding(pageUrl, user) {
  const s = sessionFor(user, 2);
  return `${pageUrl}#access_token=${s.access_token}&expires_at=${s.expires_at}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer&type=magiclink`;
}

function freshServer() {
  return {
    uploads: new Map(),        // id -> { length, bytes: Buffer[], received, objectName }
    objects: new Map(),        // objectName -> Buffer
    calls: [],                 // { fn, body, user } for the Edge Functions
    tus: [],                   // { method, id, offset, size }
    jobs: new Map(),           // jobId -> { path, seconds, polls, status, why, user }
    nextJob: 1,
    // Sign-in
    allowed: new Set([CHU.email]),
    otps: [],                  // { email, redirectTo } for every sign-in email "sent"
    auth: [],                  // { what } for every other Auth call
    emailRateLimited: false,
    // My Transcripts
    rows: [],                  // the "transcripts" table
    rest: [],                  // { method, table, query, body, user }
    nextRow: 1,
    setupNotRun: false,        // setup_2.sql was never run: no table, no functions
    dbDown: false,             // the database cannot be reached
    signed: [],                // paths a play link was made for
    // Knobs the tests turn:
    result: saved('two-speakers'),
    pollsUntilDone: 1,
    limitReached: false,
    limitAtStart: false,
    startFails: 0,             // how many start-job calls answer "Speechmatics failed"
    startBusy: 0,              // how many start-job calls answer "busy"
    reject: null,              // a reason to reject the next job
    notDeployed: false,
    patchFails: 0,             // how many PATCH requests answer 500
    holdPatch: null,           // a function that, when set, decides to hold a PATCH (returns a promise)
    afterPatch: null
  };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
let rowIds = 0;
const newRowId = () => `0000${(++rowIds).toString(16).padStart(4, '0')}-aaaa-4aaa-8aaa-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;

function makeRoute(getServer, ORIGIN) {
  const CORS = {
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, POST, PATCH, HEAD, DELETE, OPTIONS',
    'access-control-expose-headers': 'Location, Upload-Offset, Upload-Length, Tus-Resumable, Content-Range, Accept-Ranges'
  };

  return async function fakeSupabase(route) {
    const server = getServer();
    const req = route.request();
    const url = new globalThis.URL(req.url());
    const method = req.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS, body: '' });
    const h = req.headers();
    const reply = (status, body, extra) => route.fulfill({
      status, headers: { ...CORS, 'content-type': 'application/json', ...(extra || {}) }, body: body === undefined ? '' : JSON.stringify(body)
    });
    const p = url.pathname;

    // --- A recording being played through its play link (the <audio> element sends no keys) ---
    if (method === 'GET' && p.startsWith('/storage/v1/object/sign/recordings/')) {
      const name = decodeURIComponent(p.slice('/storage/v1/object/sign/recordings/'.length));
      const bytes = server.objects.get(name);
      if (!bytes || url.searchParams.get('token') !== 'play-token') return reply(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const range = /bytes=(\d+)-(\d*)/.exec(h.range || '');
      const base = { ...CORS, 'content-type': 'audio/ogg', 'accept-ranges': 'bytes' };
      if (!range) return route.fulfill({ status: 200, headers: base, body: bytes });
      const from = Number(range[1]);
      const to = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      return route.fulfill({ status: 206, headers: { ...base, 'content-range': `bytes ${from}-${to}/${bytes.length}` }, body: bytes.subarray(from, to + 1) });
    }

    // Every other call carries the publishable key and nothing secret.
    assert.strictEqual(h.apikey, PUBLISHABLE_KEY, 'apikey on ' + method + ' ' + p);
    assert.ok(!/sb_secret|service_role/.test(JSON.stringify(h)), 'no secret key in the page');
    const user = personOf(h);
    const signedIn = user && server.allowed.has(user.email) ? user : null;

    // --- Sign-in (Supabase Auth) ---
    if (p === '/auth/v1/otp' && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      if (server.emailRateLimited) return reply(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
      // The database trigger refuses to make an account for an email that is not on the list.
      if (!server.allowed.has(String(body.email).toLowerCase())) return reply(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error saving new user' });
      server.otps.push({ email: body.email, redirectTo: url.searchParams.get('redirect_to'), createUser: body.create_user });
      return reply(200, {});
    }
    if (p === '/auth/v1/user' && method === 'GET') {
      server.auth.push({ what: 'user' });
      return user ? reply(200, userJson(user)) : reply(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
    }
    if (p === '/auth/v1/token' && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      const who = PEOPLE.find((x) => String(body.refresh_token || '').startsWith('refresh-' + x.id));
      server.auth.push({ what: 'refresh' });
      return who ? reply(200, sessionFor(who, 3)) : reply(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
    }
    if (p === '/auth/v1/logout' && method === 'POST') {
      server.auth.push({ what: 'logout', scope: url.searchParams.get('scope') });
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }

    // --- The database (PostgREST) ---
    if (p.startsWith('/rest/v1/')) {
      if (server.dbDown) return route.abort('failed');
      const notThere = (what) => reply(404, { code: what === 'function' ? 'PGRST202' : 'PGRST205', details: null, hint: null,
        message: `Could not find the ${what} in the schema cache` });
      if (p.startsWith('/rest/v1/rpc/')) {
        const fn = p.slice('/rest/v1/rpc/'.length);
        const body = JSON.parse(req.postData() || '{}');
        server.rest.push({ method, rpc: fn, body, user });
        if (server.setupNotRun) return notThere('function');
        if (fn === 'transcriber_email_allowed') return reply(200, server.allowed.has(String(body.p_email || '').trim().toLowerCase()));
        if (fn === 'transcriber_storage_used') {
          if (!user) return reply(401, { code: '42501', message: 'permission denied for function transcriber_storage_used' });
          return reply(200, signedIn ? [...server.objects.values()].reduce((n, b) => n + b.length, 0) : 0);
        }
        return notThere('function');
      }
      if (p === '/rest/v1/transcripts') {
        const q = Object.fromEntries(url.searchParams);
        const body = req.postData() ? JSON.parse(req.postData()) : null;
        server.rest.push({ method, table: 'transcripts', query: q, body, user, prefer: h.prefer || '' });
        if (server.setupNotRun) return notThere('table');
        if (!user) return reply(401, { code: '42501', message: 'permission denied for table transcripts' });
        // Row level security: only this person's rows, and only if they are on the allowed list.
        const mine = (r) => signedIn && r.user_id === signedIn.id;
        const matches = (r) => ['id', 'file_key', 'user_id'].every((k) => !q[k] || q[k] === 'eq.' + r[k]);
        const pick = (r) => {
          if (!q.select || q.select === '*') return { ...r };
          return Object.fromEntries(q.select.split(',').map((k) => [k, r[k]]));
        };
        const single = /vnd\.pgrst\.object/.test(h.accept || '');
        const out = (rows, status = 200) => {
          if (!single) return reply(status, rows.map(pick));
          if (rows.length === 1) return reply(status, pick(rows[0]));
          return reply(406, { code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' });
        };
        const wantRows = /return=representation/.test(h.prefer || '');
        if (method === 'GET') {
          let rows = server.rows.filter(mine).filter(matches);
          if (q.order === 'created_at.desc') rows = rows.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
          if (q.limit) rows = rows.slice(0, Number(q.limit));
          return out(rows);
        }
        if (method === 'POST') {
          const incoming = Array.isArray(body) ? body : [body];
          const merge = /resolution=merge-duplicates/.test(h.prefer || '') && q.on_conflict === 'user_id,file_key';
          const done = [];
          for (const row of incoming) {
            const owner = row.user_id || (signedIn && signedIn.id);
            if (!signedIn || owner !== signedIn.id) return reply(403, { code: '42501', details: null, hint: null, message: 'new row violates row-level security policy for table "transcripts"' });
            const same = row.file_key ? server.rows.find((r) => r.user_id === owner && r.file_key === row.file_key) : null;
            if (same && !merge) return reply(409, { code: '23505', details: 'Key (user_id, file_key) already exists.', hint: null, message: 'duplicate key value violates unique constraint "transcripts_one_per_file"' });
            const now = new Date().toISOString();
            if (same) { Object.assign(same, row, { updated_at: now }); done.push(same); continue; }
            const made = { id: newRowId(), user_id: owner, created_at: now, updated_at: now, title: '', file_name: '', duration_seconds: 0,
              turns: [], speakers: [], speaker_names: {}, first_line: '', audio_path: null, audio_bytes: 0, speechmatics_id: null, file_key: null, ...row };
            server.rows.push(made);
            done.push(made);
          }
          return wantRows ? out(done, 201) : route.fulfill({ status: 201, headers: CORS, body: '' });
        }
        if (method === 'PATCH') {
          if (body.user_id && body.user_id !== (signedIn && signedIn.id)) return reply(403, { code: '42501', message: 'new row violates row-level security policy for table "transcripts"' });
          const rows = server.rows.filter(mine).filter(matches);
          rows.forEach((r) => Object.assign(r, body, { updated_at: new Date().toISOString() }));
          return wantRows ? out(rows) : route.fulfill({ status: 204, headers: CORS, body: '' });
        }
        if (method === 'DELETE') {
          const rows = server.rows.filter(mine).filter(matches);
          server.rows = server.rows.filter((r) => !rows.includes(r));
          return wantRows ? out(rows) : route.fulfill({ status: 204, headers: CORS, body: '' });
        }
      }
      return notThere('table');
    }

    // --- Storage: play links and deleting ---
    const ownName = (name) => signedIn && new RegExp(`^${signedIn.id}/${UUID}\\.ogg$`).test(name);
    if (method === 'POST' && p.startsWith('/storage/v1/object/sign/recordings/')) {
      const name = decodeURIComponent(p.slice('/storage/v1/object/sign/recordings/'.length));
      // The storage rules: only your own folder. Anything else looks as if it is not there.
      if (!ownName(name) || !server.objects.has(name)) return reply(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      assert.ok(JSON.parse(req.postData()).expiresIn <= 3600, 'a play link lasts an hour at most');
      server.signed.push(name);
      return reply(200, { signedURL: `/object/sign/recordings/${name}?token=play-token` });
    }
    if (method === 'DELETE' && p === '/storage/v1/object/recordings') {
      const names = JSON.parse(req.postData() || '{}').prefixes || [];
      const gone = names.filter((n) => ownName(n) && server.objects.delete(n));
      server.rest.push({ method, storage: 'remove', names, user });
      return reply(200, gone.map((name) => ({ name, bucket_id: 'recordings' })));
    }

    // --- Resumable uploads (tus) ---
    if (p.startsWith('/storage/v1/upload/resumable')) {
      // Uploading needs a signed-in person on the allowed list (the storage rules).
      if (!signedIn) return reply(403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      const id = p.split('/')[5];
      if (method === 'POST' && !id) {
        const meta = Object.fromEntries(h['upload-metadata'].split(',').map((kv) => {
          const [k, v] = kv.split(' ');
          return [k, Buffer.from(v, 'base64').toString()];
        }));
        assert.strictEqual(meta.bucketName, 'recordings');
        assert.strictEqual(meta.contentType, 'audio/ogg');
        // Only into the person's own folder.
        if (!ownName(meta.objectName)) return reply(403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
        const newId = 'up' + (server.uploads.size + 1);
        server.uploads.set(newId, { length: Number(h['upload-length']), bytes: [], received: 0, objectName: meta.objectName });
        server.tus.push({ method, id: newId, size: Number(h['upload-length']) });
        return reply(201, undefined, { location: `${SUPABASE}/storage/v1/upload/resumable/${newId}`, 'tus-resumable': '1.0.0' });
      }
      const up = server.uploads.get(id);
      if (!up) return reply(404, { error: 'not found' });
      if (method === 'HEAD') {
        server.tus.push({ method, id, offset: up.received });
        return route.fulfill({ status: 200, headers: { ...CORS, 'upload-offset': String(up.received), 'upload-length': String(up.length), 'tus-resumable': '1.0.0' } });
      }
      if (method === 'PATCH') {
        const offset = Number(h['upload-offset']);
        const body = req.postDataBuffer() || Buffer.alloc(0);
        server.tus.push({ method, id, offset, size: body.length });
        if (server.holdPatch) {
          const hold = server.holdPatch(offset, id);
          if (hold) { await hold; return route.abort('failed').catch(() => {}); }
        }
        if (server.patchFails > 0) { server.patchFails--; return reply(500, { error: 'server busy' }); }
        if (offset !== up.received) return reply(409, { error: 'offset mismatch' });
        assert.ok(body.length === 6 * 1024 * 1024 || offset + body.length === up.length, 'pieces of exactly 6 MB, except the last');
        up.bytes.push(body);
        up.received += body.length;
        if (up.received === up.length) server.objects.set(up.objectName, Buffer.concat(up.bytes));
        if (server.afterPatch) server.afterPatch(up);
        return route.fulfill({ status: 204, headers: { ...CORS, 'upload-offset': String(up.received), 'tus-resumable': '1.0.0' } });
      }
      return reply(405, {});
    }

    // --- Edge Functions ---
    if (p.startsWith('/functions/v1/')) {
      const fn = p.slice('/functions/v1/'.length);
      const body = JSON.parse(req.postData() || '{}');
      server.calls.push({ fn, body, user });
      if (server.notDeployed) return reply(404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
      // Every function checks who is asking.
      if (!user) return reply(401, { error: 'signIn', message: 'Please sign in to use the transcription service.' });
      if (!signedIn) return reply(403, { error: 'notAllowed', message: 'This app isn’t open to new users yet.' });
      const limit = () => reply(429, { error: 'dailyLimit', message: 'used up', limitMinutes: 60, usedMinutes: 61 });
      if (fn === 'check-limit') return server.limitReached ? limit() : reply(200, { open: true, limitMinutes: 60, usedMinutes: 3 });
      if (fn === 'start-job') {
        if (!ownName(body.path) && !new RegExp(`^uploads/${UUID}\\.ogg$`).test(body.path)) return reply(400, { error: 'badRequest', message: 'not yours' });
        if (server.limitReached || server.limitAtStart) return limit();
        if (!server.objects.has(body.path)) return reply(404, { error: 'notUploaded', message: 'not uploaded' });
        if (server.startBusy > 0) { server.startBusy--; return reply(409, { error: 'busy', message: 'busy' }); }
        if (server.startFails > 0) { server.startFails--; return reply(502, { error: 'speechmatics', message: 'Speechmatics could not take this job right now.' }); }
        const existing = [...server.jobs.entries()].find(([, j]) => j.path === body.path && j.status !== 'rejected');
        if (existing) return reply(200, { jobId: existing[0], reused: true });
        const jobId = 'smjob' + server.nextJob++;
        server.jobs.set(jobId, { path: body.path, seconds: body.seconds, polls: 0, status: 'running', why: server.reject, user: user.id });
        server.reject = null;
        return reply(200, { jobId });
      }
      const job = server.jobs.get(body.jobId);
      if (!job || (job.user && job.user !== user.id)) return reply(404, { error: 'unknownJob', message: 'no such job' });
      if (fn === 'job-status') {
        job.polls++;
        if (job.why) { job.status = 'rejected'; return reply(200, { status: 'failed', speechmaticsStatus: 'rejected', duration: null, errors: [job.why] }); }
        if (job.polls > server.pollsUntilDone) job.status = 'done';
        return reply(200, { status: job.status === 'done' ? 'done' : 'running', speechmaticsStatus: job.status, duration: null, errors: [] });
      }
      if (fn === 'job-result') return job.status === 'done' ? reply(200, server.result) : reply(409, { error: 'notReady' });
      if (fn === 'delete-audio') {
        if (server.rows.some((r) => r.audio_path === job.path)) return reply(200, { deleted: false, kept: true });
        server.objects.delete(job.path);
        job.deleted = true;
        return reply(200, { deleted: true });
      }
    }
    return reply(404, { error: 'unexpected ' + p });
  };
}

module.exports = { SUPABASE, PUBLISHABLE_KEY, STORAGE_KEY, CHU, TESTER, saved, freshServer, makeRoute, signedInScript, linkLanding, sessionFor, tokenFor };
