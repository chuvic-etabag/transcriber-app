/*
 * audio-reader.js — Reads audio or video files a section at a time, so a
 * 2 to 3 hour recording never has to sit in memory all at once.
 *
 * Each format has a small reader that finds where the sound is inside the
 * file, cuts out a few minutes of it, and hands those bytes to a decoder
 * (in the browser: Chrome's own decodeAudioData at 16 kHz). The result is
 * 16 kHz mono audio, which is what Whisper needs.
 *
 * Supported without loading the whole file:
 *   WAV, MP3, AAC (ADTS), M4A / MP4 / MOV / M4V / 3GP (AAC or MP3 sound),
 *   WEBM / MKV (any sound Chrome can play), OGG / OPUS, FLAC.
 * Anything else Chrome can play is decoded in one go if the file is small
 * enough (see FALLBACK_MAX_BYTES).
 *
 * Exposes window.AudioReader (and module.exports for the Node tests).
 *
 *   var reader = await AudioReader.open(file, { decode: fn });
 *   reader.kind, reader.label, reader.duration (seconds), reader.isVideo
 *   var section = await reader.read(cursor);   // cursor: reader.firstCursor
 *   // section: { samples: Float32Array, start: seconds, next: cursor|null }
 *
 *   var chunker = new AudioReader.Chunker(reader, { startTime, startCursor });
 *   var chunk = await chunker.next();  // { audio, start, end, resume } or null
 *
 * Cursors are small plain objects, so they can be saved in IndexedDB and used
 * later to carry on from the same place.
 */
