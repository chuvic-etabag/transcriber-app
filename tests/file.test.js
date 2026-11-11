/*
 * Browser tests for the File tab with Speechmatics (file.js) and the output
 * tools, in Chromium. Supabase (sign-in, resumable uploads, the database and
 * the Edge Functions) is played by tests/fake-supabase.js, and "Speechmatics"
 * answers with made-up results in its exact json-v2 format (tests/fixtures/).
 * Every test starts signed in as the allowed person. Run from the repo root:
 *
 *   node tests/file.test.js
 *
 * Needs Python 3, ffmpeg, curl and Playwright with Chromium. The first run
 * downloads a few short speech recordings into a cache folder.
 */
'use strict';
const { chromium, devices } = require('playwright');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const media = require('./media');
const F = require('../transcript-format.js');
const B = require('./fixtures/speechmatics-builder.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8768;
const ORIGIN = `http://localhost:${PORT}`;
const URL = `${ORIGIN}/index.html`;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const fake = require('./fake-supabase');
const SUPABASE = fake.SUPABASE;
const saved = fake.saved;

// ---------- Test media ----------

function testFiles() {
  const jfk = media.speech('jfk.wav');
  const ted = media.speech('ted_60.wav');
  const f = {
    jfk,
    ted,
    mp3: media.make('jfk.mp3', jfk, ['-c:a', 'libmp3lame', '-b:a', '64k']),
    courtroom: media.speech('courtroom.mp4'),
    // 40 minutes of speech: its compact audio (about 7 MB) needs two 6 MB upload pieces.
    long: path.join(media.DIR, 'speech-40min.mp3')
  };
  if (!fs.existsSync(f.long)) {
    media.ff(['-stream_loop', '-1', '-i', ted, '-t', '2400', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', f.long]);
  }
  f.text = path.join(media.DIR, 'notes.txt');
  fs.writeFileSync(f.text, 'These are notes, not a recording.\n');
  return f;
}

// ---------- A pretend Supabase + Speechmatics (tests/fake-supabase.js) ----------

let server = fake.freshServer();
const freshServer = fake.freshServer;
const fnCalls = (fn) => server.calls.filter((c) => c.fn === fn);
const fakeSupabase = fake.makeRoute(() => server, ORIGIN);

// A pretend Screen Wake Lock (the File tab keeps the screen on while it prepares and uploads).
const WAKE_LOCK = `
  window.__wake = { requests: 0, held: null };
  Object.defineProperty(navigator, 'wakeLock', { value: {
    request: () => {
      window.__wake.requests++;
      const lock = { released: false, addEventListener: () => {}, release: () => { lock.released = true; window.__wake.held = null; return Promise.resolve(); } };
      window.__wake.held = lock;
      return Promise.resolve(lock);
    }
  }});
`;
// Quick waits, so the tests don't sit through real pauses between checks.
const QUICK = `
  window.addEventListener('DOMContentLoaded', () => {
    if (window.FileTab) Object.assign(window.FileTab.TIMING, { pollFirst: 150, poll: 150, pollSlow: 150, retry: 150, busy: 150, sync: 150 });
    if (window.Folder) Object.assign(window.Folder.TIMING, { sync: 150 });
    if (window.ResumableUpload) window.ResumableUpload.WAITS.splice(0, 99, 100, 150, 200, 250, 300, 300);
  });
`;

// ---------- Helpers ----------

let passed = 0;
const failures = [];
let browser;

async function newContext(opts = {}) {
  const context = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, ...opts });
  await context.addInitScript(WAKE_LOCK);
  await context.addInitScript(QUICK);
  // Signed in as the allowed person, as if they had signed in on this device before.
  if (!opts.signedOut) await context.addInitScript(fake.signedInScript(fake.CHU));
  await context.route(SUPABASE + '/**', fakeSupabase);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  return context;
}

async function test(name, fn, { context: makeContext } = {}) {
  if (ONLY && !name.includes(ONLY)) return;
  server = freshServer();
  const context = makeContext ? await makeContext() : await newContext();
  const page = context.pages()[0] || await context.newPage();
  const errors = [];
  const requests = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('request', (r) => requests.push(r.url()));
  };
  watch(page);
  context.on('page', watch);
  const started = Date.now();
  try {
    await page.goto(URL);
    await fn(page, context, requests);
    assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join('; '));
    passed++;
    console.log(`  ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n       '));
    try { console.log('       status: ' + await page.locator('#file-status').innerText()); } catch (x) { /* ignore */ }
  } finally {
    await context.close().catch(() => {});
  }
}

const text = (page, sel) => page.locator(sel).innerText();
const status = (page) => text(page, '#file-status');

async function openFileTab(page) { await page.click('#tab-file'); }

async function chooseFile(page, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#file-choose')]);
  await chooser.setFiles(file);
}

async function waitStatus(page, re, timeout = 60000) {
  await page.waitForFunction((src) => new RegExp(src, 'i').test(document.getElementById('file-status').textContent),
    re.source, { timeout, polling: 50 });
}

/** The transcript as it reads on screen, one turn per line. */
async function screenLines(page) {
  return page.$$eval('#file-transcript .turn', (ps) => ps.map((p) => p.textContent));
}

async function transcribe(page, file, opts = {}) {
  if (opts.result) server.result = opts.result;
  await openFileTab(page);
  await chooseFile(page, file);
  await waitStatus(page, /Ready/);
  await page.click('#file-start');
  await waitStatus(page, /^Done/, opts.timeout || 90000);
}

const expectedText = (result, names = {}, times = true) => {
  const r = F.buildTurns(result);
  return F.formatTranscript(r.turns, r.speakers, names, times);
};

// ---------- Tests ----------

(async () => {
  const files = testFiles();
  const web = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch();

  try {
    console.log('English only, Whisper hidden');

    await test('no language pickers, no Auto-Detect, no Filipino, no Whisper anywhere on the screen', async (page, context, requests) => {
      assert.strictEqual(await page.locator('select').count(), 0, 'no pickers at all');
      for (const tab of ['#tab-live', '#tab-file']) {
        await page.click(tab);
        const all = await page.evaluate(() => document.body.innerText);
        for (const word of ['Filipino', 'Tagalog', 'Auto-Detect', 'Whisper', 'Language', 'Fast', 'Accurate', 'English (Philippines)']) {
          assert.ok(!all.includes(word), `"${word}" is on the ${tab} screen`);
        }
      }
      assert.ok(!requests.some((u) => /whisper|transformers|job-store/.test(u)), 'Whisper code is not loaded');
      assert.ok(fs.existsSync(path.join(ROOT, 'whisper-file.js')) && fs.existsSync(path.join(ROOT, 'whisper-worker.js')), 'but kept in the repository');
    });

    await test('headings and buttons are in title case, and nothing scrolls sideways', async (page) => {
      server.result = saved('three-speakers');
      await transcribe(page, files.jfk);
      const labels = await page.$$eval('h1, h2, button, label, .interim-label', (els) =>
        els.filter((e) => e.offsetParent !== null || e.closest('#rename-box'))
          .filter((e) => !e.classList.contains('turn-time') && !e.closest('.turn'))
          .map((e) => e.textContent.trim()).filter(Boolean));
      const small = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for']);
      for (const label of labels) {
        label.split(/[\s-]+/).forEach((word, i) => {
          const w = word.replace(/^[^A-Za-z]+/, '');
          if (!w || (i > 0 && small.has(w.toLowerCase()))) return;
          assert.ok(/^[A-Z]/.test(w), `"${label}" is not title case`);
        });
      }
      assert.ok(labels.includes('Show Timestamps') && labels.includes('Rename Speaker 2'), labels.join(' | '));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, 'sideways scroll ' + overflow);
    });

    console.log('File tab: Speechmatics');

    await test('a file goes all the way: prepare, upload, Speechmatics, numbered turns, saved with its sound in My Transcripts', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      assert.match(await text(page, '#file-details'), /11 seconds/);
      const seen = [];
      await page.exposeFunction('__seen', (t) => seen.push(t));
      await page.evaluate(() => new MutationObserver(() => window.__seen(document.getElementById('file-status').textContent))
        .observe(document.getElementById('file-status'), { childList: true, characterData: true, subtree: true }));
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
      assert.ok(seen.some((t) => /^Preparing the audio… \d+%/.test(t)), 'preparing shown');
      assert.ok(seen.some((t) => /^Uploading… \d+% \([\d.]+ of [\d.]+ MB\)/.test(t)), 'upload progress shown');
      assert.ok(seen.some((t) => /^Speechmatics is transcribing/.test(t)), 'waiting for Speechmatics shown');
      assert.match(await status(page), /^Done\. Transcribed 11 seconds of audio\. It is saved in My Transcripts\.$/);
      // What was uploaded: a small mono Ogg Opus file of the right length.
      const [up] = [...server.uploads.values()];
      const ogg = Buffer.concat(up.bytes);
      assert.strictEqual(ogg.subarray(0, 4).toString(), 'OggS');
      const out = path.join(media.DIR, 'uploaded-test.ogg');
      fs.writeFileSync(out, ogg);
      const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,channels', '-of', 'json', out]).stdout);
      assert.strictEqual(probe.streams[0].codec_name, 'opus');
      assert.strictEqual(probe.streams[0].channels, 1);
      assert.ok(Math.abs(Number(probe.format.duration) - 11) < 0.1, probe.format.duration);
      assert.ok(ogg.length < 11 * 4000, ogg.length + ' bytes');
      // The upload went into the signed-in person's own folder, carrying their sign-in.
      assert.match(up.objectName, new RegExp('^' + fake.CHU.id + '/[0-9a-f-]{36}\\.ogg$'));
      assert.ok(server.calls.every((c) => c.user && c.user.id === fake.CHU.id), 'every function call is signed in');
      // The job was started once, with the length. The sound is NOT deleted any more:
      // it is kept with the transcript in My Transcripts.
      assert.strictEqual(fnCalls('check-limit').length, 1);
      assert.strictEqual(fnCalls('start-job').length, 1);
      assert.strictEqual(fnCalls('start-job')[0].body.path, up.objectName);
      assert.strictEqual(fnCalls('start-job')[0].body.seconds, 11);
      await page.waitForFunction(() => true);
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(fnCalls('delete-audio').length, 0, 'the sound is kept');
      assert.ok(server.objects.has(up.objectName), 'still in storage');
      assert.strictEqual(server.rows.length, 1, 'one item in My Transcripts');
      const row = server.rows[0];
      const built = F.buildTurns(saved('two-speakers'));
      assert.strictEqual(row.user_id, fake.CHU.id);
      assert.strictEqual(row.title, 'jfk.wav');
      assert.strictEqual(row.file_name, 'jfk.wav');
      assert.strictEqual(row.audio_path, up.objectName);
      assert.strictEqual(row.audio_bytes, ogg.length);
      assert.ok(Math.abs(row.duration_seconds - 11) < 0.1, 'length ' + row.duration_seconds);
      assert.deepStrictEqual(row.turns, built.turns, 'turns with their times');
      assert.deepStrictEqual(row.speakers, built.speakers);
      assert.deepStrictEqual(row.speaker_names, {});
      assert.strictEqual(row.speechmatics_id, 'smjob1');
      assert.ok(row.first_line.startsWith('Speaker 1: ' + built.turns[0].text.slice(0, 40)), row.first_line);
      // The transcript, exactly as section 3 asks.
      assert.deepStrictEqual(await screenLines(page), expectedText(saved('two-speakers')).split('\n'));
      assert.strictEqual(await text(page, '#word-count'), F.countWords(F.buildTurns(saved('two-speakers')).turns) + ' Words');
      assert.ok(await page.evaluate(() => window.__wake.held === null), 'screen allowed to sleep again');
    });

    await test('Copy and Download keep whichever view is showing (with or without times)', async (page) => {
      const result = saved('many-overlaps');
      await transcribe(page, files.jfk, { result });
      const withTimes = expectedText(result);
      assert.ok(await page.isChecked('#file-timestamps'), 'times shown at first');
      await page.click('#copy-button');
      await page.waitForFunction(() => /Copied/.test(document.getElementById('output-status').textContent));
      assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), withTimes);
      let [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-button')]);
      assert.match(download.suggestedFilename(), /^transcript-jfk-\d{4}-\d\d-\d\d_\d\d-\d\d\.txt$/);
      assert.strictEqual(fs.readFileSync(await download.path(), 'utf8').replace(/\r\n/g, '\n').trim(), withTimes);
      // Hide the times: nothing is transcribed again.
      const startsBefore = fnCalls('start-job').length + fnCalls('job-result').length;
      await page.click('.switch');
      assert.ok(!(await page.isChecked('#file-timestamps')));
      const plain = expectedText(result, {}, false);
      assert.deepStrictEqual(await screenLines(page), plain.split('\n'));
      assert.strictEqual(await page.locator('.turn-time').count(), 0);
      await page.click('#copy-button');
      await page.waitForFunction(() => /Copied/.test(document.getElementById('output-status').textContent));
      assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), plain);
      [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-button')]);
      assert.strictEqual(fs.readFileSync(await download.path(), 'utf8').replace(/\r\n/g, '\n').trim(), plain);
      assert.strictEqual(fnCalls('start-job').length + fnCalls('job-result').length, startsBefore, 'not transcribed again');
      // The choice is remembered.
      await page.reload();
      await openFileTab(page);
      await page.waitForSelector('#file-transcript .turn');
      assert.ok(!(await page.isChecked('#file-timestamps')));
      assert.deepStrictEqual(await screenLines(page), plain.split('\n'));
    });

    await test('renaming a speaker changes every label for that speaker, and is saved', async (page) => {
      const result = saved('many-overlaps');
      await transcribe(page, files.jfk, { result });
      // Tap a speaker's name in the transcript.
      await page.locator('.turn-speaker', { hasText: 'Speaker 2' }).first().click();
      assert.ok(await page.isVisible('#rename-box'));
      assert.match(await text(page, '#rename-label'), /^New Name for Speaker 2$/);
      await page.fill('#rename-input', '  Maria  ');
      await page.click('#rename-save');
      const expected = expectedText(result, { S2: 'Maria' });
      assert.deepStrictEqual(await screenLines(page), expected.split('\n'));
      assert.strictEqual((await screenLines(page)).filter((l) => /Speaker 2/.test(l)).length, 0);
      assert.strictEqual((await screenLines(page)).filter((l) => /Maria/.test(l)).length, 6);
      assert.match(await status(page), /Renamed.*“Maria”/);
      // The speaker buttons, and Copy.
      assert.deepStrictEqual(await page.$$eval('#speaker-list button', (b) => b.map((x) => x.textContent)), ['Rename Speaker 1', 'Rename Maria']);
      await page.click('#copy-button');
      await page.waitForFunction(() => /Copied/.test(document.getElementById('output-status').textContent));
      assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), expected);
      // Speaker 1 with the button and Enter.
      await page.click('#speaker-list button >> text=Rename Speaker 1');
      await page.fill('#rename-input', 'Ana');
      await page.press('#rename-input', 'Enter');
      assert.deepStrictEqual(await screenLines(page), expectedText(result, { S1: 'Ana', S2: 'Maria' }).split('\n'));
      // Survives a reload.
      await page.reload();
      await openFileTab(page);
      await page.waitForSelector('#file-transcript .turn');
      assert.deepStrictEqual(await screenLines(page), expectedText(result, { S1: 'Ana', S2: 'Maria' }).split('\n'));
      // An empty name goes back to the number; Cancel changes nothing.
      await page.click('#speaker-list button >> text=Rename Maria');
      assert.match(await text(page, '#rename-label'), /Speaker 2 \(Now “Maria”\)/);
      await page.fill('#rename-input', '');
      await page.click('#rename-save');
      await page.click('#speaker-list button >> text=Rename Ana');
      await page.fill('#rename-input', 'Nobody');
      await page.click('#rename-cancel');
      assert.deepStrictEqual(await screenLines(page), expectedText(result, { S1: 'Ana' }).split('\n'));
    });

    await test('tapping a timestamp plays the chosen file from that moment', async (page) => {
      const result = B.build([
        { speaker: 'S1', at: 1.2, say: 'And so my fellow Americans,' },
        { speaker: 'S2', at: 6.4, say: 'Ask not what your country can do for you.' }
      ]);
      await transcribe(page, files.jfk, { result });
      await page.locator('.turn-time').nth(1).click();
      await page.waitForFunction(() => !document.getElementById('file-player').paused, null, { timeout: 5000 });
      const t = await page.evaluate(() => document.getElementById('file-player').currentTime);
      assert.ok(t >= 6.3 && t < 7.5, 'playing from ' + t);
      assert.ok(await page.isVisible('#file-player'));
      assert.ok(await page.locator('.turn.is-playing').count() === 1);
      await page.locator('.turn-time').nth(0).click();
      await page.waitForFunction(() => document.getElementById('file-player').currentTime < 3, null, { timeout: 5000 });
      // After a reload the file is not chosen any more: the recording kept in My Transcripts plays.
      await page.reload();
      await openFileTab(page);
      await page.waitForSelector('.turn-time');
      await page.locator('.turn-time').nth(1).click();
      await waitStatus(page, /Playing the saved recording/);
      await page.waitForFunction(() => !document.getElementById('file-player').paused && document.getElementById('file-player').currentTime >= 6.3, null, { timeout: 8000 });
      assert.strictEqual(server.signed.length, 1, 'through a play link for their own recording');
      // If the recording cannot be fetched (no internet), it says how to play it.
      await page.reload();
      await openFileTab(page);
      await page.waitForSelector('.turn-time');
      server.objects.clear();
      await page.locator('.turn-time').first().click();
      await waitStatus(page, /To play the recording from this moment, choose “jfk\.wav” again/);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /Already transcribed/);
      await page.locator('.turn-time').nth(1).click();
      await page.waitForFunction(() => !document.getElementById('file-player').paused, null, { timeout: 5000 });
      assert.strictEqual(fnCalls('start-job').length, 1, 'choosing it again did not send it again');
    });

    await test('a video file: only its sound is prepared and uploaded, and it plays from a timestamp', async (page) => {
      await transcribe(page, files.courtroom, { result: saved('three-speakers') });
      assert.match(await text(page, '#file-details'), /Video \(sound only\)/);
      const [up] = [...server.uploads.values()];
      assert.strictEqual(Buffer.concat(up.bytes).subarray(0, 4).toString(), 'OggS');
      await page.locator('.turn-time').nth(2).click();
      await page.waitForFunction(() => !document.getElementById('file-player').paused, null, { timeout: 5000 });
    });

    await test('editing a turn keeps the format; edits survive a reload and the timestamps switch', async (page) => {
      const result = saved('two-speakers');
      await transcribe(page, files.jfk, { result });
      const turn = page.locator('.turn-text').first();
      await turn.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' (Edited.)');
      await page.keyboard.press('Enter');
      const lines = await screenLines(page);
      assert.strictEqual(lines[0], '1. [00:00:05 – 00:00:07] Speaker 1: Good morning. Thanks for coming in today. (Edited.)');
      await page.waitForTimeout(600);
      await page.reload();
      await openFileTab(page);
      await page.waitForSelector('.turn');
      assert.deepStrictEqual(await screenLines(page), lines);
      await page.click('.switch');
      assert.strictEqual((await screenLines(page))[0], '1. Speaker 1: Good morning. Thanks for coming in today. (Edited.)');
    });

    await test('a 2-hour transcript shows quickly and in order', async (page) => {
      const result = B.twoHours();
      await transcribe(page, files.jfk, { result });
      const expected = expectedText(result).split('\n');
      const shown = await screenLines(page);
      assert.strictEqual(shown.length, expected.length);
      assert.deepStrictEqual(shown.slice(0, 10), expected.slice(0, 10));
      assert.deepStrictEqual(shown.slice(-5), expected.slice(-5));
      const ms = await page.evaluate(() => {
        const t = performance.now();
        document.getElementById('file-timestamps').click();
        document.getElementById('file-timestamps').click();
        return performance.now() - t;
      });
      assert.ok(ms < 1500, `switching timestamps took ${Math.round(ms)} ms`);
      console.log(`       ${shown.length} turns; timestamps off and on again in ${Math.round(ms)} ms`);
    });

    console.log('Carrying on after an interruption, never paying twice');

    await test('the app closes mid-upload: the same file carries on from the last piece, not from the start', async (page, context) => {
      await openFileTab(page);
      await chooseFile(page, files.long);
      await waitStatus(page, /^Ready/);
      // Close the app as soon as the first 6 MB piece is in.
      let closed;
      const firstPiece = new Promise((r) => { closed = r; });
      server.afterPatch = (up) => { if (up.received >= 6 * 1024 * 1024) closed(); };
      server.holdPatch = (offset) => (offset >= 6 * 1024 * 1024 ? new Promise(() => {}) : null);
      await page.click('#file-start');
      await firstPiece;
      await page.waitForTimeout(300);
      await page.close({ runBeforeUnload: false });
      server.holdPatch = null;
      server.afterPatch = null;
      const creates = server.tus.filter((t) => t.method === 'POST').length;
      const again = await context.newPage();
      await again.goto(URL);
      await openFileTab(again);
      await waitStatus(again, /stopped when the app closed\. Choose the same file again/);
      const seen = [];
      await again.exposeFunction('__seen', (t) => seen.push(t));
      await again.evaluate(() => new MutationObserver(() => window.__seen(document.getElementById('file-status').textContent))
        .observe(document.getElementById('file-status'), { childList: true, characterData: true, subtree: true }));
      await chooseFile(again, files.long);
      await again.waitForFunction(() => /Continuing where you left off/.test(document.getElementById('file-resume-text').textContent));
      await waitStatus(again, /^Done/, 120000);
      assert.ok(!seen.some((t) => /Preparing/.test(t)), 'not prepared again (kept on the device)');
      assert.strictEqual(server.tus.filter((t) => t.method === 'POST').length, creates, 'no new upload started');
      const head = server.tus.find((t) => t.method === 'HEAD');
      assert.ok(head && head.offset === 6 * 1024 * 1024, 'asked where to carry on: ' + JSON.stringify(head));
      const afterHead = server.tus.slice(server.tus.indexOf(head) + 1).filter((t) => t.method === 'PATCH');
      assert.ok(afterHead.every((t) => t.offset >= 6 * 1024 * 1024), 'nothing sent twice');
      const [up] = [...server.uploads.values()];
      assert.strictEqual(up.received, up.length);
      assert.strictEqual(fnCalls('start-job').length, 1);
    });

    await test('the app closes while Speechmatics works: reopening collects the transcript, no file needed, paid once', async (page, context) => {
      server.pollsUntilDone = 1000;   // Speechmatics takes a long time
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /Speechmatics is transcribing/);
      assert.ok(!(await page.isVisible('#file-cancel')), 'nothing to cancel once Speechmatics has it');
      await page.close({ runBeforeUnload: false });
      // Speechmatics finishes while the app is closed.
      [...server.jobs.values()][0].polls = 2000;
      const again = await context.newPage();
      await again.goto(URL);
      await openFileTab(again);
      await waitStatus(again, /^Done/);
      assert.deepStrictEqual(await screenLines(again), expectedText(saved('two-speakers')).split('\n'));
      assert.strictEqual(fnCalls('start-job').length, 1, 'started once');
      await again.waitForTimeout(300);
      assert.strictEqual(fnCalls('delete-audio').length, 0, 'the sound is kept');
      assert.strictEqual(server.rows.length, 1, 'saved in My Transcripts');
      assert.strictEqual(server.objects.size, 1);
      // And choosing the file again later: the saved transcript, nothing sent.
      await chooseFile(again, files.jfk);
      await waitStatus(again, /Already transcribed/);
      assert.match(await text(again, '#file-resume-text'), /already transcribed.*not sent again/);
      assert.ok(await again.isDisabled('#file-start'));
      assert.strictEqual(fnCalls('start-job').length, 1);
      assert.strictEqual(server.uploads.size, 1);
    });

    await test('phone restart (browser fully closed) while uploading: carries on', async () => {
      const os = require('os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-profile-'));
      const launch = async () => {
        const ctx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'] });
        await ctx.addInitScript(WAKE_LOCK);
        await ctx.addInitScript(QUICK);
        await ctx.addInitScript(fake.signedInScript(fake.CHU));
        await ctx.route(SUPABASE + '/**', fakeSupabase);
        return ctx;
      };
      let ctx = await launch();
      try {
        let page = ctx.pages()[0] || await ctx.newPage();
        await page.goto(URL);
        await openFileTab(page);
        await chooseFile(page, files.long);
        await waitStatus(page, /^Ready/);
        let gotPiece;
        const piece = new Promise((r) => { gotPiece = r; });
        server.afterPatch = (up) => { if (up.received >= 6 * 1024 * 1024) gotPiece(); };
        server.holdPatch = (offset) => (offset >= 6 * 1024 * 1024 ? new Promise(() => {}) : null);
        await page.click('#file-start');
        await piece;
        await page.waitForTimeout(500);
        await ctx.close();
        server.holdPatch = null;
        server.afterPatch = null;
        ctx = await launch();
        page = ctx.pages()[0] || await ctx.newPage();
        await page.goto(URL);
        await openFileTab(page);
        await waitStatus(page, /stopped when the app closed/);
        await chooseFile(page, files.long);
        await waitStatus(page, /^Done/, 120000);
        assert.strictEqual(server.uploads.size, 1, 'the same upload, carried on');
        assert.strictEqual(fnCalls('start-job').length, 1);
      } finally {
        await ctx.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await test('internet cut during the upload: waits, then carries on from the last piece', async (page, context) => {
      await openFileTab(page);
      await chooseFile(page, files.long);
      await waitStatus(page, /^Ready/);
      let release;
      server.holdPatch = (offset) => (offset >= 6 * 1024 * 1024 ? new Promise((r) => { release = r; }) : null);
      await page.click('#file-start');
      await page.waitForFunction(() => /Uploading… \d+%/.test(document.getElementById('file-status').textContent));
      await new Promise((r) => { const t = setInterval(() => { if (release) { clearInterval(t); r(); } }, 50); });
      server.holdPatch = null;
      await context.setOffline(true);
      release();
      await waitStatus(page, /No internet connection\. Waiting for it to come back\. The upload will carry on from where it stopped/, 30000);
      assert.strictEqual(await page.getAttribute('#file-status', 'data-kind'), 'warn');
      await page.waitForTimeout(500);
      await context.setOffline(false);
      await waitStatus(page, /^Done/, 120000);
      const [up] = [...server.uploads.values()];
      assert.strictEqual(server.uploads.size, 1, 'same upload');
      assert.strictEqual(up.received, up.length);
      const resent = server.tus.filter((t) => t.method === 'PATCH' && t.offset === 0).length;
      assert.strictEqual(resent, 1, 'the first piece was not sent again');
      const ogg = Buffer.concat(up.bytes);
      const out = path.join(media.DIR, 'uploaded-after-cut.ogg');
      fs.writeFileSync(out, ogg);
      const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).stdout);
      assert.ok(Math.abs(dur - 2400) < 1, 'the whole recording arrived intact: ' + dur);
    });

    await test('Cancel while uploading keeps the progress; Continue Transcribing carries on', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.long);
      await waitStatus(page, /^Ready/);
      let hold;
      server.holdPatch = (offset) => (offset >= 6 * 1024 * 1024 ? new Promise((r) => { hold = r; }) : null);
      await page.click('#file-start');
      await new Promise((r) => { const t = setInterval(() => { if (hold) { clearInterval(t); r(); } }, 50); });
      server.holdPatch = null;
      await page.click('#file-cancel');
      hold();
      await waitStatus(page, /^Stopped\. The upload so far is saved\. Tap Continue Transcribing/);
      assert.strictEqual(await text(page, '#file-start-label'), 'Continue Transcribing');
      await page.click('#file-start');
      await waitStatus(page, /^Done/, 120000);
      assert.strictEqual(server.uploads.size, 1);
      assert.strictEqual(fnCalls('start-job').length, 1);
    });

    await test('Start Over during an upload begins a fresh upload', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.long);
      await waitStatus(page, /^Ready/);
      let hold;
      server.holdPatch = (offset) => (offset >= 6 * 1024 * 1024 ? new Promise((r) => { hold = r; }) : null);
      await page.click('#file-start');
      await new Promise((r) => { const t = setInterval(() => { if (hold) { clearInterval(t); r(); } }, 50); });
      server.holdPatch = null;
      await page.click('#file-cancel');
      hold();
      await waitStatus(page, /^Stopped/);
      await page.reload();
      await openFileTab(page);
      // Carrying on starts by itself; keep that upload waiting so Start Over has something to stop.
      server.holdPatch = (offset, id) => (id === 'up1' && offset >= 6 * 1024 * 1024 ? new Promise(() => {}) : null);
      await chooseFile(page, files.long);
      await page.waitForFunction(() => !document.getElementById('file-start-over').hidden);
      await page.waitForFunction(() => /Uploading/.test(document.getElementById('file-status').textContent));
      await page.click('#file-start-over');
      await waitStatus(page, /^Done/, 120000);
      assert.strictEqual(server.uploads.size >= 2, true, 'a new upload');
      assert.strictEqual(fnCalls('start-job').length, 1);
    });

    await test('Start Over is gone once the upload is done, so it can never pay twice', async (page) => {
      server.pollsUntilDone = 1000;
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /Speechmatics is transcribing/);
      assert.ok(!(await page.isVisible('#file-start-over')));
      await page.evaluate(() => window.transcriberApp.file.startOver());
      await page.waitForTimeout(500);
      assert.strictEqual(fnCalls('start-job').length, 1);
      assert.strictEqual(server.uploads.size, 1);
      [...server.jobs.values()][0].polls = 5000;
      await waitStatus(page, /^Done/);
    });

    await test('closed after uploading but before Speechmatics took it: reopening carries on by itself', async (page, context) => {
      server.limitAtStart = true;
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /^Today’s transcription time is used up/);
      await page.close({ runBeforeUnload: false });
      server.limitAtStart = false;   // the next day
      const again = await context.newPage();
      await again.goto(URL);
      await openFileTab(again);
      await waitStatus(again, /^Done/);
      assert.strictEqual(server.uploads.size, 1, 'not uploaded again');
      assert.strictEqual(fnCalls('start-job').length, 2);
      assert.strictEqual(server.jobs.size, 1, 'one Speechmatics job');
    });

    await test('a recording Speechmatics refused is not sent again just by choosing it', async (page) => {
      server.reject = 'No speech found';
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /it said: “No speech found”/);
      await page.reload();
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /could not transcribe this recording last time\. Tap Try Again/);
      await page.waitForTimeout(400);
      assert.strictEqual(fnCalls('start-job').length, 1);
      assert.strictEqual(await text(page, '#file-start-label'), 'Try Again');
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
      assert.strictEqual(fnCalls('start-job').length, 2);
    });

    const forgetOnDevice = (page) => page.evaluate(async () => {
      const store = window.CloudStore;
      const jobs = await store.allJobs();
      for (const j of jobs) { delete j.turns; j.done = false; j.pruned = true; j.stage = 'processing'; await store.putJob(j); }
    });

    await test('an old transcript removed from this device to save space is shown again from My Transcripts, not paid again', async (page) => {
      await transcribe(page, files.jfk, { result: saved('two-speakers') });
      await forgetOnDevice(page);
      const checks = fnCalls('job-status').length;
      await page.reload();
      await openFileTab(page);
      await page.waitForTimeout(400);
      assert.strictEqual(fnCalls('job-status').length, checks, 'not collected by itself at start-up');
      await chooseFile(page, files.jfk);
      await waitStatus(page, /Already transcribed/);
      assert.match(await text(page, '#file-resume-text'), /already transcribed.*also in My Transcripts/);
      assert.deepStrictEqual(await screenLines(page), expectedText(saved('two-speakers')).split('\n'));
      assert.strictEqual(fnCalls('start-job').length, 1, 'no new job');
      assert.strictEqual(fnCalls('job-result').length, 1, 'nothing asked of Speechmatics again');
      assert.strictEqual(server.uploads.size, 1);
      assert.strictEqual(server.rows.length, 1);
    });

    await test('...and if it was also deleted from My Transcripts, it is collected again from Speechmatics, not paid again', async (page) => {
      await transcribe(page, files.jfk, { result: saved('two-speakers') });
      await forgetOnDevice(page);
      server.rows = [];
      await page.reload();
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Done/);
      assert.match(await text(page, '#file-resume-text'), /^$/);
      assert.deepStrictEqual(await screenLines(page), expectedText(saved('two-speakers')).split('\n'));
      assert.strictEqual(fnCalls('start-job').length, 1, 'no new job');
      assert.strictEqual(server.uploads.size, 1);
    });

    await test('a file transcribed on another device is shown from My Transcripts instead of being sent again', async (page) => {
      await transcribe(page, files.jfk, { result: saved('three-speakers') });
      // "Another device": this browser knows nothing about the file.
      await page.evaluate(async () => {
        for (const j of await window.CloudStore.allJobs()) await window.CloudStore.deleteJob(j.key);
        localStorage.removeItem('transcriber.cloudFileState');
      });
      await page.reload();
      await openFileTab(page);
      assert.deepStrictEqual(await screenLines(page), []);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /Already transcribed/);
      assert.deepStrictEqual(await screenLines(page), expectedText(saved('three-speakers')).split('\n'));
      assert.ok(await page.isDisabled('#file-start'));
      assert.strictEqual(fnCalls('start-job').length, 1, 'not sent again');
      assert.strictEqual(server.uploads.size, 1, 'not uploaded again');
      assert.strictEqual(server.rows.length, 1);
    });

    console.log('Problems, in plain words');

    await test('still being handed to Speechmatics ("busy"): plain message, not sent twice', async (page) => {
      server.startBusy = 1000;
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /^This recording is still being handed to Speechmatics\. Wait a few minutes.*will not be sent twice/, 30000);
      server.startBusy = 0;
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
      assert.strictEqual(server.jobs.size, 1);
    });


    await test('no internet: says so, and works once back online', async (page, context) => {
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await context.setOffline(true);
      await page.click('#file-start');
      await waitStatus(page, /^No internet connection\. Connect to the internet.*Continue Transcribing.*Nothing done so far is lost/);
      assert.strictEqual(await page.getAttribute('#file-status', 'data-kind'), 'error');
      assert.ok(await page.isEnabled('#file-start'));
      await context.setOffline(false);
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
    });

    await test('upload failed: plain message, Continue Transcribing carries on', async (page) => {
      server.patchFails = 100;
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /^The upload failed\. Check your internet connection and tap Continue Transcribing/, 30000);
      assert.strictEqual(await text(page, '#file-start-label'), 'Continue Transcribing');
      server.patchFails = 0;
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
      assert.strictEqual(server.uploads.size, 1, 'the same upload carried on');
    });

    await test('Speechmatics failed: plain message, Try Again works', async (page) => {
      server.startFails = 1;
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /^Speechmatics could not transcribe this recording right now\. Wait a few minutes, then tap Try Again/);
      assert.strictEqual(await text(page, '#file-start-label'), 'Try Again');
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
      assert.strictEqual(server.uploads.size, 1, 'not uploaded again');
    });

    await test('Speechmatics rejects the recording part-way: says why, Try Again starts a new job', async (page) => {
      server.reject = 'Unable to read the audio';
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /^Speechmatics could not transcribe this recording \(it said: “Unable to read the audio”\)\. Tap Try Again/);
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
      assert.strictEqual(fnCalls('start-job').length, 2);
      assert.strictEqual(server.uploads.size, 1);
    });

    await test('daily limit reached: plain message before anything is prepared or uploaded', async (page) => {
      server.limitReached = true;
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /^Today’s transcription time is used up\. This app can send 60 minutes of recordings a day to Speechmatics \(for everyone together\).*try again tomorrow/);
      assert.strictEqual(server.uploads.size, 0, 'nothing uploaded');
      assert.strictEqual(fnCalls('start-job').length, 0);
    });

    await test('daily limit reached while uploading: same message; tomorrow it carries on without uploading again', async (page) => {
      server.limitAtStart = true;
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /^Today’s transcription time is used up/);
      assert.strictEqual(await text(page, '#file-start-label'), 'Continue Transcribing');
      server.limitAtStart = false;
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
      assert.strictEqual(server.uploads.size, 1);
    });

    await test('file not supported: says so', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.text);
      await waitStatus(page, /^This file type is not supported/);
      assert.strictEqual(await page.getAttribute('#file-status', 'data-kind'), 'error');
      assert.ok(await page.isDisabled('#file-start'));
    });

    await test('service not set up yet (functions not deployed): says so', async (page) => {
      server.notDeployed = true;
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /^The transcription service is not set up yet/);
    });

    console.log('Output tools');

    await test('Live: word count, Copy, Download (.txt with date and time), Clear with confirm, survives refresh', async (page) => {
      assert.ok(await page.isDisabled('#copy-button'), 'nothing to copy yet');
      await page.fill('#transcript', 'Good morning to you. This is a test.');
      assert.strictEqual(await text(page, '#word-count'), '8 Words');
      await page.click('#copy-button');
      await page.waitForFunction(() => /Copied/.test(document.getElementById('output-status').textContent));
      assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), 'Good morning to you. This is a test.');
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-button')]);
      assert.match(download.suggestedFilename(), /^transcript-live-\d{4}-\d\d-\d\d_\d\d-\d\d\.txt$/);
      assert.strictEqual(fs.readFileSync(await download.path(), 'utf8').trim(), 'Good morning to you. This is a test.');
      await page.reload();
      assert.strictEqual(await page.inputValue('#transcript'), 'Good morning to you. This is a test.');
      await page.click('#clear-button');
      assert.match(await text(page, '#clear-confirm-text'), /Clear the whole Live transcript/);
      await page.click('#clear-no');
      assert.strictEqual(await page.inputValue('#transcript'), 'Good morning to you. This is a test.');
      await page.click('#clear-button');
      await page.click('#clear-yes');
      assert.strictEqual(await page.inputValue('#transcript'), '');
      assert.strictEqual(await text(page, '#word-count'), '0 Words');
    });

    await test('File: Clear is off while working; Live and File keep separate transcripts; Clear does not lose the paid result', async (page) => {
      server.pollsUntilDone = 3;
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /^Ready/);
      await page.click('#file-start');
      await waitStatus(page, /Speechmatics is transcribing/);
      assert.ok(await page.isDisabled('#clear-button'), 'no clearing while it works');
      await waitStatus(page, /^Done/);
      assert.ok(await page.isEnabled('#clear-button'));
      await page.click('#tab-live');
      assert.strictEqual(await page.inputValue('#transcript'), '');
      await page.click('#tab-file');
      await page.click('#clear-button');
      assert.match(await text(page, '#clear-confirm-text'), /Clear the whole File transcript/);
      await page.click('#clear-yes');
      assert.strictEqual(await page.locator('#file-transcript .turn').count(), 0);
      assert.strictEqual(await text(page, '#word-count'), '0 Words');
      await page.reload();
      await openFileTab(page);
      await page.waitForTimeout(300);
      assert.strictEqual(await page.locator('#file-transcript .turn').count(), 0, 'still cleared after a reload');
      await chooseFile(page, files.jfk);
      await waitStatus(page, /Already transcribed/);
      assert.ok(await page.locator('#file-transcript .turn').count() > 0, 'the saved transcript comes back');
      assert.strictEqual(fnCalls('start-job').length, 1);
    });

    await test('choosing a different file asks before replacing the transcript on screen', async (page) => {
      await transcribe(page, files.jfk, { result: saved('two-speakers') });
      const first = await screenLines(page);
      await chooseFile(page, files.mp3);
      await page.waitForSelector('#file-replace', { state: 'visible' });
      assert.match(await text(page, '#file-replace-text'), /from “jfk\.wav”.*“jfk\.mp3” will replace it/);
      await page.click('#file-replace-no');
      assert.deepStrictEqual(await screenLines(page), first);
      await chooseFile(page, files.mp3);
      await page.click('#file-replace-yes');
      await waitStatus(page, /^Ready/);
      assert.strictEqual(await page.locator('#file-transcript .turn').count(), 0);
      assert.strictEqual(await text(page, '#file-name'), 'jfk.mp3');
    });

    await test('a Whisper transcript saved by the earlier version is still shown and can be copied', async (page) => {
      await openFileTab(page);
      assert.strictEqual(await text(page, '#file-transcript'), '[0:00] An older transcript.');
      assert.strictEqual(await text(page, '#word-count'), '3 Words');
      await page.click('#copy-button');
      await page.waitForFunction(() => /Copied/.test(document.getElementById('output-status').textContent));
      assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), '[0:00] An older transcript.');
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-button')]);
      assert.match(download.suggestedFilename(), /^transcript-old-/);
      // Once cleared it stays cleared.
      await page.click('#clear-button');
      await page.click('#clear-yes');
      await page.reload();
      await openFileTab(page);
      assert.strictEqual(await text(page, '#file-transcript'), '');
    }, {
      context: async () => {
        // A phone that used the earlier version: only the old saved transcript is there.
        const context = await newContext();
        await context.addInitScript(() => {
          if (!localStorage.getItem('transcriber.cloudFileState')) {
            localStorage.setItem('transcriber.fileState', JSON.stringify({ text: '[0:00] An older transcript.', name: 'old.m4a' }));
          }
        });
        return context;
      }
    });
  } finally {
    await browser.close();
    web.kill();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
