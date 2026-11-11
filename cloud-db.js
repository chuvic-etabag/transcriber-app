/*
 * cloud-db.js — My Transcripts in the cloud: the "transcripts" table and the
 * recordings in Supabase Storage (supabase/setup_2.sql). Everything here runs
 * as the signed-in person, and the database rules let each person reach only
 * their own transcripts and recordings.
 *
 *   CloudDb.list()                 -> the list, newest first (no turns: they can be large)
 *   CloudDb.get(id)                -> one transcript with its turns
 *   CloudDb.findByFileKey(key)     -> the transcript made from that file, or null
 *   CloudDb.save(item)             -> saves a finished transcript, returns its id
 *   CloudDb.update(id, fields)     -> saves a rename, speaker names or corrected words
 *   CloudDb.remove(item)           -> deletes the transcript and its recording
 *   CloudDb.removeAll()            -> deletes every transcript and recording of this person
 *   CloudDb.storageUsed()          -> bytes of recordings stored
 *   CloudDb.audioUrl(path)         -> a link that plays a recording for the next hour
 *
 * Failures have a code: 'offline' | 'network' | 'signIn' | 'notSetUp' | 'failed'.
 *
 * Exposes window.CloudDb.
 */
(function (global) {
  'use strict';

  var LIST_COLUMNS = 'id,title,file_name,created_at,duration_seconds,first_line,audio_path,audio_bytes,file_key';
  var AUDIO_LINK_SECONDS = 60 * 60;
  var FIRST_LINE_LENGTH = 200;

  function DbError(code, detail) {
    var e = new Error(detail || code);
    e.code = code;
    return e;
  }

  function client() { return global.Auth.client; }
  function bucket() { return client().storage.from(global.CLOUD_CONFIG.bucket); }

  function problem(error) {
    var text = String((error && error.message) || error || '');
    var code = String((error && error.code) || '');
    var status = Number(error && (error.status || error.statusCode)) || 0;
    if (!status && /fetch|network|load failed/i.test(text)) {
      return DbError(global.navigator.onLine === false ? 'offline' : 'network', text);
    }
    if (status === 401 || code === 'PGRST301' || /jwt/i.test(text)) return DbError('signIn', text);
    if (code === 'PGRST205' || code === 'PGRST202' || code === '42P01' || code === '42883' || status === 404) return DbError('notSetUp', text);
    return DbError('failed', text || code);
  }

  /** Run one request; resolves with its data or rejects with a coded error. */
  function run(request) {
    if (!global.Auth.user()) return Promise.reject(DbError('signIn', 'Not signed in'));
    return Promise.resolve(request).then(function (res) {
      if (res && res.error) throw problem(res.error);
      return res ? res.data : null;
    }, function (err) { throw problem(err); });
  }

  /** The first line of a transcript, for the list: "Speaker 1: Good morning, everyone." */
  function firstLine(turns, speakers, names) {
    var TF = global.TranscriptFormat;
    var first = (turns || []).filter(function (t) { return String(t.text || '').trim(); })[0];
    if (!first) return '';
    var line = TF.nameOf(first.speaker, speakers || [], names || {}) + ': ' + String(first.text).trim();
    return line.length > FIRST_LINE_LENGTH ? line.slice(0, FIRST_LINE_LENGTH - 1).trimEnd() + '…' : line;
  }

  function list() {
    return run(client().from('transcripts').select(LIST_COLUMNS).order('created_at', { ascending: false }).limit(1000))
      .then(function (rows) { return rows || []; });
  }

  function get(id) {
    return run(client().from('transcripts').select('*').eq('id', id).maybeSingle());
  }

  function findByFileKey(key) {
    if (!key) return Promise.resolve(null);
    return run(client().from('transcripts').select('*').eq('file_key', key).limit(1)).then(function (rows) {
      return (rows && rows[0]) || null;
    });
  }

  /**
   * Save a finished transcript:
   * { title, fileName, duration, turns, speakers, names, audioPath, audioBytes, jobId, fileKey, createdAt }.
   * The same file saved twice (a lost answer, another device) stays one item.
   */
  function save(item) {
    var user = global.Auth.user();
    if (!user) return Promise.reject(DbError('signIn', 'Not signed in'));
    var row = {
      user_id: user.id,
      title: String(item.title || item.fileName || 'Transcript').slice(0, 200),
      file_name: String(item.fileName || ''),
      duration_seconds: Math.max(0, Math.round((Number(item.duration) || 0) * 1000) / 1000),
      turns: item.turns || [],
      speakers: item.speakers || [],
      speaker_names: item.names || {},
      first_line: firstLine(item.turns, item.speakers, item.names),
      audio_path: item.audioPath || null,
      audio_bytes: item.audioPath ? Math.max(0, Math.round(Number(item.audioBytes) || 0)) : 0,
      speechmatics_id: item.jobId || null,
      file_key: item.fileKey || null
    };
    if (item.createdAt) row.created_at = new Date(item.createdAt).toISOString();
    var table = client().from('transcripts');
    var request = row.file_key
      ? table.upsert(row, { onConflict: 'user_id,file_key' }).select('id').single()
      : table.insert(row).select('id').single();
    return run(request).then(function (saved) { return saved.id; });
  }

  /** fields: any of { title, turns, speakers, names }. The first line follows the turns and names. */
  function update(id, fields) {
    var row = {};
    if (fields.title !== undefined) row.title = String(fields.title).slice(0, 200);
    if (fields.turns !== undefined) row.turns = fields.turns;
    if (fields.names !== undefined) row.speaker_names = fields.names;
    if (fields.turns !== undefined && fields.speakers !== undefined) {
      row.first_line = firstLine(fields.turns, fields.speakers, fields.names);
    }
    return run(client().from('transcripts').update(row).eq('id', id).select('id')).then(function (rows) {
      if (!rows || !rows.length) throw DbError('gone', 'This transcript is no longer in My Transcripts');
    });
  }

  function removeAudio(paths) {
    paths = paths.filter(Boolean);
    var chunks = [];
    for (var i = 0; i < paths.length; i += 100) chunks.push(paths.slice(i, i + 100));
    return chunks.reduce(function (before, chunk) {
      return before.then(function () { return run(bucket().remove(chunk)); });
    }, Promise.resolve());
  }

  /** Delete one transcript: its recording first, then the transcript itself. */
  function remove(item) {
    return removeAudio([item.audio_path]).then(function () {
      return run(client().from('transcripts').delete().eq('id', item.id));
    });
  }

  /** Delete every transcript of this person, with every recording. Resolves with how many. */
  function removeAll() {
    var user = global.Auth.user();
    return list().then(function (rows) {
      return removeAudio(rows.map(function (r) { return r.audio_path; })).then(function () {
        return run(client().from('transcripts').delete().eq('user_id', user.id));
      }).then(function () { return rows.length; });
    });
  }

  function storageUsed() {
    return run(client().rpc('transcriber_storage_used')).then(function (bytes) { return Number(bytes) || 0; });
  }

  function audioUrl(path) {
    return run(bucket().createSignedUrl(path, AUDIO_LINK_SECONDS)).then(function (data) {
      if (!data || !data.signedUrl) throw DbError('failed', 'No link for the recording');
      return data.signedUrl;
    });
  }

  global.CloudDb = {
    list: list,
    get: get,
    findByFileKey: findByFileKey,
    save: save,
    update: update,
    remove: remove,
    removeAll: removeAll,
    storageUsed: storageUsed,
    audioUrl: audioUrl,
    firstLine: firstLine
  };
})(window);
