/*
 * cloud-api.js — Talks to the Transcriber Edge Functions on Supabase
 * (supabase/functions/), which talk to Speechmatics.
 *
 *   CloudApi.checkLimit()               -> { open, limitMinutes, usedMinutes }
 *   CloudApi.startJob(path, seconds)    -> { jobId, reused? }
 *   CloudApi.jobStatus(jobId)           -> { status: 'running' | 'done' | 'failed', errors }
 *   CloudApi.jobResult(jobId)           -> the transcript (Speechmatics json-v2)
 *   CloudApi.deleteAudio(jobId)         -> { deleted: true }
 *
 * Every call carries the signed-in person's token (auth.js); the functions
 * refuse anyone who is not signed in or not on the allowed list.
 *
 * Every failure has a code the File tab turns into plain words:
 *   'offline' | 'network' | 'notSetUp' | 'dailyLimit' | 'speechmatics' | 'busy' |
 *   'notUploaded' | 'unknownJob' | 'notReady' | 'tooLarge' | 'server' |
 *   'signIn' | 'notAllowed'
 *
 * Exposes window.CloudApi.
 */
(function (global) {
  'use strict';

  var TIMEOUT_MS = 45000;
  var RESULT_TIMEOUT_MS = 180000;   // a 3-hour transcript is a few MB

  function ApiError(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  function call(name, body, timeout) {
    return global.Auth.token().then(function (token) {
      if (!token) throw ApiError('signIn', 'Not signed in');
      return send(name, body, timeout, token);
    });
  }

  function send(name, body, timeout, token) {
    var config = global.CLOUD_CONFIG;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeout || TIMEOUT_MS) : null;
    return global.fetch(config.functionsUrl + '/' + name, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.publishableKey,
        Authorization: 'Bearer ' + token
      },
      body: JSON.stringify(body || {}),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (res.ok && data) return data;
        if (data && data.error) throw ApiError(data.error, data.message, data);
        // Supabase answers 404 by itself when a function has not been deployed.
        if (res.status === 404) throw ApiError('notSetUp', 'Function ' + name + ' not found');
        if (res.status === 401 || res.status === 403) throw ApiError('notSetUp', 'Not allowed: ' + res.status);
        throw ApiError('server', 'HTTP ' + res.status + ' ' + String(text).slice(0, 200));
      });
    }, function (err) {
      clearTimeout(timer);
      if (global.navigator.onLine === false) throw ApiError('offline', 'No internet connection');
      throw ApiError('network', 'Could not reach the server: ' + (err && err.message));
    });
  }

  global.CloudApi = {
    checkLimit: function () { return call('check-limit', {}); },
    startJob: function (path, seconds) { return call('start-job', { path: path, seconds: Math.round(seconds || 0) }); },
    jobStatus: function (jobId) { return call('job-status', { jobId: jobId }); },
    jobResult: function (jobId) { return call('job-result', { jobId: jobId }, RESULT_TIMEOUT_MS); },
    deleteAudio: function (jobId) { return call('delete-audio', { jobId: jobId }); },
    _call: call
  };
})(window);
