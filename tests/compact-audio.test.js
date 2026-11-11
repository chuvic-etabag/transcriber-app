/*
 * Browser tests for compact-audio.js: every kind of file becomes a small
 * mono Ogg Opus file that ffmpeg can play, with the sound in exactly the same
 * place in time. Run from the repo root:
 *
 *   node tests/compact-audio.test.js        (add --long for a 3-hour recording)
 *
 * Needs Python 3, ffmpeg and Playwright with Chromium.
 */
'use strict';
const { chromium } = require('playwright');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const media = require('./media');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8767;
const PAGE = `http://localhost:${PORT}/__compact-test.html`;
const LONG = process.argv.includes('--long');

const BEEPS = [1.0, 7.5, 61.25, 130.6, 179.05];
const LENGTH = 185;

/** Silence with short 1 kHz beeps at known moments, so the timeline can be checked. */
function beepSource() {
  const file = path.join(media.DIR, 'beeps.wav');
  if (fs.existsSync(file)) return file;
  const on = BEEPS.map((t) => `between(t\\,${t}\\,${(t + 0.12).toFixed(2)})`).join('+');
  media.ff(['-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*1000*t)*(${on})|0.5*sin(2*PI*1000*t)*(${on}):s=44100:d=${LENGTH}`,
    '-c:a', 'pcm_s16le', file]);
  return file;
}

function beepFiles() {
  const src = beepSource();
  const V = ['-f', 'lavfi', '-i', `testsrc=size=160x120:rate=5:duration=${LENGTH}`];
  const video = (name, args) => {
    const file = path.join(media.DIR, name);
    if (!fs.existsSync(file)) media.ff(V.concat(['-i', src, '-map', '0:v', '-map', '1:a'], args, ['-shortest', file]));
    return file;
  };
  return {
    'WAV (stereo, 44.1 kHz)': src,
    'MP3': media.make('beeps.mp3', src, ['-c:a', 'libmp3lame', '-b:a', '96k']),
    'M4A': media.make('beeps.m4a', src, ['-c:a', 'aac', '-b:a', '96k']),
    'OGG (Opus)': media.make('beeps.ogg', src, ['-c:a', 'libopus', '-b:a', '48k']),
    'FLAC': media.make('beeps.flac', src, ['-c:a', 'flac']),
    'MP4 video': video('beeps.mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac']),
    'WEBM video': video('beeps.webm', ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus'])
  };
}

function decode16k(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'], { maxBuffer: 2 ** 31 });
  assert.strictEqual(r.status, 0, 'ffmpeg could not play the file: ' + r.stderr);
  const copy = new Uint8Array(r.stdout.length);
  copy.set(r.stdout);
  return new Float32Array(copy.buffer, 0, Math.floor(r.stdout.length / 4));
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate:format=duration,format_name',
    '-of', 'json', file]);
  return JSON.parse(r.stdout.toString());
}

/** Where each beep starts in the decoded sound (seconds). */
function onsets(samples) {
  return BEEPS.map((t) => {
    const from = Math.max(0, Math.round((t - 0.4) * 16000));
    for (let i = from; i < Math.min(samples.length, from + 16000); i++) {
      if (Math.abs(samples[i]) > 0.1) return i / 16000;
    }
    return null;
  });
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n       '));
  }
}

