/*
 * transcript-view.js — Shows one transcript as numbered speaker turns, the
 * same way wherever it comes from: a file just transcribed (file.js) or an
 * item opened from My Transcripts (folder.js).
 *
 * - Show Timestamps and Show Fillers change the view at once, without
 *   transcribing again. Copy and Download use view.textOf(doc), so they
 *   follow whichever view is showing.
 * - Tap a time to play from that moment, tap a speaker to rename them
 *   everywhere, tap the words to correct them.
 *
 * A "doc" is what the view shows:
 *   {
 *     turns, speakers, names,      // as built by transcript-format.js (names = renamed speakers)
 *     legacyText,                  // or plain text from the old on-device version
 *     changed(kind),               // called after an edit: 'text' | 'names' | 'legacy' (the owner saves)
 *     play(seconds)                // the owner plays the recording from that moment
 *   }
 * The view changes doc.turns[i].text and doc.names in place.
 *
 * Exposes window.TranscriptView.
 */
(function (global) {
  'use strict';

  var TF = global.TranscriptFormat;
  var SETTINGS_KEY = 'transcriber.cloudFileSettings';

  function loadJSON(key) {
    try { return JSON.parse(global.localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function saveJSON(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  function TranscriptView(els, hooks) {
    this.els = els;
    this.onText = (hooks && hooks.onText) || function () {};
    this.onMessage = (hooks && hooks.onMessage) || function () {};
    this.doc = null;
    this._renaming = null;
    var settings = loadJSON(SETTINGS_KEY);
    if (settings && typeof settings.timestamps === 'boolean') els.timestamps.checked = settings.timestamps;
    if (settings && typeof settings.fillers === 'boolean') els.fillers.checked = settings.fillers;
    this._bind();
  }

  TranscriptView.prototype._bind = function () {
    var self = this, els = this.els;
    function switched() {
      saveJSON(SETTINGS_KEY, { timestamps: els.timestamps.checked, fillers: els.fillers.checked });
      self.render();
    }
    els.timestamps.addEventListener('change', switched);
    els.fillers.addEventListener('change', switched);

    els.transcript.addEventListener('click', function (e) {
      var time = e.target.closest('.turn-time');
      if (time) { self._play(Number(time.dataset.start), time.closest('.turn')); return; }
      var speaker = e.target.closest('.turn-speaker');
      if (speaker) self.askRename(speaker.dataset.speaker);
    });
    els.transcript.addEventListener('input', function (e) {
      var doc = self.doc;
      if (!doc) return;
      var text = e.target.closest('.turn-text');
      if (text && doc.turns) {
        var turn = doc.turns[Number(text.dataset.index)];
        if (turn) turn.text = text.textContent.replace(/\s+/g, ' ').trim();
        if (doc.changed) doc.changed('text');
        self.onText();
      } else if (e.target.classList.contains('legacy-text')) {
        doc.legacyText = e.target.innerText;
        if (doc.changed) doc.changed('legacy');
        self.onText();
      }
    });
    els.transcript.addEventListener('keydown', function (e) {
      // Enter would start a new line inside a turn; finish editing instead.
      if (e.key === 'Enter' && e.target.closest('.turn-text')) { e.preventDefault(); e.target.blur(); }
    });
    els.speakerList.addEventListener('click', function (e) {
      var b = e.target.closest('[data-speaker]');
      if (b) self.askRename(b.dataset.speaker);
    });
    els.renameSave.addEventListener('click', function () { self._saveRename(); });
    els.renameCancel.addEventListener('click', function () { self.closeRename(); });
    els.renameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); self._saveRename(); }
      if (e.key === 'Escape') { e.preventDefault(); self.closeRename(); }
    });
  };

  TranscriptView.prototype.showTimes = function () { return this.els.timestamps.checked; };
  TranscriptView.prototype.showFillers = function () { return this.els.fillers.checked; };

  /** Show this transcript (or nothing, with null). */
  TranscriptView.prototype.setDoc = function (doc) {
    if (this.doc !== doc) this.closeRename();
    this.doc = doc || null;
    this.render();
  };

  /** A transcript as text, in the view that is showing (times and fillers on or off). */
  TranscriptView.prototype.textOf = function (doc) {
    if (!doc) return '';
    if (doc.turns) return TF.formatTranscript(doc.turns, doc.speakers || [], doc.names || {}, this.showTimes(), this.showFillers());
    return doc.legacyText || '';
  };

  /** Words in the view that is showing (not counting numbers, times or names). */
  TranscriptView.prototype.wordCountOf = function (doc) {
    if (!doc) return 0;
    if (doc.turns) return TF.countWords(TF.visibleTurns(doc.turns, this.showFillers()));
    var m = String(doc.legacyText || '').replace(/\[\d{1,2}(?::\d{2}){1,2}\]/g, ' ').match(/[^\s]+/g);
    return m ? m.length : 0;
  };

  TranscriptView.prototype.render = function () {
    var els = this.els;
    var box = els.transcript;
    var doc = this.doc;
    var showTimes = this.showTimes();
    box.textContent = '';
    els.speakerList.textContent = '';
    els.speakerList.hidden = true;
    els.turnHint.hidden = true;
    if (doc && doc.turns) {
      var speakers = doc.speakers || [];
      var names = doc.names || {};
      var shown = TF.visibleTurns(doc.turns, this.showFillers());
      var frag = document.createDocumentFragment();
      shown.forEach(function (t) {
        var p = document.createElement('p');
        p.className = 'turn' + (t.overlap ? ' is-overlap' : '');
        p.dataset.n = t.n;
        var n = document.createElement('span');
        n.className = 'turn-n';
        n.textContent = t.n + '. ';
        p.appendChild(n);
        if (showTimes) {
          var time = document.createElement('button');
          time.type = 'button';
          time.className = 'turn-time';
          time.dataset.start = t.start;
          time.textContent = TF.range(t);
          time.setAttribute('aria-label', 'Play from ' + TF.clock(t.start));
          p.appendChild(time);
          p.appendChild(document.createTextNode(' '));
        }
        var who = document.createElement('button');
        who.type = 'button';
        who.className = 'turn-speaker';
        who.dataset.speaker = t.speaker;
        who.textContent = TF.nameOf(t.speaker, speakers, names);
        p.appendChild(who);
        if (t.overlap) {
          p.appendChild(document.createTextNode(' '));
          var o = document.createElement('span');
          o.className = 'turn-overlap';
          o.textContent = '(overlap)';
          p.appendChild(o);
        }
        p.appendChild(document.createTextNode(': '));
        var text = document.createElement('span');
        text.className = 'turn-text';
        text.dataset.index = t.index;
        text.contentEditable = 'plaintext-only';
        if (text.contentEditable !== 'plaintext-only') text.contentEditable = 'true';
        text.spellcheck = true;
        text.textContent = t.text;
        p.appendChild(text);
        frag.appendChild(p);
      });
      box.appendChild(frag);
      this._renderSpeakers();
      els.turnHint.hidden = !shown.length;
    } else if (doc && doc.legacyText) {
      var pre = document.createElement('p');
      pre.className = 'legacy-text';
      pre.contentEditable = 'plaintext-only';
      if (pre.contentEditable !== 'plaintext-only') pre.contentEditable = 'true';
      pre.textContent = doc.legacyText;
      box.appendChild(pre);
    }
    this.onText();
  };

  TranscriptView.prototype._renderSpeakers = function () {
    var doc = this.doc;
    var list = this.els.speakerList;
    var speakers = (doc && doc.speakers) || [];
    list.textContent = '';
    speakers.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'small-button';
      b.dataset.speaker = s;
      b.textContent = 'Rename ' + TF.nameOf(s, speakers, doc.names || {});
      list.appendChild(b);
    });
    list.hidden = !speakers.length;
  };

  // ---------- Renaming speakers ----------

  TranscriptView.prototype.askRename = function (speaker) {
    var doc = this.doc;
    if (!doc || !doc.turns) return;
    var speakers = doc.speakers || [];
    var current = TF.nameOf(speaker, speakers, doc.names || {});
    var number = TF.defaultNames(speakers)[speaker] || current;
    this._renaming = speaker;
    this.els.renameLabel.textContent = 'New Name for ' + number + (current !== number ? ' (Now “' + current + '”)' : '');
    this.els.renameInput.value = current === number ? '' : current;
    this.els.renameInput.placeholder = number;
    this.els.renameBox.hidden = false;
    this.els.renameInput.focus();
  };

  TranscriptView.prototype.closeRename = function () {
    this.els.renameBox.hidden = true;
    this._renaming = null;
  };

  /** Rename one speaker: every turn by them changes. An empty name goes back to "Speaker N". */
  TranscriptView.prototype.rename = function (speaker, name) {
    var doc = this.doc;
    if (!doc || !doc.turns) return;
    var clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    doc.names = doc.names || {};
    if (clean) doc.names[speaker] = clean;
    else delete doc.names[speaker];
    if (doc.changed) doc.changed('names');
    this.render();
  };

  TranscriptView.prototype._saveRename = function () {
    if (!this._renaming || !this.doc) return;
    var speaker = this._renaming;
    var value = this.els.renameInput.value;
    this.closeRename();
    this.rename(speaker, value);
    var label = TF.nameOf(speaker, this.doc.speakers || [], this.doc.names || {});
    this.onMessage('Renamed. Every turn by this speaker now says “' + label + '”.', 'done');
  };

  // ---------- Playing from a time ----------

  TranscriptView.prototype._play = function (seconds, turnEl) {
    var doc = this.doc;
    if (!doc || !doc.play) return;
    var playing = this.els.transcript.querySelector('.turn.is-playing');
    if (playing) playing.classList.remove('is-playing');
    if (doc.play(seconds) !== false && turnEl) turnEl.classList.add('is-playing');
  };

  /**
   * Play an <audio> element from a moment (shared by the File tab and My Transcripts).
   */
  TranscriptView.playFrom = function (player, seconds) {
    player.hidden = false;
    var go = function () {
      try { player.currentTime = Math.max(0, seconds); } catch (e) { /* not ready yet */ }
      var played = player.play();
      if (played && played.catch) played.catch(function () { /* the person can press play */ });
    };
    if (player.readyState >= 1) go();
    else player.addEventListener('loadedmetadata', go, { once: true });
  };

  global.TranscriptView = TranscriptView;
})(window);
