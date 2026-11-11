/*
 * whisper-file.js — NOT USED BY THE APP (kept for later). The File tab from
 * TR Session B, which transcribed files on the phone with Whisper. Since
 * TR Session C the File tab sends recordings to Speechmatics instead (file.js),
 * and this on-device option is hidden. tests/whisper-page/ still loads this
 * file so tests/whisper.test.js keeps checking that it works.
 *
 * Original description: choose an audio or video file and transcribe it
 * with Whisper, running in whisper-worker.js so the screen never freezes.
 *
 * - Reads the file a section at a time (audio-reader.js), so 2 to 3 hour
 *   recordings work on a phone.
 * - Sends 30-second pieces to the worker and shows a percentage.
 * - Saves every finished piece in IndexedDB (job-store.js). Choosing the
 *   same file again carries on from the last saved piece.
 * - Keeps the screen on while it works (keep-awake.js).
 *
 * Exposes window.FileTab. app.js creates it and gives it the page elements
 * and an `onText` callback (called whenever the transcript changes).
 */
(function (global) {
  'use strict';

  var MODELS = {
    fast: { id: 'onnx-community/whisper-tiny', name: 'Fast', mb: 40 },
    accurate: { id: 'onnx-community/whisper-base', name: 'Accurate', mb: 80 }
  };
  var ENGINE_MB = 27;   // the speech engine, downloaded once for both models
  var ENGINE_FILE = 'ort-wasm-simd-threaded.asyncify.wasm';
  var LONG_FILE_SECONDS = 30 * 60;
  var STATE_KEY = 'transcriber.fileState';
  var SETTINGS_KEY = 'transcriber.fileSettings';

  var MESSAGES = {
    start: 'Choose a recording to get started. Your audio stays on this device.',
    reading: 'Reading the file…',
    unsupported:
      'This file type is not supported. Choose an audio file (MP3, M4A, WAV, OGG, WEBM, FLAC) or a video file (MP4, MOV, WEBM, MKV, 3GP).',
    unreadable:
      'This file could not be read. It may be damaged or only partly downloaded. Try opening it in another app to check it plays, or choose a different file.',
    noAudio: 'This file has no sound to transcribe.',
    fileRead:
      'The file could not be read any more. It may have been moved, renamed or still be downloading. ' +
      'Choose it again to carry on from where it stopped.',
    tooLarge:
      'This file is too large to read in this format. Save or convert it as MP3 or M4A and try again.',
    memory:
      'Your phone ran out of memory. Close other apps, then tap Continue Transcribing. Your progress is saved. If it keeps happening, choose Fast.',
    offline: function (model, size) {
      return 'No internet connection. The first time you use ' + model.name +
        ', Transcriber needs to download the speech model (' + size + '). Connect to Wi-Fi and try again.';
    },
    downloadFailed: function (model, size) {
      return 'The speech model (' + model.name + ', ' + size + ') could not be downloaded. ' +
        'Check your internet connection (Wi-Fi is best) and tap Start Transcribing again.';
    },
    workerFailed: 'The speech model could not start. Reload the page and try again.',
    storage: 'Progress could not be saved on this device, so if the app closes you will have to start again.',
    ready: 'Ready. Tap Start Transcribing.',
    loading: 'Getting the speech model ready…',
    cancelled: function (at, total) {
      return 'Stopped at ' + at + ' of ' + total + '. What is done so far is saved. ' +
        'Tap Continue Transcribing to carry on, now or later.';
    },
    done: function (length, took) {
      return 'Done. Transcribed ' + length + ' of audio in ' + took + '.';
    },
    skipped: ' Some damaged parts of the file could not be read and were skipped.',
    interrupted: function (name, at, total) {
      return 'Transcribing “' + name + '” stopped at ' + at + ' of ' + total +
        ' when the app closed. Choose the same file again to carry on from there.';
    }
  };

  // ---------- Helpers ----------

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 75 -> "1:15", 3725 -> "1:02:05" (hours shown when the file is an hour or longer). */
  function clock(seconds, withHours) {
    seconds = Math.max(0, Math.floor(seconds));
    var h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
    return withHours || h ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }

  /** 41 -> "41 seconds", 3725 -> "1 hour 2 minutes". */
  function spoken(seconds) {
    seconds = Math.round(seconds);
    if (seconds < 60) return seconds + (seconds === 1 ? ' second' : ' seconds');
    var h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    var parts = [];
    if (h) parts.push(h + (h === 1 ? ' hour' : ' hours'));
    if (m || !h) parts.push(m + (m === 1 ? ' minute' : ' minutes'));
    return parts.join(' ');
  }

  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  /** What is already saved on this device: { model: bool, engine: bool, mb: download still needed }. */
  function isCached(model) {
    var none = { model: false, engine: false };
    var check = !global.caches ? Promise.resolve(none) :
      global.caches.open('transformers-cache').then(function (cache) {
        return cache.keys();
      }).then(function (keys) {
        return {
          model: keys.some(function (r) {
            return r.url.indexOf('/' + model.id + '/') !== -1 && r.url.indexOf('decoder_model_merged') !== -1;
          }),
          engine: keys.some(function (r) { return r.url.indexOf(ENGINE_FILE) !== -1; })
        };
      }).catch(function () { return none; });
    return check.then(function (c) {
      c.mb = (c.model ? 0 : model.mb) + (c.engine ? 0 : ENGINE_MB);
      c.ready = c.mb === 0;
      c.size = 'about ' + Math.ceil(c.mb / 5) * 5 + ' MB';
      return c;
    });
  }

  // ---------- The tab ----------

  function FileTab(els, hooks) {
    this.els = els;
    this.onText = (hooks && hooks.onText) || function () {};
    this.onBusy = (hooks && hooks.onBusy) || function () {};
    this.file = null;
    this.reader = null;
    this.key = null;
    this.job = null;
    this.pieces = [];         // finished pieces shown in the transcript: { start, end, text }
    this.edited = false;      // the person has typed in the transcript box
    this.running = false;
    this.cancelled = false;
    this.worker = null;
    this.workerModel = null;
    this.pending = null;      // the worker request we are waiting for
    this.awake = global.KeepAwake ? new global.KeepAwake() : null;
    this._bind();
    this._restore();
  }

  FileTab.MESSAGES = MESSAGES;
  FileTab.clock = clock;
  FileTab.MODELS = MODELS;

  FileTab.prototype._bind = function () {
    var self = this, els = this.els;
    els.choose.addEventListener('click', function () {
      if (self.running) return;
      els.input.value = '';
      els.input.click();
    });
    els.input.addEventListener('change', function () {
      var file = els.input.files && els.input.files[0];
      if (file) self.choose(file);
    });
    els.start.addEventListener('click', function () { self.start(); });
    els.cancel.addEventListener('click', function () { self.cancel(); });
    els.startOver.addEventListener('click', function () { self.startOver(); });
    els.replaceYes.addEventListener('click', function () {
      els.replaceBox.hidden = true;
      var file = self._waitingFile;
      self._waitingFile = null;
      if (file) self.choose(file, true);
    });
    els.replaceNo.addEventListener('click', function () {
      els.replaceBox.hidden = true;
      self._waitingFile = null;
    });
    els.speed.addEventListener('change', function () { self._saveSettings(); self._showModelNote(); });
    els.language.addEventListener('change', function () { self._saveSettings(); });
    els.timestamps.addEventListener('change', function () { self._saveSettings(); self._timestampsChanged(); });
    els.transcript.addEventListener('input', function () {
      self.edited = true;
      self._saveState();
    });
    global.addEventListener('pagehide', function () { self._saveState(); });
  };

  // ---------- Settings and saved state ----------

  FileTab.prototype._saveSettings = function () {
    saveJSON(SETTINGS_KEY, {
      speed: this.els.speed.value,
      language: this.els.language.value,
      timestamps: this.els.timestamps.checked
    });
  };

  FileTab.prototype._saveState = function () {
    var ok = saveJSON(STATE_KEY, {
      text: this.els.transcript.value,
      pieces: this.pieces,
      edited: this.edited,
      key: this.key,
      name: this.file ? this.file.name : (this._restoredName || ''),
      duration: this.reader ? this.reader.duration : (this._restoredDuration || 0)
    });
    if (!ok && !this._warnedStorage) {
      this._warnedStorage = true;
      this.message(MESSAGES.storage, 'warn');
    }
  };

  FileTab.prototype._restore = function () {
    var self = this;
    var settings = loadJSON(SETTINGS_KEY);
    if (settings) {
      if (settings.speed && MODELS[settings.speed]) this.els.speed.value = settings.speed;
      if (settings.language) this.els.language.value = settings.language;
      this.els.timestamps.checked = Boolean(settings.timestamps);
    }
    var state = loadJSON(STATE_KEY);
    if (state && typeof state.text === 'string') {
      this.els.transcript.value = state.text;
      this.pieces = state.pieces || [];
      this.edited = Boolean(state.edited);
      this.key = state.key || null;
      this._restoredName = state.name;
      this._restoredDuration = state.duration;
    }
    this.message(MESSAGES.start);
    this._showModelNote();
    this.onText();
    // Tell the person if a transcription was cut short last time.
    if (global.JobStore) {
      global.JobStore.latestUnfinished().then(function (job) {
        if (!job || self.file || !job.nextTime) return;
        self.message(MESSAGES.interrupted(job.name, clock(job.nextTime, job.duration >= 3600),
          clock(job.duration, job.duration >= 3600)), 'warn');
      }).catch(function () {});
    }
  };

  FileTab.prototype.model = function () {
    return MODELS[this.els.speed.value] || MODELS.fast;
  };

  FileTab.prototype._showModelNote = function () {
    var self = this;
    var model = this.model();
    this.els.speedHint.textContent = model === MODELS.fast
      ? 'Fast is quicker. Accurate gets more words right, especially in Filipino, but takes about 3 times longer.'
      : 'Accurate gets more words right, especially in Filipino, but takes about 3 times longer than Fast.';
    isCached(model).then(function (cached) {
      if (self.model() !== model) return;
      self._download = cached;
      self.els.modelNote.textContent = cached.ready
        ? model.name + ' is downloaded and ready on this device.'
        : 'First time only: ' + model.name + ' downloads the speech model (' + cached.size +
          '). Please use Wi-Fi. After that it is saved on this device.';
      self.els.modelNote.dataset.kind = cached.ready ? 'ready' : 'download';
    });
  };

  // ---------- Messages and progress ----------

  FileTab.prototype.message = function (text, kind) {
    this.els.status.textContent = text;
    this.els.status.dataset.kind = kind || 'info';
  };

  FileTab.prototype._progress = function (percent, label) {
    this.els.progressBox.hidden = percent === null;
    if (percent === null) return;
    var p = Math.max(0, Math.min(100, percent));
    this.els.progress.value = p;
    this.els.percent.textContent = label !== undefined ? label : Math.floor(p) + '%';
  };

  FileTab.prototype._setRunning = function (running) {
    var els = this.els;
    this.running = running;
    document.body.dataset.fileState = running ? 'running' : 'idle';
    els.choose.disabled = running;
    els.speed.disabled = running;
    els.language.disabled = running;
    els.start.hidden = running;
    els.cancel.hidden = !running;
    els.cancel.disabled = false;
    if (running) { if (this.awake) this.awake.start(); }
    else if (this.awake) this.awake.stop();
    this.onBusy(running);
    this._updateStartButton();
  };

  FileTab.prototype._updateStartButton = function () {
    var els = this.els;
    var canStart = Boolean(this.reader) && !this.running && !this._choosing && !(this.job && this.job.done);
    els.start.disabled = !canStart;
    els.startLabel.textContent = this.job && this.job.nextTime > 0 && !this.job.done
      ? 'Continue Transcribing' : 'Start Transcribing';
  };

  FileTab.prototype._showResume = function (text) {
    this.els.resumeText.textContent = text || '';
    this.els.resumeBox.hidden = !text;
  };

  // ---------- Transcript text ----------

  FileTab.prototype._withHours = function () {
    var d = this.reader ? this.reader.duration : (this._restoredDuration || 0);
    return d >= 3600;
  };

  FileTab.prototype._line = function (piece) {
    if (!piece.text) return '';
    return this.els.timestamps.checked ? '[' + clock(piece.start, this._withHours()) + '] ' + piece.text : piece.text;
  };

  FileTab.prototype._render = function () {
    var self = this;
    this.els.transcript.value = this.pieces.map(function (p) { return self._line(p); })
      .filter(Boolean).join('\n');
    this.edited = false;
    this._saveState();
    this.onText();
  };

  FileTab.prototype._append = function (piece) {
    this.pieces.push({ start: piece.start, end: piece.end, text: piece.text });
    var line = this._line(piece);
    if (line) {
      var box = this.els.transcript;
      var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
      var current = box.value;
      box.value = current + (current && !/\n$/.test(current) ? '\n' : '') + line;
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
    this._saveState();
    this.onText();
  };

  FileTab.prototype._timestampsChanged = function () {
    if (!this.pieces.length) return;
    if (this.edited) {
      this.message('You have edited the transcript, so timestamps change only for new sections. ' +
        'Your edits are kept.', 'warn');
      return;
    }
    this._render();
  };

  /** Called by app.js when the person clears the File transcript. */
  FileTab.prototype.cleared = function () {
    this.pieces = [];
    this.edited = false;
    this._saveState();
  };

  // ---------- Choosing a file ----------

  FileTab.prototype.choose = function (file, confirmed) {
    var self = this;
    if (this.running) return Promise.resolve();
    this._showResume('');
    this.els.replaceBox.hidden = true;

    if (!global.AudioReader.looksSupported(file)) {
      this._fail('unsupported');
      return Promise.resolve();
    }

    this.message(MESSAGES.reading);
    this._progress(null);
    this.els.choose.disabled = true;
    this._choosing = true;            // Start and Start Over wait until the new file is open
    this.els.startOver.disabled = true;
    this._updateStartButton();
    function finished() {
      self._choosing = false;
      self.els.choose.disabled = self.running;
      self.els.startOver.disabled = false;
      self._updateStartButton();
    }
    var reader, key, asked = false;
    return global.AudioReader.open(file).then(function (r) {
      reader = r;
      return global.JobStore.fileKey(file).catch(function () {
        return 'n:' + file.name + ':' + file.size + ':' + file.lastModified;
      });
    }).then(function (k) {
      key = k;
      // A different file would replace a transcript that's still in the box: ask first.
      var hasOther = self.els.transcript.value.trim() && self.key && self.key !== key;
      if (hasOther && !confirmed) {
        asked = true;
        self._waitingFile = file;
        self.els.replaceText.textContent = 'The transcript below is from “' +
          (self.file ? self.file.name : self._restoredName || 'another file') +
          '”. Choosing “' + file.name + '” will replace it. Copy or download it first if you need it.';
        self.els.replaceBox.hidden = false;
        self.message('Choose what to do with the current transcript.');
        return null;
      }
      return global.JobStore.getJob(key).catch(function () { return null; });
    }).then(function (job) {
      finished();
      if (asked || self.running) return;
      self.file = file;
      self.reader = reader;
      var sameAsBox = self.key === key;
      self.key = key;
      self.job = job || null;
      self._showFileInfo();
      if (job) return self._loadSaved(job, sameAsBox);
      self.pieces = [];
      self.els.transcript.value = '';
      self.edited = false;
      self._saveState();
      self.onText();
      self._updateStartButton();
      self._longFileWarning();
    }).catch(function (err) {
      finished();
      self._fail(err && err.code ? err.code : 'unreadable', err);
    });
  };

  FileTab.prototype._showFileInfo = function () {
    var r = this.reader;
    this.els.fileInfo.hidden = false;
    this.els.fileName.textContent = this.file.name;
    this.els.fileDetails.textContent = (r.duration ? spoken(r.duration) : 'Length unknown') + ' · ' + r.label;
  };

  FileTab.prototype._longFileWarning = function () {
    var d = this.reader.duration;
    if (d > LONG_FILE_SECONDS) {
      this.message('This recording is ' + spoken(d) + ' long. On a phone this can take a long time, ' +
        'often about as long as the recording itself on Accurate, or a third of that on Fast. ' +
        'Keep the phone plugged in and this page open. If it stops, choose the same file again ' +
        'to carry on from where it stopped.', 'warn');
    } else {
      this.message(MESSAGES.ready);
    }
  };

  /** The file was worked on before: show what was saved and carry on. */
  FileTab.prototype._loadSaved = function (job, sameAsBox) {
    var self = this;
    return global.JobStore.getPieces(job.key).then(function (pieces) {
      var saved = pieces.map(function (p) { return { start: p.start, end: p.end, text: p.text }; });
      if (sameAsBox && self.edited) {
        // Keep the person's edits; add anything saved after the box was last stored.
        if (self.pieces.length < saved.length) {
          saved.slice(self.pieces.length).forEach(function (p) { self._append(p); });
          self.pieces = saved;
        }
        self._saveState();
      } else {
        self.pieces = saved;
        self._render();
      }
      var withHours = job.duration >= 3600;
      self._updateStartButton();
      if (job.done) {
        self._showResume('This file was already transcribed. Its transcript is below. ' +
          'Tap Start Over to transcribe it again.');
        self.message('Already transcribed.');
        self._progress(100);
        return;
      }
      if (!job.nextTime) {
        self._longFileWarning();
        return;
      }
      var at = clock(job.nextTime, withHours), total = clock(job.duration, withHours);
      self._showResume('Continuing where you left off. The first ' + at + ' of ' + total +
        ' was already transcribed and saved, so Transcriber carries on from ' + at + '.');
      return self.start();
    });
  };

  // ---------- Worker ----------

  FileTab.prototype._ensureWorker = function () {
    var self = this;
    if (this.worker) return this.worker;
    var worker = new Worker(global.WHISPER_WORKER_URL || 'whisper-worker.js', { type: 'module' });
    worker.onmessage = function (e) { self._onWorkerMessage(e.data); };
    worker.onerror = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      var text = String((e && e.message) || '');
      self._workerFailed(global.AudioReader.isMemoryError({ message: text }) ? 'memory' : 'worker');
    };
    this.worker = worker;
    this.workerModel = null;
    return worker;
  };

  FileTab.prototype._workerFailed = function (code) {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.workerModel = null;
    if (this.pending) {
      var p = this.pending;
      this.pending = null;
      var err = new Error(code);
      err.code = code;
      p.reject(err);
    }
  };

  FileTab.prototype._onWorkerMessage = function (msg) {
    var p = this.pending;
    if (msg.type === 'download') {
      var mb = function (n) { return Math.round(n / 1048576); };
      this.message('Downloading the speech model (first time only)… ' + mb(msg.loaded) + ' of ' +
        mb(msg.total) + ' MB. Please stay on Wi-Fi.');
      this._progress(msg.progress);
      return;
    }
    if (!p) return;
    if (msg.type === 'ready' && p.type === 'load') { this.pending = null; p.resolve(msg); }
    else if (msg.type === 'result' && p.id === msg.id) { this.pending = null; p.resolve(msg); }
    else if (msg.type === 'cancelled' && p.id === msg.id) { this.pending = null; p.resolve(msg); }
    else if (msg.type === 'error') {
      this.pending = null;
      var err = new Error(msg.message);
      err.code = msg.code;
      p.reject(err);
    }
  };

  FileTab.prototype._ask = function (message, transfer) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.pending = { type: message.type, id: message.id, resolve: resolve, reject: reject };
      self._ensureWorker().postMessage(message, transfer || []);
    });
  };

  FileTab.prototype._loadModel = function (model) {
    var self = this;
    if (this.worker && this.workerModel === model.id) return Promise.resolve();
    this.message(MESSAGES.loading);
    this._progress(0, '');
    return this._ask({ type: 'load', model: model.id, bytes: model.mb * 1048576 }).then(function () {
      self.workerModel = model.id;
      self._showModelNote();
    });
  };

  // ---------- Transcribing ----------

  FileTab.prototype.start = function () {
    var self = this;
    if (this.running || this._choosing || !this.reader) return Promise.resolve();
    var model = this.model();
    var language = this.els.language.value;
    var reader = this.reader;
    var withHours = reader.duration >= 3600;
    this.cancelled = false;
    this._setRunning(true);

    var startedAt = Date.now();
    var audioDone = 0;           // seconds of audio transcribed this run (for the time estimate)
    var job;

    var run = isCached(model).then(function (cached) {
      self._download = cached;
      if (self.cancelled) return;
      if (!cached.ready && global.navigator.onLine === false) {
        var e = new Error('offline'); e.code = 'offline'; throw e;
      }
      return self._loadModel(model);
    }).then(function () {
      if (self.cancelled) return null;
      job = self.job || {
        key: self.key, name: self.file.name, size: self.file.size,
        duration: reader.duration, kind: reader.kind,
        nextTime: 0, cursor: reader.firstCursor, done: false, createdAt: Date.now()
      };
      job.model = model.id;
      job.language = language;
      self.job = job;
      if (!job.nextTime) self.pieces = [];
      return global.JobStore.putJob(job).catch(function () { self.message(MESSAGES.storage, 'warn'); });
    }).then(function () {
      if (self.cancelled || !job) return null;
      startedAt = Date.now();
      var chunker = new global.AudioReader.Chunker(reader, { startTime: job.nextTime, startCursor: job.cursor });
      self._chunker = chunker;
      self._showProgress(job.nextTime, reader.duration, withHours, null);
      var next = chunker.next();
      var id = 0;

      function loop() {
        return next.then(function (chunk) {
          if (!chunk || self.cancelled) return chunk;
          // Start reading the next piece while Whisper works on this one.
          next = chunker.next();
          next.catch(function () {});
          var silent = global.AudioReader.isSilent(chunk.audio);
          var ask = silent ? Promise.resolve({ type: 'result', text: '', language: null })
            : self._ask({ type: 'transcribe', id: ++id, audio: chunk.audio, language: language }, [chunk.audio.buffer]);
          return ask.then(function (result) {
            if (result.type === 'cancelled' || self.cancelled) return null;
            var piece = { key: job.key, start: chunk.start, end: chunk.end, text: result.text || '', language: result.language };
            job.nextTime = chunk.end;
            job.cursor = chunk.resume ? chunk.resume.cursor : null;
            job.done = !chunk.resume;
            return global.JobStore.savePiece(job, piece).catch(function () {
              if (!self._warnedSave) { self._warnedSave = true; self.message(MESSAGES.storage, 'warn'); }
            }).then(function () {
              self._append(piece);
              audioDone += chunk.end - chunk.start;
              var perSecond = (Date.now() - startedAt) / 1000 / Math.max(1, audioDone);
              self._showProgress(chunk.end, reader.duration, withHours, perSecond);
              if (job.done) return null;
              return loop();
            });
          });
        });
      }
      return loop().then(function () { return chunker; });
    }).then(function (chunker) {
      self._chunker = null;
      self._setRunning(false);
      if (self.cancelled || !job) {
        self._stoppedMessage();
        return;
      }
      if (!job.done) {
        // The reader ran out before the end we expected: treat it as finished.
        job.done = true;
        global.JobStore.putJob(job).catch(function () {});
      }
      self._progress(100);
      var took = (Date.now() - startedAt) / 1000;
      var text = MESSAGES.done(spoken(reader.duration || job.nextTime), spoken(took));
      if (chunker && chunker.skippedParts) text += MESSAGES.skipped;
      if (!self.els.transcript.value.trim()) text += ' No speech was found in this file.';
      self.message(text, 'done');
      self._showResume('');
      self._updateStartButton();
      global.JobStore.prune().catch(function () {});
    }).catch(function (err) {
      if (self._chunker) self._chunker.stop();
      self._chunker = null;
      self._setRunning(false);
      if (self.cancelled) { self._stoppedMessage(); return; }
      self._fail(err && err.code, err);
    });
    this._run = run;
    return run;
  };

  FileTab.prototype._showProgress = function (at, total, withHours, perSecond) {
    var percent = total ? at / total * 100 : 0;
    if (percent >= 100 && this.job && !this.job.done) percent = 99;
    var text = 'Transcribing… ' + Math.floor(percent) + '% (' + clock(at, withHours) + ' of ' + clock(total, withHours) + ').';
    if (perSecond && total > at) {
      var left = (total - at) * perSecond;
      text += ' About ' + (left < 60 ? 'a minute' : spoken(left)) + ' left.';
    }
    text += ' Keep this page open.';
    this.message(text);
    this._progress(percent);
  };

  FileTab.prototype._stoppedMessage = function () {
    var job = this.job;
    var withHours = this.reader && this.reader.duration >= 3600;
    this._updateStartButton();
    if (job && job.nextTime > 0) {
      this.message(MESSAGES.cancelled(clock(job.nextTime, withHours), clock(job.duration, withHours)));
    } else {
      this.message('Stopped. Tap Start Transcribing to begin again.');
      this._progress(null);
    }
  };

  FileTab.prototype.cancel = function () {
    if (!this.running) return;
    this.cancelled = true;
    this.els.cancel.disabled = true;
    this.message('Stopping…');
    if (this._chunker) this._chunker.stop();   // no more reading ahead
    if (this.pending && this.pending.type === 'load') {
      // Can't pause a download: stop the worker; nothing half-downloaded is kept.
      this._workerFailed('cancelled');
    } else if (this.worker) {
      this.worker.postMessage({ type: 'cancel' });
    }
  };

  FileTab.prototype.startOver = function () {
    var self = this;
    if (this._startingOver || this._choosing) return this._startingOver || Promise.resolve();
    this.els.startOver.disabled = true;
    var wait = Promise.resolve();
    if (this.running) {
      this.cancel();
      wait = this._run || Promise.resolve();
    }
    this._startingOver = wait.then(function () {
      return self.key ? global.JobStore.deleteJob(self.key).catch(function () {}) : null;
    }).then(function () {
      self.job = null;
      self.pieces = [];
      self.els.transcript.value = '';
      self.edited = false;
      self._saveState();
      self.onText();
      self._showResume('');
      self._progress(null);
      self._startingOver = null;
      self.els.startOver.disabled = false;
      if (self.reader) return self.start();
      self.message(MESSAGES.start);
    }, function () {
      self._startingOver = null;
      self.els.startOver.disabled = false;
    });
    return this._startingOver;
  };

  FileTab.prototype._fail = function (code, err) {
    var model = this.model();
    var size = this._download && this._download.mb ? this._download.size : 'about ' + model.mb + ' MB';
    var text;
    if (code === 'offline' || (code === 'download' && global.navigator.onLine === false)) text = MESSAGES.offline(model, size);
    else if (code === 'download') text = MESSAGES.downloadFailed(model, size);
    else if (code === 'memory') text = MESSAGES.memory;
    else if (code === 'worker' || code === 'other') text = MESSAGES.workerFailed;
    else if (code === 'cancelled') { this._stoppedMessage(); return; }
    else if (MESSAGES[code] && typeof MESSAGES[code] === 'string') text = MESSAGES[code];
    else text = MESSAGES.unreadable;
    // Start fresh next time: a worker that failed (or ran out of memory) keeps its bloated memory.
    if (['download', 'offline', 'worker', 'other', 'memory'].indexOf(code) !== -1) this._workerFailed('reset');
    this.message(text, 'error');
    this._progress(null);
    this._updateStartButton();
    if (err && global.console) global.console.warn('Transcriber:', code, err);
  };

  global.FileTab = FileTab;
})(window);