(async () => {
  const files = beepFiles();
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.route('**/__compact-test.html', (route) => route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: '<!doctype html><input type="file" id="f"><script src="audio-reader.js"></script><script src="compact-audio.js"></script>'
  }));
  const page = await context.newPage();
  await page.goto(PAGE);

  async function convert(file, opts = {}) {
    await page.setInputFiles('#f', file);
    return page.evaluate(async ({ keep, stopAt }) => {
      const file = document.getElementById('f').files[0];
      const reader = await window.AudioReader.open(file);
      const started = performance.now();
      let calls = 0, last = 0, backwards = false;
      try {
        const out = await window.CompactAudio.convert(reader, {
          onProgress: (f) => { calls++; if (f < last) backwards = true; last = f; },
          isStopped: () => stopAt !== undefined && last >= stopAt
        });
        let b64 = null;
        if (keep) {
          const bytes = new Uint8Array(await out.blob.arrayBuffer());
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          b64 = btoa(s);
        }
        return { ok: true, b64, bytes: out.bytes, duration: out.duration, bitrate: out.bitrate, type: out.blob.type,
          readerDuration: reader.duration, ms: performance.now() - started, calls, last, backwards,
          heap: performance.memory ? performance.memory.usedJSHeapSize : 0 };
      } catch (e) {
        return { ok: false, code: e.code, message: String(e.message) };
      }
    }, { keep: opts.keep !== false, stopAt: opts.stopAt });
  }

  try {
    console.log('Compact audio');

    await test('this Chromium has the Opus encoder', async () => {
      assert.strictEqual(await page.evaluate(() => window.CompactAudio.isSupported()), true);
    });

    for (const [label, file] of Object.entries(files)) {
      await test(`${label}: small mono Ogg Opus, plays in ffmpeg, sound in the same place in time`, async () => {
        const out = await convert(file);
        assert.ok(out.ok, out.message);
        assert.strictEqual(out.type, 'audio/ogg');
        const ogg = path.join(media.DIR, 'out-' + path.basename(file) + '.ogg');
        fs.writeFileSync(ogg, Buffer.from(out.b64, 'base64'));
        const info = probe(ogg);
        assert.strictEqual(info.format.format_name, 'ogg');
        assert.strictEqual(info.streams[0].codec_name, 'opus');
        assert.strictEqual(info.streams[0].channels, 1);
        assert.ok(Math.abs(Number(info.format.duration) - LENGTH) < 0.08, 'length ' + info.format.duration);
        assert.ok(Math.abs(out.duration - LENGTH) < 0.08, 'reported length ' + out.duration);
        const perSecond = out.bytes / LENGTH;
        assert.ok(perSecond < 3600, Math.round(perSecond) + ' bytes a second');  // mostly silence, so much smaller than speech
        const samples = decode16k(ogg);
        const found = onsets(samples);
        // Compare with the original file decoded by ffmpeg. MP3 and AAC start with a few
        // milliseconds of codec warm-up that Chrome keeps and ffmpeg trims, so allow a small,
        // steady offset, but no drift: every beep must be off by the same amount
        // (within 10 ms; the transcript shows whole seconds).
        const expected = onsets(decode16k(file));
        const offsets = found.map((t, i) => {
          assert.ok(t !== null, `beep at ${BEEPS[i]} s is there`);
          return t - expected[i];
        });
        const first = offsets[0];
        assert.ok(Math.abs(first) < 0.05, `offset ${first.toFixed(3)} s`);
        offsets.forEach((o, i) => assert.ok(Math.abs(o - first) < 0.01,
          `beep at ${BEEPS[i]} s drifted: ${offsets.map((x) => x.toFixed(3)).join(', ')}`));
        assert.ok(out.calls > 2 && !out.backwards && out.last === 1, 'progress goes up to 100%');
      });
    }

    await test('real speech: about 3 KB a second, so 3 hours fits in 50 MB', async () => {
      const out = await convert(media.speech('ted_60.wav'), { keep: false });
      assert.ok(out.ok, out.message);
      const threeHours = out.bytes / out.duration * 3 * 3600;
      assert.ok(threeHours < 40 * 1000 * 1000, Math.round(threeHours / 1e6) + ' MB for 3 hours');
      console.log(`       ${Math.round(out.bytes / out.duration)} bytes a second; 3 hours would be about ${Math.round(threeHours / 1e6)} MB`);
    });

    await test('very long recordings get a lower bitrate so they still fit', async () => {
      const rates = await page.evaluate(() => [1, 3600, 3 * 3600, 4 * 3600, 6 * 3600, 10 * 3600].map((s) => window.CompactAudio.bitrateFor(s)));
      assert.deepStrictEqual(rates.slice(0, 4), [24000, 24000, 24000, 24000]);
      assert.ok(rates[4] < 24000 && rates[4] >= 8000 && rates[4] * 6 * 3600 / 8 < 45e6, String(rates[4]));
      assert.ok(rates[5] >= 8000 && rates[5] * 10 * 3600 / 8 < 46e6, String(rates[5]));
    });

    await test('Stop part-way: stops reading and says so', async () => {
      const out = await convert(files.MP3, { stopAt: 0.3, keep: false });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.code, 'stopped');
    });

    await test('a video with no sound: says there is no sound', async () => {
      const file = path.join(media.DIR, 'silent-video.mp4');
      if (!fs.existsSync(file)) {
        media.ff(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', file]);
      }
      await page.setInputFiles('#f', file);
      const code = await page.evaluate(() => window.AudioReader.open(document.getElementById('f').files[0]).then(() => 'opened', (e) => e.code));
      assert.strictEqual(code, 'noAudio');
    });

    if (LONG) {
      await test('3-hour MP3: converted in sections, under 50 MB, memory stays low', async () => {
        const file = path.join(media.DIR, 'speech-3h.mp3');
        if (!fs.existsSync(file)) {
          media.ff(['-stream_loop', '-1', '-i', media.speech('ted_60.wav'), '-t', '10800', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', file]);
        }
        const out = await convert(file, { keep: false });
        assert.ok(out.ok, out.message);
        assert.ok(Math.abs(out.duration - 10800) < 1, 'length ' + out.duration);
        assert.ok(out.bytes < 50 * 1024 * 1024, out.bytes + ' bytes');
        console.log(`       ${(out.bytes / 1e6).toFixed(1)} MB, took ${Math.round(out.ms / 1000)} s, heap ${Math.round(out.heap / 1048576)} MB`);
      });
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
