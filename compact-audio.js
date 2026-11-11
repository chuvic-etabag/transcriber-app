/*
 * compact-audio.js — Turns any recording the app can read (audio or video)
 * into a small mono Ogg Opus file in the browser, ready to upload.
 *
 * - Reads the file a few minutes at a time with audio-reader.js, so 3-hour
 *   recordings and large videos never sit in memory all at once.
 * - Encodes 16 kHz mono speech with Chrome's built-in Opus encoder
 *   (WebCodecs AudioEncoder) at 24 kbps: about 3 KB a second, so a 3-hour
 *   recording is about 33 MB, under the 50 MB upload limit. Recordings over
 *   4 hours get a lower bitrate so they still fit.
 * - Keeps the timeline exact (silence and gaps included), so times in the
 *   transcript match the original file.
 *
 *   CompactAudio.isSupported()                     -> Promise<boolean>
 *   CompactAudio.convert(reader, { onProgress(fraction), isStopped() })
 *     -> Promise<{ blob, duration, bytes, bitrate }>
 *
 * Exposes window.CompactAudio.
 */
(function (global) {
  'use strict';

  var RATE = 16000;                       // what audio-reader.js gives us
  var BITRATE = 24000;
  var MIN_BITRATE = 8000;
  var MAX_BYTES = 45 * 1000 * 1000;       // stays clear of the 50 MB upload limit
  var PRE_SKIP = 312;                     // Opus encoder delay, in 48 kHz samples
  var PACKETS_PER_PAGE = 50;              // about one second of sound per Ogg page
  var FLUSH_BYTES = 4 * 1024 * 1024;      // move finished pages into a Blob every few MB

  function CompactError(code, detail) {
    var e = new Error(detail || code);
    e.code = code;   // 'unsupported' | 'tooLong' | 'stopped' | 'encoder' | reader codes
    return e;
  }

  /** The bitrate for a recording this long, so the file stays under MAX_BYTES. */
  function bitrateFor(seconds) {
    if (!seconds || seconds <= 0) return BITRATE;
    var fits = Math.floor(MAX_BYTES * 8 / (seconds * 1.03) / 1000) * 1000;  // 3% for the Ogg wrapping
    return Math.max(MIN_BITRATE, Math.min(BITRATE, fits));
  }

  function encoderConfig(bitrate) {
    return { codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: bitrate };
  }

  function isSupported() {
    if (typeof global.AudioEncoder !== 'function' || typeof global.AudioData !== 'function') {
      return Promise.resolve(false);
    }
    return global.AudioEncoder.isConfigSupported(encoderConfig(BITRATE)).then(function (r) {
      return Boolean(r && r.supported);
    }, function () { return false; });
  }

  // ---------- Ogg pages ----------

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var r = i << 24;
      for (var k = 0; k < 8; k++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
      table[i] = r >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0;
    for (var i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    return crc;
  }

  /** One Ogg page holding whole packets. flags: 2 = first page, 4 = last page. */
  function oggPage(packets, granule, serial, sequence, flags) {
    var lacing = [];
    var dataLength = 0;
    packets.forEach(function (p) {
      var n = p.length;
      while (n >= 255) { lacing.push(255); n -= 255; }
      lacing.push(n);
      dataLength += p.length;
    });
    var page = new Uint8Array(27 + lacing.length + dataLength);
    var view = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53], 0);            // "OggS"
    page[4] = 0;                                      // version
    page[5] = flags;
    view.setUint32(6, granule % 4294967296, true);    // granule position, 64-bit little-endian
    view.setUint32(10, Math.floor(granule / 4294967296), true);
    view.setUint32(14, serial, true);
    view.setUint32(18, sequence, true);
    view.setUint32(22, 0, true);                      // checksum, filled in below
    page[26] = lacing.length;
    page.set(lacing, 27);
    var pos = 27 + lacing.length;
    packets.forEach(function (p) { page.set(p, pos); pos += p.length; });
    view.setUint32(22, crc32(page), true);
    return page;
  }

  function opusHead() {
    var head = new Uint8Array(19);
    var view = new DataView(head.buffer);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);  // "OpusHead"
    head[8] = 1;                                // version
    head[9] = 1;                                // mono
    view.setUint16(10, PRE_SKIP, true);
    view.setUint32(12, RATE, true);             // original sample rate (for players)
    view.setInt16(16, 0, true);                 // no gain
    head[18] = 0;                               // mono/stereo mapping
    return head;
  }

  function opusTags() {
    var vendor = 'Transcriber';
    var tags = new Uint8Array(8 + 4 + vendor.length + 4);
    var view = new DataView(tags.buffer);
    tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
    view.setUint32(8, vendor.length, true);
    for (var i = 0; i < vendor.length; i++) tags[12 + i] = vendor.charCodeAt(i);
    view.setUint32(12 + vendor.length, 0, true);  // no comments
    return tags;
  }

  /** Collects Opus packets into Ogg pages, a few MB at a time into Blob parts. */
  function OggWriter() {
    this.serial = (Math.random() * 4294967295) >>> 0;
    this.sequence = 0;
    this.granule = 0;          // 48 kHz samples of all packets so far
    this.pending = [];         // packets for the next page
    this.pages = [];
    this.pageBytes = 0;
    this.parts = [];
    this.bytes = 0;
    this._write(oggPage([opusHead()], 0, this.serial, this.sequence++, 2));
    this._write(oggPage([opusTags()], 0, this.serial, this.sequence++, 0));
  }

  OggWriter.prototype._write = function (page) {
    this.pages.push(page);
    this.pageBytes += page.length;
    this.bytes += page.length;
    if (this.pageBytes >= FLUSH_BYTES) this._flushParts();
  };

  OggWriter.prototype._flushParts = function () {
    if (!this.pages.length) return;
    this.parts.push(new Blob(this.pages));
    this.pages = [];
    this.pageBytes = 0;
  };

  OggWriter.prototype.add = function (packet, samples48k) {
    // A full page goes out only once another packet arrives, so the last page always has packets.
    var lacing = Math.floor(packet.length / 255) + 1;
    // An Ogg page holds at most 255 lacing values.
    if (this.pending.length && (this.pending.length >= PACKETS_PER_PAGE || this.lacing + lacing > 255)) {
      this._write(oggPage(this.pending, this.granule, this.serial, this.sequence++, 0));
      this.pending = [];
      this.lacing = 0;
    }
    this.pending.push(packet);
    this.lacing = (this.lacing || 0) + lacing;
    this.granule += samples48k;
  };

  /** Finish the file. endGranule trims the encoder's padding off the end. */
  OggWriter.prototype.finish = function (endGranule) {
    var granule = Math.min(this.granule, endGranule);
    if (!this.pending.length) this.pending.push(new Uint8Array([0xf8, 0xff, 0xfe]));  // a silent packet
    this._write(oggPage(this.pending, granule, this.serial, this.sequence++, 4));
    this.pending = [];
    this._flushParts();
    return new Blob(this.parts, { type: 'audio/ogg' });
  };

  // ---------- Converting ----------

  /**
   * reader: an AudioReader reader (from AudioReader.open).
   * opts.onProgress(fraction, secondsDone), opts.isStopped() -> true to stop.
   */
  function convert(reader, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var isStopped = opts.isStopped || function () { return false; };
    var duration = reader.duration || 0;
    var bitrate = bitrateFor(duration);
    if (duration && duration * bitrate / 8 * 1.03 > MAX_BYTES * 1.02) {
      return Promise.reject(CompactError('tooLong', 'Recording too long for one upload'));
    }

    return isSupported().then(function (ok) {
      if (!ok) throw CompactError('unsupported', 'No Opus encoder in this browser');
      return new Promise(function (resolve, reject) {
        var writer = new OggWriter();
        var failed = null;
        var encoder = new global.AudioEncoder({
          output: function (chunk) {
            var data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            var samples = Math.round((chunk.duration || 20000) * 48000 / 1e6);
            writer.add(data, samples);
          },
          error: function (e) { failed = failed || CompactError('encoder', String(e && e.message || e)); }
        });
        encoder.configure(encoderConfig(bitrate));

        var chunker = new global.AudioReader.Chunker(reader);
        var samplesIn = 0;

        function waitForEncoder() {
          // Don't let decoded sound pile up faster than the encoder takes it.
          if (encoder.encodeQueueSize < 4) return Promise.resolve();
          return new Promise(function (r) { setTimeout(r, 10); }).then(waitForEncoder);
        }

        function step() {
          if (failed) return Promise.reject(failed);
          if (isStopped()) { chunker.stop(); return Promise.reject(CompactError('stopped')); }
          return chunker.next().then(function (chunk) {
            if (!chunk) return null;
            if (failed) throw failed;
            var audio = chunk.audio;
            var data = new global.AudioData({
              format: 'f32',
              sampleRate: RATE,
              numberOfFrames: audio.length,
              numberOfChannels: 1,
              timestamp: Math.round(samplesIn / RATE * 1e6),
              data: audio
            });
            encoder.encode(data);
            data.close();
            samplesIn += audio.length;
            onProgress(duration ? Math.min(1, chunk.end / duration) : 0, chunk.end);
            return waitForEncoder().then(step);
          });
        }

        step().then(function () {
          return encoder.flush();
        }).then(function () {
          if (failed) throw failed;
          try { encoder.close(); } catch (e) { /* already closed */ }
          if (!samplesIn) throw CompactError('noAudio', 'No sound in the file');
          var blob = writer.finish(PRE_SKIP + Math.round(samplesIn * 48000 / RATE));
          onProgress(1, samplesIn / RATE);
          resolve({ blob: blob, duration: samplesIn / RATE, bytes: blob.size, bitrate: bitrate });
        }).catch(function (err) {
          try { if (encoder.state !== 'closed') encoder.close(); } catch (e) { /* ignore */ }
          if (err && err.code) reject(err);
          else if (global.AudioReader.isMemoryError(err)) reject(CompactError('memory', String(err)));
          else reject(CompactError('encoder', String(err && err.message || err)));
        });
      });
    });
  }

  global.CompactAudio = {
    isSupported: isSupported,
    convert: convert,
    bitrateFor: bitrateFor,
    MAX_BYTES: MAX_BYTES,
    _crc32: crc32
  };
})(window);
