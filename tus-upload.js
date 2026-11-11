/*
 * tus-upload.js — Resumable upload to Supabase Storage (the "tus" protocol).
 *
 * The file goes up in 6 MB pieces. After each piece the server says how much
 * it has, and the app saves that place, so an internet cut, a closed app or a
 * phone restart carries on from the last piece instead of starting over.
 *
 *   var up = new ResumableUpload(blob, {
 *     endpoint, headers, bucket, objectName, contentType,
 *     url,                       // a saved upload link, to carry on (optional)
 *     onSaved({ url, offset }),  // save these to carry on later
 *     onProgress(sent, total),
 *     onWaiting(reason|null)     // 'offline' while waiting for the internet to come back
 *   });
 *   up.start().then(...)         // resolves when the whole file is uploaded
 *   up.stop();                   // rejects start() with code 'stopped'
 *
 * Errors have a code: 'stopped' | 'tooLarge' | 'denied' | 'failed'.
 *
 * Exposes window.ResumableUpload.
 */
(function (global) {
  'use strict';

  var CHUNK = 6 * 1024 * 1024;            // Supabase needs exactly 6 MB pieces
  var SERVER_RETRIES = 6;                  // server problems: try this many times, then give up
  var WAITS = [1000, 2000, 4000, 8000, 15000, 30000];

  function UploadError(code, detail, status) {
    var e = new Error(detail || code);
    e.code = code;
    e.status = status || 0;
    return e;
  }

  function b64(text) {
    return global.btoa(unescape(encodeURIComponent(text)));
  }

  function ResumableUpload(blob, opts) {
    this.blob = blob;
    this.opts = opts;
    this.url = opts.url || null;
    this.offset = 0;
    this.stopped = false;
    this.xhr = null;
    this._wake = null;
    this.chunkSize = opts.chunkSize || CHUNK;
  }

  ResumableUpload.CHUNK = CHUNK;

  ResumableUpload.prototype.stop = function () {
    this.stopped = true;
    if (this.xhr) this.xhr.abort();
    if (this._wake) this._wake();
  };

  /** One request. Resolves with the XHR (any status); rejects with code 'network' if it never got an answer. */
  ResumableUpload.prototype._send = function (method, url, headers, body, onUpload) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (self.stopped) { reject(UploadError('stopped')); return; }
      var xhr = new global.XMLHttpRequest();
      self.xhr = xhr;
      xhr.open(method, url, true);
      var all = Object.assign({ 'Tus-Resumable': '1.0.0' }, self.opts.headers || {}, headers || {});
      Object.keys(all).forEach(function (k) { xhr.setRequestHeader(k, all[k]); });
      if (onUpload && xhr.upload) xhr.upload.onprogress = function (e) { onUpload(e.loaded); };
      xhr.onload = function () { self.xhr = null; resolve(xhr); };
      xhr.onerror = function () { self.xhr = null; reject(UploadError('network')); };
      xhr.ontimeout = xhr.onerror;
      xhr.onabort = function () { self.xhr = null; reject(UploadError(self.stopped ? 'stopped' : 'network')); };
      xhr.send(body === undefined ? null : body);
    });
  };

  function problem(xhr) {
    var s = xhr.status;
    var detail = 'HTTP ' + s + ' ' + String(xhr.responseText || '').slice(0, 200);
    if (s === 413 || /maximum allowed size|too large|exceeded the maximum/i.test(xhr.responseText || '')) {
      return UploadError('tooLarge', detail, s);
    }
    if (s === 401 || s === 403) return UploadError('denied', detail, s);
    if (s === 404 || s === 410) return UploadError('expired', detail, s);
    if (s === 409) return UploadError('conflict', detail, s);
    if (s === 0 || s === 429 || s >= 500) return UploadError('server', detail, s);
    return UploadError('failed', detail, s);
  }

  ResumableUpload.prototype._save = function () {
    if (this.opts.onSaved) this.opts.onSaved({ url: this.url, offset: this.offset });
  };

  ResumableUpload.prototype._create = function () {
    var self = this, o = this.opts;
    var metadata = [
      'bucketName ' + b64(o.bucket),
      'objectName ' + b64(o.objectName),
      'contentType ' + b64(o.contentType || 'application/octet-stream'),
      'cacheControl ' + b64('3600')
    ].join(',');
    return this._send('POST', o.endpoint, {
      'Upload-Length': String(this.blob.size),
      'Upload-Metadata': metadata,
      'x-upsert': 'false'
    }).then(function (xhr) {
      if (xhr.status !== 201 && xhr.status !== 200) throw problem(xhr);
      var location = xhr.getResponseHeader('Location');
      if (!location) throw UploadError('failed', 'No upload link in the answer');
      self.url = new global.URL(location, o.endpoint).href;
      self.offset = 0;
      self._save();
    });
  };

  /** Ask the server how much it already has. */
  ResumableUpload.prototype._head = function () {
    var self = this;
    return this._send('HEAD', this.url, {}).then(function (xhr) {
      if (xhr.status !== 200 && xhr.status !== 204) throw problem(xhr);
      var offset = Number(xhr.getResponseHeader('Upload-Offset'));
      if (!isFinite(offset) || offset < 0) throw UploadError('failed', 'No Upload-Offset');
      self.offset = offset;
      self._save();
    });
  };

  ResumableUpload.prototype._patch = function () {
    var self = this;
    var start = this.offset;
    var end = Math.min(this.blob.size, start + this.chunkSize);
    var piece = this.blob.slice(start, end);
    return this._send('PATCH', this.url, {
      'Upload-Offset': String(start),
      'Content-Type': 'application/offset+octet-stream'
    }, piece, function (loaded) {
      if (self.opts.onProgress) self.opts.onProgress(start + Math.min(loaded, end - start), self.blob.size);
    }).then(function (xhr) {
      if (xhr.status !== 204 && xhr.status !== 200) throw problem(xhr);
      var offset = Number(xhr.getResponseHeader('Upload-Offset'));
      self.offset = isFinite(offset) && offset > start ? offset : end;
      self._save();
      if (self.opts.onProgress) self.opts.onProgress(self.offset, self.blob.size);
    });
  };

  /** Wait a moment before trying again; wakes up early when the internet comes back. */
  ResumableUpload.prototype._wait = function (ms) {
    var self = this;
    return new Promise(function (resolve) {
      var timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        global.removeEventListener('online', done);
        self._wake = null;
        resolve();
      }
      global.addEventListener('online', done);
      self._wake = done;
    });
  };

  ResumableUpload.prototype.start = function () {
    var self = this;
    var networkTries = 0;
    var serverTries = 0;
    var restarted = false;
    var needHead = Boolean(this.url);

    function step() {
      if (self.stopped) return Promise.reject(UploadError('stopped'));
      var action;
      if (!self.url) action = self._create();
      else if (needHead) action = self._head().then(function () { needHead = false; });
      else if (self.offset >= self.blob.size) return Promise.resolve();
      else action = self._patch();
      return action.then(function () {
        if (networkTries && self.opts.onWaiting) self.opts.onWaiting(null);
        networkTries = 0;
        serverTries = 0;
        return step();
      }, function (err) {
        if (self.stopped || err.code === 'stopped') throw UploadError('stopped');
        if (err.code === 'expired' || (err.code === 'failed' && needHead)) {
          // The upload link ran out (after 24 hours) or the server forgot it: start a new one, once.
          if (restarted) throw UploadError('failed', err.message, err.status);
          restarted = true;
          self.url = null;
          self.offset = 0;
          needHead = false;
          return step();
        }
        if (err.code === 'conflict') {
          // The server has a different amount than we thought: ask, then carry on from there.
          needHead = true;
          serverTries++;
          if (serverTries > SERVER_RETRIES) throw UploadError('failed', err.message, err.status);
          return step();
        }
        if (err.code === 'network') {
          // No answer at all: usually the internet is down. Keep waiting until it comes back.
          if (self.opts.onWaiting) self.opts.onWaiting(global.navigator.onLine === false || networkTries >= 1 ? 'offline' : 'retrying');
          var wait = WAITS[Math.min(networkTries, WAITS.length - 1)];
          networkTries++;
          needHead = Boolean(self.url);
          return self._wait(wait).then(step);
        }
        if (err.code === 'server') {
          serverTries++;
          if (serverTries > SERVER_RETRIES) throw UploadError('failed', err.message, err.status);
          needHead = Boolean(self.url);
          return self._wait(WAITS[Math.min(serverTries, WAITS.length - 1)]).then(step);
        }
        throw err;
      });
    }
    return step().then(function () {
      if (self.opts.onWaiting) self.opts.onWaiting(null);
      return { url: self.url, size: self.blob.size };
    });
  };

  global.ResumableUpload = ResumableUpload;
})(window);
