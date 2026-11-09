/*
 * job-store.js — Saves file transcription progress in the browser
 * (IndexedDB), so a closed app or a phone restart doesn't lose work.
 *
 * Two stores:
 *   jobs:   one record per file   { key, name, size, duration, nextTime, cursor, done, ... }
 *   pieces: one record per finished 30-second piece { key, start, end, text, language }
 * Each piece and its job are written in one transaction, so they always agree.
 *
 * Exposes window.JobStore with promise-returning functions.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'transcriber';
  var DB_VERSION = 1;
  var KEEP_JOBS = 20;   // older finished files are removed to save space
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
        if (!db.objectStoreNames.contains('pieces')) db.createObjectStore('pieces', { keyPath: ['key', 'start'] });
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
      var joined = new Uint8Array(parts[0].byteLength + parts[1].byteLength);
      joined.set(new Uint8Array(parts[0]), 0);
      joined.set(new Uint8Array(parts[1]), parts[0].byteLength);
      if (!subtle) return 'n:' + file.name + ':' + file.size + ':' + file.lastModified;
      return subtle.digest('SHA-256', joined).then(function (hash) {
        var hex = Array.prototype.map.call(new Uint8Array(hash), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
        return 'f:' + file.size + ':' + hex.slice(0, 32);
      });
    });
  }

  function getJob(key) {
    return open().then(function (db) {
      return request(db.transaction('jobs').objectStore('jobs').get(key));
    });
  }

  function getPieces(key) {
    return open().then(function (db) {
      var range = IDBKeyRange.bound([key, -Infinity], [key, Infinity]);
      return request(db.transaction('pieces').objectStore('pieces').getAll(range));
    }).then(function (pieces) {
      return pieces.sort(function (a, b) { return a.start - b.start; });
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

  /** Save one finished piece and where to carry on from, together. */
  function savePiece(job, piece) {
    return open().then(function (db) {
      var tx = db.transaction(['jobs', 'pieces'], 'readwrite');
      job.updatedAt = Date.now();
      tx.objectStore('pieces').put(piece);
      tx.objectStore('jobs').put(job);
      return done(tx);
    });
  }

  function deleteJob(key) {
    return open().then(function (db) {
      var tx = db.transaction(['jobs', 'pieces'], 'readwrite');
      tx.objectStore('jobs').delete(key);
      tx.objectStore('pieces').delete(IDBKeyRange.bound([key, -Infinity], [key, Infinity]));
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
      return jobs.filter(function (j) { return !j.done; })
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; })[0] || null;
    });
  }

  /** Keep the newest KEEP_JOBS files; remove the rest. */
  function prune() {
    return allJobs().then(function (jobs) {
      jobs.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      return Promise.all(jobs.slice(KEEP_JOBS).map(function (j) { return deleteJob(j.key); }));
    });
  }

  global.JobStore = {
    fileKey: fileKey,
    getJob: getJob,
    getPieces: getPieces,
    putJob: putJob,
    savePiece: savePiece,
    deleteJob: deleteJob,
    latestUnfinished: latestUnfinished,
    prune: prune
  };
})(window);
