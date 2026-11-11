/*
 * cloud-config.js — Where the app signs in, uploads recordings and keeps
 * My Transcripts.
 *
 * Only public values belong here. The publishable key is meant to be used in
 * web pages: by itself it can do nothing but ask for a sign-in link. Everything
 * else needs a signed-in person whose email is on the allowed list, and each
 * person reaches only their own transcripts and recordings. The Speechmatics
 * key and Supabase's secret keys stay on the server (Edge Function secrets)
 * and never appear in this app.
 */
(function (global) {
  'use strict';
  var SUPABASE_URL = 'https://mgiwopbaglgzxeaowzzt.supabase.co';
  global.CLOUD_CONFIG = {
    supabaseUrl: SUPABASE_URL,
    publishableKey: 'sb_publishable_BZjwO2iS-yPbM-MBotusbQ_3lIVcMAS',
    bucket: 'recordings',
    uploadEndpoint: SUPABASE_URL + '/storage/v1/upload/resumable',
    functionsUrl: SUPABASE_URL + '/functions/v1',
    // The free Supabase plan's file storage, shown by the meter in My Transcripts.
    storageLimitBytes: 1024 * 1024 * 1024
  };
})(window);
