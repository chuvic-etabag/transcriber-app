/*
 * keep-awake.js — Keeps the screen on (Screen Wake Lock) while the app is
 * listening or transcribing. A sleeping screen stops the microphone and
 * slows file transcription to a crawl.
 *
 * Android releases the lock whenever the page is hidden or the battery saver
 * steps in. While we still want it, this asks again as soon as the page is
 * visible, and retries a few seconds after an unexpected release.
 *
 *   var awake = new KeepAwake();
 *   awake.start();   // ask for the screen to stay on
 *   awake.stop();    // let it sleep again
 */
(function (global) {
  'use strict';

  var RETRY_MS = 3000;

  function KeepAwake() {
    this.wanted = false;
    this.lock = null;
    this._pending = false;
    this._retry = null;
    var self = this;
    if (global.document) {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.visibilityState === 'visible' && self.wanted) self._request();
      });
    }
  }

  KeepAwake.isSupported = function () {
    return Boolean(global.navigator && global.navigator.wakeLock && global.navigator.wakeLock.request);
  };

  KeepAwake.prototype.start = function () {
    this.wanted = true;
    this._request();
  };

  KeepAwake.prototype.stop = function () {
    this.wanted = false;
    clearTimeout(this._retry);
    this._retry = null;
    if (this.lock) {
      var lock = this.lock;
      this.lock = null;
      lock.release().catch(function () {});
    }
  };

  KeepAwake.prototype.isHeld = function () {
    return Boolean(this.lock);
  };

  KeepAwake.prototype._request = function () {
    var self = this;
    if (this.lock || this._pending || !KeepAwake.isSupported()) return;
    if (global.document && global.document.visibilityState === 'hidden') return;
    this._pending = true;
    global.navigator.wakeLock.request('screen').then(function (lock) {
      self._pending = false;
      if (!self.wanted) { lock.release().catch(function () {}); return; }
      self.lock = lock;
      lock.addEventListener('release', function () {
        if (self.lock !== lock) return;
        self.lock = null;
        // Released while we still want it (Android, battery saver): ask again.
        if (self.wanted) self._scheduleRetry();
      });
    }, function () {
      self._pending = false;
      if (self.wanted) self._scheduleRetry();
    });
  };

  KeepAwake.prototype._scheduleRetry = function () {
    var self = this;
    clearTimeout(this._retry);
    this._retry = setTimeout(function () {
      self._retry = null;
      if (self.wanted) self._request();
    }, RETRY_MS);
  };

  global.KeepAwake = KeepAwake;
})(window);
