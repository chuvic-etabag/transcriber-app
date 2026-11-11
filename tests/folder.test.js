/*
 * Browser tests for TR Session D, in Chromium: signing in by email link, the
 * My Transcripts folder, the Show Fillers switch on screen, and the Sunset
 * colors. Supabase and Speechmatics are played by tests/fake-supabase.js
 * (the app talks to it through the real Supabase JavaScript library).
 * Run from the repo root:
 *
 *   node tests/folder.test.js
 *
 * Needs Python 3, ffmpeg, curl and Playwright with Chromium.
 */
'use strict';
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const media = require('./media');
const F = require('../transcript-format.js');
const B = require('./fixtures/speechmatics-builder.js');
const fake = require('./fake-supabase');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8771;
const ORIGIN = `http://localhost:${PORT}`;
const URL = `${ORIGIN}/index.html`;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const { CHU, TESTER, saved } = fake;

let server = fake.freshServer();
const fakeSupabase = fake.makeRoute(() => server, ORIGIN);
const fnCalls = (fn) => server.calls.filter((c) => c.fn === fn);

const QUICK = `
  window.addEventListener('DOMContentLoaded', () => {
    if (window.FileTab) Object.assign(window.FileTab.TIMING, { pollFirst: 100, poll: 100, pollSlow: 100, retry: 100, busy: 100, sync: 100 });
    if (window.Folder) Object.assign(window.Folder.TIMING, { sync: 100 });
  });
`;

let passed = 0;
const failures = [];
let browser;

async function newContext(opts = {}) {
  const { as = CHU, ...rest } = opts;
  const context = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, ...rest });
  await context.addInitScript(QUICK);
  if (as) await context.addInitScript(fake.signedInScript(as));
  await context.route(fake.SUPABASE + '/**', fakeSupabase);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  return context;
}

async function test(name, fn, opts = {}) {
  if (ONLY && !name.includes(ONLY)) return;
  server = fake.freshServer();
  if (opts.before) opts.before();
  const context = await newContext(opts.context || {});
  const page = await context.newPage();
  const errors = [];
  const watch = (p) => p.on('pageerror', (e) => errors.push(e.message));
  watch(page);
  context.on('page', watch);
  const started = Date.now();
  try {
    await page.goto(URL);
    await fn(page, context);
    assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join('; '));
    passed++;
    console.log(`  ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 7).join('\n       '));
  } finally {
    await context.close().catch(() => {});
  }
}

const text = (page, sel) => page.locator(sel).innerText();
const waitText = (page, sel, re, timeout = 15000) => page.waitForFunction(([s, src]) => {
  const e = document.querySelector(s);
  return e && new RegExp(src, 'i').test(e.textContent);
}, [sel, re.source], { timeout, polling: 50 });
const screenLines = (page) => page.$$eval('#file-transcript .turn', (ps) => ps.map((p) => p.textContent));
const visible = (page, sel) => page.isVisible(sel);

async function chooseFile(page, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#file-choose')]);
  await chooser.setFiles(file);
}

async function transcribe(page, file, result) {
  if (result) server.result = result;
  await page.click('#tab-file');
  await chooseFile(page, file);
  await waitText(page, '#file-status', /^Ready/);
  await page.click('#file-start');
  await waitText(page, '#file-status', /^Done/, 90000);
}

async function openFolder(page) {
  await page.click('#tab-folder');
  await page.waitForFunction(() => !document.getElementById('folder-refresh').disabled && !/Loading/.test(document.getElementById('folder-status').textContent));
}

/** The app has finished looking for transcripts saved on this device by the earlier version. */
const firstCheckDone = (page) => page.waitForFunction(() => localStorage.getItem('transcriber.moveOffered'));

const cards = (page) => page.$$eval('#folder-list .item', (els) => els.map((e) => ({
  name: e.querySelector('.item-name').textContent, meta: e.querySelector('.item-meta').textContent, line: e.querySelector('.item-line').textContent
})));

/** Put an item straight into the pretend My Transcripts (as if made earlier, maybe on another device). */
function seed(owner, title, { hoursAgo = 1, result = saved('two-speakers'), minutes = 5, audio = true, names = {} } = {}) {
  const built = F.buildTurns(result);
  const audioPath = audio ? `${owner.id}/${String(server.nextRow).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa.ogg` : null;
  if (audioPath) server.objects.set(audioPath, Buffer.alloc(minutes * 80000, 1));
  const row = {
    id: `${String(server.nextRow++).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, user_id: owner.id,
    created_at: new Date(Date.now() - hoursAgo * 3600e3).toISOString(), updated_at: new Date().toISOString(),
    title, file_name: title, duration_seconds: minutes * 60, turns: built.turns, speakers: built.speakers, speaker_names: names,
    first_line: 'Speaker 1: ' + built.turns[0].text.slice(0, 180), audio_path: audioPath, audio_bytes: audio ? minutes * 80000 : 0,
    speechmatics_id: null, file_key: 'seed-' + title
  };
  server.rows.push(row);
  return row;
}

const FILLER_SCRIPT = [
  { speaker: 'S1', at: 0.5, say: 'Um, so I I wanted to ask about the, uh, schedule for next week.' },
  { speaker: 'S2', at: 2.0, say: 'Mhm.' },
  { speaker: 'S2', at: 7.0, say: 'Um.' },
  { speaker: 'S1', at: 8.0, say: 'Is Monday okay?' },
  { speaker: 'S2', at: 10.0, say: 'Uh-huh.' },
  { speaker: 'S1', at: 13.0, say: 'Hmm.' },
  { speaker: 'S2', at: 15.0, say: 'Er, Tuesday is is better.' }
];
const FILLERS_ON = [
  '1. [00:00:00 – 00:00:04] Speaker 1: Um, so I I wanted to ask about the, uh, schedule for next week.',
  '2. [00:00:02 – 00:00:02] Speaker 2 (overlap): Mhm.',
  '3. [00:00:07 – 00:00:07] Speaker 2: Um.',
  '4. [00:00:08 – 00:00:08] Speaker 1: Is Monday okay?',
  '5. [00:00:10 – 00:00:10] Speaker 2: Uh-huh.',
  '6. [00:00:13 – 00:00:13] Speaker 1: Hmm.',
  '7. [00:00:15 – 00:00:16] Speaker 2: Er, Tuesday is is better.'
];
const FILLERS_OFF = [
  '1. [00:00:00 – 00:00:04] Speaker 1: So I wanted to ask about the schedule for next week.',
  '2. [00:00:02 – 00:00:02] Speaker 2 (overlap): Mhm.',
  '3. [00:00:08 – 00:00:08] Speaker 1: Is Monday okay?',
  '4. [00:00:10 – 00:00:10] Speaker 2: Uh-huh.',
  '5. [00:00:15 – 00:00:16] Speaker 2: Tuesday is better.'
];
const noTimes = (lines) => lines.map((l) => l.replace(/\[[^\]]+\] /, ''));

// ---------- Colors ----------

const PALETTE = {
  navy: 'rgb(43, 58, 81)', panel: 'rgb(53, 92, 125)', coral: 'rgb(255, 117, 130)', plum: 'rgb(114, 90, 122)', rose: 'rgb(197, 108, 134)',
  white: 'rgb(255, 255, 255)', ink: 'rgb(27, 31, 39)', inkSoft: 'rgb(91, 100, 116)', roseTint: 'rgb(243, 221, 228)'
};

/** Every colour used by what is on screen now: text, backgrounds, borders. */
function collectColors(page) {
  return page.evaluate(() => {
    const out = [];
    const shown = (e) => e.offsetParent !== null || e === document.body;
    for (const e of document.querySelectorAll('body, body *')) {
      if (!shown(e) || e.closest('audio') || e.classList.contains('visually-hidden') || ['SCRIPT', 'AUDIO', 'OPTION'].includes(e.tagName)) continue;
      const cs = getComputedStyle(e);
      const label = e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : '');
      // Boxes people type in (not the invisible checkboxes inside the switches).
      const typing = e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && ['text', 'email', 'search'].includes(e.type)) || e.isContentEditable;
      if (e.tagName === 'INPUT' && !typing) continue;
      const ownText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || typing;
      // The background this element's text sits on: its own, or the nearest one behind it.
      let behind = 'rgb(43, 58, 81)';
      for (let a = e; a; a = a.parentElement) {
        const bg = getComputedStyle(a).backgroundColor;
        if (bg !== 'rgba(0, 0, 0, 0)') { behind = bg; break; }
      }
      if (ownText) out.push({ kind: 'text', color: cs.color, behind, label, typing });
      if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') out.push({ kind: 'background', color: cs.backgroundColor, label });
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (parseFloat(cs['border' + side + 'Width']) > 0 && cs['border' + side + 'Style'] !== 'none') out.push({ kind: 'border', color: cs['border' + side + 'Color'], label });
      }
      if (cs.textDecorationLine !== 'none' && ownText) out.push({ kind: 'border', color: cs.textDecorationColor, label: label + ' underline' });
    }
    return out;
  });
}

