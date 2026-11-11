/*
 * cloud-store.js — Remembers each file's trip to Speechmatics in the browser
 * (IndexedDB), so a closed app or a phone restart never loses the place and
 * never pays for the same file twice.
 *
 * Two stores:
 *   jobs:  one record per file, found by a fingerprint of its contents:
 *          { key, name, size, duration, stage, objectPath, uploadUrl, uploadOffset,
 *            compactBytes, jobId, turns, speakers, names, done, createdAt, updatedAt }
 *          stage: 'new' | 'uploading' | 'uploaded' | 'processing' | 'done'
 *   audio: the small converted recording waiting to be uploaded { key, blob }
 *          (deleted once Speechmatics has it)
 *
 * Exposes window.CloudStore with promise-returning functions.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'transcriber-cloud';
  var DB_VERSION = 1;
  var KEEP_DONE = 30;   // older finished transcripts are removed to save space
  var dbPromise = null;

  function request(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('aborted')); };
    });
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('IndexedDB not available')); return; }
      var req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  /**
   * A fingerprint of the file's contents (size plus the first and last
   * 256 KB), so the same recording is recognised even if Android gives it a
   * different name or date when it is picked again.
   */
  function fileKey(file) {
    var SAMPLE = 256 * 1024;
    var head = file.slice(0, Math.min(file.size, SAMPLE));
    var tail = file.slice(Math.max(0, file.size - SAMPLE), file.size);
    return Promise.all([head.arrayBuffer(), tail.arrayBuffer()]).then(function (parts) {
      var subtle = global.crypto && global.crypto.subtle;
      if (!subtle) return 'n:' + file.name + ':' + file.size + ':' + file.lastModified;
      var joined = new Uint8Array(parts[0].byteLength + parts[1].byteLength);
      joined.set(new Uint8Array(parts[0]), 0);
      joined.set(new Uint8Array(parts[1]), parts[0].byteLength);
      return subtle.digest('SHA-256', joined).then(function (hash) {
        var hex = Array.prototype.map.call(new Uint8Array(hash), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
        return 'f:' + file.size + ':' + hex.slice(0, 32);
      });
    }).catch(function () {
      return 'n:' + file.name + ':' + file.size + ':' + file.lastModified;
    });
  }

  function getJob(key) {
    return open().then(function (db) {
      return request(db.transaction('jobs').objectStore('jobs').get(key));
    });
  }

  function putJob(job) {
    return open().then(function (db) {
      var tx = db.transaction('jobs', 'readwrite');
      job.updatedAt = Date.now();
      tx.objectStore('jobs').put(job);
      return done(tx);
    });
  }

  function deleteJob(key) {
    return open().then(function (db) {
      var tx = db.transaction(['jobs', 'audio'], 'readwrite');
      tx.objectStore('jobs').delete(key);
      tx.objectStore('audio').delete(key);
      return done(tx);
    });
  }

  function putAudio(key, blob) {
    return open().then(function (db) {
      var tx = db.transaction('audio', 'readwrite');
      tx.objectStore('audio').put({ key: key, blob: blob });
      return done(tx);
    });
  }

  function getAudio(key) {
    return open().then(function (db) {
      return request(db.transaction('audio').objectStore('audio').get(key));
    }).then(function (row) { return row ? row.blob : null; });
  }

  function deleteAudio(key) {
    return open().then(function (db) {
      var tx = db.transaction('audio', 'readwrite');
      tx.objectStore('audio').delete(key);
      return done(tx);
    });
  }

  function allJobs() {
    return open().then(function (db) {
      return request(db.transaction('jobs').objectStore('jobs').getAll());
    });
  }

  /** The most recently worked-on file that is not finished, if any. */
  function latestUnfinished() {
    return allJobs().then(function (jobs) {
      return jobs.filter(function (j) { return !j.done && j.stage && j.stage !== 'new'; })
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; })[0] || null;
    });
  }

  /** Keep the newest KEEP_DONE finished transcripts; remove older ones. */
  function prune() {
    return allJobs().then(function (jobs) {
      var finished = jobs.filter(function (j) { return j.done; })
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      return Promise.all(finished.slice(KEEP_DONE).map(function (j) { return deleteJob(j.key); }));
    });
  }

  global.CloudStore = {
    fileKey: fileKey,
    getJob: getJob,
    putJob: putJob,
    deleteJob: deleteJob,
    putAudio: putAudio,
    getAudio: getAudio,
    deleteAudio: deleteAudio,
    allJobs: allJobs,
    latestUnfinished: latestUnfinished,
    prune: prune
  };
})(window);
