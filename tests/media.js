/*
 * Test media made with ffmpeg (nothing large is kept in the repository).
 * Shared by tests/audio-reader.test.js and tests/file.test.js.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = process.env.TEST_MEDIA_DIR || path.join(os.tmpdir(), 'transcriber-test-media');
fs.mkdirSync(DIR, { recursive: true });

function ff(args) {
  execFileSync('ffmpeg', ['-v', 'error', '-y'].concat(args), { stdio: ['ignore', 'ignore', 'inherit'] });
}

/**
 * A test signal whose shape changes every moment (low tones with moving
 * loudness), so a misplaced section shows up clearly when compared.
 */
function source(seconds, name) {
  const file = path.join(DIR, name || `source-${seconds}.wav`);
  if (fs.existsSync(file)) return file;
  // Two tones that drift slowly in pitch (120-310 Hz) and loudness.
  const expr = '0.25*sin(2*PI*180*t-420*cos(2*PI*t/7))*(0.6+0.4*sin(2*PI*t/3.1))' +
    '|0.25*sin(2*PI*260*t-250*cos(2*PI*t/5))*(0.6+0.4*cos(2*PI*t/2.3))';
  ff(['-f', 'lavfi', '-i', `aevalsrc=${expr}:s=44100:d=${seconds}`, '-c:a', 'pcm_s16le', file]);
  return file;
}

/** Make `name` from `input` with extra ffmpeg arguments (cached). */
function make(name, input, args, extraInputs) {
  const file = path.join(DIR, name);
  if (fs.existsSync(file)) return file;
  const inputs = ['-i', input].concat(extraInputs || []);
  ff(inputs.concat(args, [file]));
  return file;
}

const VIDEO = (seconds) => ['-f', 'lavfi', '-i', `testsrc=size=320x240:rate=15:duration=${seconds}`];

/** Every format the app promises to read, from one source. */
function formats(seconds) {
  const src = source(seconds);
  const s = seconds;
  return {
    'wav-s16-stereo': make(`t${s}.wav`, src, ['-c:a', 'pcm_s16le']),
    'wav-float-mono-48k': make(`t${s}-float.wav`, src, ['-ac', '1', '-ar', '48000', '-c:a', 'pcm_f32le']),
    'mp3-cbr': make(`t${s}-cbr.mp3`, src, ['-c:a', 'libmp3lame', '-b:a', '128k']),
    'mp3-vbr-id3': make(`t${s}-vbr.mp3`, src, ['-c:a', 'libmp3lame', '-q:a', '5', '-metadata', 'title=Test Recording', '-id3v2_version', '3']),
    'mp3-22k-mono': make(`t${s}-22k.mp3`, src, ['-ac', '1', '-ar', '22050', '-c:a', 'libmp3lame', '-b:a', '48k']),
    'aac-adts': make(`t${s}.aac`, src, ['-c:a', 'aac', '-b:a', '96k']),
    'm4a': make(`t${s}.m4a`, src, ['-c:a', 'aac', '-b:a', '96k']),
    'm4a-faststart': make(`t${s}-fast.m4a`, src, ['-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart']),
    'ogg-opus': make(`t${s}.ogg`, src, ['-c:a', 'libopus', '-b:a', '48k']),
    'opus': make(`t${s}.opus`, src, ['-ac', '1', '-c:a', 'libopus', '-b:a', '24k']),
    'ogg-vorbis': make(`t${s}-vorbis.ogg`, src, ['-c:a', 'libvorbis', '-q:a', '3']),
    'webm-opus': make(`t${s}.webm`, src, ['-c:a', 'libopus', '-b:a', '48k']),
    'flac': make(`t${s}.flac`, src, ['-c:a', 'flac']),
  };
}

/** Video files (pictures plus our test sound). */
function videos(seconds) {
  const src = source(seconds);
  const s = seconds;
  const v = (name, args) => {
    const file = path.join(DIR, name);
    if (!fs.existsSync(file)) ff(VIDEO(s).concat(['-i', src, '-map', '0:v', '-map', '1:a'], args, ['-shortest', file]));
    return file;
  };
  return {
    'mp4-h264-aac': v(`v${s}.mp4`, ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '96k']),
    'mov-h264-aac': v(`v${s}.mov`, ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac']),
    'm4v-faststart': v(`v${s}.m4v`, ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart']),
    '3gp-aac': v(`v${s}.3gp`, ['-c:v', 'h263', '-s', '352x288', '-c:a', 'aac', '-ar', '22050', '-ac', '1', '-b:a', '32k']),
    'webm-vp8-vorbis': v(`v${s}.webm`, ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-c:a', 'libvorbis']),
    'mkv-vp9-opus': v(`v${s}.mkv`, ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-c:a', 'libopus']),
    'mkv-h264-aac-blockgroups': v(`v${s}-bg.mkv`, ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-cluster_time_limit', '2000']),
    'mp4-mp3-audio': v(`v${s}-mp3.mp4`, ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'libmp3lame']),
  };
}

/** Speech: real recordings from the Transformers.js test set (downloaded once). */
function speech(name) {
  const file = path.join(DIR, name);
  if (fs.existsSync(file)) return file;
  execFileSync('curl', ['-sSfL', '-o', file,
    `https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/${name}`]);
  return file;
}

module.exports = { DIR, ff, source, make, formats, videos, speech };
