/*
 * folder.js — The My Transcripts tab: every transcript the signed-in person
 * made, kept in the cloud (cloud-db.js) with its recording, so the same
 * folder appears on every device they sign in on.
 *
 * - A storage meter ("Using 120 MB of 1 GB") and the list, newest first:
 *   name, date, length and the first line.
 * - Open an item: it is shown by the same transcript view as a fresh
 *   transcript (transcript-view.js), with tap-to-play times, speaker
 *   renaming, Show Timestamps, Show Fillers, Copy and Download. Renames and
 *   corrections are saved to the cloud.
 * - Rename an item. Delete an item (with a confirm step): its transcript and
 *   its recording are both removed. Delete All needs the word DELETE typed.
 * - Once, after the first sign-in on a device, it offers to move the
 *   transcripts saved in this browser by the earlier version into the folder.
 *
 * Exposes window.Folder. app.js creates it and gives it the page elements.
 */
(function (global) {
  'use strict';

  var MOVE_KEY = 'transcriber.moveOffered';
  var TIMING = { sync: 1500 };   // the tests make this shorter
  var MB = 1024 * 1024;
  var GB = 1024 * MB;

  var MESSAGES = {
    loading: 'Loading your transcripts…',
    empty: 'No transcripts yet. Transcribe a recording in the File tab and it will be kept here.',
    offline: 'No internet connection. My Transcripts will show once you are back online.',
    network: 'Could not reach My Transcripts. Check your internet connection and tap Refresh.',
    signIn: 'Your sign-in has ended. Tap Sign Out at the top, then sign in again.',
    notSetUp: 'My Transcripts is not set up yet. Please try again later.',
    failed: 'Something went wrong with My Transcripts. Wait a minute and tap Refresh.',
    noAudio: 'This transcript has no saved recording, so it cannot be played. (It was moved here from a device after its recording was already deleted.)',
    cantPlay: 'The recording could not be played. Check your internet connection and tap the time again.',
    gettingAudio: 'Getting the recording…',
    notSaved: 'Your change could not be saved to My Transcripts. Check your internet connection; it will be tried again when you change something else.'
  };

  function problemText(err) {
    var code = err && err.code;
    return MESSAGES[code] && typeof MESSAGES[code] === 'string' ? MESSAGES[code] : MESSAGES.failed;
  }

  /** 125829120 -> "120 MB"; 300000 -> "0.3 MB"; 1288490188 -> "1.2 GB". */
  function size(bytes) {
    bytes = Math.max(0, Number(bytes) || 0);
    if (bytes >= GB) return (bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1) + ' GB';
    var mb = bytes / MB;
    if (mb === 0) return '0 MB';
    return (mb < 10 ? Math.max(0.1, mb).toFixed(1) : String(Math.round(mb))) + ' MB';
  }

  function dateText(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function lengthText(seconds) {
    seconds = Number(seconds) || 0;
    return seconds ? global.FileTab.spoken(seconds) : 'Length unknown';
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(label, className, action) {
    var b = el('button', className || 'small-button', label);
    b.type = 'button';
    if (action) b.dataset.action = action;
    return b;
  }

  function Folder(els, hooks) {
    this.els = els;
    this.view = hooks.view;
    this.onText = hooks.onText || function () {};
    this.onOpen = hooks.onOpen || function () {};       // an item was opened or closed
    this.onChanged = hooks.onChanged || function () {}; // (id, fields) an open item was edited
    this.onDeleted = hooks.onDeleted || function () {}; // (ids | null) items were deleted
    this.localStore = hooks.localStore;                  // CloudStore: transcripts saved in this browser
    this.user = null;
    this.active = false;
    this.items = [];
    this.loaded = false;
    this.open = null;              // the opened item (a full row) or null
    this.doc = null;               // what the transcript view shows for it
    this._load = 0;
    this._bind();
  }

  Folder.MESSAGES = MESSAGES;
  Folder.TIMING = TIMING;
  Folder.size = size;

  Folder.prototype._bind = function () {
    var self = this, els = this.els;
    els.refresh.addEventListener('click', function () { self.refresh(); });
    els.list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-action]');
      var card = e.target.closest('.item');
      if (!b || !card) return;
      self._cardAction(card, b.dataset.action);
    });
    els.list.addEventListener('keydown', function (e) {
      var input = e.target.closest('.item-rename-input');
      if (!input) return;
      var card = input.closest('.item');
      if (e.key === 'Enter') { e.preventDefault(); self._cardAction(card, 'rename-save'); }
      if (e.key === 'Escape') { e.preventDefault(); self._cardAction(card, 'rename-cancel'); }
    });

    els.deleteAll.addEventListener('click', function () {
      els.deleteAllText.textContent = 'This deletes all ' + self.items.length + (self.items.length === 1 ? ' transcript' : ' transcripts') +
        ' in My Transcripts, with their recordings, from every device. This cannot be undone. Copy or download anything you need first.';
      els.deleteAllInput.value = '';
      els.deleteAllYes.disabled = true;
      els.deleteAllBox.hidden = false;
      els.deleteAllInput.focus();
    });
    els.deleteAllInput.addEventListener('input', function () {
      els.deleteAllYes.disabled = els.deleteAllInput.value.trim() !== 'DELETE';
    });
    els.deleteAllInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !els.deleteAllYes.disabled) { e.preventDefault(); self._deleteAll(); }
      if (e.key === 'Escape') { e.preventDefault(); els.deleteAllBox.hidden = true; }
    });
    els.deleteAllYes.addEventListener('click', function () { self._deleteAll(); });
    els.deleteAllNo.addEventListener('click', function () {
      els.deleteAllBox.hidden = true;
      els.deleteAll.focus();
    });

    // The opened item
    els.back.addEventListener('click', function () { self.close(); });
    els.itemRename.addEventListener('click', function () {
      els.itemRenameInput.value = self.open ? self.open.title : '';
      els.itemRenameBox.hidden = false;
      els.itemDeleteBox.hidden = true;
      els.itemRenameInput.focus();
      els.itemRenameInput.select();
    });
    els.itemRenameSave.addEventListener('click', function () { self._renameOpen(); });
    els.itemRenameCancel.addEventListener('click', function () { els.itemRenameBox.hidden = true; });
    els.itemRenameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); self._renameOpen(); }
      if (e.key === 'Escape') { e.preventDefault(); els.itemRenameBox.hidden = true; }
    });
    els.itemDelete.addEventListener('click', function () {
      els.itemDeleteText.textContent = self._deleteQuestion(self.open);
      els.itemDeleteBox.hidden = false;
      els.itemRenameBox.hidden = true;
      els.itemDeleteNo.focus();
    });
    els.itemDeleteNo.addEventListener('click', function () { els.itemDeleteBox.hidden = true; });
    els.itemDeleteYes.addEventListener('click', function () {
      var item = self.open;
      if (!item) return;
      els.itemDeleteYes.disabled = true;
      self._delete(item).then(function (ok) {
        els.itemDeleteYes.disabled = false;
        if (ok) { self.close(); self.message('Deleted “' + item.title + '” and its recording.', 'done'); }
      });
    });
    els.player.addEventListener('error', function () {
      if (!els.player.getAttribute('src') || !self.open) return;
      // The play link lasts an hour: get a fresh one the next time a time is tapped.
      self._audioFor = null;
      self.itemMessage(MESSAGES.cantPlay, 'warn');
    });

    // Moving the transcripts saved in this browser
    els.moveYes.addEventListener('click', function () { self._move(); });
    els.moveNo.addEventListener('click', function () {
      self._moveAnswered();
      els.moveBox.hidden = true;
    });
    global.addEventListener('pagehide', function () { if (self._syncTimer) self._syncNow(); });
  };

  // ---------- Messages ----------

  Folder.prototype.message = function (text, kind) {
    this.els.status.textContent = text || '';
    this.els.status.dataset.kind = kind || 'info';
  };

  Folder.prototype.itemMessage = function (text, kind) {
    this.els.itemStatus.textContent = text || '';
    this.els.itemStatus.dataset.kind = kind || 'info';
  };

  // ---------- Signing in and out, showing the tab ----------

  Folder.prototype.signedIn = function (user) {
    this.user = user;
    this.items = [];
    this.loaded = false;
    this._offerMove();
    if (this.active) this.refresh();
  };

  Folder.prototype.signedOut = function () {
    this.user = null;
    this._load++;
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    this.items = [];
    this.loaded = false;
    this._closeItem();
    this.els.moveBox.hidden = true;
    this.els.deleteAllBox.hidden = true;
    this._renderList();
    this._meter(0);
    this.message('');
  };

  /** app.js says whether this tab is on screen. */
  Folder.prototype.setActive = function (active) {
    this.active = active;
    if (!active) return;
    this.view.setDoc(this.doc);
    if (this.user && !this.open) this.refresh();
  };

  /** Something was saved or changed elsewhere (the File tab): the list is out of date. */
  Folder.prototype.changed = function () {
    this.loaded = false;
    if (this.active && !this.open) this.refresh();
  };

  // ---------- The list ----------

  Folder.prototype.refresh = function () {
    var self = this;
    if (!this.user) return Promise.resolve();
    var load = ++this._load;
    if (!this.loaded) this.message(MESSAGES.loading);
    this.els.refresh.disabled = true;
    var done = function () { if (self._load === load) self.els.refresh.disabled = false; };
    global.CloudDb.storageUsed().then(function (bytes) {
      if (self._load === load) self._meter(bytes);
    }, function () { /* the list below says what is wrong */ });
    return global.CloudDb.list().then(function (rows) {
      if (self._load !== load) return;
      self.items = rows;
      self.loaded = true;
      self._renderList();
      self.message(rows.length ? '' : MESSAGES.empty);
      done();
    }, function (err) {
      if (self._load !== load) return;
      self.message(problemText(err), 'error');
      done();
    });
  };

  Folder.prototype._meter = function (bytes) {
    var limit = global.CLOUD_CONFIG.storageLimitBytes;
    this.els.meterText.textContent = 'Using ' + size(bytes) + ' of ' + size(limit);
    this.els.meterBar.max = 100;
    this.els.meterBar.value = Math.max(0, Math.min(100, bytes / limit * 100));
  };

  Folder.prototype._deleteQuestion = function (item) {
    return 'Delete “' + (item ? item.title : '') + '”? Its transcript and its recording will be removed from My Transcripts on every device. This cannot be undone.';
  };

  Folder.prototype._renderList = function () {
    var list = this.els.list;
    var self = this;
    list.textContent = '';
    this.items.forEach(function (item) {
      var card = el('li', 'item');
      card.dataset.id = item.id;
      card.appendChild(el('h3', 'item-name', item.title));
      card.appendChild(el('p', 'item-meta', dateText(item.created_at) + ' · ' + lengthText(item.duration_seconds)));
      card.appendChild(el('p', 'item-line', item.first_line || 'No speech was found in this recording.'));
      var row = el('div', 'item-buttons');
      row.appendChild(button('Open', 'small-button', 'open'));
      row.appendChild(button('Rename', 'small-button', 'rename'));
      row.appendChild(button('Delete', 'small-button', 'delete'));
      card.appendChild(row);
      list.appendChild(card);
    });
    var n = this.items.length;
    this.els.count.textContent = n + (n === 1 ? ' Transcript' : ' Transcripts');
    this.els.deleteAll.hidden = !n;
    if (!n) this.els.deleteAllBox.hidden = true;
    void self;
  };

  Folder.prototype._item = function (id) {
    return this.items.filter(function (i) { return i.id === id; })[0] || null;
  };

  /** Remove any open rename or delete box from a card. */
  function closeBoxes(card) {
    Array.prototype.slice.call(card.querySelectorAll('.item-box')).forEach(function (b) { b.remove(); });
  }

  Folder.prototype._cardAction = function (card, action) {
    var self = this;
    var item = this._item(card.dataset.id);
    if (!item) return;
    if (action === 'open') { this.openItem(item.id); return; }
    if (action === 'rename') {
      closeBoxes(card);
      var box = el('div', 'confirm item-box');
      var label = el('label', null, 'New Name');
      var input = el('input', 'text-input item-rename-input');
      input.type = 'text';
      input.maxLength = 120;
      input.autocomplete = 'off';
      input.value = item.title;
      input.id = 'rename-item-' + item.id;
      label.htmlFor = input.id;
      var buttons = el('div', 'confirm-buttons');
      buttons.appendChild(button('Save Name', 'small-button', 'rename-save'));
      buttons.appendChild(button('Cancel', 'small-button', 'rename-cancel'));
      box.appendChild(label);
      box.appendChild(input);
      box.appendChild(buttons);
      card.appendChild(box);
      input.focus();
      input.select();
      return;
    }
    if (action === 'rename-cancel' || action === 'delete-no') { closeBoxes(card); return; }
    if (action === 'rename-save') {
      var name = card.querySelector('.item-rename-input').value;
      closeBoxes(card);
      this._rename(item, name);
      return;
    }
    if (action === 'delete') {
      closeBoxes(card);
      var ask = el('div', 'confirm item-box');
      ask.appendChild(el('p', null, this._deleteQuestion(item)));
      var row = el('div', 'confirm-buttons');
      row.appendChild(button('Yes, Delete It', 'small-button danger', 'delete-yes'));
      row.appendChild(button('Keep It', 'small-button', 'delete-no'));
      ask.appendChild(row);
      card.appendChild(ask);
      row.lastChild.focus();
      return;
    }
    if (action === 'delete-yes') {
      Array.prototype.slice.call(card.querySelectorAll('button')).forEach(function (b) { b.disabled = true; });
      this._delete(item).then(function (ok) {
        if (ok) self.message('Deleted “' + item.title + '” and its recording.', 'done');
        else self._renderList();
      });
    }
  };

  // ---------- Rename, delete, delete all ----------

  Folder.prototype._rename = function (item, name) {
    var self = this;
    var clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!clean || clean === item.title) return Promise.resolve(false);
    return global.CloudDb.update(item.id, { title: clean }).then(function () {
      item.title = clean;
      var listed = self._item(item.id);
      if (listed) listed.title = clean;
      if (self.open && self.open.id === item.id) { self.open.title = clean; self._showItemHead(); }
      self._renderList();
      var say = 'Renamed to “' + clean + '”.';
      if (self.open) self.itemMessage(say, 'done'); else self.message(say, 'done');
      return true;
    }, function (err) {
      if (self.open) self.itemMessage(problemText(err), 'error'); else self.message(problemText(err), 'error');
      return false;
    });
  };

  Folder.prototype._renameOpen = function () {
    var value = this.els.itemRenameInput.value;
    this.els.itemRenameBox.hidden = true;
    if (this.open) this._rename(this.open, value);
  };

  /** Delete one item: its recording, then its transcript. Resolves true when it is gone. */
  Folder.prototype._delete = function (item) {
    var self = this;
    return global.CloudDb.remove(item).then(function () {
      self.items = self.items.filter(function (i) { return i.id !== item.id; });
      self._renderList();
      if (!self.items.length) self.message(MESSAGES.empty);
      self.onDeleted([item.id]);
      global.CloudDb.storageUsed().then(function (bytes) { self._meter(bytes); }, function () {});
      return true;
    }, function (err) {
      var say = 'Not deleted. ' + problemText(err);
      if (self.open) self.itemMessage(say, 'error'); else self.message(say, 'error');
      return false;
    });
  };

  Folder.prototype._deleteAll = function () {
    var self = this, els = this.els;
    if (els.deleteAllInput.value.trim() !== 'DELETE') return;
    els.deleteAllYes.disabled = true;
    this.message('Deleting everything…');
    global.CloudDb.removeAll().then(function (n) {
      els.deleteAllBox.hidden = true;
      els.deleteAllInput.value = '';
      self.items = [];
      self._renderList();
      self._meter(0);
      self.onDeleted(null);
      self.message('Deleted ' + n + (n === 1 ? ' transcript' : ' transcripts') + ' and ' + (n === 1 ? 'its recording' : 'their recordings') + '. My Transcripts is empty.', 'done');
      global.CloudDb.storageUsed().then(function (bytes) { self._meter(bytes); }, function () {});
    }, function (err) {
      els.deleteAllYes.disabled = false;
      self.message('Not everything was deleted. ' + problemText(err), 'error');
      self.refresh();
    });
  };

  // ---------- An opened item ----------

  Folder.prototype.openItem = function (id) {
    var self = this;
    var load = ++this._load;
    this.message('Opening…');
    return global.CloudDb.get(id).then(function (row) {
      if (self._load !== load) return;
      if (!row) {
        self.message('That transcript is no longer in My Transcripts.', 'warn');
        return self.refresh();
      }
      self.message('');
      self.open = row;
      row.speaker_names = row.speaker_names || {};
      self.doc = {
        turns: row.turns || [],
        speakers: row.speakers || [],
        names: row.speaker_names,
        changed: function () { row.speaker_names = this.names; self._syncSoon(); },
        play: function (seconds) { return self._play(seconds); }
      };
      self._audioFor = null;
      self.els.player.removeAttribute('src');
      self.els.player.hidden = true;
      self._showItemHead();
      self.els.listView.hidden = true;
      self.els.itemView.hidden = false;
      self.els.itemRenameBox.hidden = true;
      self.els.itemDeleteBox.hidden = true;
      self.itemMessage(row.audio_path ? '' : MESSAGES.noAudio);
      if (self.active) self.view.setDoc(self.doc);
      self.onOpen(true);
    }, function (err) {
      if (self._load !== load) return;
      self.message(problemText(err), 'error');
    });
  };

  Folder.prototype._showItemHead = function () {
    var row = this.open;
    this.els.itemName.textContent = row.title;
    this.els.itemMeta.textContent = dateText(row.created_at) + ' · ' + lengthText(row.duration_seconds) +
      (row.file_name && row.file_name !== row.title ? ' · From ' + row.file_name : '');
  };

  Folder.prototype._closeItem = function () {
    if (this._syncTimer) this._syncNow();
    this.open = null;
    this.doc = null;
    this._audioFor = null;
    try { this.els.player.pause(); } catch (e) { /* not playing */ }
    this.els.player.removeAttribute('src');
    this.els.player.hidden = true;
    this.els.itemView.hidden = true;
    this.els.listView.hidden = false;
    if (this.active) this.view.setDoc(null);
    this.onOpen(false);
  };

  /** Back to the list. */
  Folder.prototype.close = function () {
    this._closeItem();
    if (this.user) this.refresh();
  };

  /** The name of the opened item (for the downloaded file's name). */
  Folder.prototype.openName = function () {
    return this.open ? this.open.title : '';
  };

  Folder.prototype.text = function () { return this.view.textOf(this.doc); };
  Folder.prototype.wordCount = function () { return this.view.wordCountOf(this.doc); };

  /** After a speaker rename or a corrected word: save to the cloud a moment later. */
  Folder.prototype._syncSoon = function () {
    var self = this;
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(function () { self._syncNow(); }, TIMING.sync);
  };

  Folder.prototype._syncNow = function () {
    var self = this;
    var row = this.open;
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    if (!row || !this.user) return Promise.resolve();
    var fields = { turns: row.turns, speakers: row.speakers || [], names: row.speaker_names || {} };
    return global.CloudDb.update(row.id, fields).then(function () {
      var listed = self._item(row.id);
      if (listed) listed.first_line = global.CloudDb.firstLine(fields.turns, fields.speakers, fields.names);
      self.onChanged(row.id, fields);
    }, function () {
      if (self.open === row) self.itemMessage(MESSAGES.notSaved, 'warn');
    });
  };

  Folder.prototype._play = function (seconds) {
    var self = this;
    var row = this.open;
    var player = this.els.player;
    if (!row) return false;
    if (!row.audio_path) { this.itemMessage(MESSAGES.noAudio, 'warn'); return false; }
    if (this._audioFor === row.id && player.getAttribute('src')) {
      global.TranscriptView.playFrom(player, seconds);
      return true;
    }
    this.itemMessage(MESSAGES.gettingAudio);
    global.CloudDb.audioUrl(row.audio_path).then(function (url) {
      if (self.open !== row) return;
      self._audioFor = row.id;
      player.setAttribute('src', url);
      self.itemMessage('');
      global.TranscriptView.playFrom(player, seconds);
    }, function () {
      if (self.open === row) self.itemMessage(MESSAGES.cantPlay, 'warn');
    });
    return true;
  };

  // ---------- Moving the transcripts saved in this browser (once) ----------

  function moveAnswer() {
    try { return global.localStorage.getItem(MOVE_KEY); } catch (e) { return null; }
  }

  Folder.prototype._moveAnswered = function () {
    try { global.localStorage.setItem(MOVE_KEY, '1'); } catch (e) { /* asked again next time */ }
  };

  /** Finished transcripts saved in this browser before sign-in existed (TR Session C). */
  Folder.prototype._localTranscripts = function () {
    if (!this.localStore || !this.localStore.allJobs) return Promise.resolve([]);
    return this.localStore.allJobs().then(function (jobs) {
      return jobs.filter(function (j) { return j.done && Array.isArray(j.turns) && !j.cloudId && !j.userId; })
        .sort(function (a, b) { return (a.doneAt || a.updatedAt || 0) - (b.doneAt || b.updatedAt || 0); });
    }).catch(function () { return []; });
  };

  Folder.prototype._offerMove = function () {
    var self = this, els = this.els;
    els.moveBox.hidden = true;
    if (moveAnswer()) return Promise.resolve();
    var user = this.user;
    return this._localTranscripts().then(function (jobs) {
      if (self.user !== user || !user) return;
      if (!jobs.length) { self._moveAnswered(); return; }   // nothing to move on this device: never ask
      var n = jobs.length;
      els.moveText.textContent = 'This device has ' + n + (n === 1 ? ' transcript' : ' transcripts') +
        ' saved from before you signed in. Move ' + (n === 1 ? 'it' : 'them') + ' into My Transcripts, so ' +
        (n === 1 ? 'it is' : 'they are') + ' kept in the cloud and show on every device? (Their recordings were already deleted, so only the words move.)';
      els.moveYes.disabled = false;
      els.moveNo.disabled = false;
      els.moveStatus.textContent = '';
      els.moveBox.hidden = false;
    });
  };

  Folder.prototype._move = function () {
    var self = this, els = this.els;
    var user = this.user;
    els.moveYes.disabled = true;
    els.moveNo.disabled = true;
    els.moveStatus.dataset.kind = 'info';
    els.moveStatus.textContent = 'Moving…';
    var moved = 0;
    return this._localTranscripts().then(function (jobs) {
      return jobs.reduce(function (before, job, i) {
        return before.then(function () {
          if (self.user !== user) throw new Error('signed out');
          els.moveStatus.textContent = 'Moving ' + (i + 1) + ' of ' + jobs.length + '…';
          return global.CloudDb.save({
            title: job.name, fileName: job.name, duration: job.duration || job.resultDuration || 0,
            turns: job.turns, speakers: job.speakers || [], names: job.names || {},
            audioPath: null, jobId: job.jobId || null, fileKey: job.key,
            createdAt: job.doneAt || job.updatedAt || job.createdAt || null
          }).then(function (id) {
            job.cloudId = id;
            job.userId = user.id;
            job.cloudPending = false;
            moved++;
            return self.localStore.putJob(job);
          });
        });
      }, Promise.resolve());
    }).then(function () {
      self._moveAnswered();
      els.moveText.textContent = 'Moved ' + moved + (moved === 1 ? ' transcript' : ' transcripts') + ' into My Transcripts.';
      els.moveStatus.textContent = '';
      els.moveYes.hidden = true;
      els.moveNo.textContent = 'Close';
      els.moveNo.disabled = false;
      self.changed();
    }, function (err) {
      // Not finished (no internet?): the offer stays, and what was moved is not moved twice.
      els.moveYes.disabled = false;
      els.moveNo.disabled = false;
      els.moveStatus.dataset.kind = 'error';
      els.moveStatus.textContent = (moved ? moved + ' moved so far. ' : '') + 'The rest could not be moved. ' + problemText(err) + ' Then tap Move Them again.';
      if (moved) self.changed();
    });
  };

  global.Folder = Folder;
})(window);
