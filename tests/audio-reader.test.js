/*
 * Tests for audio-reader.js in Node, with ffmpeg standing in for Chrome's
 * decoder (Chrome's decoder is built from ffmpeg too). Run from the repo root:
 *
 *   node tests/audio-reader.test.js          (add --long for the 2.5-hour files)
 *
 * For every format it checks that reading the file a section at a time gives
 * the same sound, in the same place, as decoding the whole file at once.
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const media = require('./media');
const AudioReader = require('../audio-reader.js');

const RATE = 16000;
const LONG = process.argv.includes('--long');

function ffDecode(bytes) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', String(RATE), 'pipe:1'],
    { input: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), maxBuffer: 2 ** 30 });
  if (r.status !== 0) return Promise.reject(new Error('ffmpeg: ' + r.stderr.toString().slice(0, 300)));
  const out = r.stdout;
  const copy = new Uint8Array(out.length);
  copy.set(out);
  return Promise.resolve(new Float32Array(copy.buffer, 0, Math.floor(out.length / 4)));
}

function reference(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-f', 'f32le', '-ac', '1', '-ar', String(RATE), 'pipe:1'],
    { maxBuffer: 2 ** 31 });
  const copy = new Uint8Array(r.stdout.length);
  copy.set(r.stdout);
  return new Float32Array(copy.buffer, 0, Math.floor(r.stdout.length / 4));
}

async function blobFor(file, type) {
  const blob = await fs.openAsBlob(file, { type: type || '' });
  return new File([blob], path.basename(file), { type: type || '' });
}

/** Read every chunk through the Chunker, like the app does. */
async function readAll(reader, opts) {
  const chunker = new AudioReader.Chunker(reader, opts);
  const chunks = [];
  for (;;) {
    const c = await chunker.next();
    if (!c) break;
    chunks.push(c);
  }
  return chunks;
}

function joinAudio(chunks) {
  const n = chunks.reduce((a, c) => a + c.audio.length, 0);
  const out = new Float32Array(n);
  let p = 0;
  for (const c of chunks) { out.set(c.audio, p); p += c.audio.length; }
  return out;
}

/**
 * Compare `got` to `ref` one second at a time: find the best small shift and
 * the match at that shift. Codecs add a fixed delay of a few milliseconds,
 * so we allow a constant shift but not drift.
 */
function compare(got, ref, fromSec, toSec) {
  const W = RATE, MAXLAG = Math.round(0.08 * RATE);
  const lags = [], scores = [];
  for (let s = fromSec; s < toSec - 1; s++) {
    const a = s * W;
    if (a + W + MAXLAG > got.length || a + W + MAXLAG > ref.length || a < MAXLAG) continue;
    let best = -2, bestLag = 0;
    for (let lag = -MAXLAG; lag <= MAXLAG; lag += 4) {
      let xy = 0, xx = 0, yy = 0;
      for (let i = a; i < a + W; i += 2) {
        const x = got[i], y = ref[i + lag];
        xy += x * y; xx += x * x; yy += y * y;
      }
      const c = xy / Math.sqrt(xx * yy + 1e-12);
      if (c > best) { best = c; bestLag = lag; }
    }
    for (let lag = bestLag - 3; lag <= bestLag + 3; lag++) {
      let xy = 0, xx = 0, yy = 0;
      for (let i = a; i < a + W; i += 2) {
        const x = got[i], y = ref[i + lag];
        xy += x * y; xx += x * x; yy += y * y;
      }
      const c = xy / Math.sqrt(xx * yy + 1e-12);
      if (c > best) { best = c; bestLag = lag; }
    }
    lags.push(bestLag); scores.push(best);
  }
  lags.sort((x, y) => x - y);
  const median = lags[lags.length >> 1] || 0;
  const drift = lags.reduce((m, l) => Math.max(m, Math.abs(l - median)), 0);
  const good = scores.filter((x) => x > 0.9).length / Math.max(1, scores.length);
  return { median, drift, good, windows: scores.length };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       '));
  }
}

async function checkFile(label, file, expectSeconds, { video = false } = {}) {
  const reader = await AudioReader.open(await blobFor(file), { decode: ffDecode });
  assert.ok(Math.abs(reader.duration - expectSeconds) < Math.max(1.5, expectSeconds * 0.03),
    `duration ${reader.duration} vs ${expectSeconds}`);
  assert.strictEqual(Boolean(reader.isVideo), video, 'isVideo');
  const chunks = await readAll(reader);
  // Chunks are at most 30 s, follow each other with no gap, and cover the file.
  let t = 0;
  for (const c of chunks) {
    assert.ok(Math.abs(c.start - t) < 1e-6, `chunk starts at ${c.start}, expected ${t}`);
    assert.ok(c.end - c.start <= 30.0001, 'chunk too long ' + (c.end - c.start));
    assert.ok(Math.abs(c.audio.length / RATE - (c.end - c.start)) < 1e-3);
    t = c.end;
  }
  assert.ok(Math.abs(t - expectSeconds) < 0.25, `covered ${t}s of ${expectSeconds}s`);
  const got = joinAudio(chunks);
  const ref = reference(file);
  const cmp = compare(got, ref, 1, Math.min(expectSeconds, ref.length / RATE));
  assert.ok(cmp.good >= 0.97, `only ${(cmp.good * 100).toFixed(1)}% of seconds match (${JSON.stringify(cmp)})`);
  assert.ok(Math.abs(cmp.median) <= 0.06 * RATE, 'offset ' + cmp.median / RATE);
  // Opus, Vorbis and AAC decoders lose a few milliseconds when they start, so a
  // section can sit up to ~25 ms off. That never adds up and is far too small
  // to change what Whisper hears; anything bigger means a reader bug.
  assert.ok(cmp.drift <= 0.03 * RATE, 'drift ' + cmp.drift / RATE + 's');
  return { reader, chunks, got, ref };
}