function hueOf(rgb) {
  const m = rgb.match(/[\d.]+/g).map(Number);
  const [r, g, b] = m.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.08) return null;   // grey, white or black
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: d / max };
}

function checkColors(found, where) {
  const P = PALETTE;
  const allowed = new Set([...Object.values(P), 'rgba(255, 255, 255, 0.28)']);
  for (const c of found) {
    assert.ok(allowed.has(c.color), `${where}: ${c.kind} colour ${c.color} on ${c.label} is not in the Sunset palette`);
    const hue = hueOf(c.color);
    assert.ok(!(hue && hue.h >= 18 && hue.h <= 75 && hue.s > 0.2), `${where}: ${c.color} on ${c.label} is yellow or orange`);
    if (c.kind === 'text') {
      // Pink is never used for text.
      assert.ok(![P.coral, P.rose, P.roseTint].includes(c.color), `${where}: pink text on ${c.label}`);
      if (c.typing) {
        assert.strictEqual(c.color, P.ink, `${where}: a box people type in has near-black text (${c.label})`);
        assert.strictEqual(c.behind, P.white, `${where}: a box people type in is white (${c.label})`);
      } else if ([P.navy, P.panel, P.plum, P.rose].includes(c.behind)) {
        assert.strictEqual(c.color, P.white, `${where}: text on the dark background is white (${c.label} on ${c.behind})`);
      } else if (c.behind === P.coral) {
        assert.strictEqual(c.color, P.navy, `${where}: coral buttons have dark navy text (${c.label})`);
      } else {
        assert.ok([P.ink, P.inkSoft].includes(c.color), `${where}: text on a light background is near-black (${c.label}: ${c.color} on ${c.behind})`);
      }
    }
  }
}

function checkTitleCase(labels, where) {
  const small = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with']);
  for (const label of labels) {
    label.split(/[\s-]+/).forEach((word, i) => {
      const w = word.replace(/^[^A-Za-z]+/, '');
      if (!w || (i > 0 && small.has(w.toLowerCase()))) return;
      assert.ok(/^[A-Z]/.test(w), `${where}: "${label}" is not title case`);
    });
  }
}
const labelsOn = (page) => page.$$eval('h1, h2, button, label, .interim-label', (els) =>
  els.filter((e) => e.offsetParent !== null).filter((e) => !e.closest('.turn')).map((e) => e.textContent.trim()).filter(Boolean));

// ---------- Tests ----------

