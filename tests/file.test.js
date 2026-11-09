/*
 * Browser tests for the File tab and the output tools, with the real Whisper
 * model running in the worker. Run from the repo root:
 *
 *   node tests/file.test.js            (add --long for the 2.5-hour files)
 *
 * Needs Python 3, ffmpeg, curl and Playwright. The first run downloads the
 * speech models (about 120 MB) and some speech recordings into a cache
 * folder; later runs use the cache. Requests to huggingface.co are answered
 * from that cache, which also lets the tests pretend the internet is down.
 */
'use strict';
const { chromium, devices } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const media = require('./media');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8766;
const URL = `http://localhost:${PORT}/index.html`;
const LONG = process.argv.includes('--long');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const HF_DIR = path.join(media.DIR, 'hf');

// ---------- Test media ----------

function speechFiles() {
  const jfk = media.speech('jfk.wav');
  const ted = media.speech('ted_60.wav');
  const files = {
    jfk,
    ted,
    interview: media.speech('interview.mp4'),       // video: H.264 + AAC
    hopper: media.speech('hopper.webm'),            // video: VP9 + Opus
    courtroom: media.speech('courtroom.mp4'),
    mp3: media.make('jfk.mp3', jfk, ['-c:a', 'libmp3lame', '-b:a', '64k']),
    m4a: media.make('jfk.m4a', jfk, ['-c:a', 'aac', '-b:a', '64k']),
    ogg: media.make('jfk.ogg', jfk, ['-c:a', 'libopus', '-b:a', '32k']),
    webm: media.make('jfk.webm', jfk, ['-c:a', 'libopus', '-b:a', '32k']),
    flac: media.make('jfk.flac', jfk, ['-c:a', 'flac']),
    aac: media.make('jfk.aac', jfk, ['-c:a', 'aac', '-b:a', '64k']),
    mov: media.make('jfk.mov', jfk, [], ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=11',
      '-map', '1:v', '-map', '0:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest']),
  };
  // Filipino speech (Google FLEURS, Tagalog), six sentences.
  files.fil = path.join(media.DIR, 'fil.wav');
  if (!fs.existsSync(files.fil)) {
    const dir = path.join(media.DIR, 'fleurs');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('bash', ['-c', `cd ${dir} && curl -sSfL -r 0-6000000 -o part.tgz ` +
      '"https://huggingface.co/datasets/google/fleurs/resolve/main/data/fil_ph/audio/dev.tar.gz" ; ' +
      'tar xzf part.tgz 2>/dev/null; ls dev/*.wav | head -6 | sed "s/^/file /" > list.txt']);
    media.ff(['-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-ar', '16000', '-ac', '1', files.fil]);
  }
  // 40 minutes of speech (over the 30-minute warning), small MP3.
  files.long40 = path.join(media.DIR, 'speech-40min.mp3');
  if (!fs.existsSync(files.long40)) {
    media.ff(['-stream_loop', '-1', '-i', ted, '-t', '2400', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', files.long40]);
  }
  files.noSound = path.join(media.DIR, 'silent-video.mp4');
  if (!fs.existsSync(files.noSound)) {
    media.ff(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', files.noSound]);
  }
  files.text = path.join(media.DIR, 'notes.txt');
  fs.writeFileSync(files.text, 'These are notes, not a recording.\n');
  files.broken = path.join(media.DIR, 'broken.mp3');
  if (!fs.existsSync(files.broken)) {
    const junk = Buffer.alloc(200000);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919 + 13) % 251;
    fs.writeFileSync(files.broken, junk);
  }
  return files;
}

function longFiles() {
  const secs = 2.5 * 3600;
  const ted = media.speech('ted_60.wav');
  const out = {};
  const mk = (name, args, video) => {
    const file = path.join(media.DIR, name);
    if (!fs.existsSync(file)) {
      const input = ['-stream_loop', '-1', '-i', ted];
      const v = video ? ['-f', 'lavfi', '-i', `testsrc=size=160x120:rate=1:duration=${secs}`, '-map', '1:v', '-map', '0:a'] : [];
      media.ff(input.concat(v, ['-t', String(secs)], args, [file]));
    }
    return file;
  };
  out.mp3 = mk('speech-2h30.mp3', ['-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k']);
  out.m4a = mk('speech-2h30.m4a', ['-ac', '1', '-c:a', 'aac', '-b:a', '48k']);
  out.mp4 = mk('speech-2h30.mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-ac', '1', '-c:a', 'aac', '-b:a', '48k'], true);
  out.webm = mk('speech-2h30.webm', ['-ac', '1', '-c:a', 'libopus', '-b:a', '24k']);
  return out;
}

