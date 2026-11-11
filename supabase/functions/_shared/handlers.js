// The work behind each Transcriber Edge Function. Each function's index.js
// hands its requests to one of these. Kept in one file so the tests can call
// them directly (tests/functions.test.mjs).
//
// Secrets come from the Edge Function environment and never reach the browser:
//   SPEECHMATICS_API_KEY        (added by Chu as an Edge Function secret)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (provided by Supabase automatically)

import {
  DAILY_LIMIT_MINUTES,
  TIME_ZONE,
  ALLOWED_ORIGINS,
  BUCKET,
  SIGNED_URL_SECONDS,
  DELETE_UNUSED_UPLOADS_AFTER_HOURS,
  SPEECHMATICS_URL,
  TRANSCRIPTION_CONFIG
} from './settings.js';

const UPLOAD_PATH = /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ogg$/;
const JOB_ID = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// ---------- Small helpers ----------

function env(name) {
  if (globalThis.Deno && globalThis.Deno.env) return globalThis.Deno.env.get(name) || '';
  return (globalThis.process && globalThis.process.env[name]) || '';
}

/** The server-only Supabase key (bypasses the database rules). */
function serviceKey() {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  if (key) return key;
  // Projects that only use the new secret keys get them as JSON: {"default": "sb_secret_..."}.
  const keys = env('SUPABASE_SECRET_KEYS');
  if (keys.trim().startsWith('{')) {
    try { return Object.values(JSON.parse(keys))[0] || ''; } catch (_) { return ''; }
  }
  return keys;
}

function allowedOrigin(origin) {
  if (!origin) return ALLOWED_ORIGINS[0];
  try {
    const url = new URL(origin);
    const bare = url.protocol + '//' + url.hostname;
    if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes(bare)) return origin;
  } catch (_) { /* not a URL */ }
  return null;
}

function corsHeaders(req) {
  const origin = allowedOrigin(req.headers.get('origin'));
  return {
    'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function reply(req, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/** A refusal the app turns into plain words (error is a short code). */
function refuse(req, status, error, message, extra) {
  return reply(req, status, { error, message, ...(extra || {}) });
}

class ServiceError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 0;
  }
}

/** A whole number of seconds, or null if not given. */
function seconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

async function readJson(req) {
  try { return await req.json(); } catch (_) { return {}; }
}

function limitMessage() {
  return `Today's transcription time is used up. This app can send ${DAILY_LIMIT_MINUTES} minutes of ` +
    'recordings a day to Speechmatics (for everyone together), and that has been reached. Please try again tomorrow.';
}

// ---------- Supabase (database functions and storage) ----------

function supabaseHeaders(extra) {
  const key = serviceKey();
  return { apikey: key, Authorization: `Bearer ${key}`, ...(extra || {}) };
}

async function rpc(name, args) {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: supabaseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args)
  });
  const text = await res.text();
  if (!res.ok) throw new ServiceError('database', `Database function ${name} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
  return text ? JSON.parse(text) : null;
}

/** Facts about an uploaded file, or null if it isn't there. */
async function storedFile(path) {
  const slash = path.lastIndexOf('/');
  const folder = path.slice(0, slash);
  const name = path.slice(slash + 1);
  const res = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: supabaseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix: folder, search: name, limit: 10, offset: 0 })
  });
  const text = await res.text();
  if (!res.ok) throw new ServiceError('storage', `Storage list failed: ${res.status} ${text.slice(0, 300)}`, res.status);
  const rows = JSON.parse(text || '[]');
  return rows.find((r) => r.name === name) || null;
}

async function signedUrl(path) {
  const res = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: 'POST',
    headers: supabaseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: SIGNED_URL_SECONDS })
  });
  const text = await res.text();
  if (!res.ok) throw new ServiceError('storage', `Could not make a signed link: ${res.status} ${text.slice(0, 300)}`, res.status);
  const signed = JSON.parse(text).signedURL || JSON.parse(text).signedUrl;
  if (!signed) throw new ServiceError('storage', 'No signed link in the answer');
  return /^https?:/.test(signed) ? signed : `${env('SUPABASE_URL')}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
}

