/*
 * live.js — Live microphone transcription using Chrome's Web Speech API.
 *
 * Exposes window.LiveTranscriber. It knows nothing about the page layout;
 * app.js passes in callbacks and decides what to show.
 *
 * Callbacks (all optional):
 *   onFinal(text)            confirmed words to add to the transcript
 *   onInterim(text)          unconfirmed words ('' clears them)
 *   onState(state)           'idle' | 'starting' | 'listening' | 'paused' | 'stopping'
 *   onMessage(text, kind)    a plain-words status line; kind is 'info' | 'warn' | 'error'
 */
(function (global) {
  'use strict';

  var SpeechRecognition = global.SpeechRecognition || global.webkitSpeechRecognition;

  // How long to wait before restarting after Chrome stops listening on its own.
  var RESTART_DELAY_MS = 250;
  // If Chrome stops this many times inside the window below without hearing
  // anything, stop trying so we don't loop forever.
  var MAX_QUICK_RESTARTS = 8;
  var QUICK_RESTART_WINDOW_MS = 15000;
  // Network hiccups: retry a few times before giving up.
  var MAX_NETWORK_RETRIES = 3;

  var MESSAGES = {
    unsupported:
      'This browser cannot do live transcription. Please open this page in Google Chrome.',
    insecure:
      'The microphone only works on a secure (https) page. Please open the https:// link.',
    offline:
      'No internet connection. Live transcription needs internet because Chrome sends the audio to Google’s speech service. Connect and tap Start Listening again.',
    askPermission:
      'Chrome will ask to use your microphone. Tap Allow so Transcriber can hear you.',
    permissionDenied:
      'Microphone permission is blocked. To fix it: tap the icon to the left of the web address, tap Permissions, turn on Microphone, then reload this page.',
    serviceNotAllowed:
      'Chrome’s speech service is not available right now. Check that Google speech services are turned on for this phone, then try again.',
    noMic:
      'No microphone was found, or another app is using it. Close other apps that use the microphone and try again.',
    noSpeech: 'No speech heard yet. Still listening…',
    network:
      'Lost connection to the speech service. Check your internet and tap Start Listening again.',
    networkRetry: 'Connection hiccup. Trying again…',
    language:
      'This language is not available on this phone’s speech service. Try another language.',
    tooManyRestarts:
      'Chrome keeps stopping the microphone. Tap Start Listening to try again.',
    listening: 'Listening. Speak now.',
    paused: 'Paused while Transcriber is in the background. Come back to keep listening.',
    stopped: 'Stopped. Tap Start Listening to continue.',
    generic: 'Something went wrong with the microphone. Tap Start Listening to try again.'
  };

  function noop() {}

  function normalize(text) {
    return String(text || '').trim().replace(/\s+/g, ' ');
  }

  /**
   * Some Android builds of Chrome send a final result that repeats the
   * previous final result plus new words ("hello" then "hello how are you").
   * Return only the part that is new. Exported for tests.
   */
  function newPart(previous, next) {
    var prev = normalize(previous);
    var curr = normalize(next);
    if (!curr) return '';
    if (!prev) return curr;
    var p = prev.toLowerCase();
    var c = curr.toLowerCase();
    if (c === p) return '';
    if (c.indexOf(p + ' ') === 0) return curr.slice(prev.length).trim();
    return curr;
  }

  function LiveTranscriber(callbacks) {
    callbacks = callbacks || {};
    this.onFinal = callbacks.onFinal || noop;
    this.onInterim = callbacks.onInterim || noop;
    this.onState = callbacks.onState || noop;
    this.onMessage = callbacks.onMessage || noop;

    this.state = 'idle';
    this.lang = 'en-US';
    this._wanted = false;       // true from Start until Stop (or a fatal error)
    this._rec = null;
    this._restartTimer = null;
    this._stopFallback = null;
    this._interim = '';
    this._lastFinal = '';
    this._restartTimes = [];
    this._networkRetries = 0;
    this._fatal = false;
    // Keeps the screen on while listening (keep-awake.js); asks again if Android lets go.
    this._awake = global.KeepAwake ? new global.KeepAwake() : null;

    var self = this;
    this._onVisibility = function () { self._handleVisibility(); };
    if (global.document) {
      global.document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  LiveTranscriber.isSupported = function () {
    return typeof SpeechRecognition === 'function';
  };
  LiveTranscriber.MESSAGES = MESSAGES;
  LiveTranscriber.newPart = newPart;

  LiveTranscriber.prototype.isActive = function () {
    return this._wanted;
  };

  LiveTranscriber.prototype._setState = function (state) {
    if (this.state === state) return;
    this.state = state;
    this.onState(state);
    if (state === 'listening') this._holdWakeLock();
    if (state === 'idle') this._releaseWakeLock();
  };

  /** Start listening. Resolves once the start attempt has been made. */
  LiveTranscriber.prototype.start = function (lang) {
    var self = this;
    if (lang) this.lang = lang;
    if (this._wanted) return Promise.resolve();

    if (!LiveTranscriber.isSupported()) {
      this.onMessage(MESSAGES.unsupported, 'error');
      return Promise.resolve();
    }
    if (global.isSecureContext === false) {
      this.onMessage(MESSAGES.insecure, 'error');
      return Promise.resolve();
    }
    if (global.navigator && global.navigator.onLine === false) {
      this.onMessage(MESSAGES.offline, 'error');
      return Promise.resolve();
    }

    clearTimeout(this._stopFallback);
    this._wanted = true;
    this._fatal = false;
    this._restartTimes = [];
    this._networkRetries = 0;
    this._lastFinal = '';
    this._setState('starting');

    return this._checkPermission().then(function (permission) {
      if (!self._wanted) return;
      if (permission === 'denied') {
        self._fail(MESSAGES.permissionDenied);
        return;
      }
      if (permission === 'prompt') self.onMessage(MESSAGES.askPermission, 'info');
      self._startRecognition();
    });
  };

  /** Stop listening. Any words still being heard are kept. */
  LiveTranscriber.prototype.stop = function () {
    var self = this;
    this._wanted = false;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;

    if (!this._rec) {
      this._commitInterim();
      this._setState('idle');
      this.onMessage(MESSAGES.stopped, 'info');
      return;
    }

    this._setState('stopping');
    try { this._rec.stop(); } catch (e) { /* already stopped */ }

    // If Chrome never reports that it ended, clean up anyway.
    clearTimeout(this._stopFallback);
    this._stopFallback = setTimeout(function () {
      if (self._rec) {
        try { self._rec.abort(); } catch (e) { /* ignore */ }
        self._detach();
        self._commitInterim();
        self._setState('idle');
        self.onMessage(MESSAGES.stopped, 'info');
      }
    }, 2000);
  };

  LiveTranscriber.prototype._checkPermission = function () {
    var nav = global.navigator;
    if (!nav || !nav.permissions || !nav.permissions.query) return Promise.resolve('unknown');
    return nav.permissions.query({ name: 'microphone' })
      .then(function (status) { return status.state; })
      .catch(function () { return 'unknown'; });
  };

  LiveTranscriber.prototype._startRecognition = function () {
    var self = this;
    if (!this._wanted) return;

    if (global.document && global.document.hidden) {
      this._setState('paused');
      this.onMessage(MESSAGES.paused, 'info');
      return;
    }

    // Only one recognizer at a time (e.g. Start tapped again while stopping).
    if (this._rec) {
      var old = this._rec;
      this._detach();
      try { old.abort(); } catch (e) { /* ignore */ }
      this._commitInterim();
    }

    // A fresh object each time is the most reliable way on Android.
    var rec = new SpeechRecognition();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    var committed = {};  // result indexes already added, for this session only

    rec.onstart = function () {
      if (rec !== self._rec) return;
      self._setState('listening');
      self.onMessage(MESSAGES.listening, 'info');
    };

    rec.onresult = function (event) {
      if (rec !== self._rec) return;
      var interim = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var result = event.results[i];
        var text = result[0] ? result[0].transcript : '';
        if (result.isFinal) {
          if (committed[i]) continue;
          committed[i] = true;
          self._addFinal(text);
        } else {
          interim += text;
        }
      }
      // Hearing words means we're healthy again.
      self._restartTimes = [];
      self._networkRetries = 0;
      self._setInterim(interim);
      if (self.state !== 'listening') self._setState('listening');
    };

    rec.onerror = function (event) {
      if (rec !== self._rec) return;
      self._handleError(event.error);
    };

    rec.onend = function () {
      if (rec !== self._rec) return;
      self._detach();
      self._commitInterim();

      if (!self._wanted || self._fatal) {
        clearTimeout(self._stopFallback);
        self._setState('idle');
        if (!self._fatal) self.onMessage(MESSAGES.stopped, 'info');
        return;
      }
      self._scheduleRestart(RESTART_DELAY_MS);
    };

    this._rec = rec;
    try {
      rec.start();
    } catch (e) {
      // InvalidStateError: already started. Anything else: try again shortly.
      if (!e || e.name !== 'InvalidStateError') {
        this._detach();
        this._scheduleRestart(RESTART_DELAY_MS * 4);
      }
    }
  };

  LiveTranscriber.prototype._scheduleRestart = function (delay) {
    var self = this;
    var now = Date.now();
    this._restartTimes = this._restartTimes.filter(function (t) {
      return now - t < QUICK_RESTART_WINDOW_MS;
    });
    this._restartTimes.push(now);
    if (this._restartTimes.length > MAX_QUICK_RESTARTS) {
      this._fail(MESSAGES.tooManyRestarts);
      return;
    }
    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(function () {
      self._restartTimer = null;
      self._startRecognition();
    }, delay);
  };

  LiveTranscriber.prototype._handleError = function (code) {
    switch (code) {
      case 'no-speech':
        // Normal after a quiet stretch. Chrome will end; we restart.
        this.onMessage(MESSAGES.noSpeech, 'info');
        break;
      case 'aborted':
        break;
      case 'not-allowed':
        this._fail(MESSAGES.permissionDenied);
        break;
      case 'service-not-allowed':
        this._fail(MESSAGES.serviceNotAllowed);
        break;
      case 'audio-capture':
        this._fail(MESSAGES.noMic);
        break;
      case 'network':
        if (global.navigator && global.navigator.onLine === false) {
          this._fail(MESSAGES.offline);
        } else if (this._networkRetries < MAX_NETWORK_RETRIES) {
          this._networkRetries++;
          this.onMessage(MESSAGES.networkRetry, 'warn');
        } else {
          this._fail(MESSAGES.network);
        }
        break;
      case 'language-not-supported':
        this._fail(MESSAGES.language);
        break;
      default:
        this._fail(MESSAGES.generic);
    }
  };

  /** A problem we can't recover from by ourselves. */
  LiveTranscriber.prototype._fail = function (message) {
    this._fatal = true;
    this._wanted = false;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    this.onMessage(message, 'error');
    if (this._rec) {
      try { this._rec.abort(); } catch (e) { /* ignore */ }
      // onend will finish the cleanup; if it never comes, do it now.
      var self = this;
      var rec = this._rec;
      setTimeout(function () {
        if (self._rec === rec) {
          self._detach();
          self._commitInterim();
          self._setState('idle');
        }
      }, 1000);
    } else {
      this._commitInterim();
      this._setState('idle');
    }
  };

  LiveTranscriber.prototype._detach = function () {
    var rec = this._rec;
    if (!rec) return;
    rec.onstart = rec.onresult = rec.onerror = rec.onend = null;
    this._rec = null;
  };

  LiveTranscriber.prototype._addFinal = function (text) {
    var part = newPart(this._lastFinal, text);
    if (normalize(text)) this._lastFinal = normalize(text);
    if (part) this.onFinal(part);
  };

  LiveTranscriber.prototype._setInterim = function (text) {
    var clean = normalize(text);
    if (clean === this._interim) return;
    this._interim = clean;
    this.onInterim(clean);
  };

  /** Keep words Chrome heard but never confirmed (it happens when it stops). */
  LiveTranscriber.prototype._commitInterim = function () {
    if (this._interim) {
      var text = this._interim;
      this._setInterim('');
      this._addFinal(text);
    }
  };

  LiveTranscriber.prototype._handleVisibility = function () {
    if (!global.document) return;
    if (global.document.hidden) {
      this._releaseWakeLock();
      return;
    }
    if (this._wanted && this.state === 'paused') {
      this._restartTimes = [];
      this._setState('starting');
      this._startRecognition();
    } else if (this.state === 'listening') {
      this._holdWakeLock();
    }
  };

  // Keep the screen on while listening; a sleeping screen stops the mic.
  LiveTranscriber.prototype._holdWakeLock = function () {
    if (this._awake) this._awake.start();
  };

  LiveTranscriber.prototype._releaseWakeLock = function () {
    if (this._awake) this._awake.stop();
  };

  global.LiveTranscriber = LiveTranscriber;
})(window);