// ---------- Hugging Face, answered from a local cache ----------

const net = { mode: 'ok' };   // 'ok' | 'fail'

function cachedModelFile(pathname) {
  const local = path.join(HF_DIR, decodeURIComponent(pathname).replace(/\.\./g, ''));
  if (fs.existsSync(local) || fs.existsSync(local + '.404')) return local;
  fs.mkdirSync(path.dirname(local), { recursive: true });
  try {
    execFileSync('curl', ['-sSfL', '--retry', '3', '-o', local + '.part', 'https://huggingface.co' + pathname]);
    fs.renameSync(local + '.part', local);
  } catch (e) {
    fs.rmSync(local + '.part', { force: true });
    fs.writeFileSync(local + '.404', '');
  }
  return local;
}

async function routeModels(context) {
  await context.route('https://huggingface.co/**', async (route) => {
    if (net.mode === 'fail') return route.abort('internetdisconnected');
    const url = new globalThis.URL(route.request().url());
    const local = cachedModelFile(url.pathname);
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'content-length, content-range, etag',
      'content-type': 'application/octet-stream',
      'accept-ranges': 'bytes'
    };
    if (!fs.existsSync(local)) return route.fulfill({ status: 404, headers, body: 'Not found' });
    const body = fs.readFileSync(local);
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      return route.fulfill({
        status: 206,
        headers: { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}` },
        body: body.subarray(start, end + 1)
      });
    }
    return route.fulfill({ status: 200, headers, body });
  });
}

// A pretend Screen Wake Lock that records what the app does with it.
const WAKE_LOCK = `
  window.__wake = { requests: 0, held: null };
  Object.defineProperty(navigator, 'wakeLock', { value: {
    request: () => {
      window.__wake.requests++;
      const listeners = [];
      const lock = {
        released: false,
        addEventListener: (t, f) => { if (t === 'release') listeners.push(f); },
        release: () => { lock.released = true; window.__wake.held = null; listeners.forEach((f) => f()); return Promise.resolve(); },
        __androidLetsGo: () => { lock.released = true; window.__wake.held = null; listeners.forEach((f) => f()); }
      };
      window.__wake.held = lock;
      return Promise.resolve(lock);
    }
  }});
`;

// ---------- Helpers ----------

let passed = 0;
const failures = [];
let browser;

async function newContext(opts = {}) {
  const context = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, ...opts });
  await context.addInitScript(WAKE_LOCK);
  await routeModels(context);
  return context;
}

async function test(name, fn, { context: makeContext } = {}) {
  if (ONLY && !name.includes(ONLY)) return;
  net.mode = 'ok';
  const context = makeContext ? await makeContext() : await newContext();
  const page = context.pages()[0] || await context.newPage();
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
    console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n       '));
    try { console.log('       status: ' + await page.locator('#file-status').innerText()); } catch (x) { /* ignore */ }
  } finally {
    await context.close().catch(() => {});
  }
}

const text = (page, sel) => page.locator(sel).innerText();
const fileText = (page) => page.locator('#file-transcript').inputValue();

async function openFileTab(page) {
  await page.click('#tab-file');
}

/** Pick a file the way a person does: tap the button, then choose in the picker. */
async function chooseFile(page, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#file-choose')]);
  await chooser.setFiles(file);
}

async function waitStatus(page, re, timeout = 120000) {
  await page.waitForFunction((src) => new RegExp(src, 'i').test(document.getElementById('file-status').textContent),
    re.source, { timeout, polling: 100 });
}

async function transcribe(page, file, { language = 'auto', speed = 'fast', timeout = 240000 } = {}) {
  await openFileTab(page);
  await page.selectOption('#file-language', language);
  await page.selectOption('#file-speed', speed);
  await chooseFile(page, file);
  await waitStatus(page, /Ready|long|Tap Start/);
  await page.click('#file-start');
  await waitStatus(page, /^Done/, timeout);
  return fileText(page);
}

const lower = (s) => s.toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ');

// ---------- Tests ----------

(async () => {
  const files = speechFiles();
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch();

  try {
    console.log('File tab');

    await test('File tab: pickers, title-case labels and the Wi-Fi note', async (page) => {
      await openFileTab(page);
      const langs = await page.$$eval('#file-language option', (o) => o.map((x) => x.textContent));
      assert.deepStrictEqual(langs, ['Auto-Detect', 'English', 'Filipino']);
      const speeds = await page.$$eval('#file-speed option', (o) => o.map((x) => x.textContent));
      assert.deepStrictEqual(speeds, ['Fast', 'Accurate']);
      assert.match(await text(page, '#model-note'), /First time only.*about 70 MB.*Wi-Fi/);
      await page.selectOption('#file-speed', 'accurate');
      await page.waitForFunction(() => /about 110 MB/.test(document.getElementById('model-note').textContent));
      assert.ok(await page.isDisabled('#file-start'));
      const labels = await page.$$eval('h1, h2, button, label, option, .interim-label', (els) =>
        els.filter((e) => e.offsetParent !== null || e.tagName === 'OPTION').map((e) => e.textContent.trim()).filter(Boolean));
      const small = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for']);
      for (const label of labels) {
        label.split(/[\s-]+/).forEach((word, i) => {
          const w = word.replace(/^[^A-Za-z]+/, '');
          if (!w || (i > 0 && small.has(w.toLowerCase()))) return;
          assert.ok(/^[A-Z]/.test(w), `"${label}" is not title case`);
        });
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, 'sideways scroll ' + overflow);
    });

    await test('English WAV: downloads the model once with progress, transcribes, then says it is ready', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /Ready/);
      assert.match(await text(page, '#file-details'), /11 seconds/);
      const seen = [];
      await page.exposeFunction('__seen', (t) => seen.push(t));
      await page.evaluate(() => new MutationObserver(() => window.__seen(document.getElementById('file-status').textContent))
        .observe(document.getElementById('file-status'), { childList: true, characterData: true, subtree: true }));
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
      assert.ok(seen.some((t) => /Downloading the speech model \(first time only\).*MB/.test(t)), 'download progress shown');
      assert.ok(seen.some((t) => /Transcribing… \d+%/.test(t)), 'percentage shown');
      const out = lower(await fileText(page));
      assert.ok(out.includes('ask not what your country can do for you'), out);
      assert.match(await text(page, '#word-count'), /^2\d Words$/);
      assert.match(await text(page, '#model-note'), /Fast is downloaded and ready/);
      await page.selectOption('#file-speed', 'accurate');
      await page.waitForFunction(() => /Accurate downloads the speech model \(about 80 MB\)/.test(document.getElementById('model-note').textContent));
      await page.selectOption('#file-speed', 'fast');
      assert.strictEqual(await page.evaluate(() => document.getElementById('file-progress').value), 100);
      // A second file: no download this time.
      seen.length = 0;
      await chooseFile(page, files.mp3);
      await page.click('#file-replace-yes');
      await waitStatus(page, /Ready/);
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
      assert.ok(!seen.some((t) => /Downloading/.test(t)), 'no second download');
    });

    for (const [label, key] of [['MP3', 'mp3'], ['M4A', 'm4a'], ['OGG (Opus)', 'ogg'], ['WEBM audio', 'webm'], ['FLAC', 'flac'], ['AAC', 'aac']]) {
      await test(`${label}: transcribed`, async (page) => {
        const out = lower(await transcribe(page, files[key], { language: 'english' }));
        assert.ok(out.includes('my fellow americans') && out.includes('your country'), out);
        assert.ok(!/Video/.test(await text(page, '#file-details')));
      });
    }

    await test('MP4 video (H.264 + AAC): only the sound is used', async (page) => {
      const out = lower(await transcribe(page, files.interview));
      assert.match(await text(page, '#file-details'), /Video \(sound only\)/);
      assert.ok(out.split(' ').length > 40, out);
    });

    await test('WEBM video (VP9 + Opus): only the sound is used', async (page) => {
      const out = lower(await transcribe(page, files.hopper));
      assert.match(await text(page, '#file-details'), /Video \(sound only\)/);
      assert.ok(out.split(' ').length > 30, out);
    });

    await test('MOV video: only the sound is used', async (page) => {
      const out = lower(await transcribe(page, files.mov));
      assert.match(await text(page, '#file-details'), /Video \(sound only\)/);
      assert.ok(out.includes('fellow americans'), out);
    });

    await test('Filipino with Auto-Detect on Accurate', async (page) => {
      const out = lower(await transcribe(page, files.fil, { speed: 'accurate' }));
      assert.ok(/\bang\b/.test(out) && /\bng\b|\bna\b|\bmga\b/.test(out), 'looks like Filipino: ' + out);
      assert.ok(/(malalaking|kagubatan|kegubatan|populasyon|pinagbago|pulis)/.test(out), out);
    });

    await test('Filipino chosen by hand on Fast', async (page) => {
      const out = lower(await transcribe(page, files.fil, { language: 'tagalog' }));
      assert.ok(/\bang\b/.test(out), out);
    });

    await test('timestamps: shown beside each section and can be turned off', async (page) => {
      await openFileTab(page);
      await page.check('#file-timestamps');
      await transcribe(page, files.ted, { language: 'english' });
      const lines = (await fileText(page)).split('\n').filter(Boolean);
      assert.ok(lines.length >= 2, 'several sections');
      assert.match(lines[0], /^\[0:00\] \S/);
      lines.forEach((l) => assert.match(l, /^\[\d:\d\d\] /));
      const words = Number((await text(page, '#word-count')).split(' ')[0]);
      await page.uncheck('#file-timestamps');
      const plain = (await fileText(page)).split('\n').filter(Boolean);
      assert.strictEqual(plain.length, lines.length);
      plain.forEach((l) => assert.ok(!/^\[/.test(l), l));
      assert.strictEqual(Number((await text(page, '#word-count')).split(' ')[0]), words, 'timestamps are not counted as words');
      // Settings are remembered.
      await page.check('#file-timestamps');
      await page.reload();
      await openFileTab(page);
      assert.ok(await page.isChecked('#file-timestamps'));
      assert.match((await fileText(page)).split('\n')[0], /^\[0:00\]/);
    });

    await test('the screen never freezes while Whisper works', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.ted);
      await waitStatus(page, /Ready/);
      await page.evaluate(() => {
        window.__gaps = [];
        let last = performance.now();
        window.__tick = setInterval(() => { const now = performance.now(); window.__gaps.push(now - last); last = now; }, 50);
      });
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
      const worst = await page.evaluate(() => { clearInterval(window.__tick); return Math.max(...window.__gaps); });
      assert.ok(worst < 400, `the page was stuck for ${Math.round(worst)} ms`);
    });

    await test('Keep Screen On: held while transcribing, asked again when Android lets go, released after', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.long40);
      await waitStatus(page, /long/);
      await page.click('#file-start');
      await waitStatus(page, /Transcribing… \d+%/);
      assert.ok(await page.evaluate(() => window.__wake.held && !window.__wake.held.released), 'screen kept on');
      const before = await page.evaluate(() => window.__wake.requests);
      await page.evaluate(() => window.__wake.held.__androidLetsGo());
      await page.waitForFunction((n) => window.__wake.requests > n && window.__wake.held, before, { timeout: 8000 });
      // Hidden then visible again (switching apps): asked again.
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        window.__wake.held && window.__wake.held.__androidLetsGo();
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(() => window.__wake.held, null, { timeout: 8000 });
      await page.click('#file-cancel');
      await waitStatus(page, /^Stopped/);
      assert.strictEqual(await page.evaluate(() => window.__wake.held), null, 'released after stopping');
    });

    await test('Cancel stops, keeps what is done, and Continue carries on without repeats', async (page) => {
      await openFileTab(page);
      await page.check('#file-timestamps');
      await chooseFile(page, files.long40);
      await waitStatus(page, /40 minutes long.*long time.*same file again/);
      await page.click('#file-start');
      await page.waitForFunction(() => document.getElementById('file-transcript').value.split('\n').filter(Boolean).length >= 2,
        null, { timeout: 120000 });
      await page.click('#file-cancel');
      await waitStatus(page, /Stopped at \d+:\d\d of 40:00/);
      assert.strictEqual(await text(page, '#file-start-label'), 'Continue Transcribing');
      assert.ok(await page.isVisible('#file-start'));
      assert.ok(!(await page.isVisible('#file-cancel')));
      const stoppedLines = (await fileText(page)).split('\n').filter(Boolean);
      await page.click('#file-start');
      await page.waitForFunction((n) => document.getElementById('file-transcript').value.split('\n').filter(Boolean).length >= n + 1,
        stoppedLines.length, { timeout: 120000 });
      await page.click('#file-cancel');
      await waitStatus(page, /Stopped at/);
      const lines = (await fileText(page)).split('\n').filter(Boolean);
      const stamps = lines.map((l) => l.match(/^\[(\d+):(\d\d)\]/)).map((m) => Number(m[1]) * 60 + Number(m[2]));
      for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] > stamps[i - 1], 'no repeated sections: ' + stamps.join(','));
      assert.deepStrictEqual(lines.slice(0, stoppedLines.length), stoppedLines);
    });

    await test('app closed mid-way: message on return, same file resumes from the saved section', async (page, context) => {
      await openFileTab(page);
      await page.check('#file-timestamps');
      await chooseFile(page, files.long40);
      await waitStatus(page, /long/);
      await page.click('#file-start');
      await page.waitForFunction(() => document.getElementById('file-transcript').value.split('\n').filter(Boolean).length >= 3,
        null, { timeout: 120000 });
      const savedLines = (await fileText(page)).split('\n').filter(Boolean);
      // The app closes (tab killed) while working.
      await page.close({ runBeforeUnload: false });
      const again = await context.newPage();
      await again.goto(URL);
      await openFileTab(again);
      await waitStatus(again, /stopped at \d+:\d\d of 40:00 when the app closed.*same file again/);
      const restored = (await fileText(again)).split('\n').filter(Boolean);
      assert.ok(restored.length >= savedLines.length, 'transcript survived');
      await chooseFile(again, files.long40);
      await again.waitForFunction(() => !document.getElementById('file-resume').hidden);
      assert.match(await text(again, '#file-resume-text'), /Continuing where you left off\. The first \d+:\d\d of 40:00 was already transcribed/);
      await waitStatus(again, /Transcribing… \d+% \(\d+:\d\d of 40:00\)/);
      await again.waitForFunction((n) => document.getElementById('file-transcript').value.split('\n').filter(Boolean).length >= n + 1,
        restored.length, { timeout: 120000 });
      await again.click('#file-cancel');
      await waitStatus(again, /Stopped at/);
      const lines = (await fileText(again)).split('\n').filter(Boolean);
      const stamps = lines.map((l) => { const m = l.match(/^\[(\d+):(\d\d)\]/); return Number(m[1]) * 60 + Number(m[2]); });
      for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] > stamps[i - 1], 'no repeats: ' + stamps.join(','));
      assert.deepStrictEqual(lines.slice(0, savedLines.length), savedLines, 'kept the earlier sections');
    });

    await test('phone restart (browser fully closed): same file resumes', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-profile-'));
      const launch = async () => {
        const ctx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'] });
        await ctx.addInitScript(WAKE_LOCK);
        await routeModels(ctx);
        return ctx;
      };
      let ctx = await launch();
      let page = ctx.pages()[0] || await ctx.newPage();
      await page.goto(URL);
      await openFileTab(page);
      await chooseFile(page, files.long40);
      await waitStatus(page, /long/);
      await page.click('#file-start');
      await page.waitForFunction(() => document.getElementById('file-transcript').value.trim().length > 50, null, { timeout: 120000 });
      await page.waitForTimeout(500);
      await ctx.close();                       // everything shuts down
      ctx = await launch();                    // and starts again later
      try {
        page = ctx.pages()[0] || await ctx.newPage();
        await page.goto(URL);
        await openFileTab(page);
        await waitStatus(page, /when the app closed/);
        await chooseFile(page, files.long40);
        await page.waitForFunction(() => /Continuing where you left off/.test(document.getElementById('file-resume-text').textContent));
        await waitStatus(page, /Transcribing… [1-9]?\d% \((?!0:00)\d+:\d\d of 40:00\)/);
        await page.click('#file-cancel');
        await waitStatus(page, /Stopped at/);
      } finally {
        await ctx.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, { context: () => newContext() });

    await test('Start Over transcribes again from the beginning', async (page) => {
      await transcribe(page, files.jfk, { language: 'english' });
      await chooseFile(page, files.jfk);
      await page.waitForFunction(() => /already transcribed/.test(document.getElementById('file-resume-text').textContent));
      assert.ok(await page.isDisabled('#file-start'));
      assert.ok((await fileText(page)).length > 20, 'saved transcript shown');
      await page.click('#file-start-over');
      await waitStatus(page, /^Done/);
      const out = lower(await fileText(page));
      assert.strictEqual(out.split('ask not what').length - 1, 1, 'transcribed once, not twice: ' + out);
    });

    await test('Start Over tapped twice: transcribed once, not wiped later', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.ted);
      await waitStatus(page, /Ready/);
      await page.click('#file-start');
      await page.waitForFunction(() => document.getElementById('file-transcript').value.length > 0, null, { timeout: 60000 });
      await page.evaluate(() => { const f = window.transcriberApp.file; f.startOver(); f.startOver(); });
      await waitStatus(page, /^Done/);
      const done = await fileText(page);
      await page.waitForTimeout(1500);
      assert.strictEqual(await fileText(page), done, 'not cleared again afterwards');
      assert.match(await text(page, '#file-status'), /^Done/);
      const firstLine = done.split('\n')[0];
      assert.strictEqual(done.split(firstLine).length - 1, 1, 'first section appears once');
    });

    await test('Start is blocked while a new file is still opening', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /Ready/);
      await page.setInputFiles('#file-input', files.long40);
      const started = await page.evaluate(() => { window.transcriberApp.file.start(); return window.transcriberApp.file.running; });
      assert.strictEqual(started, false);
      await waitStatus(page, /long/);
      assert.strictEqual(await text(page, '#file-name'), 'speech-40min.mp3');
    });

    console.log('Problems, in plain words');

    await test('a text file: "not supported"', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.text);
      await waitStatus(page, /This file type is not supported/);
      assert.strictEqual(await page.getAttribute('#file-status', 'data-kind'), 'error');
      assert.ok(await page.isDisabled('#file-start'));
    });

    await test('a damaged file: "could not be read"', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.broken);
      await waitStatus(page, /could not be read|not supported/);
    });

    await test('a video with no sound: says so', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.noSound);
      await waitStatus(page, /no sound to transcribe/);
    });

    await test('no internet on first use: says to connect, names the download size', async (page, context) => {
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /Ready/);
      await context.setOffline(true);
      await page.click('#file-start');
      await waitStatus(page, /No internet connection\. The first time you use Fast.*about 70 MB.*Wi-Fi/);
      assert.ok(await page.isEnabled('#file-start'), 'can try again');
      await context.setOffline(false);
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
    });

    await test('model download fails: plain message, can try again', async (page) => {
      await openFileTab(page);
      await chooseFile(page, files.jfk);
      await waitStatus(page, /Ready/);
      net.mode = 'fail';
      await page.click('#file-start');
      await waitStatus(page, /could not be downloaded.*internet/);
      net.mode = 'ok';
      await page.click('#file-start');
      await waitStatus(page, /^Done/);
    });

    await test('not enough memory: plain message, progress kept', async (page, context) => {
      // Swap in a worker that runs out of memory on the third piece.
      await context.route('**/whisper-worker.js', async (route) => {
        const src = fs.readFileSync(path.join(ROOT, 'whisper-worker.js'), 'utf8').replace(
          'const result = await transcribe(msg);',
          'if (msg.id === 3) throw new RangeError("Array buffer allocation failed"); const result = await transcribe(msg);');
        await route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript' }, body: src });
      });
      await openFileTab(page);
      await chooseFile(page, files.long40);
      await waitStatus(page, /long/);
      await page.click('#file-start');
      await waitStatus(page, /ran out of memory\. Close other apps.*progress is saved/);
      assert.strictEqual(await text(page, '#file-start-label'), 'Continue Transcribing');
      assert.ok((await fileText(page)).trim().length > 20, 'earlier pieces kept');
    });

    console.log('Output tools');

    await test('Live: word count, Copy, Download (.txt with date and time), Clear with confirm, survives refresh', async (page, context) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
      assert.ok(await page.isDisabled('#copy-button'), 'nothing to copy yet');
      await page.fill('#transcript', 'Magandang umaga po. This is a test.');
      assert.strictEqual(await text(page, '#word-count'), '7 Words');
      await page.click('#copy-button');
      await page.waitForFunction(() => /Copied/.test(document.getElementById('output-status').textContent));
      assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), 'Magandang umaga po. This is a test.');
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-button')]);
      assert.match(download.suggestedFilename(), /^transcript-live-\d{4}-\d\d-\d\d_\d\d-\d\d\.txt$/);
      const saved = fs.readFileSync(await download.path(), 'utf8');
      assert.strictEqual(saved.trim(), 'Magandang umaga po. This is a test.');
      await page.reload();
      assert.strictEqual(await page.inputValue('#transcript'), 'Magandang umaga po. This is a test.');
      assert.strictEqual(await text(page, '#word-count'), '7 Words');
      await page.click('#clear-button');
      assert.ok(await page.isVisible('#clear-confirm'));
      assert.match(await text(page, '#clear-confirm-text'), /Clear the whole Live transcript/);
      await page.click('#clear-no');
      assert.ok(!(await page.isVisible('#clear-confirm')));
      assert.strictEqual(await page.inputValue('#transcript'), 'Magandang umaga po. This is a test.');
      await page.click('#clear-button');
      await page.click('#clear-yes');
      assert.strictEqual(await page.inputValue('#transcript'), '');
      assert.strictEqual(await text(page, '#word-count'), '0 Words');
      await page.reload();
      assert.strictEqual(await page.inputValue('#transcript'), '');
    });

    await test('File: Download is named after the recording, Clear is off while working, transcript survives refresh', async (page, context) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
      await openFileTab(page);
      await chooseFile(page, files.ted);
      await waitStatus(page, /Ready/);
      await page.click('#file-start');
      await waitStatus(page, /Transcribing/);
      await page.waitForFunction(() => document.getElementById('file-transcript').value.length > 0, null, { timeout: 60000 });
      assert.ok(await page.isDisabled('#clear-button'), 'no clearing while it works');
      await waitStatus(page, /^Done/);
      assert.ok(await page.isEnabled('#clear-button'));
      const out = await fileText(page);
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-button')]);
      assert.match(download.suggestedFilename(), /^transcript-ted_60-\d{4}-\d\d-\d\d_\d\d-\d\d\.txt$/);
      assert.strictEqual(fs.readFileSync(await download.path(), 'utf8').replace(/\r\n/g, '\n').trim(), out.trim());
      await page.click('#copy-button');
      await page.waitForFunction(() => /Copied/.test(document.getElementById('output-status').textContent));
      assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), out);
      // Live and File keep separate transcripts.
      await page.click('#tab-live');
      assert.strictEqual(await page.inputValue('#transcript'), '');
      await page.click('#tab-file');
      await page.reload();
      await openFileTab(page);
      assert.strictEqual(await fileText(page), out);
      const words = Number((await text(page, '#word-count')).split(' ')[0]);
      assert.ok(words > 50, 'word count ' + words);
      await page.click('#clear-button');
      assert.match(await text(page, '#clear-confirm-text'), /Clear the whole File transcript/);
      await page.click('#clear-yes');
      assert.strictEqual(await fileText(page), '');
      await page.reload();
      await openFileTab(page);
      assert.strictEqual(await fileText(page), '');
    });

    await test('choosing a different file asks before replacing the transcript', async (page) => {
      await transcribe(page, files.jfk, { language: 'english' });
      const first = await fileText(page);
      await chooseFile(page, files.courtroom);
      await page.waitForSelector('#file-replace', { state: 'visible' });
      assert.match(await text(page, '#file-replace-text'), /from “jfk\.wav”.*“courtroom\.mp4” will replace it/);
      await page.click('#file-replace-no');
      assert.strictEqual(await fileText(page), first);
      await chooseFile(page, files.courtroom);
      await page.click('#file-replace-yes');
      await waitStatus(page, /Ready/);
      assert.strictEqual(await fileText(page), '');
      assert.strictEqual(await text(page, '#file-name'), 'courtroom.mp4');
    });

    await test('typing in the File transcript is kept and saved', async (page) => {
      await transcribe(page, files.jfk, { language: 'english' });
      await page.locator('#file-transcript').press('End');
      await page.keyboard.type(' (Edited by hand.)');
      const edited = await fileText(page);
      await page.reload();
      await openFileTab(page);
      assert.strictEqual(await fileText(page), edited);
      await page.check('#file-timestamps');
      assert.strictEqual(await fileText(page), edited, 'edits not thrown away');
      assert.match(await text(page, '#file-status'), /edits are kept/);
    });

    if (LONG) {
      console.log('Long recordings (2.5 hours) in Chrome');
      const long = longFiles();
      for (const [label, file] of Object.entries(long)) {
        await test(`${label}: 2.5 hours read end to end in sections by Chrome, memory stays low`, async (page) => {
          await page.setInputFiles('#file-input', file).catch(() => {});
          const result = await page.evaluate(async () => {
            const file = document.getElementById('file-input').files[0];
            const reader = await window.AudioReader.open(file);
            const chunker = new window.AudioReader.Chunker(reader);
            let t = 0, n = 0, gaps = 0, peak = 0;
            for (;;) {
              const c = await chunker.next();
              if (!c) break;
              if (Math.abs(c.start - t) > 1e-6) gaps++;
              t = c.end; n++;
              if (n % 20 === 0 && performance.memory) peak = Math.max(peak, performance.memory.usedJSHeapSize);
            }
            return { duration: reader.duration, covered: t, n, gaps, peak, label: reader.label };
          });
          assert.ok(Math.abs(result.duration - 9000) < 20, 'duration ' + result.duration);
          assert.ok(Math.abs(result.covered - 9000) < 5, 'covered ' + result.covered);
          assert.strictEqual(result.gaps, 0);
          assert.ok(result.peak < 300 * 1048576, 'heap ' + Math.round(result.peak / 1048576) + ' MB');
          console.log(`       ${result.n} pieces, ${result.label}, heap at most ${Math.round(result.peak / 1048576)} MB`);
        });
      }
      await test('2.5-hour MP3 in the app: long warning, transcribes, resumes deep in the file', async (page) => {
        await openFileTab(page);
        await chooseFile(page, long.mp3);
        await waitStatus(page, /2 hours 30 minutes long/);
        assert.match(await text(page, '#file-details'), /2 hours 30 minutes/);
        await page.click('#file-start');
        await waitStatus(page, /Transcribing… \d+% \(0:0\d:\d\d of 2:30:00\)/);
        await page.waitForFunction(() => document.getElementById('file-transcript').value.split('\n').filter(Boolean).length >= 2,
          null, { timeout: 120000 });
        await page.click('#file-cancel');
        await waitStatus(page, /Stopped at 0:0\d:\d\d of 2:30:00/);
        await page.reload();
        await openFileTab(page);
        await chooseFile(page, long.mp3);
        await waitStatus(page, /Transcribing… \d+% \(0:0\d:\d\d of 2:30:00\)/);
        await page.click('#file-cancel');
        await waitStatus(page, /Stopped at/);
      });
    }
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
