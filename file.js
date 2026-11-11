/*
 * file.js — The File tab: choose an audio or video file and get a transcript
 * from Speechmatics, as numbered speaker turns (transcript-format.js).
 *
 * The steps, each saved in the browser (cloud-store.js) so a closed app, an
 * internet cut or a phone restart carries on instead of starting over, and a
 * file is never paid for twice:
 *   1. Prepare: the sound becomes a small mono Ogg Opus file in the browser
 *      (compact-audio.js), read a few minutes at a time (audio-reader.js).
 *   2. Upload: to a private Supabase bucket in 6 MB pieces (tus-upload.js).
 *   3. Speechmatics: an Edge Function starts the job (cloud-api.js); the app
 *      checks on it until it is done. The Speechmatics job number is saved.
 *   4. Save: the transcript is saved on this device and in My Transcripts
 *      (cloud-db.js), together with its uploaded sound, which is kept until
 *      the item is deleted there.
 *
 * Everything needs a signed-in person (auth.js). The transcript itself is
 * shown by transcript-view.js, the same view My Transcripts uses.
 *
 * Exposes window.FileTab. app.js creates it and gives it the page elements.
 */
(function (global) {
  'use strict';

  var TF = global.TranscriptFormat;
  var STATE_KEY = 'transcriber.cloudFileState';
  var OLD_STATE_KEY = 'transcriber.fileState';     // the Whisper transcript from TR Session B
  var LONG_FILE_SECONDS = 60 * 60;
  // How often to ask Speechmatics how it is going (the tests make these shorter).
  var TIMING = { pollFirst: 4000, poll: 10000, pollSlow: 20000, retry: 8000, busy: 3000, sync: 1500, lookup: 8000 };
  var MB = 1000 * 1000;

  var MESSAGES = {
    start: 'Choose a recording to get started.',
    reading: 'Reading the file…',
    ready: 'Ready. Tap Start Transcribing.',
    unsupported:
      'This file type is not supported. Choose an audio file (MP3, M4A, WAV, OGG, WEBM, FLAC) or a video file (MP4, MOV, WEBM, MKV, 3GP).',
    unreadable:
      'This file could not be read. It may be damaged or only partly downloaded. Try opening it in another app to check it plays, or choose a different file.',
    noAudio: 'This file has no sound to transcribe.',
    fileRead:
      'The file could not be read any more. It may have been moved, renamed or still be downloading. Choose it again to carry on.',
    tooLarge: 'This file is too large to read in this format. Save or convert it as MP3 or M4A and try again.',
    tooLong: 'This recording is too long to send in one go. Split it into parts of up to 12 hours and transcribe each part.',
    memory: 'Your phone ran out of memory. Close other apps, then tap Continue Transcribing. Your progress is saved.',
    oldBrowser: 'This browser cannot prepare recordings for upload. Update Chrome to the latest version and try again.',
    space: 'There is not enough free space on this device to prepare the recording. Free up some space and try again.',
    offline:
      'No internet connection. Connect to the internet (Wi-Fi is best for long recordings), then tap Continue Transcribing. Nothing done so far is lost.',
    offlineWaiting:
      'No internet connection. Waiting for it to come back. The upload will carry on from where it stopped.',
    offlineChecking:
      'No internet connection. Speechmatics keeps working on your recording; the app will collect the transcript when you are back online.',
    network:
      'Could not reach the transcription service. Check your internet connection and tap Continue Transcribing to try again.',
    uploadFailed:
      'The upload failed. Check your internet connection and tap Continue Transcribing to try again. It carries on from where it stopped.',
    uploadDenied:
      'The upload was refused by the server. The storage for recordings may not be set up yet. Please try again later.',
    speechmatics:
      'Speechmatics could not transcribe this recording right now. Wait a few minutes, then tap Try Again.',
    rejected: function (why) {
      return 'Speechmatics could not transcribe this recording' + (why ? ' (it said: “' + why + '”)' : '') +
        '. Tap Try Again. If it happens again, check that the recording plays and has speech in it.';
    },
    dailyLimit: function (minutes) {
      return 'Today’s transcription time is used up. This app can send ' + (minutes || 60) +
        ' minutes of recordings a day to Speechmatics (for everyone together), and that has been reached. Please try again tomorrow.';
    },
    notSetUp: 'The transcription service is not set up yet. Please try again later.',
    busy: 'This recording is still being handed to Speechmatics. Wait a few minutes, then tap Continue Transcribing. It will not be sent twice.',
    expired: 'Speechmatics no longer keeps the transcript of this recording (it keeps them for about a week). Tap Try Again to transcribe it again; this uses today’s minutes.',
    server: 'Something went wrong on the transcription server. Wait a minute, then tap Continue Transcribing.',
    storage: 'Progress could not be saved on this device, so if the app closes it may have to start again.',
    needFile: function (name) {
      return 'To carry on, choose “' + name + '” again with Choose Audio or Video File.';
    },
    interrupted: function (name) {
      return 'Transcribing “' + name + '” stopped when the app closed. Choose the same file again to carry on from where it stopped.';
    },
    playNeedsFile: function (name) {
      return 'To play the recording from this moment, choose “' + name + '” again with Choose Audio or Video File.';
    },
    cantPlay: 'This recording cannot be played here, but its transcript is fine.',
    gettingAudio: 'Getting the saved recording…',
    signIn: 'Your sign-in has ended. Tap Sign Out at the top, sign in again, then tap Continue Transcribing. Nothing done so far is lost.',
    notAllowed: 'This app isn’t open to new users yet.',
    savedInFolder: ' It is saved in My Transcripts.',
    notSavedYet: ' It could not be saved to My Transcripts yet; the app will try again by itself. It is safe on this device meanwhile.'
  };

  // ---------- Helpers ----------

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
    try { return JSON.parse(global.localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function saveJSON(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    var b = new Uint8Array(16);
    global.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function TabError(code, extra) {
    var e = new Error(code);
    e.code = code;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  function isQuotaError(err) {
    return err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message || '')));
  }

  // ---------- The tab ----------

  function FileTab(els, hooks) {
    this.els = els;
    this.view = hooks.view;       // shows the transcript (transcript-view.js)
    this.onText = (hooks && hooks.onText) || function () {};
    this.onBusy = (hooks && hooks.onBusy) || function () {};
    this.onSaved = (hooks && hooks.onSaved) || function () {};   // My Transcripts changed
    this.user = null;             // the signed-in person; nothing is sent anywhere without one
    this.active = false;          // is the File tab the one on screen?
    this.file = null;
    this.reader = null;
    this.key = null;
    this.job = null;              // the saved record for the current file (see cloud-store.js)
    this.running = false;
    this.cancelled = false;
    this.upload = null;
    this.playerUrl = null;
    this.legacyText = '';         // a Whisper transcript from before TR Session C
    this.awake = global.KeepAwake ? new global.KeepAwake() : null;
    this._run = 0;                // each run gets a number; an old run stops when it sees a newer one
    this._bind();
    this._restore();
  }

  FileTab.MESSAGES = MESSAGES;
  FileTab.TIMING = TIMING;
  FileTab.spoken = spoken;

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
      self.message(self.job && self.job.done ? 'Kept the transcript below.' : MESSAGES.start);
    });
    els.player.addEventListener('error', function () {
      if (self.els.player.getAttribute('src')) self.message(MESSAGES.cantPlay, 'warn');
    });
    global.addEventListener('pagehide', function () {
      self._saveState();
      if (self._saveTimer) self._saveJobNow();
      if (self._syncTimer) self._syncNow();
    });
  };

  // ---------- Settings and saved state ----------

  /** What is on screen: which saved file it is (the transcript itself is in IndexedDB). */
  FileTab.prototype._saveState = function () {
    var ok = saveJSON(STATE_KEY, {
      key: this.key || null,
      userId: this.user ? this.user.id : (this._stateUserId || null),
      name: this.fileName(),
      legacyText: this.legacyText || '',
      oldChecked: Boolean(this._oldChecked)
    });
    if (!ok && !this._warnedStorage) {
      this._warnedStorage = true;
      this.message(MESSAGES.storage, 'warn');
    }
  };

  FileTab.prototype._saveJob = function (job) {
    var self = this;
    job = job || this.job;
    if (!job) return Promise.resolve();
    return global.CloudStore.putJob(job).catch(function (err) {
      if (!self._warnedStorage) {
        self._warnedStorage = true;
        self.message(isQuotaError(err) ? MESSAGES.space : MESSAGES.storage, 'warn');
      }
    });
  };

  FileTab.prototype._saveJobSoon = function () {
    var self = this;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(function () { self._saveJobNow(); }, 400);
  };
  FileTab.prototype._saveJobNow = function () {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    return this._saveJob();
  };

  FileTab.prototype._restore = function () {
    var self = this;
    var state = loadJSON(STATE_KEY);
    this.message(MESSAGES.start);
    if (state) {
      this.legacyText = state.legacyText || '';
      this._restoredName = state.name || '';
      this.key = state.key || null;   // kept even if the page closes before the saved transcript is loaded
      this._stateUserId = state.userId || null;
    }
    if (!state || !state.oldChecked) {
      // A transcript from the earlier on-device version (TR Session B): keep showing it, once.
      var old = loadJSON(OLD_STATE_KEY);
      if (old && typeof old.text === 'string' && old.text.trim() && !(state && state.key)) {
        this.legacyText = old.text;
        this._restoredName = old.name || '';
      }
      this._oldChecked = true;
      this._saveState();
    }
    this._oldChecked = true;
    this._render();
    // The transcript that was on screen comes back from this device's storage.
    this.ready = Promise.resolve().then(function () {
      if (!state || !state.key) return null;
      return global.CloudStore.getJob(state.key).then(function (job) {
        if (!job) { if (!self.file && self.key === state.key) self.key = null; return; }
        if (self.file || self.key !== state.key) return;
        self.key = job.key;
        self.job = job;
        self._restoredName = job.name;
        self._render();
      });
    }).catch(function () {});
  };

  /** Is this saved record this person's? (Records from before sign-in existed belong to whoever signs in.) */
  FileTab.prototype._mine = function (job) {
    return Boolean(job) && Boolean(this.user) && (!job.userId || job.userId === this.user.id);
  };

  /** Called by app.js when someone signs in: carry on with anything unfinished. */
  FileTab.prototype.signedIn = function (user) {
    var self = this;
    this.user = user;
    this.ready = this.ready.then(function () {
      if (self.user !== user) return;
      // A different person than last time on this device: their screen starts empty.
      if ((self._stateUserId && self._stateUserId !== user.id) || (self.job && !self._mine(self.job))) self._clearScreen();
      self._stateUserId = user.id;
      self._saveState();
      return global.CloudStore.latestUnfinished(user.id).then(function (job) {
        if (!job || self.file || self.running || self.user !== user) return;
        if ((job.stage === 'processing' && job.jobId) || (job.stage === 'uploaded' && job.objectPath && !job.failed)) {
          // The sound is already uploaded or with Speechmatics: carry on and collect the
          // transcript, no file needed. (A transcript that was on screen stays saved: choosing
          // its file again shows it.)
          self.key = job.key;
          self.job = job;
          self._restoredName = job.name;
          self._showResume('Carrying on with “' + job.name + '”. Its transcript will appear below when it is ready.', false);
          self.start();
          return;
        }
        self.message(MESSAGES.interrupted(job.name), 'warn');
      }).catch(function () {});
    }).then(function () {
      if (self.user === user) return self._retryCloudSaves();
    }).catch(function () {});
    return this.ready;
  };

  /** Called by app.js on Sign Out: stop, and leave nothing of this person's on screen. */
  FileTab.prototype.signedOut = function () {
    this.user = null;
    this._run++;                       // anything running stops at its next step
    this.cancelled = true;
    if (this.upload) { this.upload.stop(); this.upload = null; }
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    if (this.running) this._setRunning(false);
    this._clearScreen();
    this._stateUserId = null;
    this._saveState();
    this.message(MESSAGES.start);
  };

  FileTab.prototype._clearScreen = function () {
    this.file = null;
    this.reader = null;
    this.job = null;
    this.key = null;
    this.legacyText = '';
    this._restoredName = '';
    this._waitingFile = null;
    this._hasCompactAudio = false;
    this._setPlayer(null);
    this.els.fileInfo.hidden = true;
    this.els.replaceBox.hidden = true;
    this._showResume('');
    this._progress(null);
    this._render();
    this._updateStartButton();
  };

  // ---------- My Transcripts (the cloud copy) ----------

  /** Is this the path of a recording in this person's own cloud folder? */
  FileTab.prototype._ownPath = function (path) {
    return Boolean(path) && Boolean(this.user) && path.indexOf(this.user.id + '/') === 0;
  };

  FileTab.prototype._newPath = function () {
    return this.user.id + '/' + uuid() + '.ogg';
  };

  /**
   * Save a finished transcript, with its recording, in My Transcripts. Never fails:
   * if it can't be saved now (no internet), the record is marked and tried again later.
   */
  FileTab.prototype._saveToCloud = function (job) {
    var self = this;
    if (!this.user || !job.turns) return Promise.resolve(false);
    return global.CloudDb.save({
      title: job.title || job.name,
      fileName: job.name,
      duration: job.duration || job.resultDuration || 0,
      turns: job.turns,
      speakers: job.speakers || [],
      names: job.names || {},
      audioPath: job.audioPath || null,
      audioBytes: job.compactBytes || 0,
      jobId: job.jobId || null,
      fileKey: job.key,
      createdAt: job.doneAt || null
    }).then(function (id) {
      job.cloudId = id;
      job.cloudPending = false;
      job.cloudDirty = false;
      job.userId = job.userId || (self.user && self.user.id);
      // An upload from before sign-in existed is not in this person's folder, so it is not kept.
      if (job.jobId && job.objectPath && !job.audioPath) global.CloudApi.deleteAudio(job.jobId).catch(function () {});
      return self._putJob(job).then(function () { self.onSaved(id); return true; });
    }, function (err) {
      job.cloudPending = true;
      if (global.console) global.console.warn('Transcriber: not saved to My Transcripts yet', err && err.code, err);
      return self._putJob(job).then(function () { return false; });
    });
  };

  /** Save a record on this device without changing what is on screen. */
  FileTab.prototype._putJob = function (job) {
    if (this.job && this.job.key === job.key && this.job !== job) return Promise.resolve();
    return global.CloudStore.putJob(job).catch(function () {});
  };

  /** Transcripts and corrections that could not reach My Transcripts last time: try again. */
  FileTab.prototype._retryCloudSaves = function () {
    var self = this;
    var store = global.CloudStore;
    if (!store.allJobs || !this.user) return Promise.resolve();
    var userId = this.user.id;
    return store.allJobs().then(function (jobs) {
      var waiting = jobs.filter(function (j) {
        return j.done && j.turns && j.userId === userId && (j.cloudPending || (j.cloudDirty && j.cloudId));
      });
      return waiting.reduce(function (before, saved) {
        return before.then(function () {
          if (!self.user || self.user.id !== userId) return;
          // The one on screen: use it as it is now (with any newer corrections).
          var job = self.job && self.job.key === saved.key ? self.job : saved;
          if (job.cloudPending || !job.cloudId) return self._saveToCloud(job);
          return self._syncNow(job);
        });
      }, Promise.resolve());
    }).catch(function () {});
  };

  /** After a rename or a corrected word: save to My Transcripts a moment later. */
  FileTab.prototype._syncSoon = function () {
    var self = this;
    var job = this.job;
    if (!job || !job.cloudId) return;
    job.cloudDirty = true;
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(function () { self._syncNow(job); }, TIMING.sync);
  };

  FileTab.prototype._syncNow = function (job) {
    var self = this;
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    job = job || this.job;
    if (!job || !job.cloudId || !this.user) return Promise.resolve();
    return global.CloudDb.update(job.cloudId, { turns: job.turns, speakers: job.speakers || [], names: job.names || {} }).then(function () {
      job.cloudDirty = false;
      self.onSaved(job.cloudId);
      return self._putJob(job);
    }, function (err) {
      if (err && err.code === 'gone') {
        // Deleted from My Transcripts (on another device): it stays on this screen only.
        job.cloudId = null;
        job.cloudDirty = false;
        return self._putJob(job);
      }
      // Still marked as changed: tried again the next time the app opens.
    });
  };

  /** My Transcripts changed this item (renamed speakers, corrected words): show the same here. */
  FileTab.prototype.cloudChanged = function (id, fields) {
    var job = this.job;
    if (!job || job.cloudId !== id) return;
    if (fields.turns) job.turns = fields.turns;
    if (fields.names) job.names = fields.names;
    this._docOf = null;
    this._saveJob(job);
    this._render();
  };

  /** Items deleted from My Transcripts are forgotten on this device too. ids: a list, or null for all. */
  FileTab.prototype.forget = function (ids) {
    var self = this;
    var gone = function (job) { return job && job.cloudId && self._mine(job) && (!ids || ids.indexOf(job.cloudId) !== -1); };
    if (gone(this.job) && this.job.done) {
      this.job = null;
      this.key = null;
      if (!this.running) { this.file = null; this.reader = null; this._setPlayer(null); this.els.fileInfo.hidden = true; }
      this._showResume('');
      this.message(MESSAGES.start);
      this._render();
      this._saveState();
      this._updateStartButton();
    }
    return global.CloudStore.allJobs().then(function (jobs) {
      return Promise.all(jobs.filter(gone).map(function (j) { return global.CloudStore.deleteJob(j.key); }));
    }).catch(function () {});
  };

  // ---------- Messages and progress ----------

  FileTab.prototype.message = function (text, kind) {
    this.els.status.textContent = text;
    this.els.status.dataset.kind = kind || 'info';
  };

  /** percent: a number, 'busy' (moving bar, no number) or null (hidden). */
  FileTab.prototype._progress = function (percent, label) {
    var els = this.els;
    els.progressBox.hidden = percent === null;
    if (percent === null) return;
    if (percent === 'busy') {
      els.progress.removeAttribute('value');
      els.percent.textContent = label || '';
      return;
    }
    var p = Math.max(0, Math.min(100, percent));
    els.progress.value = p;
    els.percent.textContent = label !== undefined ? label : Math.floor(p) + '%';
  };

  FileTab.prototype._setRunning = function (running) {
    var els = this.els;
    this.running = running;
    document.body.dataset.fileState = running ? 'running' : 'idle';
    els.choose.disabled = running;
    els.start.hidden = running;
    els.cancel.hidden = !running || !this._cancellable;
    els.cancel.disabled = false;
    if (running) { if (this.awake) this.awake.start(); }
    else if (this.awake) this.awake.stop();
    this.onBusy(running);
    this._updateStartButton();
  };

  /** Cancel shows while preparing and uploading; once Speechmatics has it there is nothing to cancel. */
  FileTab.prototype._setCancellable = function (yes) {
    this._cancellable = yes;
    this.els.cancel.hidden = !this.running || !yes;
  };

  FileTab.prototype._updateStartButton = function () {
    var els = this.els;
    var job = this.job;
    var hasSource = Boolean(this.reader) || Boolean(job && ['uploaded', 'processing'].indexOf(job.stage) !== -1) ||
      Boolean(job && job.stage === 'uploading' && this._hasCompactAudio);
    els.start.disabled = !hasSource || this.running || this._choosing || Boolean(job && job.done);
    var label = 'Start Transcribing';
    if (job && !job.done && job.failed) label = 'Try Again';
    else if (job && !job.done && job.stage && job.stage !== 'new') label = 'Continue Transcribing';
    els.startLabel.textContent = label;
  };

  /** The blue box under the status. canStartOver: show the Start Over button. */
  FileTab.prototype._showResume = function (text, canStartOver) {
    this.els.resumeText.textContent = text || '';
    this.els.resumeBox.hidden = !text;
    this.els.startOver.hidden = !canStartOver;
  };

  // ---------- The transcript on screen ----------

  FileTab.prototype.fileName = function () {
    if (this.file) return this.file.name;
    if (this.job && this.job.name) return this.job.name;
    return this._restoredName || '';
  };

  FileTab.prototype._turns = function () {
    return this.job && this.job.done && this.job.turns ? this.job.turns : null;
  };

  /** What the transcript view shows for this tab (see transcript-view.js), or null. */
  FileTab.prototype._doc = function () {
    var self = this;
    var job = this.job;
    if (this._turns()) {
      if (!this._docOf || this._docOf.job !== job || this._docOf.doc.turns !== job.turns) {
        job.names = job.names || {};
        this._docOf = {
          job: job,
          doc: {
            turns: job.turns,
            speakers: job.speakers || [],
            names: job.names,
            changed: function (kind) {
              job.names = this.names;
              if (kind === 'names') self._saveJob(job); else self._saveJobSoon();
              self._syncSoon();
            },
            play: function (seconds) { return self.playFrom(seconds); }
          }
        };
      }
      return this._docOf.doc;
    }
    this._docOf = null;
    if (this.legacyText) {
      return {
        legacyText: this.legacyText,
        changed: function () { self.legacyText = this.legacyText; self._saveState(); }
      };
    }
    return null;
  };

  FileTab.prototype._hasText = function () {
    return Boolean(this.text().trim());
  };

  /** The transcript as text, in the view that is showing (times and fillers on or off). */
  FileTab.prototype.text = function () {
    return this.view.textOf(this._doc());
  };

  FileTab.prototype.wordCount = function () {
    return this.view.wordCountOf(this._doc());
  };

  /** app.js says which tab is on screen; the transcript view is shared with My Transcripts. */
  FileTab.prototype.setActive = function (active) {
    this.active = active;
    if (active) this._render();
  };

  FileTab.prototype._render = function () {
    if (this.active) this.view.setDoc(this._doc());
    this.onText();
  };

  FileTab.prototype.askRename = function (speaker) {
    if (this.active && this._turns()) this.view.askRename(speaker);
  };

  /** Rename one speaker: every turn by them changes. An empty name goes back to "Speaker N". */
  FileTab.prototype.rename = function (speaker, name) {
    if (!this._turns()) return;
    if (this.active) { this.view.setDoc(this._doc()); this.view.rename(speaker, name); return; }
    var doc = this._doc();
    var clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (clean) doc.names[speaker] = clean; else delete doc.names[speaker];
    doc.changed('names');
  };

  // ---------- Playing from a time ----------

  FileTab.prototype.playFrom = function (seconds) {
    var self = this;
    var player = this.els.player;
    var job = this.job;
    if (this.file && player.getAttribute('src')) {
      global.TranscriptView.playFrom(player, seconds);
      return true;
    }
    if (job && job.audioPath && this.user) {
      // No file chosen (the app was reopened): play the recording kept in My Transcripts.
      if (this._cloudAudio === job.audioPath && player.getAttribute('src')) {
        global.TranscriptView.playFrom(player, seconds);
        return true;
      }
      this.message(MESSAGES.gettingAudio);
      global.CloudDb.audioUrl(job.audioPath).then(function (url) {
        if (self.job !== job || self.file) return;
        self._cloudAudio = job.audioPath;
        player.setAttribute('src', url);
        self.els.fileInfo.hidden = false;
        self.els.fileName.textContent = job.name || 'Recording';
        self.els.fileDetails.textContent = (job.duration ? spoken(job.duration) + ' · ' : '') + 'Saved recording';
        self.message('Playing the saved recording.');
        global.TranscriptView.playFrom(player, seconds);
      }, function () {
        if (self.job === job) self.message(MESSAGES.playNeedsFile(self.fileName() || 'the recording'), 'warn');
      });
      return true;
    }
    this.message(MESSAGES.playNeedsFile(this.fileName() || 'the recording'), 'warn');
    return false;
  };

  FileTab.prototype._setPlayer = function (file) {
    var player = this.els.player;
    if (this.playerUrl) URL.revokeObjectURL(this.playerUrl);
    this._cloudAudio = null;
    this.playerUrl = file ? URL.createObjectURL(file) : null;
    if (this.playerUrl) player.setAttribute('src', this.playerUrl);
    else { player.removeAttribute('src'); player.hidden = true; }
    player.hidden = !file;
  };

  /**
   * Called by app.js when the person clears the File transcript from the screen. The saved
   * job stays (nothing is paid twice) and so does the copy in My Transcripts.
   */
  FileTab.prototype.cleared = function () {
    this.legacyText = '';
    if (this.job && this.job.done) { this.job = null; this.key = null; }
    this.view.closeRename();
    this._render();
    this._saveState();
  };

  // ---------- Choosing a file ----------

  FileTab.prototype.choose = function (file, confirmed) {
    var self = this;
    if (this.running || !this.user) return Promise.resolve();
    var user = this.user;
    this._showResume('');
    this.els.replaceBox.hidden = true;

    if (!global.AudioReader.looksSupported(file)) {
      this._fail(TabError('unsupported'));
      return Promise.resolve();
    }

    this.message(MESSAGES.reading);
    this._progress(null);
    this.els.choose.disabled = true;
    this._choosing = true;
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
      return global.CloudStore.fileKey(file);
    }).then(function (k) {
      key = k;
      // A different file would replace a transcript that's still on screen: ask first.
      if (self._hasText() && self.key !== key && !confirmed) {
        asked = true;
        self._waitingFile = file;
        self.els.replaceText.textContent = 'The transcript below is from “' + (self.fileName() || 'another file') +
          '”. Choosing “' + file.name + '” will replace it on the screen. Copy or download it first if you need it.';
        self.els.replaceBox.hidden = false;
        self.message('Choose what to do with the current transcript.');
        return null;
      }
      return global.CloudStore.getJob(key).catch(function () { return null; }).then(function (job) {
        if (job && !self._mine(job)) job = null;       // someone else's record on this device
        if (job && job.stage && job.stage !== 'new' && !job.pruned) return job;
        // Not known on this device: was it already transcribed on another one? Then it is in
        // My Transcripts and is shown from there instead of being paid for again.
        var lookup = global.CloudDb.findByFileKey(key).catch(function () { return null; });
        var giveUp = wait(TIMING.lookup).then(function () { return null; });
        return Promise.race([lookup, giveUp]).then(function (row) {
          if (!row || !Array.isArray(row.turns)) return job;
          var found = {
            key: key, name: file.name, size: file.size, duration: Number(row.duration_seconds) || reader.duration,
            stage: 'done', done: true, turns: row.turns, speakers: row.speakers || [], names: row.speaker_names || {},
            cloudId: row.id, audioPath: row.audio_path || null, compactBytes: Number(row.audio_bytes) || 0,
            jobId: row.speechmatics_id || null, userId: user.id, createdAt: Date.now(), doneAt: Date.parse(row.created_at) || Date.now()
          };
          return global.CloudStore.putJob(found).catch(function () {}).then(function () { return found; });
        });
      });
    }).then(function (job) {
      finished();
      if (asked || self.running || self.user !== user) return;
      self.file = file;
      self.reader = reader;
      self.key = key;
      self.legacyText = '';
      self.job = job || { key: key, name: file.name, size: file.size, duration: reader.duration, stage: 'new', createdAt: Date.now() };
      self.job.name = file.name;
      self.job.userId = user.id;
      self._setPlayer(file);
      self._showFileInfo();
      self._render();
      self._saveState();
      if (job && job.pruned && job.jobId) {
        // An old transcript removed from this device to save space: collect it again (free).
        job.done = false;
        job.pruned = false;
        job.stage = 'processing';
        self._showResume('This file was transcribed before. Collecting its transcript again from Speechmatics (no extra cost).', false);
        return self.start();
      }
      if (job && job.done) {
        self._showResume('This file was already transcribed. Its saved transcript is below, so it was not sent again.' +
          (job.cloudId ? ' It is also in My Transcripts.' : ''), false);
        self.message('Already transcribed.', 'done');
        self._progress(null);
        self._updateStartButton();
        return;
      }
      if (job && job.failed) {
        self._updateStartButton();
        self.message('Speechmatics could not transcribe this recording last time. Tap Try Again to send it again.', 'warn');
        return;
      }
      if (job && job.stage && job.stage !== 'new') {
        self._showResume('Continuing where you left off with this file. Nothing done before is repeated or paid for again.',
          job.stage === 'uploading');
        return self.start();
      }
      self._updateStartButton();
      self._readyMessage();
    }).catch(function (err) {
      finished();
      self._fail(err && err.code ? err : TabError('unreadable'), err);
    });
  };

  FileTab.prototype._showFileInfo = function () {
    var r = this.reader;
    this.els.fileInfo.hidden = false;
    this.els.fileName.textContent = this.file.name;
    this.els.fileDetails.textContent = (r.duration ? spoken(r.duration) : 'Length unknown') + ' · ' + r.label;
  };

  FileTab.prototype._readyMessage = function () {
    var d = this.reader ? this.reader.duration : 0;
    if (d > LONG_FILE_SECONDS) {
      this.message('Ready. This recording is ' + spoken(d) + ' long. Preparing and uploading it can take several minutes; ' +
        'keep this page open until Speechmatics has it. If it stops, choose the same file again to carry on.', 'warn');
    } else {
      this.message(MESSAGES.ready);
    }
  };

  // ---------- Transcribing ----------

  FileTab.prototype.start = function () {
    var self = this;
    if (this.running || this._choosing || !this.job || this.job.done || !this.user) return Promise.resolve();
    var job = this.job;
    job.userId = job.userId || this.user.id;
    // An upload begun before sign-in existed went to a folder that is now closed: begin it again.
    if (job.stage === 'uploading' && !this._ownPath(job.objectPath)) {
      job.objectPath = this._newPath();
      job.uploadUrl = null;
      job.uploadOffset = 0;
    }
    var run = ++this._run;
    // Ask Chrome not to clear this app's saved progress when space runs low.
    if (global.navigator.storage && global.navigator.storage.persist) global.navigator.storage.persist().catch(function () {});
    this.cancelled = false;
    job.failed = false;
    this._setCancellable(job.stage === 'new' || job.stage === 'uploading');
    this._setRunning(true);
    var stillMine = function () { return self._run === run && !self.cancelled; };

    var work = this._steps(job, stillMine).then(function () {
      if (self._run !== run) return;
      self._setRunning(false);
      self._finished(job);
    }).catch(function (err) {
      if (self._run !== run) return;
      if (self.upload) { self.upload.stop(); self.upload = null; }
      self._setRunning(false);
      if (self.cancelled || (err && err.code === 'stopped')) { self._stoppedMessage(); return; }
      self._fail(err, err);
    });
    this._work = work;
    return work;
  };

  FileTab.prototype._steps = function (job, stillMine) {
    var self = this;
    function check() { if (!stillMine()) throw TabError('stopped'); }

    var step = Promise.resolve();
    if (job.stage === 'new' || job.stage === 'uploading') {
      step = step.then(function () {
        if (global.navigator.onLine === false) throw TabError('offline');
        self.message('Checking with the transcription service…');
        self._progress('busy');
        // Don't prepare or upload anything if today's time is already used up.
        return global.CloudApi.checkLimit();
      }).then(check);
    }
    return step.then(function () {
      if (job.stage === 'new') return self._prepare(job, stillMine);
    }).then(function (blob) {
      check();
      if (job.stage === 'uploading') return self._upload(job, blob, stillMine);
    }).then(function () {
      check();
      if (job.stage === 'uploaded') return self._startJob(job, stillMine);
    }).then(function () {
      check();
      if (job.stage === 'processing') return self._waitForSpeechmatics(job, stillMine);
    });
  };

  /** Step 1: make the small Ogg Opus file and keep it on this device. */
  FileTab.prototype._prepare = function (job, stillMine) {
    var self = this;
    if (!this.reader) throw TabError('needFile');
    this.message('Preparing the audio… 0%. Keep this page open.');
    this._progress(0);
    return global.CompactAudio.convert(this.reader, {
      isStopped: function () { return !stillMine(); },
      onProgress: function (fraction) {
        if (!stillMine()) return;
        var p = Math.floor(fraction * 100);
        self.message('Preparing the audio… ' + p + '%. Keep this page open.');
        self._progress(p);
      }
    }).then(function (out) {
      if (!stillMine()) throw TabError('stopped');
      return global.CloudStore.putAudio(job.key, out.blob).then(function () {
        self._hasCompactAudio = true;
      }, function (err) {
        // Not saved: it can still be uploaded now, but would need preparing again after a restart.
        if (isQuotaError(err)) self.message(MESSAGES.space, 'warn');
      }).then(function () {
        job.stage = 'uploading';
        job.objectPath = self._newPath();
        job.uploadUrl = null;
        job.uploadOffset = 0;
        job.compactBytes = out.bytes;
        job.duration = out.duration || job.duration;
        return self._saveJob(job);
      }).then(function () { return out.blob; });
    });
  };

  /** Step 2: upload in 6 MB pieces, saving the place after each piece. */
  FileTab.prototype._upload = function (job, blob, stillMine) {
    var self = this;
    var config = global.CLOUD_CONFIG;
    var get = blob ? Promise.resolve(blob) : global.CloudStore.getAudio(job.key).catch(function () { return null; });
    return get.then(function (audio) {
      if (!stillMine()) throw TabError('stopped');
      if (!audio) {
        // The prepared sound was not kept (no space, or cleared): prepare it again from the file.
        if (!self.reader) throw TabError('needFile');
        job.stage = 'new';
        return self._prepare(job, stillMine).then(function (b) { return self._upload(job, b, stillMine); });
      }
      var total = audio.size;
      var mb = function (n) { return (n / MB).toFixed(n < 10 * MB ? 1 : 0); };
      var show = function (sent) {
        if (!stillMine() || self._waitingNet) return;
        var p = total ? Math.floor(sent / total * 100) : 0;
        self.message('Uploading… ' + p + '% (' + mb(sent) + ' of ' + mb(total) + ' MB). Keep this page open.');
        self._progress(p);
      };
      show(job.uploadOffset || 0);
      var up = new global.ResumableUpload(audio, {
        endpoint: config.uploadEndpoint,
        // Asked before every piece, so a long upload always carries a current sign-in.
        headers: function () {
          return global.Auth.token().then(function (token) {
            if (!token) { var e = new Error('Not signed in'); e.code = 'signIn'; throw e; }
            return { authorization: 'Bearer ' + token, apikey: config.publishableKey };
          });
        },
        bucket: config.bucket,
        objectName: job.objectPath,
        contentType: 'audio/ogg',
        url: job.uploadUrl,
        onSaved: function (place) {
          job.uploadUrl = place.url;
          job.uploadOffset = place.offset;
          self._saveJob(job);
        },
        onProgress: show,
        onWaiting: function (reason) {
          if (!stillMine()) return;
          self._waitingNet = reason === 'offline';
          if (reason === 'offline') self.message(MESSAGES.offlineWaiting, 'warn');
          else show(job.uploadOffset || 0);
        }
      });
      self.upload = up;
      return up.start().then(function () {
        self.upload = null;
        self._waitingNet = false;
        job.stage = 'uploaded';
        return self._saveJob(job);
      }, function (err) {
        self.upload = null;
        self._waitingNet = false;
        if (err.code === 'stopped') throw err;
        if (err.code === 'signIn') throw TabError('signIn');
        if (err.code === 'tooLarge') throw TabError('tooLong');
        if (err.code === 'denied') throw TabError('uploadDenied');
        throw TabError('uploadFailed', { detail: err.message });
      });
    });
  };

  /** Step 3: ask the Edge Function to start the Speechmatics job, and save the job number. */
  FileTab.prototype._startJob = function (job, stillMine) {
    var self = this;
    this._setCancellable(false);
    this.els.cancel.hidden = true;
    this.els.startOver.hidden = true;   // uploaded: starting over now could pay twice
    this.message('Sending to Speechmatics…');
    this._progress('busy');
    var tries = 0;
    function attempt() {
      return global.CloudApi.startJob(job.objectPath, job.duration).catch(function (err) {
        if (err.code === 'busy' && tries++ < 20 && stillMine()) return wait(TIMING.busy).then(attempt);
        if (err.code === 'notUploaded') {
          // The upload was cleared from the server (after a day): upload it again.
          job.stage = 'uploading';
          job.uploadUrl = null;
          job.uploadOffset = 0;
          job.objectPath = self._newPath();
          return self._saveJob(job).then(function () {
            self._setCancellable(true);
            return self._upload(job, null, stillMine);
          }).then(function () { self._setCancellable(false); return attempt(); });
        }
        throw err;
      });
    }
    return attempt().then(function (res) {
      if (!res || !res.jobId) return;   // the upload was redone above and started then
      job.jobId = res.jobId;
      job.stage = 'processing';
      job.sentAt = job.sentAt || Date.now();
      return self._saveJob(job).then(function () {
        // Speechmatics has the sound now; the copy on this device is no longer needed.
        self._hasCompactAudio = false;
        return global.CloudStore.deleteAudio(job.key).catch(function () {});
      });
    });
  };

  /** Step 4: check on the job until it is done, then fetch and save the transcript. */
  FileTab.prototype._waitForSpeechmatics = function (job, stillMine) {
    var self = this;
    this._setCancellable(false);
    this.els.cancel.hidden = true;
    var started = Date.now();
    var checks = 0;
    // Nothing happens on this device now, so the screen may sleep.
    if (this.awake) this.awake.stop();
    function show() {
      var since = Math.max(0, Math.round((Date.now() - (job.sentAt || started)) / 1000));
      self.message('Speechmatics is transcribing… (' + (since < 60 ? 'just started' : spoken(since) + ' so far') + '). ' +
        'This usually takes a few minutes; long recordings can take up to about half their length. ' +
        'You can close the app: the transcript will be collected when you come back.');
      self._progress('busy');
    }
    function poll() {
      if (!stillMine()) throw TabError('stopped');
      checks++;
      return global.CloudApi.jobStatus(job.jobId).then(function (s) {
        if (s.status === 'done') return true;
        if (s.status === 'failed') {
          if (s.speechmaticsStatus === 'expired' || s.speechmaticsStatus === 'deleted') throw TabError('expired');
          throw TabError('rejected', { why: (s.errors && s.errors[0]) || '' });
        }
        show();
        return false;
      }, function (err) {
        if (err.code === 'offline' || err.code === 'network' || err.code === 'server' || err.code === 'speechmatics') {
          self.message(err.code === 'offline' ? MESSAGES.offlineChecking : 'Lost touch with Speechmatics for a moment. Trying again…', 'warn');
          return false;
        }
        throw err;
      }).then(function (done) {
        if (done) return;
        return wait(checks < 8 ? TIMING.pollFirst : checks < 40 ? TIMING.poll : TIMING.pollSlow).then(poll);
      });
    }
    show();
    return poll().then(function () {
      self.message('Saving the transcript…');
      return self._fetchResult(job, stillMine);
    });
  };

  FileTab.prototype._fetchResult = function (job, stillMine) {
    var self = this;
    var tries = 0;
    function attempt() {
      return global.CloudApi.jobResult(job.jobId).catch(function (err) {
        if (['offline', 'network', 'server', 'notReady', 'speechmatics'].indexOf(err.code) !== -1 && tries++ < 1000 && stillMine()) {
          if (err.code === 'offline') self.message(MESSAGES.offlineChecking, 'warn');
          return wait(err.code === 'notReady' ? TIMING.busy : TIMING.retry).then(attempt);
        }
        throw err;
      });
    }
    return attempt().then(function (result) {
      if (!stillMine()) throw TabError('stopped');
      var built = TF.buildTurns(result);
      job.turns = built.turns;
      job.speakers = built.speakers;
      job.names = job.names || {};
      job.resultDuration = built.duration;
      job.stage = 'done';
      job.done = true;
      job.doneAt = Date.now();
      // The uploaded sound is kept with the transcript in My Transcripts until the item is deleted.
      job.audioPath = self._ownPath(job.objectPath) ? job.objectPath : null;
      job.cloudPending = true;
      return global.CloudStore.putJob(job).then(null, function (err) {
        // Not saved on this device (no space): show it anyway; My Transcripts still gets it.
        self.message(isQuotaError(err) ? MESSAGES.space : MESSAGES.storage, 'warn');
      }).then(function () {
        self.message('Saving to My Transcripts…');
        return self._saveToCloud(job);
      }).then(function () {
        global.CloudStore.prune().catch(function () {});
      });
    });
  };

  FileTab.prototype._finished = function (job) {
    if (this.job !== job) return;
    this._progress(100);
    this._showResume('');
    this._render();
    this._saveState();
    var length = job.duration || job.resultDuration;
    var text = 'Done. Transcribed ' + (length ? spoken(length) + ' of audio' : 'the recording') + '.';
    if (!job.turns.length) text += ' No speech was found in this file.';
    text += job.cloudId ? MESSAGES.savedInFolder : MESSAGES.notSavedYet;
    this.message(text, job.cloudId ? 'done' : 'warn');
    this._updateStartButton();
  };

  FileTab.prototype._stoppedMessage = function () {
    var job = this.job;
    this._updateStartButton();
    this._progress(null);
    if (job && job.stage === 'uploading' && job.uploadOffset) {
      this.message('Stopped. The upload so far is saved. Tap Continue Transcribing to carry on, now or later.');
    } else if (job && job.stage !== 'new') {
      this.message('Stopped. Tap Continue Transcribing to carry on, now or later.');
    } else {
      this.message('Stopped. Tap Start Transcribing to begin again.');
    }
  };

  FileTab.prototype.cancel = function () {
    if (!this.running || !this._cancellable) return;
    this.cancelled = true;
    this.els.cancel.disabled = true;
    this.message('Stopping…');
    if (this.upload) this.upload.stop();
  };

  /** Throw away the saved progress for this file (before Speechmatics has it) and start again. */
  FileTab.prototype.startOver = function () {
    var self = this;
    // Only before Speechmatics has the recording: after that, starting over would pay twice.
    var canStartOver = function () { return self.job && (self.job.stage === 'new' || self.job.stage === 'uploading'); };
    if (this._choosing || !canStartOver()) return Promise.resolve();
    var wait1 = Promise.resolve();
    if (this.running) {
      this.cancel();
      wait1 = this._work || Promise.resolve();
    }
    this.els.startOver.disabled = true;
    return wait1.then(function () {
      if (!canStartOver()) {
        self.els.startOver.disabled = false;
        self.els.startOver.hidden = true;
        return 'too late';
      }
      return global.CloudStore.deleteJob(self.key).catch(function () {});
    }).then(function (tooLate) {
      if (tooLate) return;
      self.els.startOver.disabled = false;
      self._showResume('');
      self._hasCompactAudio = false;
      self.job = { key: self.key, name: self.fileName(), size: self.file ? self.file.size : 0,
        duration: self.reader ? self.reader.duration : 0, stage: 'new', createdAt: Date.now() };
      if (self.reader) return self.start();
      self.message(MESSAGES.start);
    });
  };

  FileTab.prototype._fail = function (err, original) {
    var code = err && err.code;
    var job = this.job;
    var text;
    var kind = 'error';
    switch (code) {
      case 'offline': text = MESSAGES.offline; break;
      case 'network': text = MESSAGES.network; break;
      case 'uploadFailed': text = MESSAGES.uploadFailed; break;
      case 'uploadDenied': text = MESSAGES.uploadDenied; break;
      case 'dailyLimit': text = MESSAGES.dailyLimit(err.limitMinutes); break;
      case 'speechmatics': text = MESSAGES.speechmatics; if (job) job.failed = true; break;
      case 'expired':
        text = MESSAGES.expired;
        if (job) { job.failed = true; job.stage = 'uploaded'; job.jobId = null; this._saveJob(job); }
        break;
      case 'rejected':
        text = MESSAGES.rejected(err.why);
        if (job) { job.failed = true; job.stage = 'uploaded'; job.jobId = null; this._saveJob(job); }
        break;
      case 'notSetUp': text = MESSAGES.notSetUp; break;
      case 'signIn': text = MESSAGES.signIn; kind = 'warn'; break;
      case 'notAllowed': text = MESSAGES.notAllowed; break;
      case 'busy': text = MESSAGES.busy; kind = 'warn'; break;
      case 'server': case 'badRequest': case 'unknownJob': text = MESSAGES.server; break;
      case 'needFile': text = MESSAGES.needFile(this.fileName()); kind = 'warn'; break;
      case 'unsupported':
        // From the converter: this browser has no Opus encoder. Otherwise: the file type.
        text = err.message === 'No Opus encoder in this browser' ? MESSAGES.oldBrowser : MESSAGES.unsupported;
        break;
      case 'encoder': text = MESSAGES.oldBrowser; break;
      case 'tooLong': text = MESSAGES.tooLong; break;
      case 'memory': text = MESSAGES.memory; break;
      default:
        text = MESSAGES[code] && typeof MESSAGES[code] === 'string' ? MESSAGES[code] : MESSAGES.unreadable;
    }
    if (isQuotaError(original)) text = MESSAGES.space;
    this.message(text, kind);
    this._progress(null);
    this._updateStartButton();
    if (original && global.console) global.console.warn('Transcriber:', code, original);
  };

  global.FileTab = FileTab;
})(window);