(async () => {
  const jfk = media.speech('jfk.wav');
  const ted = media.speech('ted_60.wav');
  const web = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch();

  try {
    console.log('Sign-in by email link');

    await test('signed out: only the sign-in screen; no tabs, no transcribing, no folder, nothing sent', async (page) => {
      await page.waitForSelector('#sign-in', { state: 'visible' });
      assert.strictEqual(await text(page, '#sign-in-heading'), 'Sign In');
      assert.strictEqual(await text(page, '#sign-in-button'), 'Sign In');
      for (const sel of ['.tabs', '#tab-live', '#tab-file', '#tab-folder', '#panel-live', '#live-toggle', '#file-choose', '#file-start',
        '#output', '#transcript', '#folder-list', '#account', '#sign-out', '#move-box']) {
        assert.ok(!(await visible(page, sel)), sel + ' is hidden until sign-in');
      }
      assert.strictEqual(await page.locator('input[type=password]').count(), 0, 'no passwords anywhere');
      // Even asked directly, the page will not call the functions or the folder without a sign-in.
      const codes = await page.evaluate(async () => {
        const out = [];
        for (const call of [() => window.CloudApi.checkLimit(), () => window.CloudApi.startJob('uploads/x.ogg', 5), () => window.CloudDb.list(), () => window.CloudDb.removeAll()]) {
          try { await call(); out.push('ok'); } catch (e) { out.push(e.code); }
        }
        await window.transcriberApp.file.start();
        return out;
      });
      assert.deepStrictEqual(codes, ['signIn', 'signIn', 'signIn', 'signIn']);
      assert.strictEqual(server.calls.length, 0, 'no Edge Function was called');
      assert.strictEqual(server.rest.length, 0);
      assert.strictEqual(server.tus.length, 0);
    }, { context: { as: null } });

    await test('the Edge Functions and storage refuse anyone who is not signed in, even with the page\'s key', async (page) => {
      const answers = await page.evaluate(async (key) => {
        const out = {};
        for (const fn of ['check-limit', 'start-job', 'job-status', 'job-result', 'delete-audio']) {
          const res = await fetch('https://mgiwopbaglgzxeaowzzt.supabase.co/functions/v1/' + fn, {
            method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key }, body: '{"jobId":"smjob1"}' });
          out[fn] = res.status + ' ' + (await res.json()).error;
        }
        const up = await fetch('https://mgiwopbaglgzxeaowzzt.supabase.co/storage/v1/upload/resumable', {
          method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Tus-Resumable': '1.0.0', 'Upload-Length': '10', 'Upload-Metadata': 'bucketName cmVjb3JkaW5ncw==' } });
        out.upload = up.status;
        return out;
      }, fake.PUBLISHABLE_KEY);
      assert.deepStrictEqual(answers, { 'check-limit': '401 signIn', 'start-job': '401 signIn', 'job-status': '401 signIn', 'job-result': '401 signIn',
        'delete-audio': '401 signIn', upload: 403 });
    }, { context: { as: null } });

    await test('an email that is not allowed: "This app isn\'t open to new users yet." and no email is sent', async (page) => {
      for (const email of ['someone@else.com', 'CHUVICAME@yahoo.com', 'chuvicame@gmail.com.evil.example']) {
        await page.fill('#sign-in-email', email);
        await page.click('#sign-in-button');
        await waitText(page, '#sign-in-status', /^This app isn’t open to new users yet\.$/);
        assert.strictEqual(await page.getAttribute('#sign-in-status', 'data-kind'), 'error');
        await page.fill('#sign-in-email', '');
        await page.evaluate(() => { document.getElementById('sign-in-status').textContent = ''; });
      }
      assert.strictEqual(server.otps.length, 0, 'no sign-in email was asked for');
      assert.ok(!(await visible(page, '.tabs')));
    }, { context: { as: null } });

    await test('...and the server refuses too, if someone skips the page\'s own check', async (page) => {
      const code = await page.evaluate(async () => {
        const { error } = await window.Auth.client.auth.signInWithOtp({ email: 'someone@else.com' });
        return error && error.message;
      });
      assert.match(code, /Database error saving new user/);
      assert.strictEqual(server.otps.length, 0);
    }, { context: { as: null } });

    await test('the allowed email gets a sign-in link that comes back to this page; opening it signs in', async (page) => {
      await page.fill('#sign-in-email', '  ChuVicame@Gmail.com ');
      await page.click('#sign-in-button');
      await waitText(page, '#sign-in-status', /^Check your email\. A sign-in link was sent to chuvicame@gmail\.com/);
      assert.strictEqual(server.otps.length, 1);
      assert.strictEqual(server.otps[0].email, 'chuvicame@gmail.com');
      assert.strictEqual(server.otps[0].redirectTo, ORIGIN + '/', 'the link returns to the app\'s own address (no index.html)');
      assert.ok(!(await visible(page, '.tabs')), 'not signed in until the link is opened');
      // Opening the link in the email lands back on the app with the sign-in attached.
      await page.goto('about:blank');
      await page.goto(fake.linkLanding(ORIGIN + '/', CHU));
      await page.waitForSelector('#tab-live', { state: 'visible' });
      assert.ok(!(await visible(page, '#sign-in')));
      assert.strictEqual(await text(page, '#account-email'), 'chuvicame@gmail.com');
      assert.strictEqual(await text(page, '#sign-out'), 'Sign Out');
      await page.waitForFunction(() => !location.hash.includes('access_token'));
      assert.ok(await visible(page, '#live-toggle') && await visible(page, '#tab-file') && await visible(page, '#tab-folder'));
    }, { context: { as: null } });

    await test('stays signed in after a reload and a closed tab, until Sign Out; then nothing is left on screen', async (page, context) => {
      await transcribe(page, jfk);
      await page.reload();
      await page.waitForSelector('#tab-live', { state: 'visible' });
      const again = await context.newPage();
      await again.goto(URL);
      await again.waitForSelector('#tab-live', { state: 'visible' });
      assert.strictEqual(await text(again, '#account-email'), 'chuvicame@gmail.com');
      await again.click('#tab-file');
      await again.waitForSelector('.turn');
      await again.close();
      // Sign Out.
      await page.click('#sign-out');
      await page.waitForSelector('#sign-in', { state: 'visible' });
      assert.match(await text(page, '#sign-in-status'), /signed out on this device/);
      assert.ok(!(await visible(page, '.tabs')) && !(await visible(page, '#output')) && !(await visible(page, '#account')));
      assert.deepStrictEqual(server.auth.filter((a) => a.what === 'logout').map((a) => a.scope), ['local'], 'this device only');
      assert.deepStrictEqual(await screenLines(page), [], 'the transcript is off the screen');
      await page.reload();
      await page.waitForSelector('#sign-in', { state: 'visible' });
      assert.ok(!(await visible(page, '.tabs')), 'still signed out after a reload');
      const calls = server.calls.length;
      assert.strictEqual(await page.evaluate(() => window.CloudApi.checkLimit().then(() => 'ok', (e) => e.code)), 'signIn');
      assert.strictEqual(server.calls.length, calls);
      // The transcript is still in My Transcripts for the next sign-in.
      assert.strictEqual(server.rows.length, 1);
    });

    await test('a sign-in link that expired says so, and a new one can be asked for', async (page) => {
      await page.goto('about:blank');
      await page.goto(ORIGIN + '/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
      await waitText(page, '#sign-in-status', /sign-in link has expired or was already used/);
      assert.ok(await visible(page, '#sign-in-button'));
      assert.ok(!(await page.evaluate(() => location.hash.includes('error'))), 'the address is tidied');
    }, { context: { as: null } });

    await test('sign-in problems in plain words: not an email, too many emails, not set up yet, no internet', async (page, context) => {
      const tryEmail = async (email, re) => {
        await page.fill('#sign-in-email', email);
        await page.click('#sign-in-button');
        await waitText(page, '#sign-in-status', re);
      };
      await tryEmail('chuvicame', /Please type your email address/);
      await tryEmail('', /Please type your email address/);
      server.emailRateLimited = true;
      await tryEmail('chuvicame@gmail.com', /Too many sign-in emails/);
      server.emailRateLimited = false;
      server.setupNotRun = true;
      await tryEmail('chuvicame@gmail.com', /Sign-in is not set up yet/);
      server.setupNotRun = false;
      await context.setOffline(true);
      await tryEmail('chuvicame@gmail.com', /No internet connection/);
      await context.setOffline(false);
      await tryEmail('chuvicame@gmail.com', /Check your email/);
      // Enter in the email box works like the button.
      await page.fill('#sign-in-email', 'chuvicame@gmail.com');
      await page.press('#sign-in-email', 'Enter');
      await page.waitForFunction(() => true);
      await waitText(page, '#sign-in-status', /Check your email/);
      assert.strictEqual(server.otps.length, 2);
    }, { context: { as: null } });

    await test('a signed-in person who is not on the list any more can do nothing', async (page) => {
      server.allowed.delete(CHU.email);
      await page.click('#tab-file');
      await chooseFile(page, jfk);
      await waitText(page, '#file-status', /^Ready/);
      await page.click('#file-start');
      await waitText(page, '#file-status', /This app isn’t open to new users yet/);
      assert.strictEqual(server.tus.length, 0, 'nothing uploaded');
      assert.strictEqual(server.jobs.size, 0, 'nothing sent to Speechmatics');
    }, { before: () => seed(CHU, 'Old item') });

    console.log('My Transcripts');

    await test('a finished transcript is in My Transcripts with its name, date, length, first line and its audio', async (page) => {
      await transcribe(page, jfk, saved('two-speakers'));
      assert.match(await text(page, '#file-status'), /saved in My Transcripts/);
      await openFolder(page);
      const list = await cards(page);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].name, 'jfk.wav');
      const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      assert.ok(list[0].meta.startsWith(today) && list[0].meta.endsWith('11 seconds'), list[0].meta);
      const built = F.buildTurns(saved('two-speakers'));
      assert.ok(list[0].line.startsWith('Speaker 1: ' + built.turns[0].text.slice(0, 30)), list[0].line);
      assert.strictEqual(await text(page, '#folder-count'), '1 Transcript');
      // The storage meter counts the compact audio that is kept.
      const bytes = [...server.objects.values()][0].length;
      assert.ok(bytes > 10000 && bytes < 44000, 'compact audio: ' + bytes);
      assert.match(await text(page, '#storage-text'), /^Using 0\.1 MB of 1 GB$/);
      assert.ok(!(await visible(page, '#output')), 'the list only, until an item is opened');
      for (const label of ['Open', 'Rename', 'Delete']) assert.ok(await visible(page, `.item button:text-is("${label}")`), label);
    });

    await test('the list is newest first, shows the storage used, and only this person\'s items', async (page) => {
      await openFolder(page);
      const list = await cards(page);
      assert.deepStrictEqual(list.map((c) => c.name), ['Newest.m4a', 'Middle.mp3', 'Oldest.wav']);
      assert.match(list[0].meta, /· 42 minutes$/);
      assert.match(list[1].meta, /· 1 hour 35 minutes$/);
      assert.match(list[2].meta, /· 3 minutes$/);
      assert.strictEqual(await text(page, '#folder-count'), '3 Transcripts');
      // 42 + 95 minutes of audio at 80,000 bytes a minute, plus the other person's 5 minutes = 11.36 MB in the bucket.
      assert.strictEqual(await text(page, '#storage-text'), 'Using 11 MB of 1 GB');
      const bar = await page.$eval('#storage-bar', (e) => e.value);
      assert.ok(bar > 1 && bar < 1.2, 'meter bar ' + bar);
      assert.ok(!(await page.evaluate(() => document.body.innerText.includes('Private'))), 'another person\'s item is not shown');
      // Asked directly, the database gives nothing of the other person's either.
      const got = await page.evaluate((id) => window.CloudDb.get(id), server.rows.find((r) => r.title === 'Private.wav').id);
      assert.strictEqual(got, null);
    }, { before: () => {
      seed(CHU, 'Oldest.wav', { hoursAgo: 200, minutes: 3, audio: false });
      seed(CHU, 'Newest.m4a', { hoursAgo: 1, minutes: 42 });
      seed(TESTER, 'Private.wav', { hoursAgo: 2, minutes: 5 });
      seed(CHU, 'Middle.mp3', { hoursAgo: 30, minutes: 95 });
    } });

    await test('the meter reads like "Using 120 MB of 1 GB"', async (page) => {
      const sizes = await page.evaluate(() => [0, 300000, 5 * 1048576, 120 * 1048576, 999 * 1048576, 1073741824, 1.2 * 1073741824].map((b) => window.Folder.size(b)));
      assert.deepStrictEqual(sizes, ['0 MB', '0.3 MB', '5.0 MB', '120 MB', '999 MB', '1 GB', '1.2 GB']);
      server.objects.set(`${CHU.id}/00000000-0000-4000-8000-000000000000.ogg`, Buffer.alloc(120 * 1048576));
      await openFolder(page);
      assert.strictEqual(await text(page, '#storage-text'), 'Using 120 MB of 1 GB');
    });

    await test('opening an item shows it exactly like a fresh transcript, and it plays from a timestamp', async (page) => {
      const result = B.build([
        { speaker: 'S1', at: 1.2, say: 'And so my fellow Americans,' },
        { speaker: 'S2', at: 6.4, say: 'Ask not what your country can do for you.' }
      ]);
      await transcribe(page, jfk, result);
      const fresh = await screenLines(page);
      const freshTools = await page.$$eval('#file-output .switch, #speaker-list button, .tools button:not([hidden])', (els) => els.map((e) => e.textContent.trim()));
      await page.reload();   // nothing chosen, as on another day
      await openFolder(page);
      await page.click('.item button:text-is("Open")');
      await page.waitForSelector('#folder-item-view', { state: 'visible' });
      assert.strictEqual(await text(page, '#item-name'), 'jfk.wav');
      assert.ok(await visible(page, '#output'));
      assert.strictEqual(await text(page, '#output-heading'), 'Saved Transcript');
      assert.deepStrictEqual(await screenLines(page), fresh);
      assert.deepStrictEqual(fresh, F.formatTranscript(F.buildTurns(result).turns, ['S1', 'S2'], {}, true).split('\n'));
      const tools = await page.$$eval('#file-output .switch, #speaker-list button, .tools button:not([hidden])', (els) => els.map((e) => e.textContent.trim()));
      assert.deepStrictEqual(tools, ['Show Timestamps', 'Show Fillers', 'Rename Speaker 1', 'Rename Speaker 2', 'Copy', 'Download Text File']);
      assert.deepStrictEqual(freshTools, [...tools, 'Clear'], 'the same tools as a fresh transcript (which can also be cleared from the screen)');
      assert.strictEqual(await text(page, '#word-count'), '14 Words');
      // Tap a time: the kept recording plays from that moment.
      await page.locator('.turn-time').nth(1).click();
      await page.waitForFunction(() => { const p = document.getElementById('item-player'); return !p.paused && p.currentTime >= 6.3 && p.currentTime < 9; }, null, { timeout: 8000 });
      assert.ok(await visible(page, '#item-player'));
      assert.strictEqual(await page.locator('.turn.is-playing').count(), 1);
      assert.strictEqual(server.signed.length, 1);
      await page.locator('.turn-time').nth(0).click();
      await page.waitForFunction(() => document.getElementById('item-player').currentTime < 3, null, { timeout: 8000 });
      assert.strictEqual(server.signed.length, 1, 'the same play link is used again');
      // Show Timestamps, Copy and Download work as on a fresh transcript.
      await page.uncheck('#file-timestamps', { force: true });
      const plain = F.formatTranscript(F.buildTurns(result).turns, ['S1', 'S2'], {}, false);
      assert.deepStrictEqual(await screenLines(page), plain.split('\n'));
      await page.click('#copy-button');
      assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), plain);
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-button')]);
      assert.match(download.suggestedFilename(), /^transcript-jfk-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.txt$/);
      assert.strictEqual(fs.readFileSync(await download.path(), 'utf8'), plain.replace(/\n/g, '\r\n') + '\r\n');
      // Back to the list.
      await page.click('#item-back');
      await page.waitForSelector('#folder-list .item');
      assert.ok(!(await visible(page, '#output')) && !(await visible(page, '#folder-item-view')));
    });

    await test('speaker renames and corrected words in an opened item are saved to the cloud', async (page, context) => {
      const row = server.rows[0];
      await openFolder(page);
      await page.click('.item button:text-is("Open")');
      await page.waitForSelector('.turn');
      await page.click('#speaker-list button:text-is("Rename Speaker 2")');
      await page.fill('#rename-input', 'Teacher');
      await page.click('#rename-save');
      await waitText(page, '#item-status', /Renamed\. Every turn by this speaker now says “Teacher”/);
      const first = page.locator('.turn-text').first();
      await first.click();
      await first.evaluate((e) => { e.textContent = 'Good morning, class.'; e.dispatchEvent(new InputEvent('input', { bubbles: true })); });
      await page.waitForFunction(() => true);
      await page.waitForTimeout(500);
      assert.deepStrictEqual(row.speaker_names, { S2: 'Teacher' });
      assert.strictEqual(row.turns[0].text, 'Good morning, class.');
      assert.strictEqual(row.first_line, 'Speaker 1: Good morning, class.');
      assert.strictEqual(row.title, 'Lesson.m4a', 'nothing else changed');
      // Another device (a fresh browser, signed in as the same person) shows the same.
      const other = await newContext();
      const page2 = await other.newPage();
      await page2.goto(URL);
      await openFolder(page2);
      assert.strictEqual((await cards(page2))[0].line, 'Speaker 1: Good morning, class.');
      await page2.click('.item button:text-is("Open")');
      await page2.waitForSelector('.turn');
      const lines = await screenLines(page2);
      assert.match(lines[0], /^1\. \[00:00:0\d – 00:00:\d\d\] Speaker 1: Good morning, class\.$/);
      assert.ok(lines.some((l) => / Teacher(?: \(overlap\))?: /.test(l)) && !lines.some((l) => /Speaker 2/.test(l)), lines.join(' | '));
      await other.close();
      void context;
    }, { before: () => seed(CHU, 'Lesson.m4a') });

    await test('rename an item, from the list and from the opened item', async (page) => {
      await openFolder(page);
      await page.click('.item button:text-is("Rename")');
      assert.strictEqual(await page.inputValue('.item-rename-input'), 'Lesson.m4a');
      await page.fill('.item-rename-input', '  Maths   lesson, Monday ');
      await page.click('.item button:text-is("Save Name")');
      await waitText(page, '#folder-status', /Renamed to “Maths lesson, Monday”/);
      assert.strictEqual((await cards(page))[0].name, 'Maths lesson, Monday');
      assert.strictEqual(server.rows[0].title, 'Maths lesson, Monday');
      assert.strictEqual(server.rows[0].file_name, 'Lesson.m4a', 'the file name is kept');
      // Cancel changes nothing; an empty name is not saved.
      await page.click('.item button:text-is("Rename")');
      await page.fill('.item-rename-input', 'Something else');
      await page.click('.item button:text-is("Cancel")');
      await page.click('.item button:text-is("Rename")');
      await page.fill('.item-rename-input', '   ');
      await page.press('.item-rename-input', 'Enter');
      assert.strictEqual(server.rows[0].title, 'Maths lesson, Monday');
      // From the opened item.
      await page.click('.item button:text-is("Open")');
      await page.waitForSelector('#item-rename', { state: 'visible' });
      await page.click('#item-rename');
      await page.fill('#item-rename-input', 'Monday Maths');
      await page.press('#item-rename-input', 'Enter');
      await waitText(page, '#item-name', /^Monday Maths$/);
      assert.strictEqual(server.rows[0].title, 'Monday Maths');
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-button')]);
      assert.match(download.suggestedFilename(), /^transcript-Monday-Maths-/);
      await page.click('#item-back');
      await page.waitForSelector('#folder-list .item');
      assert.strictEqual((await cards(page))[0].name, 'Monday Maths');
    }, { before: () => seed(CHU, 'Lesson.m4a') });

    await test('delete an item: "Keep It" keeps it; "Yes, Delete It" removes the transcript and its audio', async (page) => {
      const [keep, gone] = [server.rows[0], server.rows[1]];
      await openFolder(page);
      const card = page.locator('.item', { hasText: 'Delete me.mp3' });
      await card.locator('button:text-is("Delete")').click();
      assert.match(await card.locator('.confirm p').innerText(), /Delete “Delete me\.mp3”\? Its transcript and its recording will be removed.*cannot be undone/);
      assert.deepStrictEqual(await card.locator('.confirm button').allInnerTexts(), ['Yes, Delete It', 'Keep It']);
      await card.locator('button:text-is("Keep It")').click();
      assert.strictEqual(await card.locator('.confirm').count(), 0);
      assert.strictEqual(server.rows.length, 2);
      assert.ok(server.objects.has(gone.audio_path));
      await card.locator('button:text-is("Delete")').click();
      await card.locator('button:text-is("Yes, Delete It")').click();
      await waitText(page, '#folder-status', /Deleted “Delete me\.mp3” and its recording/);
      assert.deepStrictEqual((await cards(page)).map((c) => c.name), ['Keep me.mp3']);
      assert.deepStrictEqual(server.rows, [keep], 'the transcript is gone from the database');
      assert.ok(!server.objects.has(gone.audio_path), 'its audio is gone from storage');
      assert.ok(server.objects.has(keep.audio_path), 'the other item\'s audio is untouched');
      assert.strictEqual(await text(page, '#folder-count'), '1 Transcript');
      assert.match(await text(page, '#storage-text'), /^Using 0\.4 MB of 1 GB$/);
      // From the opened item, too.
      await page.click('.item button:text-is("Open")');
      await page.waitForSelector('#item-delete', { state: 'visible' });
      await page.click('#item-delete');
      await page.click('#item-delete-no');
      assert.strictEqual(server.rows.length, 1);
      await page.click('#item-delete');
      await page.click('#item-delete-yes');
      await waitText(page, '#folder-status', /No transcripts yet|Deleted/);
      assert.strictEqual(server.rows.length, 0);
      assert.strictEqual(server.objects.size, 0);
      assert.ok(!(await visible(page, '#output')) && !(await visible(page, '#folder-item-view')));
      assert.ok(!(await visible(page, '#folder-delete-all')), 'nothing left to delete');
    }, { before: () => { seed(CHU, 'Keep me.mp3', { hoursAgo: 5 }); seed(CHU, 'Delete me.mp3', { hoursAgo: 1 }); } });

    await test('Delete All needs the word DELETE typed, and removes every transcript and audio of this person only', async (page) => {
      const others = server.rows.filter((r) => r.user_id === TESTER.id);
      await openFolder(page);
      await page.click('#folder-delete-all');
      assert.match(await text(page, '#delete-all-text'), /deletes all 3 transcripts.*with their recordings.*cannot be undone/);
      assert.strictEqual(await text(page, '#delete-all-label'), 'Type DELETE to Confirm');
      assert.ok(await page.isDisabled('#delete-all-yes'));
      for (const wrong of ['delete', 'DELET', 'DELETE ALL', 'yes']) {
        await page.fill('#delete-all-input', wrong);
        assert.ok(await page.isDisabled('#delete-all-yes'), wrong);
        await page.press('#delete-all-input', 'Enter');
      }
      assert.strictEqual(server.rows.length, 4, 'nothing deleted yet');
      await page.click('#delete-all-no');
      assert.ok(!(await visible(page, '#delete-all-box')));
      assert.strictEqual(server.rows.length, 4);
      await page.click('#folder-delete-all');
      assert.strictEqual(await page.inputValue('#delete-all-input'), '', 'the word must be typed again');
      await page.fill('#delete-all-input', 'DELETE');
      assert.ok(await page.isEnabled('#delete-all-yes'));
      await page.click('#delete-all-yes');
      await waitText(page, '#folder-status', /Deleted 3 transcripts and their recordings\. My Transcripts is empty\./);
      assert.deepStrictEqual(await cards(page), []);
      assert.deepStrictEqual(server.rows, others, 'only this person\'s transcripts');
      assert.deepStrictEqual([...server.objects.keys()], [others[0].audio_path], 'only this person\'s audio');
      assert.strictEqual(await text(page, '#folder-count'), '0 Transcripts');
      assert.ok(!(await visible(page, '#folder-delete-all')));
    }, { before: () => {
      seed(CHU, 'One.mp3'); seed(CHU, 'Two.mp3', { audio: false }); seed(TESTER, 'Theirs.mp3'); seed(CHU, 'Three.mp3');
    } });

    await test('deleting an item also clears it from the File tab on this device, so the file can be transcribed afresh', async (page) => {
      await transcribe(page, jfk);
      await openFolder(page);
      await page.click('.item button:text-is("Delete")');
      await page.click('.item button:text-is("Yes, Delete It")');
      await waitText(page, '#folder-status', /Deleted/);
      await page.click('#tab-file');
      assert.deepStrictEqual(await screenLines(page), []);
      await chooseFile(page, jfk);
      await waitText(page, '#file-status', /^Ready/);
      assert.strictEqual(await text(page, '#file-start-label'), 'Start Transcribing');
    });

    await test('the same folder appears when signing in on another device', async (page) => {
      await transcribe(page, jfk, saved('three-speakers'));
      const other = await browser.newContext({ ...devices['Desktop Chrome'] });   // a computer, never used before
      await other.route(fake.SUPABASE + '/**', fakeSupabase);
      const page2 = await other.newPage();
      await page2.goto(fake.linkLanding(ORIGIN + '/', CHU));                      // signs in with the email link
      await page2.waitForSelector('#tab-folder', { state: 'visible' });
      await openFolder(page2);
      const list = await cards(page2);
      assert.deepStrictEqual(list.map((c) => c.name), ['jfk.wav', 'From my phone.m4a']);
      await page2.click('.item button:text-is("Open")');
      await page2.waitForSelector('.turn');
      const built = F.buildTurns(saved('three-speakers'));
      assert.deepStrictEqual(await screenLines(page2), F.formatTranscript(built.turns, built.speakers, {}, true).split('\n'));
      await page2.locator('.turn-time').first().click();
      await page2.waitForFunction(() => !document.getElementById('item-player').paused, null, { timeout: 8000 });
      await other.close();
    }, { before: () => seed(CHU, 'From my phone.m4a', { hoursAgo: 50 }) });

    await test('transcripts saved in this browser by the earlier version: offered once, and moved into My Transcripts', async (page) => {
      // Two transcripts as TR Session C left them on this device (no owner, audio already deleted).
      await firstCheckDone(page);
      const put = (extra) => page.evaluate(async (jobs) => {
        localStorage.removeItem('transcriber.moveOffered');
        for (const j of jobs) await window.CloudStore.putJob(j);
      }, extra);
      const a = F.buildTurns(saved('two-speakers')), b = F.buildTurns(saved('three-speakers'));
      await put([
        { key: 'f:100:aaaa', name: 'Old interview.m4a', size: 100, duration: 754, stage: 'done', done: true, turns: a.turns, speakers: a.speakers,
          names: { S1: 'Maria' }, jobId: 'oldjob1', audioDeleted: true, createdAt: Date.parse('2026-11-11T02:00:00Z'), doneAt: Date.parse('2026-11-11T02:10:00Z') },
        { key: 'f:200:bbbb', name: 'Old meeting.mp3', size: 200, duration: 60, stage: 'done', done: true, turns: b.turns, speakers: b.speakers,
          names: {}, jobId: 'oldjob2', audioDeleted: true, createdAt: Date.parse('2026-11-11T03:00:00Z'), doneAt: Date.parse('2026-11-11T03:05:00Z') },
        { key: 'f:300:cccc', name: 'Unfinished.mp3', size: 300, duration: 60, stage: 'uploading', createdAt: Date.now() }
      ]);
      await page.reload();
      await page.waitForSelector('#move-box', { state: 'visible' });
      assert.match(await text(page, '#move-text'), /This device has 2 transcripts saved from before you signed in\. Move them into My Transcripts/);
      assert.deepStrictEqual(await page.$$eval('#move-box button', (els) => els.filter((e) => !e.hidden).map((e) => e.textContent)), ['Move Them', 'Not Now']);
      assert.strictEqual(server.rows.length, 0, 'nothing moves until asked');
      await page.click('#move-yes');
      await waitText(page, '#move-text', /^Moved 2 transcripts into My Transcripts\.$/);
      assert.deepStrictEqual(server.rows.map((r) => [r.title, r.audio_path, r.duration_seconds, r.user_id, r.created_at]), [
        ['Old interview.m4a', null, 754, CHU.id, '2026-11-11T02:10:00.000Z'],
        ['Old meeting.mp3', null, 60, CHU.id, '2026-11-11T03:05:00.000Z']
      ]);
      assert.deepStrictEqual(server.rows[0].turns, a.turns);
      assert.deepStrictEqual(server.rows[0].speaker_names, { S1: 'Maria' }, 'speaker names come along');
      await page.click('#move-no');   // now labelled Close
      await openFolder(page);
      assert.deepStrictEqual((await cards(page)).map((c) => c.name), ['Old meeting.mp3', 'Old interview.m4a']);
      // It opens like any other; with no recording, tapping a time says so.
      await page.locator('.item', { hasText: 'Old interview' }).locator('button:text-is("Open")').click();
      await page.waitForSelector('.turn');
      assert.match((await screenLines(page))[0], /Maria: /);
      await page.locator('.turn-time').first().click();
      await waitText(page, '#item-status', /has no saved recording/);
      // Never offered again, and nothing is moved twice.
      await page.reload();
      await page.waitForSelector('#tab-live', { state: 'visible' });
      await page.waitForTimeout(400);
      assert.ok(!(await visible(page, '#move-box')));
      assert.strictEqual(server.rows.length, 2);
    });

    await test('...and "Not Now" is remembered: it is not offered again, and the transcripts stay on the device', async (page) => {
      const a = F.buildTurns(saved('two-speakers'));
      await firstCheckDone(page);
      await page.evaluate(async (job) => { localStorage.removeItem('transcriber.moveOffered'); await window.CloudStore.putJob(job); },
        { key: 'f:100:aaaa', name: 'Old interview.m4a', size: 100, duration: 754, stage: 'done', done: true, turns: a.turns, speakers: a.speakers, names: {}, jobId: 'oldjob1' });
      await page.reload();
      await page.waitForSelector('#move-box', { state: 'visible' });
      assert.match(await text(page, '#move-text'), /This device has 1 transcript saved from before you signed in\. Move it into/);
      await page.click('#move-no');
      assert.ok(!(await visible(page, '#move-box')));
      await page.reload();
      await page.waitForSelector('#tab-live', { state: 'visible' });
      await page.waitForTimeout(400);
      assert.ok(!(await visible(page, '#move-box')), 'offered once only');
      assert.strictEqual(server.rows.length, 0);
      assert.strictEqual(await page.evaluate(async () => (await window.CloudStore.getJob('f:100:aaaa')).turns.length), a.turns.length, 'still on the device');
    });

    await test('a device with nothing saved from before is never asked', async (page) => {
      await page.waitForSelector('#tab-live', { state: 'visible' });
      await page.waitForTimeout(400);
      assert.ok(!(await visible(page, '#move-box')));
      await transcribe(page, jfk);
      await page.reload();
      await page.waitForSelector('#tab-live', { state: 'visible' });
      await page.waitForTimeout(400);
      assert.ok(!(await visible(page, '#move-box')), 'a transcript made after signing in is already in the folder');
    });

    await test('no internet when a transcript finishes: it is kept on the device and saved to My Transcripts later by itself', async (page) => {
      await page.click('#tab-file');
      await chooseFile(page, jfk);
      await waitText(page, '#file-status', /^Ready/);
      server.dbDown = true;
      await page.click('#file-start');
      await waitText(page, '#file-status', /^Done\. Transcribed 11 seconds of audio\. It could not be saved to My Transcripts yet/, 90000);
      assert.strictEqual(server.rows.length, 0);
      assert.ok((await screenLines(page)).length > 0, 'the transcript is on screen meanwhile');
      assert.strictEqual(server.objects.size, 1, 'the audio is kept');
      server.dbDown = false;
      await page.reload();
      await page.waitForFunction(() => true);
      const until = Date.now() + 8000;
      while (!server.rows.length && Date.now() < until) await page.waitForTimeout(100);
      assert.strictEqual(server.rows.length, 1, 'saved after reopening');
      assert.strictEqual(server.rows[0].audio_path, [...server.objects.keys()][0]);
      assert.strictEqual(fnCalls('start-job').length, 1, 'not sent to Speechmatics again');
      await page.reload();
      await page.waitForTimeout(600);
      assert.strictEqual(server.rows.length, 1, 'and only once');
    });

    await test('My Transcripts problems in plain words: no internet, not set up yet; Refresh tries again', async (page, context) => {
      server.setupNotRun = true;
      await page.click('#tab-folder');
      await waitText(page, '#folder-status', /My Transcripts is not set up yet/);
      server.setupNotRun = false;
      server.dbDown = true;                 // the server cannot be reached
      await page.click('#folder-refresh');
      await waitText(page, '#folder-status', /Could not reach My Transcripts/);
      await context.setOffline(true);       // and now the device itself is offline
      await page.click('#folder-refresh');
      await waitText(page, '#folder-status', /No internet connection/);
      await context.setOffline(false);
      server.dbDown = false;
      await page.click('#folder-refresh');
      await page.waitForSelector('#folder-list .item');
      assert.strictEqual(await text(page, '#folder-status'), '');
      // A delete that cannot reach the server deletes nothing and says so.
      server.dbDown = true;
      await page.click('.item button:text-is("Delete")');
      await page.click('.item button:text-is("Yes, Delete It")');
      await waitText(page, '#folder-status', /^Not deleted\./);
      assert.strictEqual((await cards(page)).length, 1);
      server.dbDown = false;
    }, { before: () => seed(CHU, 'Item.mp3') });

    await test('an empty folder says how to fill it', async (page) => {
      await openFolder(page);
      assert.match(await text(page, '#folder-status'), /No transcripts yet\. Transcribe a recording in the File tab/);
      assert.strictEqual(await text(page, '#storage-text'), 'Using 0 MB of 1 GB');
      assert.ok(!(await visible(page, '#folder-delete-all')));
    });

    console.log('Show Fillers');

    await test('Show Fillers sits next to Show Timestamps and works at once, without transcribing again', async (page) => {
      await transcribe(page, jfk, B.build(FILLER_SCRIPT));
      const a = await page.locator('label.switch:has(#file-timestamps)').boundingBox();
      const b = await page.locator('label.switch:has(#file-fillers)').boundingBox();
      assert.ok(Math.abs(b.y - (a.y + a.height)) < 12 || Math.abs(a.y - b.y) < 4, 'the two switches are together');
      assert.ok(await page.isChecked('#file-fillers'), 'on to begin with: everything is shown');
      assert.deepStrictEqual(await screenLines(page), FILLERS_ON);
      assert.strictEqual(await text(page, '#word-count'), '26 Words');
      const before = { calls: server.calls.length, tus: server.tus.length, jobs: server.jobs.size, rest: server.rest.length };
      const t0 = Date.now();
      await page.uncheck('#file-fillers', { force: true });
      assert.deepStrictEqual(await screenLines(page), FILLERS_OFF);
      assert.ok(Date.now() - t0 < 1500, 'instant');
      assert.strictEqual(await text(page, '#word-count'), noTimes(FILLERS_OFF).join(' ').replace(/\d\. Speaker \d(?: \(overlap\))?: /g, '').split(/\s+/).length + ' Words');
      // The hesitation-only turns are gone and the numbers closed up; yes sounds kept their own turns.
      assert.deepStrictEqual(await page.$$eval('.turn-n', (els) => els.map((e) => e.textContent.trim())), ['1.', '2.', '3.', '4.', '5.']);
      await page.check('#file-fillers', { force: true });
      assert.deepStrictEqual(await screenLines(page), FILLERS_ON, 'back on: everything returns');
      assert.deepStrictEqual({ calls: server.calls.length, tus: server.tus.length, jobs: server.jobs.size, rest: server.rest.length }, before, 'nothing was sent anywhere');
      assert.deepStrictEqual(server.rows[0].turns.map((t) => t.text), F.buildTurns(B.build(FILLER_SCRIPT)).turns.map((t) => t.text), 'the saved transcript keeps every word');
    });

    await test('Copy and Download follow whichever view is showing (fillers and timestamps, in every combination)', async (page) => {
      await transcribe(page, jfk, B.build(FILLER_SCRIPT));
      for (const [fillers, times] of [[true, true], [false, true], [false, false], [true, false]]) {
        await page.setChecked('#file-fillers', fillers, { force: true });
        await page.setChecked('#file-timestamps', times, { force: true });
        let want = fillers ? FILLERS_ON : FILLERS_OFF;
        if (!times) want = noTimes(want);
        assert.deepStrictEqual(await screenLines(page), want);
        await page.click('#copy-button');
        assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), want.join('\n'), `copy with fillers ${fillers}, times ${times}`);
        const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-button')]);
        assert.strictEqual(fs.readFileSync(await download.path(), 'utf8'), want.join('\r\n') + '\r\n', `download with fillers ${fillers}, times ${times}`);
      }
    });

    await test('the choice is remembered, and works the same in an item opened from My Transcripts', async (page) => {
      await openFolder(page);
      await page.click('.item button:text-is("Open")');
      await page.waitForSelector('.turn');
      assert.deepStrictEqual(await screenLines(page), FILLERS_ON);
      await page.uncheck('#file-fillers', { force: true });
      assert.deepStrictEqual(await screenLines(page), FILLERS_OFF);
      await page.click('#copy-button');
      assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), FILLERS_OFF.join('\n'));
      await page.reload();
      await openFolder(page);
      await page.click('.item button:text-is("Open")');
      await page.waitForSelector('.turn');
      assert.ok(!(await page.isChecked('#file-fillers')), 'still off after a reload');
      assert.deepStrictEqual(await screenLines(page), FILLERS_OFF);
      // Tapping a time in the shorter view still plays the right moment (turn 3 on screen starts at 8 seconds).
      assert.strictEqual(await page.locator('.turn-time').nth(2).getAttribute('data-start'), '8');
      // Renaming a speaker works in this view and the hidden turns come back untouched.
      await page.click('#speaker-list button:text-is("Rename Speaker 1")');
      await page.fill('#rename-input', 'Chu');
      await page.click('#rename-save');
      assert.match((await screenLines(page))[0], /^1\. \[[^\]]+\] Chu: So I wanted to ask/);
      await page.check('#file-fillers', { force: true });
      assert.deepStrictEqual(await screenLines(page), FILLERS_ON.map((l) => l.replace(/Speaker 1/, 'Chu')));
    }, { before: () => seed(CHU, 'Fillers.mp3', { result: B.build(FILLER_SCRIPT) }) });

    await test('correcting a word while fillers are hidden changes that turn only; hidden turns are untouched', async (page) => {
      await openFolder(page);
      await page.click('.item button:text-is("Open")');
      await page.waitForSelector('.turn');
      await page.uncheck('#file-fillers', { force: true });
      // On screen, turn 3 is "Is Monday okay?" (the saved list's 4th turn).
      const third = page.locator('.turn-text').nth(2);
      await third.evaluate((e) => { e.textContent = 'Is Friday okay?'; e.dispatchEvent(new InputEvent('input', { bubbles: true })); });
      await page.waitForTimeout(500);
      const texts = server.rows[0].turns.map((t) => t.text);
      assert.deepStrictEqual(texts, ['Um, so I I wanted to ask about the, uh, schedule for next week.', 'Mhm.', 'Um.', 'Is Friday okay?', 'Uh-huh.', 'Hmm.', 'Er, Tuesday is is better.']);
      await page.check('#file-fillers', { force: true });
      assert.deepStrictEqual(await screenLines(page), FILLERS_ON.map((l) => l.replace('Is Monday okay?', 'Is Friday okay?')));
    }, { before: () => seed(CHU, 'Fillers.mp3', { result: B.build(FILLER_SCRIPT) }) });

    await test('a transcript of only hesitations shows nothing with the switch off, and all of it with the switch on', async (page) => {
      await openFolder(page);
      await page.click('.item button:text-is("Open")');
      await page.waitForSelector('.turn');
      assert.strictEqual((await screenLines(page)).length, 3);
      await page.uncheck('#file-fillers', { force: true });
      assert.deepStrictEqual(await screenLines(page), []);
      assert.strictEqual(await text(page, '#word-count'), '0 Words');
      assert.ok(await page.isDisabled('#copy-button') && await page.isDisabled('#download-button'));
      await page.check('#file-fillers', { force: true });
      assert.strictEqual((await screenLines(page)).length, 3);
    }, { before: () => seed(CHU, 'Hesitations.mp3', { result: B.build([
      { speaker: 'S1', at: 1, say: 'Um.' }, { speaker: 'S2', at: 3, say: 'Uh, er.' }, { speaker: 'S1', at: 6, say: 'Hmm, erm.' }]) }) });

    console.log('Sunset colors and title case, on every screen');

    await test('the sign-in screen', async (page) => {
      await page.waitForSelector('#sign-in', { state: 'visible' });
      checkColors(await collectColors(page), 'sign-in');
      await page.fill('#sign-in-email', 'someone@else.com');
      await page.click('#sign-in-button');
      await waitText(page, '#sign-in-status', /isn’t open/);
      checkColors(await collectColors(page), 'sign-in, refused');
      checkTitleCase(await labelsOn(page), 'sign-in');
      const look = await page.$eval('#sign-in-button', (e) => { const c = getComputedStyle(e); return [c.backgroundColor, c.color, c.boxShadow !== 'none']; });
      assert.deepStrictEqual(look, [PALETTE.coral, PALETTE.navy, true], 'Sign In: coral, dark navy text, a shadow');
      const box = await page.$eval('#sign-in-email', (e) => { const c = getComputedStyle(e); return [c.backgroundColor, c.color]; });
      assert.deepStrictEqual(box, [PALETTE.white, PALETTE.ink], 'the email box is white with near-black text');
      assert.strictEqual(await page.$eval('body', (e) => getComputedStyle(e).backgroundColor), PALETTE.navy);
      assert.strictEqual(await page.getAttribute('meta[name=theme-color]', 'content'), '#2B3A51');
    }, { context: { as: null } });

    await test('the Live tab, the File tab with a transcript, renaming, and confirm boxes', async (page) => {
      checkColors(await collectColors(page), 'live');
      checkTitleCase(await labelsOn(page), 'live');
      const start = await page.$eval('#live-toggle', (e) => { const c = getComputedStyle(e); return [c.backgroundColor, c.color, c.boxShadow !== 'none']; });
      assert.deepStrictEqual(start, [PALETTE.coral, PALETTE.navy, true], 'Start Listening: coral, dark navy text, a shadow');
      const tab = await page.$eval('#tab-live', (e) => getComputedStyle(e).backgroundColor);
      assert.strictEqual(tab, PALETTE.rose, 'the selected tab is rose');
      assert.strictEqual(await page.$eval('#tab-file', (e) => getComputedStyle(e).backgroundColor), PALETTE.panel);
      assert.deepStrictEqual(await page.$eval('#transcript', (e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]), [PALETTE.white, PALETTE.ink]);
      await page.fill('#transcript', 'Some words to clear.');
      await page.click('#clear-button');
      checkColors(await collectColors(page), 'live, clear confirm');
      checkTitleCase(await labelsOn(page), 'live, clear confirm');
      await page.click('#clear-no');

      await page.click('#tab-file');
      checkColors(await collectColors(page), 'file, empty');
      await chooseFile(page, jfk);
      await waitText(page, '#file-status', /^Ready/);
      checkColors(await collectColors(page), 'file, chosen');
      const go = await page.$eval('#file-start', (e) => { const c = getComputedStyle(e); return [c.backgroundColor, c.color, c.boxShadow !== 'none']; });
      assert.deepStrictEqual(go, [PALETTE.coral, PALETTE.navy, true], 'Start Transcribing: coral, dark navy text, a shadow');
      server.result = saved('many-overlaps');
      await page.click('#file-start');
      await waitText(page, '#file-status', /^Done/, 90000);
      checkColors(await collectColors(page), 'file, transcript');
      checkTitleCase(await labelsOn(page), 'file, transcript');
      const tag = await page.$eval('.turn-overlap', (e) => { const c = getComputedStyle(e); return [c.borderTopColor, c.color]; });
      assert.deepStrictEqual(tag, [PALETTE.rose, PALETTE.ink], 'the (overlap) tag is outlined in rose, its words near-black');
      assert.deepStrictEqual(await page.$eval('#file-transcript', (e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]), [PALETTE.white, PALETTE.ink]);
      for (const sel of ['#copy-button', '#download-button', '#clear-button', '#speaker-list button', '#sign-out']) {
        assert.deepStrictEqual(await page.$eval(sel, (e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]), [PALETTE.plum, PALETTE.white], sel + ' is plum with white text');
      }
      assert.strictEqual(await page.$eval('#file-timestamps + .switch-track', (e) => getComputedStyle(e).backgroundColor), PALETTE.rose, 'a switch that is on is rose');
      await page.click('.turn-speaker');
      checkColors(await collectColors(page), 'file, rename box');
      assert.deepStrictEqual(await page.$eval('#rename-input', (e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]), [PALETTE.white, PALETTE.ink]);
      await page.click('#rename-cancel');
      await page.locator('.turn-text').first().click();
      checkColors(await collectColors(page), 'file, editing a turn');
      await chooseFile(page, ted);
      await page.waitForSelector('#file-replace', { state: 'visible' });
      checkColors(await collectColors(page), 'file, replace confirm');
      checkTitleCase(await labelsOn(page), 'file, replace confirm');
      // A problem message is white too (no red, orange or yellow).
      await page.click('#file-replace-no');
      const notes = path.join(media.DIR, 'notes.txt');
      fs.writeFileSync(notes, 'not a recording');
      await chooseFile(page, notes);
      await waitText(page, '#file-status', /not supported/);
      checkColors(await collectColors(page), 'file, error message');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, 'sideways scroll ' + overflow);
    });

    await test('My Transcripts: the list, rename and delete boxes, Delete All, an opened item, and the move offer', async (page) => {
      const a = F.buildTurns(saved('two-speakers'));
      await firstCheckDone(page);
      await page.evaluate(async (job) => { localStorage.removeItem('transcriber.moveOffered'); await window.CloudStore.putJob(job); },
        { key: 'f:100:aaaa', name: 'Old.m4a', size: 100, duration: 60, stage: 'done', done: true, turns: a.turns, speakers: a.speakers, names: {} });
      await page.reload();
      await page.waitForSelector('#move-box', { state: 'visible' });
      await openFolder(page);
      checkColors(await collectColors(page), 'folder, list with the move offer');
      checkTitleCase(await labelsOn(page), 'folder, list');
      assert.strictEqual(await page.$eval('#tab-folder', (e) => getComputedStyle(e).backgroundColor), PALETTE.rose);
      await page.locator('.item').nth(0).locator('button:text-is("Rename")').click();
      await page.locator('.item').nth(1).locator('button:text-is("Delete")').click();
      await page.click('#folder-delete-all');
      await page.fill('#delete-all-input', 'DELETE');
      checkColors(await collectColors(page), 'folder, boxes open');
      checkTitleCase(await labelsOn(page), 'folder, boxes open');
      for (const sel of ['.item-rename-input', '#delete-all-input']) {
        assert.deepStrictEqual(await page.$eval(sel, (e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]), [PALETTE.white, PALETTE.ink], sel);
      }
      for (const label of ['Open', 'Rename', 'Delete', 'Yes, Delete It', 'Keep It', 'Delete All', 'Refresh', 'Yes, Delete Everything', 'Save Name']) {
        const look = await page.locator(`#panel-folder button:text-is("${label}")`).first().evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e).color]);
        assert.deepStrictEqual(look, [PALETTE.plum, PALETTE.white], label + ' is plum with white text');
      }
      await page.click('#delete-all-no');
      await page.locator('.item').nth(0).locator('button:text-is("Open")').click();
      await page.waitForSelector('.turn');
      await page.click('#item-rename');
      checkColors(await collectColors(page), 'folder, opened item');
      checkTitleCase(await labelsOn(page), 'folder, opened item');
      await page.click('#item-rename-cancel');
      await page.click('#item-delete');
      checkColors(await collectColors(page), 'folder, opened item, delete box');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, 'sideways scroll ' + overflow);
    }, { before: () => { seed(CHU, 'One.mp3', { result: saved('many-overlaps') }); seed(CHU, 'Two.mp3', { hoursAgo: 9 }); } });

    await test('no yellow, orange or pink text anywhere in the stylesheet either', async () => {
      const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const hexes = [...new Set((css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toUpperCase()))];
      assert.deepStrictEqual(hexes.sort(), ['#1B1F27', '#2B3A51', '#355C7D', '#5B6474', '#725A7A', '#C56C86', '#F3DDE4', '#FF7582', '#FFFFFF'].sort(),
        'only the Sunset palette (plus near-black for typing, its soft form for hints inside white boxes, and a light rose for highlights there)');
      assert.ok(!/\b(yellow|orange|gold|amber|pink|red|green|blue)\b/i.test(css.replace(/--[\w-]+/g, '')), 'no named colours');
      for (const m of css.matchAll(/(?:^|[;{\s])color:\s*([^;}]+)/g)) {
        assert.ok(!/--(coral|rose|rose-tint)\b/.test(m[1]), 'text colour ' + m[1] + ' is pink');
      }
    });
  } finally {
    await browser.close();
    web.kill();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