(function (global) {
  'use strict';

  var RATE = 16000;                     // Whisper's sample rate
  var SECTION_SECONDS = 120;            // how much sound to decode at a time
  var BLOCK = 1024 * 1024;              // bytes read from the file at a time
  var FALLBACK_MAX_BYTES = 80 * 1024 * 1024;
  var PREROLL_FRAMES = 2;               // MP3/AAC frames decoded before a section and thrown away

  // ---------- Errors with a code the screen can turn into plain words ----------

  function ReaderError(code, detail) {
    var e = new Error(detail || code);
    e.code = code;   // 'unsupported' | 'unreadable' | 'noAudio' | 'tooLarge' | 'memory'
    return e;
  }

  function isMemoryError(err) {
    var text = String(err && (err.message || err.name || err) || '');
    return (err && err.name === 'RangeError') ||
      /out of memory|allocation failed|allocate|oom|bad_alloc|memory/i.test(text);
  }

  // ---------- Byte helpers ----------

  function readBytes(file, start, end) {
    start = Math.max(0, start);
    end = Math.min(file.size, end);
    if (end <= start) return Promise.resolve(new Uint8Array(0));
    return file.slice(start, end).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    }, function (err) {
      if (isMemoryError(err)) throw ReaderError('memory', String(err));
      throw ReaderError('unreadable', 'Could not read the file: ' + err);
    });
  }

  function ascii(bytes, offset, length) {
    var s = '';
    for (var i = 0; i < length && offset + i < bytes.length; i++) s += String.fromCharCode(bytes[offset + i]);
    return s;
  }

  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u32be(b, o) { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
  function u64be(b, o) { return u32be(b, o) * 4294967296 + u32be(b, o + 4); }
  function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0); }

  function concat(parts, total) {
    if (total === undefined) {
      total = 0;
      for (var i = 0; i < parts.length; i++) total += parts[i].length;
    }
    var out = new Uint8Array(total);
    var pos = 0;
    for (var j = 0; j < parts.length; j++) { out.set(parts[j], pos); pos += parts[j].length; }
    return out;
  }

  /** A forward-only window over the file, so parsers can ask for bytes at any offset. */
  function ByteWindow(file) {
    this.file = file;
    this.start = 0;
    this.bytes = new Uint8Array(0);
  }
  /**
   * Make sure bytes [offset, offset + length) are loaded (or as many as the
   * file has). Returns false only when offset is at or past the end.
   */
  ByteWindow.prototype.ensure = function (offset, length) {
    var self = this;
    var want = Math.min(offset + length, this.file.size);
    if (offset >= this.file.size) return Promise.resolve(false);
    if (offset >= this.start && want <= this.start + this.bytes.length) return Promise.resolve(true);
    return readBytes(this.file, offset, offset + Math.max(length, BLOCK)).then(function (bytes) {
      self.start = offset;
      self.bytes = bytes;
      return true;
    });
  };
  ByteWindow.prototype.at = function (offset) { return this.bytes[offset - this.start]; };
  ByteWindow.prototype.sub = function (offset, length) {
    return this.bytes.subarray(offset - this.start, offset - this.start + length);
  };

  // ---------- Decoding (injected so tests can use ffmpeg instead of Chrome) ----------

  var sharedContext = null;

  /** Browser decoder: Chrome decodes and resamples to 16 kHz; we mix to mono. */
  function browserDecode(bytes) {
    var Ctx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!Ctx) return Promise.reject(ReaderError('unsupported', 'No Web Audio'));
    if (!sharedContext) sharedContext = new Ctx(1, 1, RATE);
    // decodeAudioData takes ownership of the buffer, so give it a copy of just these bytes.
    var buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer : bytes.slice().buffer;
    return sharedContext.decodeAudioData(buf).then(function (audio) {
      return mixToMono(audio);
    });
  }

  function mixToMono(audio) {
    var n = audio.numberOfChannels;
    var first = audio.getChannelData(0);
    if (n === 1) return new Float32Array(first);
    var out = new Float32Array(first.length);
    for (var c = 0; c < n; c++) {
      var data = audio.getChannelData(c);
      for (var i = 0; i < out.length; i++) out[i] += data[i];
    }
    for (var k = 0; k < out.length; k++) out[k] /= n;
    return out;
  }

  function decodeWith(reader, bytes) {
    return Promise.resolve().then(function () { return reader.decode(bytes); }).catch(function (err) {
      if (err && err.code) throw err;
      if (isMemoryError(err)) throw ReaderError('memory', String(err));
      throw ReaderError('unreadable', 'Decode failed: ' + (err && err.message || err));
    });
  }

  function trimStart(samples, seconds) {
    var n = Math.min(samples.length, Math.max(0, Math.round(seconds * RATE)));
    return n ? samples.subarray(n) : samples;
  }

  // ---------- Format detection ----------

  var VIDEO_EXT = /\.(mp4|m4v|mov|mkv|3gp|3g2|avi|wmv|mpg|mpeg|ts|mts|flv)$/i;

  function id3Size(b) {
    if (ascii(b, 0, 3) !== 'ID3' || b.length < 10) return 0;
    var size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return 10 + size + ((b[5] & 0x10) ? 10 : 0);
  }

  function sniff(file) {
    return readBytes(file, 0, 64 * 1024).then(function (head) {
      if (head.length < 12) return { kind: 'empty' };
      var skip = id3Size(head);
      var p = skip ? readBytes(file, skip, skip + 64 * 1024) : Promise.resolve(head);
      return p.then(function (b) {
        if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return { kind: 'wav' };
        if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'AVI ') return { kind: 'other', video: true };
        if (ascii(b, 4, 4) === 'ftyp' || ascii(b, 4, 4) === 'moov' || ascii(b, 4, 4) === 'mdat' ||
            ascii(b, 4, 4) === 'wide' || ascii(b, 4, 4) === 'free') return { kind: 'mp4' };
        if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'mkv' };
        if (ascii(b, 0, 4) === 'OggS') return { kind: 'ogg' };
        if (ascii(b, 0, 4) === 'fLaC') return { kind: 'flac', offset: skip };
        if (ascii(b, 0, 5) === '#!AMR') return { kind: 'unsupported' };
        // MPEG audio: look for two frames in a row so random bytes don't fool us.
        var found = findFrameSync(b, 0, true);
        if (found) return { kind: found.type, offset: skip + found.offset };
        return { kind: 'unknown' };
      });
    });
  }

  // ---------- WAV ----------

  function WavReader(file, opts) {
    this.file = file;
    this.decode = opts.decode;
    this.kind = 'wav';
    this.label = 'WAV audio';
  }
  WavReader.prototype.init = function () {
    var self = this;
    return readBytes(this.file, 0, 1024 * 1024).then(function (b) {
      var pos = 12;
      var fmt = null;
      while (pos + 8 <= b.length) {
        var id = ascii(b, pos, 4);
        var size = u32le(b, pos + 4);
        if (id === 'fmt ') fmt = { offset: pos, bytes: b.slice(pos, pos + 8 + size) };
        if (id === 'data') {
          self.dataStart = pos + 8;
          var avail = self.file.size - self.dataStart;
          self.dataSize = size === 0 || size === 0xffffffff || size > avail ? avail : size;
          break;
        }
        pos += 8 + size + (size & 1);
      }
      if (!fmt || self.dataStart === undefined) throw ReaderError('unreadable', 'WAV without fmt/data');
      var f = fmt.bytes;
      self.format = u16le(f, 8);
      self.channels = u16le(f, 10);
      self.sampleRate = u32le(f, 12);
      self.blockAlign = u16le(f, 20) || 1;
      self.fmtChunk = f;
      // Plain PCM, float, A-law and mu-law can be cut anywhere on a sample boundary.
      self.sliceable = [1, 3, 6, 7, 0xfffe].indexOf(self.format) !== -1 && self.sampleRate > 0;
      self.totalFrames = Math.floor(self.dataSize / self.blockAlign);
      self.duration = self.sampleRate ? self.totalFrames / self.sampleRate : 0;
      self.firstCursor = { frame: 0 };
      if (self.totalFrames === 0) throw ReaderError('noAudio', 'Empty WAV');
    });
  };
  WavReader.prototype.read = function (cursor) {
    var self = this;
    var first = cursor.frame;
    var count = Math.min(this.totalFrames - first, Math.round(SECTION_SECONDS * this.sampleRate));
    if (count <= 0) return Promise.resolve(null);
    var start = this.dataStart + first * this.blockAlign;
    return readBytes(this.file, start, start + count * this.blockAlign).then(function (pcm) {
      var fmt = self.fmtChunk;
      var header = new Uint8Array(12 + fmt.length + 8);
      var dv = new DataView(header.buffer);
      header.set([82, 73, 70, 70], 0);                       // RIFF
      dv.setUint32(4, header.length - 8 + pcm.length, true);
      header.set([87, 65, 86, 69], 8);                       // WAVE
      header.set(fmt, 12);
      header.set([100, 97, 116, 97], 12 + fmt.length);       // data
      dv.setUint32(16 + fmt.length, pcm.length, true);
      return decodeWith(self, concat([header, pcm]));
    }).then(function (samples) {
      var nextFrame = first + count;
      return {
        samples: samples,
        start: first / self.sampleRate,
        next: nextFrame < self.totalFrames ? { frame: nextFrame } : null
      };
    });
  };

  // ---------- MP3 and AAC (ADTS): a stream of self-contained frames ----------

  var MP3_BITRATES = {
    // [version 1, version 2/2.5] x layer (1, 2, 3)
    '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  };
  var MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  var AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  /** Parse a frame header at b[o]. Returns { type, length, samples, rate, ... } or null. */
  function parseFrame(b, o) {
    if (o + 7 > b.length || b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
    var layerBits = (b[o + 1] >> 1) & 3;
    if (layerBits === 0) {
      // ADTS (AAC). The top 12 bits must all be set.
      if ((b[o + 1] & 0xf0) !== 0xf0) return null;
      var sfIndex = (b[o + 2] >> 2) & 0x0f;
      if (sfIndex > 12) return null;
      var len = ((b[o + 3] & 3) << 11) | (b[o + 4] << 3) | (b[o + 5] >> 5);
      var headerLen = (b[o + 1] & 1) ? 7 : 9;
      if (len < headerLen) return null;
      return {
        type: 'adts', length: len, rate: AAC_RATES[sfIndex],
        samples: 1024 * ((b[o + 6] & 3) + 1),
        key: 'adts-' + sfIndex + '-' + (((b[o + 2] & 1) << 2) | (b[o + 3] >> 6))
      };
    }
    var versionBits = (b[o + 1] >> 3) & 3;
    if (versionBits === 1) return null;
    var layer = 4 - layerBits;
    var brIndex = b[o + 2] >> 4;
    var srIndex = (b[o + 2] >> 2) & 3;
    if (brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
    var v1 = versionBits === 3;
    var bitrate = MP3_BITRATES[(v1 ? '1-' : '2-') + layer][brIndex] * 1000;
    var rate = MP3_RATES[versionBits][srIndex];
    var pad = (b[o + 2] >> 1) & 1;
    var length, samples;
    if (layer === 1) { length = (Math.floor(12 * bitrate / rate) + pad) * 4; samples = 384; }
    else if (layer === 2) { length = Math.floor(144 * bitrate / rate) + pad; samples = 1152; }
    else { length = Math.floor((v1 ? 144 : 72) * bitrate / rate) + pad; samples = v1 ? 1152 : 576; }
    return {
      type: 'mp3', length: length, rate: rate, samples: samples, bitrate: bitrate,
      key: 'mp3-' + versionBits + '-' + layer + '-' + srIndex, v1: v1,
      mono: (b[o + 3] >> 6) === 3
    };
  }

  /** Find the first frame in b (from start) that is followed by a matching frame. */
  function findFrameSync(b, start, strict) {
    for (var o = start; o + 7 <= b.length; o++) {
      if (b[o] !== 0xff) continue;
      var f = parseFrame(b, o);
      if (!f) continue;
      var n = o + f.length;
      if (n + 7 > b.length) { if (!strict) return { offset: o, frame: f, type: f.type }; continue; }
      var g = parseFrame(b, n);
      if (g && g.key === f.key) return { offset: o, frame: f, type: f.type };
    }
    return null;
  }

  function FrameReader(file, opts, info) {
    this.file = file;
    this.decode = opts.decode;
    this.kind = info.kind;
    this.label = info.kind === 'mp3' ? 'MP3 audio' : 'AAC audio';
    this.audioStart = info.offset || 0;
  }
  FrameReader.prototype.init = function () {
    var self = this;
    return readBytes(this.file, this.audioStart, this.audioStart + 256 * 1024).then(function (b) {
      var sync = findFrameSync(b, 0, false);
      if (!sync) throw ReaderError('unreadable', 'No frames');
      var f = sync.frame;
      self.audioStart += sync.offset;
      self.rate = f.rate;
      self.key = f.key;
      var o = sync.offset;
      var frames = null;
      if (f.type === 'mp3') {
        // A Xing/Info or VBRI header in the first frame gives the real length of VBR files.
        var side = f.v1 ? (f.mono ? 17 : 32) : (f.mono ? 9 : 17);
        var tag = ascii(b, o + 4 + side, 4);
        if (tag === 'Xing' || tag === 'Info') {
          var flags = u32be(b, o + 8 + side);
          if (flags & 1) frames = u32be(b, o + 12 + side);
          self.audioStart += f.length;   // the header frame holds no sound
        } else if (ascii(b, o + 36, 4) === 'VBRI') {
          frames = u32be(b, o + 36 + 14);
          self.audioStart += f.length;
        }
      }
      var tail = self.file.size - self.audioStart;
      if (frames) {
        self.duration = frames * f.samples / f.rate;
      } else {
        // Average the first frames to estimate the length.
        var count = 0, bytes = 0, samples = 0, p = o;
        while (count < 200) {
          var g = parseFrame(b, p);
          if (!g || g.key !== f.key) break;
          count++; bytes += g.length; samples += g.samples; p += g.length;
        }
        self.duration = bytes ? tail / bytes * samples / f.rate : 0;
      }
      self.firstCursor = { offset: self.audioStart, samples: 0, preroll: null };
    });
  };
  FrameReader.prototype.read = function (cursor) {
    var self = this;
    var win = new ByteWindow(this.file);
    var target = Math.round(SECTION_SECONDS * this.rate);
    var offset = cursor.offset;
    var samples = 0;
    var recent = [];          // offsets of the last frames, for the next section's pre-roll
    var recentSamples = [];
    var end = offset;

    function step() {
      return win.ensure(offset, 16 * 1024).then(function (ok) {
        if (!ok) return;
        while (samples < target) {
          var rel = offset - win.start;
          if (offset + 7 > self.file.size) { offset = self.file.size; return; }
          if (rel + 7 > win.bytes.length) return step();
          var f = parseFrame(win.bytes, rel);
          if (f && f.key === self.key && f.length > 0) {
            if (rel + f.length > win.bytes.length && offset + f.length <= self.file.size) return step();
            recent.push(offset); recentSamples.push(f.samples);
            if (recent.length > PREROLL_FRAMES) { recent.shift(); recentSamples.shift(); }
            samples += f.samples;
            offset += f.length;
            end = Math.min(offset, self.file.size);
            continue;
          }
          // Lost sync (damaged bytes or tags): scan forward for the next good frame.
          return resync().then(function (found) { if (found) return step(); });
        }
      });
    }

    function resync() {
      return win.ensure(offset + 1, 4096).then(function (ok) {
        if (!ok) return false;
        var rel = offset + 1 - win.start;
        var b = win.bytes;
        for (var i = rel; i + 7 <= b.length; i++) {
          if (b[i] !== 0xff) continue;
          var f = parseFrame(b, i);
          if (!f || f.key !== self.key) continue;
          var g = parseFrame(b, i + f.length);
          if (i + f.length + 7 > b.length || (g && g.key === self.key)) {
            offset = win.start + i;
            return true;
          }
        }
        offset = win.start + b.length - 8;
        if (offset + 8 >= self.file.size) return false;
        return resync();
      });
    }

    return step().then(function () {
      if (samples === 0) return null;
      var from = cursor.preroll !== null && cursor.preroll !== undefined ? cursor.preroll.offset : cursor.offset;
      var prerollSeconds = cursor.preroll ? cursor.preroll.samples / self.rate : 0;
      return readBytes(self.file, from, end).then(function (bytes) {
        return decodeWith(self, bytes);
      }).then(function (pcm) {
        var nextOffset = offset;
        var hasMore = nextOffset + 7 < self.file.size;
        var pre = 0;
        for (var i = 0; i < recentSamples.length; i++) pre += recentSamples[i];
        return {
          samples: trimStart(pcm, prerollSeconds),
          start: cursor.samples / self.rate,
          next: hasMore ? {
            offset: nextOffset,
            samples: cursor.samples + samples,
            preroll: recent.length ? { offset: recent[0], samples: pre } : null
          } : null
        };
      });
    });
  };

  // ---------- MP4 / M4A / MOV / 3GP ----------

  function boxHeader(b, o) {
    if (o + 8 > b.length) return null;
    var size = u32be(b, o);
    var type = ascii(b, o + 4, 4);
    var header = 8;
    if (size === 1) { if (o + 16 > b.length) return null; size = u64be(b, o + 8); header = 16; }
    return { size: size, type: type, header: header };
  }

  /** Children of a box: [{ type, start (payload offset), end }]. */
  function children(b, start, end) {
    var out = [];
    var o = start;
    while (o + 8 <= end) {
      var h = boxHeader(b, o);
      if (!h) break;
      var size = h.size === 0 ? end - o : h.size;
      if (size < h.header || o + size > end) break;
      out.push({ type: h.type, start: o + h.header, end: o + size });
      o += size;
    }
    return out;
  }
  function child(b, box, type) {
    var list = children(b, box.start, box.end);
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
    return null;
  }
  function path(b, box, types) {
    for (var i = 0; box && i < types.length; i++) box = child(b, box, types[i]);
    return box;
  }

  function readDescriptorLength(b, o) {
    var len = 0, i = 0;
    for (; i < 4; i++) {
      var c = b[o + i];
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) { i++; break; }
    }
    return { length: len, size: i };
  }

  /** Parse esds: returns { objectType, asc: Uint8Array|null }. */
  function parseEsds(b, box) {
    var o = box.start + 4;
    var end = box.end;
    var result = { objectType: 0, asc: null };
    while (o + 2 <= end) {
      var tag = b[o];
      var d = readDescriptorLength(b, o + 1);
      var body = o + 1 + d.size;
      if (tag === 0x03) {
        var flags = b[body + 2];
        o = body + 3;
        if (flags & 0x80) o += 2;
        if (flags & 0x40) o += 1 + b[o];
        if (flags & 0x20) o += 2;
        continue;
      }
      if (tag === 0x04) {
        result.objectType = b[body];
        o = body + 13;
        continue;
      }
      if (tag === 0x05) {
        result.asc = b.slice(body, body + d.length);
        break;
      }
      o = body + d.length;
    }
    return result;
  }

  function findBox(b, start, end, type) {
    // Search sample-entry children; QuickTime may wrap esds inside a 'wave' box.
    var list = children(b, start, end);
    for (var i = 0; i < list.length; i++) {
      if (list[i].type === type) return list[i];
      if (list[i].type === 'wave') {
        var inner = findBox(b, list[i].start, list[i].end, type);
        if (inner) return inner;
      }
    }
    return null;
  }

  /** Read the AudioSpecificConfig and work out the ADTS fields. */
  function adtsFromAsc(asc, channelCount) {
    var pos = 0;
    function read(n) {
      var v = 0;
      for (var i = 0; i < n; i++) {
        var byte = asc[pos >> 3] || 0;
        v = (v << 1) | ((byte >> (7 - (pos & 7))) & 1);
        pos++;
      }
      return v;
    }
    var aot = read(5);
    if (aot === 31) aot = 32 + read(6);
    var sfIndex = read(4);
    var rate = sfIndex === 15 ? read(24) : AAC_RATES[sfIndex];
    var channels = read(4);
    if (aot === 5 || aot === 29) {
      // HE-AAC: the core is described after the extension rate.
      var ext = read(4);
      if (ext === 15) read(24);
      aot = read(5);
      if (aot === 31) aot = 32 + read(6);
    }
    if (sfIndex === 15) sfIndex = AAC_RATES.indexOf(rate);
    if (aot < 1 || aot > 4 || sfIndex < 0 || sfIndex > 12) return null;
    if (channels === 0) channels = Math.min(Math.max(channelCount || 2, 1), 7);
    return { profile: aot - 1, sfIndex: sfIndex, channels: channels };
  }

  function adtsHeader(cfg, payloadLength) {
    var len = payloadLength + 7;
    return new Uint8Array([
      0xff, 0xf1,
      (cfg.profile << 6) | (cfg.sfIndex << 2) | (cfg.channels >> 2),
      ((cfg.channels & 3) << 6) | (len >> 11),
      (len >> 3) & 0xff,
      ((len & 7) << 5) | 0x1f,
      0xfc
    ]);
  }

  function Mp4Reader(file, opts) {
    this.file = file;
    this.decode = opts.decode;
    this.kind = 'mp4';
    this.label = 'MP4 / M4A';
  }

  Mp4Reader.prototype.init = function () {
    var self = this;
    var moov = null, fragmented = false, offset = 0, afterMoov = 0;
    function scan() {
      if (offset + 8 > self.file.size) return Promise.resolve();
      return readBytes(self.file, offset, offset + 16).then(function (h) {
        var box = boxHeader(h, 0);
        if (!box) return;
        var size = box.size === 0 ? self.file.size - offset : box.size;
        if (size < 8) return;
        if (moov) afterMoov++;
        if (box.type === 'moov') moov = { offset: offset, size: size };
        if (box.type === 'moof') fragmented = true;
        offset += size;
        // One box after moov is enough to tell whether the file is fragmented.
        if (moov && (fragmented || afterMoov >= 1)) return;
        return scan();
      });
    }
    return scan().then(function () {
      if (!moov) throw ReaderError('unreadable', 'No moov box');
      if (moov.size > 200 * 1024 * 1024) throw ReaderError('tooLarge', 'moov too large');
      return readBytes(self.file, moov.offset, moov.offset + moov.size);
    }).then(function (b) {
      var root = { start: 8, end: b.length };
      var traks = children(b, root.start, root.end).filter(function (x) { return x.type === 'trak'; });
      var sawVideo = false;
      var chosen = null;
      for (var i = 0; i < traks.length && !chosen; i++) {
        var hdlr = path(b, traks[i], ['mdia', 'hdlr']);
        var handler = hdlr ? ascii(b, hdlr.start + 8, 4) : '';
        if (handler === 'vide') sawVideo = true;
        if (handler === 'soun') chosen = traks[i];
      }
      self.isVideo = sawVideo;
      if (sawVideo) self.label = 'Video (sound only)';
      if (!chosen) throw ReaderError('noAudio', 'No sound track');
      var mdhd = path(b, chosen, ['mdia', 'mdhd']);
      var stbl = path(b, chosen, ['mdia', 'minf', 'stbl']);
      if (!mdhd || !stbl) throw ReaderError('unreadable', 'Bad track');
      self.timescale = b[mdhd.start] === 1 ? u32be(b, mdhd.start + 20) : u32be(b, mdhd.start + 12);

      // Sample description: which codec?
      var stsd = child(b, stbl, 'stsd');
      var entry = children(b, stsd.start + 8, stsd.end)[0];
      if (!entry) throw ReaderError('unreadable', 'No sample entry');
      var format = entry.type;
      var version = u16be(b, entry.start + 8);
      var channelCount = u16be(b, entry.start + 16);
      var childStart = entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
      if (format === 'mp4a') {
        var esds = findBox(b, childStart, entry.end, 'esds');
        var info = esds ? parseEsds(b, esds) : { objectType: 0x40, asc: null };
        if (info.objectType === 0x69 || info.objectType === 0x6b) {
          self.codec = 'mp3';
        } else if (info.asc) {
          self.adts = adtsFromAsc(info.asc, channelCount);
          if (!self.adts) throw ReaderError('unsupported', 'AAC type not supported');
          self.codec = 'aac';
        } else {
          throw ReaderError('unsupported', 'mp4a without config');
        }
      } else if (format === '.mp3' || format === 'mp3 ') {
        self.codec = 'mp3';
      } else {
        throw ReaderError('unsupported', 'Sound format ' + format);
      }

      // Sample tables.
      var stsz = child(b, stbl, 'stsz');
      var stco = child(b, stbl, 'stco');
      var co64 = child(b, stbl, 'co64');
      var stsc = child(b, stbl, 'stsc');
      var stts = child(b, stbl, 'stts');
      if (!stsz || !(stco || co64) || !stsc || !stts) throw ReaderError('unreadable', 'Missing tables');
      var fixed = u32be(b, stsz.start + 4);
      var count = u32be(b, stsz.start + 8);
      if (count === 0) {
        if (fragmented) throw ReaderError('fragmented', 'Fragmented MP4');
        throw ReaderError('noAudio', 'No samples');
      }
      var sizes = new Uint32Array(count);
      for (var s = 0; s < count; s++) sizes[s] = fixed || u32be(b, stsz.start + 12 + s * 4);

      var chunkBox = stco || co64;
      var chunkCount = u32be(b, chunkBox.start + 4);
      var chunkOffsets = new Float64Array(chunkCount);
      for (var c = 0; c < chunkCount; c++) {
        chunkOffsets[c] = co64 ? u64be(b, chunkBox.start + 8 + c * 8) : u32be(b, chunkBox.start + 8 + c * 4);
      }

      var offsets = new Float64Array(count);
      var stscCount = u32be(b, stsc.start + 4);
      var sample = 0;
      for (var e = 0; e < stscCount && sample < count; e++) {
        var firstChunk = u32be(b, stsc.start + 8 + e * 12) - 1;
        var perChunk = u32be(b, stsc.start + 12 + e * 12);
        var lastChunk = e + 1 < stscCount ? u32be(b, stsc.start + 8 + (e + 1) * 12) - 1 : chunkCount;
        for (var ch = firstChunk; ch < lastChunk && sample < count; ch++) {
          var pos = chunkOffsets[ch];
          for (var k = 0; k < perChunk && sample < count; k++) {
            offsets[sample] = pos;
            pos += sizes[sample];
            sample++;
          }
        }
      }

      var times = new Float64Array(count + 1);
      var sttsCount = u32be(b, stts.start + 4);
      var t = 0, idx = 0;
      for (var r = 0; r < sttsCount && idx < count; r++) {
        var n = u32be(b, stts.start + 8 + r * 8);
        var delta = u32be(b, stts.start + 12 + r * 8);
        for (var q = 0; q < n && idx < count; q++) { times[idx++] = t; t += delta; }
      }
      while (idx < count) times[idx++] = t;
      times[count] = t;

      self.count = count;
      self.sizes = sizes;
      self.offsets = offsets;
      self.times = times;
      self.duration = t / self.timescale;
      self.firstCursor = { sample: 0 };
    });
  };

  Mp4Reader.prototype.read = function (cursor) {
    var self = this;
    var first = cursor.sample;
    if (first >= this.count) return Promise.resolve(null);
    var limit = this.times[first] + SECTION_SECONDS * this.timescale;
    var last = first;
    while (last < this.count && this.times[last] < limit) last++;
    var from = Math.max(0, first - PREROLL_FRAMES);

    // Group neighbouring samples into runs so we read the file in few pieces
    // (in a video file the sound is mixed in between pictures).
    var runs = [];
    for (var i = from; i < last; i++) {
      var o = this.offsets[i], end = o + this.sizes[i];
      var run = runs[runs.length - 1];
      if (run && o >= run.end && o - run.end < 4096) run.end = end;
      else runs.push({ start: o, end: end });
    }
    var parts = [];
    return runs.reduce(function (p, run) {
      return p.then(function () {
        return readBytes(self.file, run.start, run.end).then(function (bytes) { run.bytes = bytes; });
      });
    }, Promise.resolve()).then(function () {
      var r = 0;
      for (var j = from; j < last; j++) {
        while (self.offsets[j] >= runs[r].end) r++;
        var rel = self.offsets[j] - runs[r].start;
        var data = runs[r].bytes.subarray(rel, rel + self.sizes[j]);
        if (self.codec === 'aac') parts.push(adtsHeader(self.adts, data.length));
        parts.push(data);
      }
      runs = null;
      return decodeWith(self, concat(parts));
    }).then(function (pcm) {
      var pre = (self.times[first] - self.times[from]) / self.timescale;
      return {
        samples: trimStart(pcm, pre),
        start: self.times[first] / self.timescale,
        next: last < self.count ? { sample: last } : null
      };
    });
  };

  // ---------- WEBM / MKV ----------

  var EBML = {
    Segment: 0x18538067, Info: 0x1549a966, Tracks: 0x1654ae6b, TrackEntry: 0xae,
    TrackNumber: 0xd7, TrackType: 0x83, Cluster: 0x1f43b675, Timecode: 0xe7,
    SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
    Cues: 0x1c53bb6b, Tags: 0x1254c367, Attachments: 0x1941a469, Chapters: 0x1043a770,
    SeekHead: 0x114d9b74, Void: 0xec, CodecID: 0x86, CodecDelay: 0x56aa
  };
  var LEVEL1 = [EBML.Cluster, EBML.Cues, EBML.Tags, EBML.Attachments, EBML.Chapters,
    EBML.SeekHead, EBML.Info, EBML.Tracks];

  function readId(b, o) {
    var first = b[o];
    if (first === undefined) return null;
    var len = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
    if (!len || o + len > b.length) return null;
    var id = 0;
    for (var i = 0; i < len; i++) id = id * 256 + b[o + i];
    return { id: id, length: len };
  }
  function readSize(b, o) {
    var first = b[o];
    if (first === undefined || first === 0) return null;
    var len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (o + len > b.length) return null;
    var value = first & (0xff >> len);
    var allOnes = value === (0xff >> len);
    for (var i = 1; i < len; i++) {
      value = value * 256 + b[o + i];
      if (b[o + i] !== 0xff) allOnes = false;
    }
    return { value: allOnes ? -1 : value, length: len };
  }
  function readElement(b, o) {
    var id = readId(b, o);
    if (!id) return null;
    var size = readSize(b, o + id.length);
    if (!size) return null;
    return { id: id.id, size: size.value, header: id.length + size.length, start: o + id.length + size.length };
  }
  function readUint(b, o, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; }
  function readFloat(b, o, n) {
    var dv = new DataView(b.buffer, b.byteOffset + o, n);
    return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
  }
  function writeId(id) {
    var bytes = [];
    while (id > 0) { bytes.unshift(id & 0xff); id = Math.floor(id / 256); }
    return bytes;
  }
  function uintBytes(n) {
    var bytes = writeId(n);
    return new Uint8Array(bytes.length ? bytes : [0]);
  }
  function writeSize8(n) {
    var out = [0x01];
    for (var i = 6; i >= 0; i--) out.push(Math.floor(n / Math.pow(256, i)) & 0xff);
    return out;
  }
  function element(id, payload) {
    return concat([new Uint8Array(writeId(id)), new Uint8Array(writeSize8(payload.length)), payload]);
  }

  function MkvReader(file, opts) {
    this.file = file;
    this.decode = opts.decode;
    this.kind = 'mkv';
    this.label = 'WEBM / MKV';
  }

  MkvReader.prototype.init = function () {
    var self = this;
    var win = new ByteWindow(this.file);
    this.timecodeScale = 1000000;
    var sawVideo = false;

    return win.ensure(0, 64).then(function () {
      var head = readElement(win.bytes, 0);
      if (!head || head.size < 0) throw ReaderError('unreadable', 'Bad EBML header');
      self.ebmlHeader = win.bytes.slice(0, head.start + head.size);
      var segOffset = head.start + head.size;
      return win.ensure(segOffset, 16).then(function () {
        var seg = readElement(win.bytes, segOffset - win.start);
        if (!seg || seg.id !== EBML.Segment) throw ReaderError('unreadable', 'No Segment');
        self.segmentStart = segOffset + seg.header;
        var pos = self.segmentStart;
        function next() {
          return win.ensure(pos, 16).then(function (ok) {
            if (!ok) return;
            var el = readElement(win.bytes, pos - win.start);
            if (!el) return;
            if (el.id === EBML.Cluster) { self.firstCluster = pos; return; }
            if (el.size < 0) throw ReaderError('unreadable', 'Unknown-size header element');
            var total = el.header + el.size;
            if (el.id === EBML.Info || el.id === EBML.Tracks) {
              return win.ensure(pos, total).then(function () {
                var body = win.sub(pos, total);
                if (el.id === EBML.Info) parseInfo(body, el.header);
                else parseTracks(body, el.header);
                pos += total;
                return next();
              });
            }
            pos += total;
            return next();
          });
        }
        return next();
      });
    }).then(function () {
      self.isVideo = sawVideo;
      if (sawVideo) self.label = 'Video (sound only)';
      if (!self.trackEntry) throw ReaderError('noAudio', 'No sound track');
      if (!self.firstCluster) throw ReaderError('unreadable', 'No clusters');
      self.firstCursor = { offset: self.firstCluster };
      if (!self.duration) return self._estimateDuration();
    });

    function parseInfo(b, start) {
      var o = start;
      while (o < b.length) {
        var el = readElement(b, o);
        if (!el || el.size < 0) break;
        if (el.id === EBML.TimecodeScale) self.timecodeScale = readUint(b, el.start, el.size);
        if (el.id === EBML.Duration) self.durationUnits = readFloat(b, el.start, el.size);
        o = el.start + el.size;
      }
      if (self.durationUnits) self.duration = self.durationUnits * self.timecodeScale / 1e9;
    }

    function parseTracks(b, start) {
      var o = start;
      while (o < b.length) {
        var el = readElement(b, o);
        if (!el || el.size < 0) break;
        if (el.id === EBML.TrackEntry) {
          var type = 0, number = 0, p = el.start;
          while (p < el.start + el.size) {
            var c = readElement(b, p);
            if (!c || c.size < 0) break;
            if (c.id === EBML.TrackType) type = readUint(b, c.start, c.size);
            if (c.id === EBML.TrackNumber) number = readUint(b, c.start, c.size);
            if (c.id === EBML.CodecID) self.codecId = ascii(b, c.start, c.size);
            if (c.id === EBML.CodecDelay) self.codecDelay = readUint(b, c.start, c.size) / 1e9;
            p = c.start + c.size;
          }
          if (type === 1) sawVideo = true;
          if (type === 2 && !self.trackEntry) {
            self.trackEntry = b.slice(o, el.start + el.size);
            self.trackNumber = number;
          }
        }
        o = el.start + el.size;
      }
    }
  };

  /** No duration in the header (common for phone and browser recordings): look at the last cluster. */
  MkvReader.prototype._estimateDuration = function () {
    var self = this;
    var tailStart = Math.max(this.firstCluster, this.file.size - 2 * 1024 * 1024);
    return readBytes(this.file, tailStart, this.file.size).then(function (b) {
      for (var i = b.length - 12; i >= 0; i--) {
        if (b[i] !== 0x1f || b[i + 1] !== 0x43 || b[i + 2] !== 0xb6 || b[i + 3] !== 0x75) continue;
        var el = readElement(b, i);
        if (!el) continue;
        var tc = readElement(b, el.start);
        if (tc && tc.id === EBML.Timecode && tc.size > 0 && tc.size <= 8) {
          self.duration = readUint(b, tc.start, tc.size) * self.timecodeScale / 1e9;
          return;
        }
      }
      self.duration = 0;
    });
  };

  MkvReader.prototype.read = function (cursor) {
    var self = this;
    var win = new ByteWindow(this.file);
    var clusters = [];
    var pos = cursor.offset;
    var startTime = null;
    var scale = this.timecodeScale / 1e9;

    // Read one cluster at pos, keeping only our track's blocks.
    function readCluster() {
      return win.ensure(pos, 16).then(function (ok) {
        if (!ok) return false;
        var el = readElement(win.bytes, pos - win.start);
        if (!el) return false;
        if (el.id !== EBML.Cluster) {
          // Skip Cues, Tags and the like between clusters.
          if (el.size < 0) return false;
          pos += el.header + el.size;
          return readCluster();
        }
        var end = el.size < 0 ? Infinity : pos + el.header + el.size;
        var p = pos + el.header;
        var timecode = 0;
        var blocks = [];
        function nextChild() {
          if (p >= end || p >= self.file.size) { pos = Math.min(end, self.file.size); return Promise.resolve(true); }
          return win.ensure(p, 32).then(function (ok2) {
            if (!ok2) { pos = self.file.size; return true; }
            var c = readElement(win.bytes, p - win.start);
            if (!c) { pos = self.file.size; return true; }
            if (el.size < 0 && LEVEL1.indexOf(c.id) !== -1) { pos = p; return true; }
            if (c.size < 0) { pos = self.file.size; return true; }
            var total = c.header + c.size;
            var body = p + c.header;          // file offset of the element's contents
            if (c.id === EBML.Timecode) {
              return win.ensure(p, total).then(function () {
                timecode = readUint(win.bytes, body - win.start, c.size);
                p += total;
                return nextChild();
              });
            }
            if (c.id === EBML.SimpleBlock) {
              var track = readSize(win.bytes, body - win.start);
              if (track && track.value === self.trackNumber) {
                return win.ensure(p, total).then(function () {
                  blocks.push(win.sub(body, c.size).slice());
                  p += total;
                  return nextChild();
                });
              }
              p += total;
              return nextChild();
            }
            if (c.id === EBML.BlockGroup) {
              // Peek at the Block's track number before loading the whole group.
              var head = readElement(win.bytes, body - win.start);
              if (head && head.id === EBML.Block) {
                var peek = readSize(win.bytes, body + head.header - win.start);
                if (peek && peek.value !== self.trackNumber) { p += total; return nextChild(); }
              }
              return win.ensure(p, total).then(function () {
                var q = body;
                while (q < body + c.size) {
                  var g = readElement(win.bytes, q - win.start);
                  if (!g || g.size < 0) break;
                  var gBody = q + g.header;
                  if (g.id === EBML.Block) {
                    var tn = readSize(win.bytes, gBody - win.start);
                    if (tn && tn.value === self.trackNumber) {
                      var block = win.sub(gBody, g.size).slice();
                      block[tn.length + 2] = (block[tn.length + 2] & 0x0e) | 0x80;
                      blocks.push(block);
                    }
                  }
                  q = gBody + g.size;
                }
                p += total;
                return nextChild();
              });
            }
            p += total;
            return nextChild();
          });
        }
        return nextChild().then(function () {
          if (startTime === null) startTime = timecode * scale;
          var payload = [element(EBML.Timecode, uintBytes(timecode))];
          for (var i = 0; i < blocks.length; i++) payload.push(element(EBML.SimpleBlock, blocks[i]));
          if (blocks.length) clusters.push(element(EBML.Cluster, concat(payload)));
          self._lastTime = timecode * scale;
          return true;
        });
      });
    }

    function loop() {
      return readCluster().then(function (more) {
        if (more && pos < self.file.size && (self._lastTime - startTime) < SECTION_SECONDS) return loop();
        return more && pos < self.file.size;
      });
    }

    return loop().then(function (hasMore) {
      if (!clusters.length) {
        return hasMore ? { samples: new Float32Array(0), start: startTime || 0, next: { offset: pos } } : null;
      }
      var info = element(EBML.Info, element(EBML.TimecodeScale, uintBytes(self.timecodeScale)));
      var tracks = element(EBML.Tracks, self.trackEntry);
      var segment = concat([new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), info, tracks]);
      var bytes = concat([self.ebmlHeader, segment].concat(clusters));
      clusters = null;
      return decodeWith(self, bytes).then(function (pcm) {
        // Opus drops its start-up delay at the beginning of every decode.
        var shift = startTime > 0 && self.codecId === 'A_OPUS' ? (self.codecDelay || 0) : 0;
        return { samples: pcm, start: startTime + shift, next: hasMore ? { offset: pos } : null };
      });
    });
  };

  // ---------- OGG (Opus, Vorbis) ----------

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var r = i << 24;
      for (var j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
      t[i] = r >>> 0;
    }
    return t;
  })();
  function oggCrc(b) {
    var crc = 0;
    for (var i = 0; i < b.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b[i]) & 0xff]) >>> 0;
    return crc;
  }

  function parsePage(b, o) {
    if (o + 27 > b.length || b[o] !== 0x4f || b[o + 1] !== 0x67 || b[o + 2] !== 0x67 || b[o + 3] !== 0x53) return null;
    var nsegs = b[o + 26];
    if (o + 27 + nsegs > b.length) return { partial: true };
    var body = 0;
    for (var i = 0; i < nsegs; i++) body += b[o + 27 + i];
    var lo = u32le(b, o + 6), hi = u32le(b, o + 10);
    return {
      flags: b[o + 5],
      granule: hi === 0xffffffff && lo === 0xffffffff ? -1 : hi * 4294967296 + lo,
      serial: u32le(b, o + 14),
      nsegs: nsegs,
      headerLength: 27 + nsegs,
      length: 27 + nsegs + body
    };
  }

  /** Remove a packet continued from the previous page, so the section starts cleanly. */
  function dropContinuation(page) {
    var nsegs = page[26];
    var skipSegs = 0, skipBytes = 0;
    while (skipSegs < nsegs) {
      var lace = page[27 + skipSegs];
      skipSegs++; skipBytes += lace;
      if (lace < 255) break;
    }
    var keep = nsegs - skipSegs;
    var out = new Uint8Array(27 + keep + (page.length - 27 - nsegs - skipBytes));
    out.set(page.subarray(0, 26), 0);
    out[5] = page[5] & ~1;
    out[26] = keep;
    out.set(page.subarray(27 + skipSegs, 27 + nsegs), 27);
    out.set(page.subarray(27 + nsegs + skipBytes), 27 + keep);
    out[22] = out[23] = out[24] = out[25] = 0;
    var crc = oggCrc(out);
    out[22] = crc & 0xff; out[23] = (crc >>> 8) & 0xff; out[24] = (crc >>> 16) & 0xff; out[25] = crc >>> 24;
    return keep ? out : null;
  }

  function OggReader(file, opts) {
    this.file = file;
    this.decode = opts.decode;
    this.kind = 'ogg';
    this.label = 'OGG / OPUS';
  }
  OggReader.prototype.init = function () {
    var self = this;
    var win = new ByteWindow(this.file);
    var pos = 0;
    var headers = [];
    var packetsDone = 0;
    var needed = 0;
    function next() {
      return win.ensure(pos, 27 + 255).then(function () {
        var page = parsePage(win.bytes, pos - win.start);
        if (!page || page.partial) throw ReaderError('unreadable', 'Bad Ogg page');
        return win.ensure(pos, page.length).then(function () {
          var bytes = win.sub(pos, page.length);
          if (!headers.length) {
            var id = ascii(bytes, page.headerLength, 8);
            if (id === 'OpusHead') {
              self.codec = 'opus';
              self.rate = 48000;
              self.preSkip = u16le(bytes, page.headerLength + 10);
              needed = 2;
            } else if (ascii(bytes, page.headerLength + 1, 6) === 'vorbis') {
              self.codec = 'vorbis';
              self.rate = u32le(bytes, page.headerLength + 12);
              self.preSkip = 0;
              needed = 3;
            } else {
              throw ReaderError('unsupported', 'Ogg codec not supported');
            }
            self.serial = page.serial;
          }
          if (page.serial === self.serial) {
            headers.push(bytes.slice());
            for (var i = 0; i < page.nsegs; i++) if (bytes[27 + i] < 255) packetsDone++;
          }
          pos += page.length;
          if (packetsDone >= needed) return;
          return next();
        });
      });
    }
    return next().then(function () {
      self.headerPages = concat(headers);
      self.firstCursor = { offset: pos, granule: 0 };
      return readBytes(self.file, Math.max(pos, self.file.size - 128 * 1024), self.file.size);
    }).then(function (tail) {
      var last = 0;
      for (var i = 0; i + 27 <= tail.length; i++) {
        if (tail[i] !== 0x4f || tail[i + 1] !== 0x67 || tail[i + 2] !== 0x67 || tail[i + 3] !== 0x53) continue;
        var p = parsePage(tail, i);
        if (p && !p.partial && p.serial === self.serial && p.granule > 0) last = p.granule;
      }
      self.duration = Math.max(0, last - self.preSkip) / self.rate;
    });
  };
  OggReader.prototype.read = function (cursor) {
    var self = this;
    var win = new ByteWindow(this.file);
    var pos = cursor.offset;
    var pages = [];
    var startGranule = cursor.granule;
    var lastGranule = startGranule;
    var limit = SECTION_SECONDS * this.rate;
    function next() {
      if (lastGranule - startGranule >= limit) return Promise.resolve(true);
      return win.ensure(pos, 27 + 255).then(function (ok) {
        if (!ok) return false;
        var page = parsePage(win.bytes, pos - win.start);
        if (!page || page.partial) {
          // Damaged: look for the next page.
          var b = win.bytes;
          for (var i = pos + 1 - win.start; i + 4 <= b.length; i++) {
            if (b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53) { pos = win.start + i; return next(); }
          }
          pos = win.start + b.length - 3;
          return pos + 27 < self.file.size ? next() : false;
        }
        return win.ensure(pos, page.length).then(function () {
          if (page.serial === self.serial && !(page.flags & 2)) {
            var bytes = win.sub(pos, page.length).slice();
            if (!pages.length && (page.flags & 1)) bytes = dropContinuation(bytes);
            if (bytes) pages.push(bytes);
            if (page.granule >= 0) lastGranule = page.granule;
          }
          pos += page.length;
          if (pos >= self.file.size) return false;
          return next();
        });
      });
    }
    return next().then(function (hasMore) {
      // Opus decoders drop the pre-skip samples at the start of every decode,
      // so a section's sound begins at its start granule.
      var start = startGranule / self.rate;
      if (!pages.length) return hasMore ? { samples: new Float32Array(0), start: start, next: { offset: pos, granule: lastGranule } } : null;
      return decodeWith(self, concat([self.headerPages].concat(pages))).then(function (pcm) {
        return {
          samples: pcm,
          start: start,
          next: hasMore ? { offset: pos, granule: lastGranule } : null
        };
      });
    });
  };

  // ---------- FLAC ----------

  var CRC8 = (function () {
    var t = new Uint8Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var j = 0; j < 8; j++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
      t[i] = c;
    }
    return t;
  })();

  /** Check for a real FLAC frame header at b[o]; returns its first sample number or -1. */
  function flacFrameAt(b, o, info) {
    if (o + 16 > b.length || b[o] !== 0xff || (b[o + 1] & 0xfe) !== 0xf8) return -1;
    var variable = b[o + 1] & 1;
    var bsCode = b[o + 2] >> 4, srCode = b[o + 2] & 0x0f;
    if (bsCode === 0 || srCode === 15 || (b[o + 3] & 1) || ((b[o + 3] >> 1) & 7) === 3 || ((b[o + 3] >> 1) & 7) === 7) return -1;
    if ((b[o + 3] >> 4) > 10) return -1;
    var p = o + 4;
    var c = b[p];
    var extra = c < 0x80 ? 0 : c >= 0xfe ? 6 : c >= 0xfc ? 5 : c >= 0xf8 ? 4 : c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : c >= 0xc0 ? 1 : -1;
    if (extra < 0) return -1;
    var num = extra === 0 ? c : c & (0x3f >> extra);
    for (var i = 1; i <= extra; i++) {
      if ((b[p + i] & 0xc0) !== 0x80) return -1;
      num = num * 64 + (b[p + i] & 0x3f);
    }
    p += extra + 1;
    if (bsCode === 6) p += 1; else if (bsCode === 7) p += 2;
    if (srCode === 12) p += 1; else if (srCode === 13 || srCode === 14) p += 2;
    var crc = 0;
    for (var k = o; k < p; k++) crc = CRC8[crc ^ b[k]];
    if (crc !== b[p]) return -1;
    return variable ? num : num * info.blockSize;
  }

  function FlacReader(file, opts, info) {
    this.file = file;
    this.decode = opts.decode;
    this.kind = 'flac';
    this.label = 'FLAC audio';
    this.base = info.offset || 0;
  }
  FlacReader.prototype.init = function () {
    var self = this;
    return readBytes(this.file, this.base, this.base + 4 * 1024 * 1024).then(function (b) {
      var o = 4;
      var streamInfo = null;
      while (o + 4 <= b.length) {
        var last = b[o] & 0x80, type = b[o] & 0x7f;
        var len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
        if (type === 0) streamInfo = b.slice(o + 4, o + 4 + len);
        o += 4 + len;
        if (last) break;
      }
      if (!streamInfo) throw ReaderError('unreadable', 'No STREAMINFO');
      self.audioStart = self.base + o;
      self.blockSize = u16be(streamInfo, 0);
      self.rate = (streamInfo[10] << 12) | (streamInfo[11] << 4) | (streamInfo[12] >> 4);
      var total = (streamInfo[13] & 0x0f) * 4294967296 + u32be(streamInfo, 14);
      var si = streamInfo.slice();
      // Section headers say "length unknown" and carry no checksum.
      si[13] &= 0xf0; si[14] = si[15] = si[16] = si[17] = 0;
      for (var m = 18; m < 34; m++) si[m] = 0;
      self.header = concat([new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]), si]);
      self.duration = total ? total / self.rate : 0;
      self.bytesPerSecond = self.duration ? (self.file.size - self.audioStart) / self.duration : self.rate * 2;
      if (!self.duration) self.duration = (self.file.size - self.audioStart) / self.bytesPerSecond;
      self.firstCursor = { offset: self.audioStart };
    });
  };
  /** First real frame at or after offset: { offset, sample } or null. */
  FlacReader.prototype._findFrame = function (offset) {
    var self = this;
    return readBytes(this.file, offset, offset + 256 * 1024).then(function (b) {
      for (var i = 0; i + 16 <= b.length; i++) {
        if (b[i] !== 0xff) continue;
        var s = flacFrameAt(b, i, self);
        if (s >= 0) return { offset: offset + i, sample: s };
      }
      if (offset + b.length >= self.file.size) return null;
      return self._findFrame(offset + b.length - 16);
    });
  };
  FlacReader.prototype.read = function (cursor) {
    var self = this;
    var first;
    return this._findFrame(cursor.offset).then(function (f) {
      if (!f) return null;
      first = f;
      var target = f.offset + Math.round(SECTION_SECONDS * self.bytesPerSecond);
      return target >= self.file.size ? null : self._findFrame(target);
    }).then(function (end) {
      if (!first) return null;
      var stop = end ? end.offset : self.file.size;
      return readBytes(self.file, first.offset, stop).then(function (frames) {
        return decodeWith(self, concat([self.header, frames]));
      }).then(function (pcm) {
        return { samples: pcm, start: first.sample / self.rate, next: end ? { offset: end.offset } : null };
      });
    });
  };

  // ---------- Anything else Chrome can play: decode the whole (small) file ----------

  function WholeFileReader(file, opts) {
    this.file = file;
    this.decode = opts.decode;
    this.kind = 'other';
    this.label = 'Audio';
  }
  WholeFileReader.prototype.init = function () {
    var self = this;
    if (this.file.size > FALLBACK_MAX_BYTES) return Promise.reject(ReaderError('tooLarge', 'Too big to decode at once'));
    return readBytes(this.file, 0, this.file.size).then(function (bytes) {
      return decodeWith(self, bytes);
    }).then(function (pcm) {
      if (!pcm.length) throw ReaderError('noAudio', 'Silent or empty');
      self.pcm = pcm;
      self.duration = pcm.length / RATE;
      self.firstCursor = { sample: 0 };
    });
  };
  WholeFileReader.prototype.read = function (cursor) {
    var n = SECTION_SECONDS * RATE;
    if (cursor.sample >= this.pcm.length) return Promise.resolve(null);
    var end = Math.min(this.pcm.length, cursor.sample + n);
    return Promise.resolve({
      samples: this.pcm.slice(cursor.sample, end),
      start: cursor.sample / RATE,
      next: end < this.pcm.length ? { sample: end } : null
    });
  };

  // ---------- Opening a file ----------

  var SUPPORTED_EXT = /\.(mp3|m4a|m4b|aac|wav|wave|ogg|oga|opus|webm|weba|flac|mp4|m4v|mov|mkv|3gp|3g2|avi)$/i;

  /** Is this something we should even try? (Checked before reading the file.) */
  function looksSupported(file) {
    var type = String(file.type || '');
    if (SUPPORTED_EXT.test(file.name || '')) return true;
    if (/^(audio|video)\//.test(type)) return true;
    return !type && !/\.[a-z0-9]{1,5}$/i.test(file.name || '');
  }

  function open(file, opts) {
    opts = opts || {};
    var options = { decode: opts.decode || browserDecode };
    if (!file || !file.size) return Promise.reject(ReaderError('unreadable', 'Empty file'));
    if (!looksSupported(file)) return Promise.reject(ReaderError('unsupported', 'Not audio or video'));
    return sniff(file).then(function (info) {
      var reader;
      switch (info.kind) {
        case 'wav': reader = new WavReader(file, options); break;
        case 'mp3': case 'adts': reader = new FrameReader(file, options, info); break;
        case 'mp4': reader = new Mp4Reader(file, options); break;
        case 'mkv': reader = new MkvReader(file, options); break;
        case 'ogg': reader = new OggReader(file, options); break;
        case 'flac': reader = new FlacReader(file, options, info); break;
        case 'unsupported': return Promise.reject(ReaderError('unsupported', 'Format not supported'));
        case 'empty': return Promise.reject(ReaderError('unreadable', 'Empty file'));
        default:
          if (!/^(audio|video)\//.test(file.type || '') && !SUPPORTED_EXT.test(file.name || '')) {
            return Promise.reject(ReaderError('unsupported', 'Unknown format'));
          }
          reader = new WholeFileReader(file, options);
          reader.unknownFormat = true;
      }
      if (info.video || VIDEO_EXT.test(file.name || '') || /^video\//.test(file.type || '')) reader.isVideo = true;
      return reader.init().then(function () {
        if (reader.kind === 'wav' && !reader.sliceable) {
          var whole = new WholeFileReader(file, options);
          return whole.init().then(function () { return whole; });
        }
        return reader;
      }, function (err) {
        // A format quirk we can't read in sections (for example a fragmented MP4):
        // small files can still be decoded in one go.
        if (err && (err.code === 'noAudio' || err.code === 'memory' || err.code === 'tooLarge')) throw err;
        if (reader.unknownFormat) throw ReaderError('unsupported', 'Chrome cannot play this format');
        if (file.size <= FALLBACK_MAX_BYTES) {
          var whole = new WholeFileReader(file, options);
          whole.isVideo = reader.isVideo;
          return whole.init().then(function () { return whole; }, function (err2) {
            if (err2 && (err2.code === 'memory' || err2.code === 'noAudio')) throw err2;
            throw err && err.code === 'unsupported' ? err : ReaderError('unreadable', String(err2 && err2.message));
          });
        }
        if (err && err.code) {
          if (err.code === 'fragmented') throw ReaderError('tooLarge', err.message);
          throw err;
        }
        throw ReaderError('unreadable', String(err));
      });
    }).then(function (reader) {
      if (reader.isVideo) reader.label = 'Video (sound only)';
      return reader;
    });
  }

  // ---------- Chunker: turns sections into Whisper-sized pieces ----------

  var CHUNK_SECONDS = 30;
  var CHUNK_MIN_SECONDS = 20;

  /**
   * opts.startTime / opts.startCursor: carry on from a saved place. The cursor
   * points at a section that starts at or before startTime; sound before
   * startTime is skipped.
   */
  function Chunker(reader, opts) {
    opts = opts || {};
    this.reader = reader;
    this.cursor = opts.startCursor || reader.firstCursor;
    this.skipUntil = opts.startTime || 0;
    this.buf = new Float32Array(0);
    this.bufTime = null;          // time of buf[0]
    this.sections = [];           // [{ time, cursor }] sections whose sound is in buf
    this.done = false;
    this.skippedParts = 0;
  }

  Chunker.prototype._append = function (section, cursor) {
    var samples = section.samples;
    var start = section.start;
    if (this.bufTime === null) {
      if (start < this.skipUntil) {
        samples = samples.subarray(Math.min(samples.length, Math.round((this.skipUntil - start) * RATE)));
        start = this.skipUntil;
      }
      this.bufTime = start;
    } else {
      // Keep the timeline exact: fill small gaps with silence, drop small overlaps.
      var expected = this.bufTime + this.buf.length / RATE;
      var diff = start - expected;
      if (diff > 0.002) {
        var pad = new Float32Array(Math.round(diff * RATE));
        samples = concatFloat([pad, samples]);
      } else if (diff < -0.002) {
        samples = samples.subarray(Math.min(samples.length, Math.round(-diff * RATE)));
      }
    }
    this.sections.push({ time: section.start, cursor: cursor });
    this.buf = concatFloat([this.buf, samples]);
  };

  function concatFloat(list) {
    var n = 0, i;
    for (i = 0; i < list.length; i++) n += list[i].length;
    var out = new Float32Array(n);
    var pos = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], pos); pos += list[i].length; }
    return out;
  }

  Chunker.prototype._fill = function () {
    var self = this;
    var need = (CHUNK_SECONDS + 1) * RATE;
    if (this.done || this.buf.length >= need) return Promise.resolve();
    var cursor = this.cursor;
    return this.reader.read(cursor).then(function (section) {
      if (!section) { self.done = true; return; }
      self.cursor = section.next;
      if (!section.next) self.done = true;
      self._append(section, cursor);
      return self._fill();
    }, function (err) {
      // One damaged part in the middle of a long file: skip it and carry on.
      if (err && err.code === 'unreadable' && self.bufTime !== null && self.cursor) {
        self.skippedParts++;
        return self._skipBadSection(cursor).then(function () { return self._fill(); });
      }
      throw err;
    });
  };

  /** Move past a section that could not be decoded. */
  Chunker.prototype._skipBadSection = function (cursor) {
    var self = this;
    var saved = this.reader.decode;
    this.reader.decode = function () { return Promise.resolve(new Float32Array(0)); };
    return this.reader.read(cursor).then(function (section) {
      self.reader.decode = saved;
      if (!section || !section.next) { self.done = true; return; }
      self.cursor = section.next;
    }, function () {
      self.reader.decode = saved;
      self.done = true;
    });
  };

  /** Where to cut: the quietest moment between 20 and 30 seconds. */
  function quietestCut(buf) {
    var frame = RATE / 10;
    var from = CHUNK_MIN_SECONDS * RATE, to = CHUNK_SECONDS * RATE - frame;
    var best = to + frame, bestEnergy = Infinity;
    for (var s = from; s <= to; s += frame / 2) {
      var e = 0;
      for (var i = s; i < s + frame; i++) e += buf[i] * buf[i];
      if (e < bestEnergy) { bestEnergy = e; best = s + frame / 2; }
    }
    return Math.round(best);
  }

  Chunker.prototype.next = function () {
    var self = this;
    return this._fill().then(function () {
      if (!self.buf.length) return null;
      var cut;
      if (self.buf.length <= CHUNK_SECONDS * RATE) {
        if (!self.done) return self.next();
        cut = self.buf.length;
      } else {
        cut = quietestCut(self.buf);
      }
      var audio = self.buf.slice(0, cut);
      var start = self.bufTime;
      var end = start + cut / RATE;
      self.buf = self.buf.slice(cut);
      self.bufTime = end;
      // Where to carry on from if we stop after this chunk.
      while (self.sections.length > 1 && self.sections[1].time <= end) self.sections.shift();
      var finished = self.done && !self.buf.length;
      var resume = finished ? null : (self.sections.length ? { time: end, cursor: self.sections[0].cursor }
        : { time: end, cursor: self.cursor });
      return { audio: audio, start: start, end: end, resume: resume };
    });
  };

  /** Peak and loudness, to skip silent chunks instead of asking Whisper. */
  function isSilent(audio) {
    var peak = 0, sum = 0;
    for (var i = 0; i < audio.length; i++) {
      var v = audio[i] < 0 ? -audio[i] : audio[i];
      if (v > peak) peak = v;
      sum += v * v;
    }
    var rms = Math.sqrt(sum / Math.max(1, audio.length));
    return peak < 0.01 && rms < 0.002;
  }

  var AudioReader = {
    open: open,
    Chunker: Chunker,
    isSilent: isSilent,
    isMemoryError: isMemoryError,
    looksSupported: looksSupported,
    RATE: RATE,
    SECTION_SECONDS: SECTION_SECONDS,
    CHUNK_SECONDS: CHUNK_SECONDS,
    FALLBACK_MAX_BYTES: FALLBACK_MAX_BYTES,
    _setSectionSeconds: function (s) { SECTION_SECONDS = s; AudioReader.SECTION_SECONDS = s; }
  };

  global.AudioReader = AudioReader;
  if (typeof module !== 'undefined' && module.exports) module.exports = AudioReader;
})(typeof window !== 'undefined' ? window : globalThis);
