/*
 * Browser tests for the Live tab, using a fake SpeechRecognition so they run
 * without a real microphone. Run from the repo root:
 *
 *   node tests/live.test.js
 *
 * Needs Python 3 (serves the files) and Playwright (require('playwright')).
 */
'use strict';
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8765;
const URL = `http://localhost:${PORT}/index.html`;

// Installed before the page loads. Records every recognizer the app creates.
const FAKE = `
  window.__recs = [];
  window.__permission = 'granted';
  window.__autoStart = true;  // real Chrome fires onstart only once the mic is allowed
  class FakeRecognition {
    constructor() { this.started = false; this.stopped = false; window.__recs.push(this); }
    start() { this.started = true; if (window.__autoStart) setTimeout(() => this.onstart && this.onstart(), 0); }
    stop() { this.stopped = true; setTimeout(() => this.onend && this.onend(), 0); }
    abort() { this.stopped = true; setTimeout(() => this.onend && this.onend(), 0); }
  }
  window.webkitSpeechRecognition = FakeRecognition;
  window.SpeechRecognition = FakeRecognition;
  window.__current = () => window.__recs[window.__recs.length - 1];
  // results: [[text, isFinal], ...]
  window.__emit = (results, resultIndex = 0) => {
    const list = results.map(([t, f]) => { const r = [{ transcript: t }]; r.isFinal = f; return r; });
    window.__current().onresult({ resultIndex, results: list });
  };
  window.__error = (code) => window.__current().onerror({ error: code });
  window.__end = () => { const r = window.__current(); r.onend && r.onend(); };
  window.__hidden = false;
  Object.defineProperty(document, 'hidden', { get: () => window.__hidden });
  window.__setHidden = (h) => { window.__hidden = h; document.dispatchEvent(new Event('visibilitychange')); };
  Object.defineProperty(navigator, 'permissions', { value: {
    query: () => Promise.resolve({ state: window.__permission })
  }});
`;

const NO_SPEECH_API = `
  delete window.webkitSpeechRecognition;
  delete window.SpeechRecognition;
`;

let passed = 0;
const failures = [];

async function test(name, browser, fn, { init = FAKE } = {}) {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(URL);
    await fn(page);
    assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join('; '));
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + e.message.split('\n').join('\n       '));
  } finally {
    await context.close();
  }
}

const text = (page, sel) => page.locator(sel).innerText();
const value = (page) => page.locator('#transcript').inputValue();
const recCount = (page) => page.evaluate(() => window.__recs.length);
const state = (page) => page.evaluate(() => document.body.dataset.liveState);

async function startListening(page) {
  await page.click('#live-toggle');
  await page.waitForFunction(() => document.body.dataset.liveState === 'listening');
}