async function removeFiles(paths) {
  if (!paths.length) return [];
  const res = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: supabaseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: paths })
  });
  const text = await res.text();
  if (!res.ok) throw new ServiceError('storage', `Could not delete: ${res.status} ${text.slice(0, 300)}`, res.status);
  return JSON.parse(text || '[]');
}

/** Delete uploads older than a day that never became a transcript (the app was abandoned). */
async function deleteUnusedUploads() {
  const res = await fetch(`${env('SUPABASE_URL')}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: supabaseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix: 'uploads', limit: 100, offset: 0, sortBy: { column: 'created_at', order: 'asc' } })
  });
  if (!res.ok) return [];
  const rows = await res.json();
  const before = Date.now() - DELETE_UNUSED_UPLOADS_AFTER_HOURS * 3600 * 1000;
  const old = rows.filter((r) => r.id && r.created_at && Date.parse(r.created_at) < before).map((r) => `uploads/${r.name}`);
  return removeFiles(old);
}

/**
 * The length of an uploaded Ogg Opus file, read from its last page (the server's own
 * measure, so the daily limit doesn't rely on what the page says). null if unknown.
 */
async function oggSeconds(url) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=-65536' } });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    for (let i = bytes.length - 27; i >= 0; i--) {
      if (bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + i);
        const granule = view.getUint32(6, true) + view.getUint32(10, true) * 4294967296;
        if (!granule || granule > 48000 * 86400) return null;
        return Math.max(0, Math.round((granule - 312) / 48000));
      }
    }
  } catch (_) { /* unknown */ }
  return null;
}

// ---------- Speechmatics ----------

async function speechmatics(path, init) {
  const key = env('SPEECHMATICS_API_KEY');
  if (!key) throw new ServiceError('notSetUp', 'SPEECHMATICS_API_KEY is not set');
  let res;
  try {
    res = await fetch(`${SPEECHMATICS_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, ...((init && init.headers) || {}) }
    });
  } catch (err) {
    throw new ServiceError('speechmatics', `Could not reach Speechmatics: ${err && err.message}`);
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  if (!res.ok) {
    const detail = body && (body.detail || body.error) ? `${body.error || ''} ${body.detail || ''}`.trim() : text.slice(0, 300);
    throw new ServiceError('speechmatics', `Speechmatics answered ${res.status}: ${detail}`, res.status);
  }
  return body;
}

function speechmaticsFailed(req, err) {
  console.error(err.message);
  if (err.code === 'notSetUp') {
    return refuse(req, 500, 'notSetUp', 'The Speechmatics key is missing on the server.');
  }
  if (err.code === 'speechmatics') {
    return refuse(req, 502, 'speechmatics', 'Speechmatics could not take this job right now.', { status: err.status });
  }
  return refuse(req, 500, 'server', 'Something went wrong on the server.');
}

/** Only the parts of the Speechmatics result the app uses, in the same json-v2 shape. */
function slimResult(result) {
  const results = (result.results || []).map((r) => {
    const alt = (r.alternatives && r.alternatives[0]) || {};
    const slim = { type: r.type, start_time: r.start_time, end_time: r.end_time };
    if (r.attaches_to) slim.attaches_to = r.attaches_to;
    if (r.is_eos) slim.is_eos = true;
    const a = { content: alt.content, speaker: alt.speaker };
    if (alt.tags) a.tags = alt.tags;
    slim.alternatives = [a];
    return slim;
  });
  return { format: result.format, job: result.job, metadata: result.metadata, results };
}

/**
 * Ask Speechmatics the real length of today's jobs that nobody has checked on yet,
 * so a job counts in full towards the daily limit even if its page never asks again.
 */