/** Stop after a few chunks, then carry on from the saved place: same result. */
async function checkResume(file) {
  const reader = await AudioReader.open(await blobFor(file), { decode: ffDecode });
  const full = await readAll(reader);
  const stopAt = Math.min(3, full.length - 2);
  const saved = JSON.parse(JSON.stringify(full[stopAt].resume));   // as stored in IndexedDB
  const again = await AudioReader.open(await blobFor(file), { decode: ffDecode });
  const rest = await readAll(again, { startTime: saved.time, startCursor: saved.cursor });
  assert.ok(Math.abs(rest[0].start - full[stopAt].end) < 1e-6, 'resumes where it stopped');
  const a = joinAudio(full.slice(stopAt + 1));
  const b = joinAudio(rest);
  assert.ok(Math.abs(a.length - b.length) < RATE * 0.05, `lengths ${a.length} vs ${b.length}`);
  const cmp = compare(b, a, 1, a.length / RATE);
  assert.ok(cmp.good >= 0.97 && Math.abs(cmp.median) <= 0.06 * RATE, JSON.stringify(cmp));
}

(async () => {
  // Small sections in tests so every file crosses several section boundaries.
  AudioReader._setSectionSeconds(25);
  const SECONDS = 95;

  console.log('Audio formats');
  for (const [label, file] of Object.entries(media.formats(SECONDS))) {
    await test(`${label}: reads in sections, matches a full decode`, () => checkFile(label, file, SECONDS));
  }

  console.log('Video formats (sound only)');
  for (const [label, file] of Object.entries(media.videos(SECONDS))) {
    await test(`${label}: reads the sound only`, () => checkFile(label, file, SECONDS, { video: true }));
  }

  console.log('Resume from a saved place');
  const f = media.formats(SECONDS), v = media.videos(SECONDS);
  for (const [label, file] of [['wav', f['wav-s16-stereo']], ['mp3', f['mp3-vbr-id3']], ['aac', f['aac-adts']],
    ['m4a', f['m4a']], ['mp4', v['mp4-h264-aac']], ['webm', f['webm-opus']], ['mkv video', v['mkv-vp9-opus']],
    ['ogg', f['ogg-opus']], ['vorbis', f['ogg-vorbis']], ['flac', f['flac']]]) {
    await test(`${label}: resume gives the same sound as reading straight through`, () => checkResume(file));
  }

  console.log('Short and odd files');
  const src = media.source(4, 'source-4.wav');
  await test('4-second MP3 is one chunk', async () => {
    const file = media.make('t4.mp3', src, ['-c:a', 'libmp3lame']);
    const { chunks } = await checkFile('mp3', file, 4);
    assert.strictEqual(chunks.length, 1);
  });
  await test('4-second M4A is one chunk', async () => {
    const file = media.make('t4.m4a', src, ['-c:a', 'aac']);
    const { chunks } = await checkFile('m4a', file, 4);
    assert.strictEqual(chunks.length, 1);
  });
  await test('fragmented MP4 (screen recorders): read in one go', async () => {
    const file = media.make('t40-frag.mp4', media.source(40), ['-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov']);
    const reader = await AudioReader.open(await blobFor(file), { decode: ffDecode });
    assert.strictEqual(reader.kind, 'other');
    const chunks = await readAll(reader);
    assert.ok(Math.abs(chunks[chunks.length - 1].end - 40) < 0.3);
  });
  await test('WebM written live (unknown sizes, no duration): reads and estimates length', async () => {
    const file = media.make('t95-live.webm', media.source(95), ['-c:a', 'libopus', '-live', '1', '-cluster_time_limit', '5000']);
    await checkFile('webm-live', file, 95);
  });
  await test('mu-law WAV: read in one go', async () => {
    const file = media.make('t20-mulaw.wav', media.source(20), ['-ac', '1', '-ar', '8000', '-c:a', 'pcm_mulaw']);
    await checkFile('mulaw', file, 20);
  });

  console.log('Problems');
  const codeOf = async (file, type) => {
    try { await AudioReader.open(await blobFor(file, type), { decode: ffDecode }); return 'opened'; }
    catch (e) { return e.code; }
  };
  await test('a text file is "unsupported"', async () => {
    const file = path.join(media.DIR, 'notes.txt');
    fs.writeFileSync(file, 'hello, these are not sounds\n'.repeat(100));
    assert.strictEqual(await codeOf(file, 'text/plain'), 'unsupported');
  });
  await test('a picture is "unsupported"', async () => {
    const file = path.join(media.DIR, 'photo.jpg');
    media.ff(['-f', 'lavfi', '-i', 'testsrc=size=64x64:duration=1', '-frames:v', '1', file]);
    assert.strictEqual(await codeOf(file, 'image/jpeg'), 'unsupported');
  });
  await test('random bytes named .mp3 are "unreadable" or "unsupported"', async () => {
    const file = path.join(media.DIR, 'broken.mp3');
    const junk = Buffer.alloc(200000);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919 + 13) % 251;
    fs.writeFileSync(file, junk);
    assert.ok(['unreadable', 'unsupported'].includes(await codeOf(file, 'audio/mpeg')));
  });
  await test('an empty file is "unreadable"', async () => {
    const file = path.join(media.DIR, 'empty.m4a');
    fs.writeFileSync(file, '');
    assert.strictEqual(await codeOf(file, 'audio/mp4'), 'unreadable');
  });
  await test('a cut-off M4A (download stopped early) is "unreadable"', async () => {
    const whole = fs.readFileSync(f['m4a']);
    const file = path.join(media.DIR, 'cut.m4a');
    fs.writeFileSync(file, whole.subarray(0, Math.floor(whole.length * 0.6)));
    assert.strictEqual(await codeOf(file, 'audio/mp4'), 'unreadable');
  });
  await test('a video with no sound is "noAudio"', async () => {
    const file = path.join(media.DIR, 'silent-video.mp4');
    if (!fs.existsSync(file)) media.ff(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', file]);
    assert.strictEqual(await codeOf(file, 'video/mp4'), 'noAudio');
  });
  await test('an AMR voice note is "unsupported"', async () => {
    const file = path.join(media.DIR, 'voice.amr');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(5000, 0x3c)]));
    assert.strictEqual(await codeOf(file, 'audio/amr'), 'unsupported');
  });
  await test('damaged bytes in the middle of an MP3 are skipped, the rest is kept', async () => {
    const whole = Buffer.from(fs.readFileSync(f['mp3-cbr']));
    const mid = Math.floor(whole.length / 2);
    for (let i = mid; i < mid + 20000; i++) whole[i] = 0;
    const file = path.join(media.DIR, 'damaged.mp3');
    fs.writeFileSync(file, whole);
    const reader = await AudioReader.open(await blobFor(file, 'audio/mpeg'), { decode: ffDecode });
    const chunks = await readAll(reader);
    assert.ok(chunks[chunks.length - 1].end > SECONDS - 3, 'reads to the end: ' + chunks[chunks.length - 1].end);
  });

  console.log('Silence');
  await test('silent chunks are detected, quiet speech is not', async () => {
    const silent = new Float32Array(RATE * 5);
    for (let i = 0; i < silent.length; i++) silent[i] = ((i * 31) % 7 - 3) * 0.0001;
    assert.ok(AudioReader.isSilent(silent));
    const quiet = new Float32Array(RATE * 5);
    for (let i = 0; i < quiet.length; i++) quiet[i] = 0.02 * Math.sin(i / 8);
    assert.ok(!AudioReader.isSilent(quiet));
  });

  if (LONG) {
    console.log('Long recordings (2.5 hours), read with normal-size sections');
    AudioReader._setSectionSeconds(120);
    const HOURS = 2.5, secs = HOURS * 3600;
    const longSrc = media.source(secs, 'source-long.wav');
    const longFiles = {
      mp3: media.make('long.mp3', longSrc, ['-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k']),
      m4a: media.make('long.m4a', longSrc, ['-ac', '1', '-c:a', 'aac', '-b:a', '48k']),
      webm: media.make('long.webm', longSrc, ['-ac', '1', '-c:a', 'libopus', '-b:a', '24k']),
    };
    for (const [label, file] of Object.entries(longFiles)) {
      await test(`${label}: 2.5 hours read in sections with steady memory`, async () => {
        const reader = await AudioReader.open(await blobFor(file), { decode: ffDecode });
        assert.ok(Math.abs(reader.duration - secs) < 20, 'duration ' + reader.duration);
        const chunker = new AudioReader.Chunker(reader);
        let t = 0, n = 0, peak = 0;
        const base = process.memoryUsage().rss;
        for (;;) {
          const c = await chunker.next();
          if (!c) break;
          assert.ok(Math.abs(c.start - t) < 1e-6);
          t = c.end; n++;
          if (n % 50 === 0) { global.gc && global.gc(); peak = Math.max(peak, process.memoryUsage().rss - base); }
        }
        assert.ok(Math.abs(t - secs) < 2, 'covered ' + t);
        // The whole file decoded at once would be 576 MB; sections keep us far below that.
        assert.ok(peak < 250 * 1024 * 1024, 'memory grew by ' + Math.round(peak / 1048576) + ' MB');
        console.log(`       ${n} chunks, extra memory at most ${Math.round(peak / 1048576)} MB`);
      });
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