(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore'
  });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();

  try {
    await test('opens on the Live tab, English only: no language picker', browser, async (page) => {
      assert.strictEqual(await page.title(), 'Transcriber');
      assert.strictEqual(await text(page, '.app-title'), 'Transcriber');
      assert.ok(await page.isVisible('#panel-live'));
      assert.ok(!(await page.isVisible('#panel-file')));
      assert.strictEqual(await page.locator('#live-language, select').count(), 0);
      assert.ok(!/Filipino|Language/.test(await text(page, '#panel-live')));
      assert.strictEqual(await text(page, '#live-toggle-label'), 'Start Listening');
    });

    await test('File tab shows the file controls and its own transcript', browser, async (page) => {
      await page.click('#tab-file');
      assert.ok(await page.isVisible('#panel-file'));
      assert.ok(!(await page.isVisible('#panel-live')));
      assert.strictEqual(await text(page, '#file-choose'), 'Choose Audio or Video File');
      assert.ok(await page.isVisible('#file-output'));
      assert.ok(!(await page.isVisible('#transcript')));
      assert.strictEqual(await text(page, '#output-heading'), 'File Transcript');
      await page.click('#tab-live');
      assert.ok(await page.isVisible('#panel-live'));
      assert.ok(await page.isVisible('#transcript'));
      assert.strictEqual(await text(page, '#output-heading'), 'Live Transcript');
    });

    await test('headings and buttons are in title case', browser, async (page) => {
      const labels = await page.$$eval('h1, h2, button, .interim-label', (els) =>
        els.map((e) => e.textContent.trim()).filter(Boolean));
      const small = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for']);
      for (const label of labels) {
        label.split(/\s+/).forEach((word, i) => {
          const w = word.replace(/^[^A-Za-z]+/, '');
          if (!w || (i > 0 && small.has(w.toLowerCase()))) return;
          assert.ok(/^[A-Z]/.test(w), `"${label}" is not title case`);
        });
      }
    });

    await test('Start listens in English and shows listening', browser, async (page) => {
      await startListening(page);
      assert.strictEqual(await page.evaluate(() => window.__current().lang), 'en-US');
      assert.strictEqual(await page.evaluate(() => window.__current().continuous), true);
      assert.strictEqual(await page.evaluate(() => window.__current().interimResults), true);
      assert.strictEqual(await text(page, '#live-toggle-label'), 'Stop Listening');
      assert.strictEqual(await page.getAttribute('#live-toggle', 'aria-pressed'), 'true');
      assert.match(await text(page, '#live-status'), /Listening/);
    });

    await test('a language saved by the earlier version (Filipino) is ignored: always English', browser, async (page) => {
      await page.evaluate(() => localStorage.setItem('transcriber.liveLanguage', 'fil-PH'));
      await page.reload();
      await startListening(page);
      assert.strictEqual(await page.evaluate(() => window.__current().lang), 'en-US');
    });

    await test('interim words show in grey, then move to the transcript when final', browser, async (page) => {
      await startListening(page);
      await page.evaluate(() => window.__emit([['hello wor', false]]));
      assert.ok(await page.isVisible('.interim-box'));
      assert.strictEqual(await text(page, '#interim'), 'hello wor');
      assert.strictEqual(await value(page), '');
      const color = await page.$eval('#interim', (e) => getComputedStyle(e).color);
      assert.strictEqual(color, 'rgb(122, 131, 148)');
      await page.evaluate(() => window.__emit([['hello world', true]]));
      assert.strictEqual(await value(page), 'hello world');
      assert.ok(!(await page.isVisible('.interim-box')));
      await page.evaluate(() => window.__emit([['hello world', true], ['how are you', false]], 1));
      await page.evaluate(() => window.__emit([['hello world', true], ['how are you', true]], 1));
      assert.strictEqual(await value(page), 'hello world how are you');
    });

    await test('repeated final results (Android quirk) are not duplicated', browser, async (page) => {
      await startListening(page);
      await page.evaluate(() => window.__emit([['good morning', true]]));
      // Same index delivered again
      await page.evaluate(() => window.__emit([['good morning', true]], 0));
      // Next result repeats the previous one plus new words
      await page.evaluate(() => window.__emit([['good morning', true], ['good morning to you all', true]], 1));
      assert.strictEqual(await value(page), 'good morning to you all');
    });

    await test('auto-restarts after Chrome stops on a pause, keeping the text', browser, async (page) => {
      await startListening(page);
      await page.evaluate(() => window.__emit([['first part', true]]));
      await page.evaluate(() => window.__error('no-speech'));
      assert.match(await text(page, '#live-status'), /No speech heard/);
      await page.evaluate(() => window.__end());
      await page.waitForFunction(() => window.__recs.length === 2 && window.__recs[1].started);
      await page.waitForFunction(() => document.body.dataset.liveState === 'listening');
      await page.evaluate(() => window.__emit([['second part', true]]));
      assert.strictEqual(await value(page), 'first part second part');
      assert.strictEqual(await text(page, '#live-toggle-label'), 'Stop Listening');
    });

    await test('words still being heard are kept if Chrome stops early', browser, async (page) => {
      await startListening(page);
      await page.evaluate(() => window.__emit([['unfinished words', false]]));
      await page.evaluate(() => window.__end());
      assert.strictEqual(await value(page), 'unfinished words');
      assert.strictEqual(await text(page, '#interim'), '');
      await page.waitForFunction(() => window.__recs.length === 2);
    });

    await test('Stop ends listening and does not restart', browser, async (page) => {
      await startListening(page);
      await page.evaluate(() => window.__emit([['keep me', false]]));
      await page.click('#live-toggle');
      await page.waitForFunction(() => document.body.dataset.liveState === 'idle');
      await page.waitForTimeout(600);
      assert.strictEqual(await recCount(page), 1);
      assert.strictEqual(await text(page, '#live-toggle-label'), 'Start Listening');
      assert.strictEqual(await value(page), 'keep me');
      assert.match(await text(page, '#live-status'), /Stopped/);
    });

    await test('new words are added after text the user typed', browser, async (page) => {
      await page.fill('#transcript', 'My notes:');
      await startListening(page);
      await page.evaluate(() => window.__emit([['spoken words', true]]));
      assert.strictEqual(await value(page), 'My notes: spoken words');
    });

    await test('permission denied: clear message, no restart', browser, async (page) => {
      await startListening(page);
      await page.evaluate(() => window.__error('not-allowed'));
      await page.evaluate(() => window.__end());
      await page.waitForFunction(() => document.body.dataset.liveState === 'idle');
      await page.waitForTimeout(600);
      assert.strictEqual(await recCount(page), 1);
      assert.match(await text(page, '#live-status'), /Microphone permission is blocked/);
      assert.strictEqual(await page.getAttribute('#live-status', 'data-kind'), 'error');
    });

    await test('permission already blocked: message shown before starting', browser, async (page) => {
      await page.evaluate(() => { window.__permission = 'denied'; });
      await page.click('#live-toggle');
      await page.waitForFunction(() => document.body.dataset.liveState === 'idle');
      assert.strictEqual(await recCount(page), 0);
      assert.match(await text(page, '#live-status'), /Microphone permission is blocked/);
    });

    await test('first time: asks the user to tap Allow', browser, async (page) => {
      await page.evaluate(() => { window.__permission = 'prompt'; window.__autoStart = false; });
      await page.click('#live-toggle');
      await page.waitForFunction(() => window.__recs.length === 1);
      assert.match(await text(page, '#live-status'), /Tap Allow/);
      // User taps Allow; Chrome starts listening.
      await page.evaluate(() => window.__current().onstart());
      assert.match(await text(page, '#live-status'), /Listening/);
    });

    await test('no internet before starting: plain message', browser, async (page) => {
      await page.context().setOffline(true);
      await page.click('#live-toggle');
      assert.match(await text(page, '#live-status'), /No internet connection/);
      assert.strictEqual(await state(page), 'idle');
      assert.strictEqual(await recCount(page), 0);
    });

    await test('internet lost while listening: plain message, stops', browser, async (page) => {
      await startListening(page);
      await page.context().setOffline(true);
      await page.evaluate(() => window.__error('network'));
      await page.evaluate(() => window.__end());
      await page.waitForFunction(() => document.body.dataset.liveState === 'idle');
      assert.match(await text(page, '#live-status'), /No internet connection/);
    });

    await test('network hiccup while online: retries, then gives up', browser, async (page) => {
      await startListening(page);
      for (let i = 1; i <= 3; i++) {
        await page.evaluate(() => window.__error('network'));
        assert.match(await text(page, '#live-status'), /Trying again/);
        await page.evaluate(() => window.__end());
        await page.waitForFunction((n) => window.__recs.length === n + 1 && window.__recs[n].started, i);
      }
      await page.evaluate(() => window.__error('network'));
      await page.evaluate(() => window.__end());
      await page.waitForFunction(() => document.body.dataset.liveState === 'idle');
      assert.match(await text(page, '#live-status'), /Lost connection/);
    });

    await test('no microphone: plain message', browser, async (page) => {
      await startListening(page);
      await page.evaluate(() => window.__error('audio-capture'));
      await page.evaluate(() => window.__end());
      await page.waitForFunction(() => document.body.dataset.liveState === 'idle');
      assert.match(await text(page, '#live-status'), /No microphone/);
    });

    await test('stops trying if Chrome keeps ending straight away', browser, async (page) => {
      await startListening(page);
      for (let i = 0; i < 12; i++) {
        const n = await recCount(page);
        await page.evaluate(() => { const r = window.__current(); r.onend && r.onend(); });
        await page.waitForTimeout(300);
        if (await state(page) === 'idle') break;
        assert.ok(await recCount(page) > n);
      }
      assert.strictEqual(await state(page), 'idle');
      assert.match(await text(page, '#live-status'), /keeps stopping/);
    });

    await test('pauses in the background and resumes on return', browser, async (page) => {
      await startListening(page);
      await page.evaluate(() => window.__emit([['before', true]]));
      await page.evaluate(() => { window.__setHidden(true); window.__end(); });
      await page.waitForFunction(() => document.body.dataset.liveState === 'paused');
      assert.match(await text(page, '#live-status'), /Paused/);
      assert.strictEqual(await recCount(page), 1);
      assert.strictEqual(await text(page, '#live-toggle-label'), 'Stop Listening');
      await page.evaluate(() => window.__setHidden(false));
      await page.waitForFunction(() => document.body.dataset.liveState === 'listening');
      assert.strictEqual(await recCount(page), 2);
      await page.evaluate(() => window.__emit([['after', true]]));
      assert.strictEqual(await value(page), 'before after');
    });

    await test('browser without speech support: button disabled with a message', browser, async (page) => {
      assert.ok(await page.isDisabled('#live-toggle'));
      assert.match(await text(page, '#live-status'), /open this page in Google Chrome/);
    }, { init: NO_SPEECH_API });

    await test('page fits a phone screen with no sideways scroll', browser, async (page) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, 'overflow ' + overflow);
      const h = await page.$eval('#live-toggle', (e) => e.getBoundingClientRect().height);
      assert.ok(h >= 48);
    });
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