async function refreshLengths() {
  let ids = [];
  try { ids = (await rpc('transcriber_jobs_without_length', { p_time_zone: TIME_ZONE })) || []; } catch (_) { return; }
  await Promise.all(ids.map(async (id) => {
    try {
      const answer = await speechmatics(`/jobs/${encodeURIComponent(id)}`, { method: 'GET' });
      const duration = seconds(answer && answer.job && answer.job.duration);
      if (duration !== null) {
        await rpc('transcriber_job_update', { p_speechmatics_id: id, p_status: null, p_duration_seconds: duration, p_audio_deleted: null });
      }
    } catch (_) { /* try again next time */ }
  }));
}

// ---------- The functions ----------

async function handle(req, work) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return refuse(req, 405, 'method', 'Use POST.');
  if (req.headers.get('origin') && !allowedOrigin(req.headers.get('origin'))) {
    return refuse(req, 403, 'origin', 'This page is not allowed to use the transcription service.');
  }
  try {
    return await work(await readJson(req));
  } catch (err) {
    console.error(err && err.stack || err);
    if (err instanceof ServiceError && (err.code === 'speechmatics' || err.code === 'notSetUp')) return speechmaticsFailed(req, err);
    return refuse(req, 500, 'server', 'Something went wrong on the server.');
  }
}

async function findJob(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return null;
  return rpc('transcriber_find_job', { p_speechmatics_id: jobId });
}

/** check-limit: is there time left today? (The app asks before it uploads.) */
export function checkLimit(req) {
  return handle(req, async () => {
    await refreshLengths();
    const used = Number(await rpc('transcriber_used_seconds', { p_time_zone: TIME_ZONE })) || 0;
    const limit = DAILY_LIMIT_MINUTES * 60;
    if (used >= limit) {
      return refuse(req, 429, 'dailyLimit', limitMessage(), { limitMinutes: DAILY_LIMIT_MINUTES, usedMinutes: Math.floor(used / 60) });
    }
    return reply(req, 200, { open: true, limitMinutes: DAILY_LIMIT_MINUTES, usedMinutes: Math.floor(used / 60) });
  });
}

