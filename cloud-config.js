/*
 * cloud-config.js — Where the File tab sends recordings.
 *
 * Only public values belong here. The publishable key is meant to be used in
 * web pages: it can only upload into the private "recordings" bucket and call
 * the Edge Functions. The Speechmatics key and Supabase's secret keys stay on
 * the server (Edge Function secrets) and never appear in this app.
 */
(function (global) {
  'use strict';
  var SUPABASE_URL = 'https://mgiwopbaglgzxeaowzzt.supabase.co';
  global.CLOUD_CONFIG = {
    supabaseUrl: SUPABASE_URL,
    publishableKey: 'sb_publishable_BZjwO2iS-yPbM-MBotusbQ_3lIVcMAS',
    bucket: 'recordings',
    uploadEndpoint: SUPABASE_URL + '/storage/v1/upload/resumable',
    functionsUrl: SUPABASE_URL + '/functions/v1'
  };
})(window);