/** start-job: send an uploaded file to Speechmatics. Body: { path, seconds } */
export function startJob(req) {
  return handle(req, async (body) => {
    const path = body.path;
    if (typeof path !== 'string' || !UPLOAD_PATH.test(path)) {
      return refuse(req, 400, 'badRequest', 'That is not an upload from this app.');
    }
    let claimed = Math.round(Number(body.seconds));
    if (!isFinite(claimed) || claimed < 0) claimed = 0;

    // Already sent to Speechmatics? Hand back that job (even if the upload has since been cleared).
    const live = await rpc('transcriber_find_live_job', { p_object_path: path });
    if (live && live.speechmatics_id) return reply(req, 200, { jobId: live.speechmatics_id, reused: true });

    const file = await storedFile(path);
    if (!file) return refuse(req, 404, 'notUploaded', 'The recording has not finished uploading.');
    const size = Number(file.metadata && file.metadata.size) || 0;
    if (size > MAX_UPLOAD_BYTES) {
      await removeFiles([path]).catch(() => {});
      return refuse(req, 413, 'tooLarge', 'The recording is too large.');
    }

    const url = await signedUrl(path);
    const measured = await oggSeconds(url);
    await refreshLengths();
    const begun = await rpc('transcriber_begin_job', {
      p_object_path: path,
      p_seconds: Math.max(claimed, measured || 0),
      p_limit_seconds: DAILY_LIMIT_MINUTES * 60,
      p_time_zone: TIME_ZONE
    });
    if (begun.status === 'existing') return reply(req, 200, { jobId: begun.speechmatics_id, reused: true });
    if (begun.status === 'busy') return refuse(req, 409, 'busy', 'This recording is already being sent to Speechmatics.');
    if (begun.status === 'limit') {
      return refuse(req, 429, 'dailyLimit', limitMessage(), { limitMinutes: DAILY_LIMIT_MINUTES, usedMinutes: Math.floor(begun.used_seconds / 60) });
    }

    deleteUnusedUploads().catch((err) => console.error('Cleaning old uploads:', err && err.message));

    let created;
    try {
      const form = new FormData();
      form.append('config', JSON.stringify({
        type: 'transcription',
        fetch_data: { url },
        transcription_config: TRANSCRIPTION_CONFIG
      }));
      created = await speechmatics('/jobs', { method: 'POST', body: form });
      if (!created || !created.id) throw new ServiceError('speechmatics', 'Speechmatics gave no job number', 400);
    } catch (err) {
      // Only when Speechmatics clearly said no is the job marked failed (and not counted).
      // If the answer was lost, it may have started the job: the row stays "starting", so a
      // retry within 10 minutes gets "busy" instead of starting (and paying for) a second job.
      if (err.code === 'notSetUp' || (err.status >= 400 && err.status < 500)) {
        await rpc('transcriber_job_failed', { p_id: begun.id, p_error: String(err && err.message) }).catch(() => {});
      }
      throw err;
    }
    const jobId = String(created.id);
    for (let i = 0; ; i++) {
      try {
        await rpc('transcriber_job_started', { p_id: begun.id, p_speechmatics_id: jobId });
        break;
      } catch (err) {
        if (i >= 2) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return reply(req, 200, { jobId });
  });
}

/** job-status: how is the job doing? Body: { jobId } -> { status: 'running' | 'done' | 'failed' } */
export function jobStatus(req) {
  return handle(req, async (body) => {
    const row = await findJob(body.jobId);
    if (!row) return refuse(req, 404, 'unknownJob', 'This app has no job with that number.');
    const answer = await speechmatics(`/jobs/${encodeURIComponent(body.jobId)}`, { method: 'GET' });
    const job = (answer && answer.job) || {};
    const duration = seconds(job.duration);
    let status = 'running';
    if (job.status === 'done') status = 'done';
    else if (['rejected', 'deleted', 'expired'].includes(job.status)) status = 'failed';
    await rpc('transcriber_job_update', {
      p_speechmatics_id: body.jobId,
      p_status: row.status === 'saved' ? null : status === 'failed' ? 'rejected' : status,
      p_duration_seconds: duration,
      p_audio_deleted: null
    });
    const errors = Array.isArray(job.errors) ? job.errors.map((e) => e && e.message).filter(Boolean) : [];
    return reply(req, 200, { status, speechmaticsStatus: job.status || null, duration, errors });
  });
}

/** job-result: the finished transcript in Speechmatics' json-v2 format. Body: { jobId } */
export function jobResult(req) {
  return handle(req, async (body) => {
    const row = await findJob(body.jobId);
    if (!row) return refuse(req, 404, 'unknownJob', 'This app has no job with that number.');
    let result;
    try {
      result = await speechmatics(`/jobs/${encodeURIComponent(body.jobId)}/transcript?format=json-v2`, { method: 'GET' });
    } catch (err) {
      if (err.status === 404) return refuse(req, 409, 'notReady', 'The transcript is not ready yet.');
      throw err;
    }
    const duration = seconds(result && result.job && result.job.duration);
    await rpc('transcriber_job_update', {
      p_speechmatics_id: body.jobId,
      p_status: row.status === 'saved' ? null : 'done',
      p_duration_seconds: duration,
      p_audio_deleted: null
    });
    return reply(req, 200, slimResult(result || {}));
  });
}

/** delete-audio: the app has saved the transcript, so delete the uploaded recording. Body: { jobId } */
export function deleteAudio(req) {
  return handle(req, async (body) => {
    const row = await findJob(body.jobId);
    if (!row) return refuse(req, 404, 'unknownJob', 'This app has no job with that number.');
    if (!row.audio_deleted) await removeFiles([row.object_path]);
    await rpc('transcriber_job_update', {
      p_speechmatics_id: body.jobId,
      p_status: 'saved',
      p_duration_seconds: null,
      p_audio_deleted: true
    });
    return reply(req, 200, { deleted: true });
  });
}

// For the tests.
export { oggSeconds as _oggSeconds };
