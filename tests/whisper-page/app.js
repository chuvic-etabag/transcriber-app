/*
 * TEST PAGE ONLY: a copy of app.js as it was in TR Session B, so the hidden
 * Whisper File tab (whisper-file.js) can still be tested. Not used by the app.
 *
 * app.js — Screen logic: tabs, the Live tab controls, the File tab, and the
 * shared output area (Copy, Download, Clear, word count) for both tabs.
 */
(function () {
  'use strict';

  var LANGUAGE_KEY = 'transcriber.liveLanguage';
  var LIVE_TEXT_KEY = 'transcriber.liveTranscript';

  function $(id) { return document.getElementById(id); }

  var els = {
    tabs: Array.prototype.slice.call(document.querySelectorAll('[role="tab"]')),
    language: $('live-language'),
    toggle: $('live-toggle'),
    toggleLabel: $('live-toggle-label'),
    status: $('live-status'),
    transcript: $('transcript'),
    fileTranscript: $('file-transcript'),
    interim: $('interim'),
    interimBox: document.querySelector('.interim-box'),
    heading: $('output-heading'),
    wordCount: $('word-count'),
    copy: $('copy-button'),
    download: $('download-button'),
    clear: $('clear-button'),
    clearConfirm: $('clear-confirm'),
    clearText: $('clear-confirm-text'),
    clearYes: $('clear-yes'),
    clearNo: $('clear-no'),
    outputStatus: $('output-status')
  };

  // ---------- Saving text in the browser ----------

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* storage full or blocked */ }
  }
  function load(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  var saveTimer = null;
  function saveLiveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLiveNow, 300);
  }
  function saveLiveNow() {
    clearTimeout(saveTimer);
    store(LIVE_TEXT_KEY, els.transcript.value);
  }
  window.addEventListener('pagehide', saveLiveNow);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveLiveNow();
  });

  // ---------- Output area: whichever transcript belongs to the open tab ----------

  var activeTab = 'live';
  var fileBusy = false;

  function activeBox() {
    return activeTab === 'file' ? els.fileTranscript : els.transcript;
  }

  /** Words, not counting timestamps like [1:05] or [1:02:05]. */
  function countWords(text) {
    var words = String(text || '').replace(/\[\d{1,2}(?::\d{2}){1,2}\]/g, ' ').match(/[^\s]+/g);
    return words ? words.length : 0;
  }

  function updateTools() {
    var text = activeBox().value;
    var n = countWords(text);
    els.wordCount.textContent = n + (n === 1 ? ' Word' : ' Words');
    var empty = !text.trim();
    els.copy.disabled = empty;
    els.download.disabled = empty;
    els.clear.disabled = empty || (activeTab === 'file' && fileBusy);
    if (els.clear.disabled) els.clearConfirm.hidden = true;
  }

  function outputMessage(text, kind) {
    els.outputStatus.textContent = text;
    els.outputStatus.dataset.kind = kind || 'info';
  }

  function showOutputFor(tab) {
    activeTab = tab;
    document.body.dataset.tab = tab;
    els.transcript.hidden = tab !== 'live';
    els.fileTranscript.hidden = tab !== 'file';
    els.heading.textContent = tab === 'file' ? 'File Transcript' : 'Live Transcript';
    els.clearConfirm.hidden = true;
    outputMessage('');
    updateTools();
  }

  // Copy
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }
  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var box = activeBox();
      var start = box.selectionStart, end = box.selectionEnd;
      box.focus();
      box.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      box.setSelectionRange(start, end);
      if (ok) resolve(); else reject(new Error('copy failed'));
      void text;
    });
  }

  els.copy.addEventListener('click', function () {
    var text = activeBox().value;
    if (!text.trim()) return;
    copyText(text).then(function () {
      outputMessage('Copied. You can now paste it into another app.', 'done');
    }, function () {
      outputMessage('Could not copy automatically. Press and hold in the transcript, tap Select All, then Copy.', 'error');
    });
  });

  // Download as a .txt file named with the date and time
  function stamp(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + '-' + p(d.getMinutes());
  }
  function downloadName() {
    var label = 'live';
    if (activeTab === 'file') {
      var name = fileTab && fileTab.file ? fileTab.file.name : (fileTab && fileTab._restoredName) || 'file';
      label = name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9À-ɏ_-]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 40) || 'file';
    }
    return 'transcript-' + label + '-' + stamp(new Date()) + '.txt';
  }
  els.download.addEventListener('click', function () {
    var text = activeBox().value;
    if (!text.trim()) return;
    var blob = new Blob([text.replace(/\r?\n/g, '\r\n') + '\r\n'], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = downloadName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    outputMessage('Saved as ' + a.download + '. Look in your Downloads folder.', 'done');
  });

  // Clear, with a confirm step
  els.clear.addEventListener('click', function () {
    if (els.clear.disabled) return;
    els.clearText.textContent = 'Clear the whole ' + (activeTab === 'file' ? 'File' : 'Live') +
      ' transcript? This cannot be undone. Copy or download it first if you need it.';
    els.clearConfirm.hidden = false;
    outputMessage('');
    els.clearNo.focus();
  });
  els.clearNo.addEventListener('click', function () {
    els.clearConfirm.hidden = true;
    els.clear.focus();
  });
  els.clearYes.addEventListener('click', function () {
    els.clearConfirm.hidden = true;
    if (activeTab === 'file') {
      els.fileTranscript.value = '';
      if (fileTab) fileTab.cleared();
    } else {
      els.transcript.value = '';
      saveLiveNow();
    }
    updateTools();
    outputMessage('Cleared.');
  });

  els.transcript.addEventListener('input', function () { saveLiveSoon(); updateTools(); });
  els.fileTranscript.addEventListener('input', updateTools);

  // ---------- Tabs ----------

  function selectTab(tab, focus) {
    els.tabs.forEach(function (t) {
      var selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
    });
    showOutputFor(tab.id === 'tab-file' ? 'file' : 'live');
    if (focus) tab.focus();
  }

  els.tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { selectTab(tab, false); });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = els.tabs[(index + 1) % els.tabs.length];
      if (e.key === 'ArrowLeft') next = els.tabs[(index - 1 + els.tabs.length) % els.tabs.length];
      if (next) { e.preventDefault(); selectTab(next, true); }
    });
  });

  // ---------- Language (remembered on this phone) ----------

  try {
    var saved = localStorage.getItem(LANGUAGE_KEY);
    if (saved && els.language.querySelector('option[value="' + saved + '"]')) {
      els.language.value = saved;
    }
  } catch (e) { /* storage blocked; use the default */ }

  els.language.addEventListener('change', function () {
    try { localStorage.setItem(LANGUAGE_KEY, els.language.value); } catch (e) { /* ignore */ }
  });

  // ---------- Live transcript ----------

  var savedLive = load(LIVE_TEXT_KEY);
  if (savedLive) els.transcript.value = savedLive;

  function appendText(text) {
    var box = els.transcript;
    var current = box.value;
    var joiner = current && !/\s$/.test(current) ? ' ' : '';
    box.value = current + joiner + text;
    box.scrollTop = box.scrollHeight;
    saveLiveSoon();
    if (activeTab === 'live') updateTools();
  }

  function showInterim(text) {
    els.interim.textContent = text;
    els.interimBox.classList.toggle('has-text', Boolean(text));
  }

  // ---------- Live tab ----------

  function showMessage(text, kind) {
    els.status.textContent = text;
    els.status.dataset.kind = kind || 'info';
  }

  function showState(state) {
    var active = state !== 'idle';
    document.body.dataset.liveState = state;
    els.toggle.setAttribute('aria-pressed', String(active));
    els.toggle.classList.toggle('is-active', active);
    els.toggleLabel.textContent = active ? 'Stop Listening' : 'Start Listening';
    els.language.disabled = active;
  }

  var live = new window.LiveTranscriber({
    onFinal: appendText,
    onInterim: showInterim,
    onState: showState,
    onMessage: showMessage
  });

  if (!window.LiveTranscriber.isSupported()) {
    showMessage(window.LiveTranscriber.MESSAGES.unsupported, 'error');
    els.toggle.disabled = true;
  }

  els.toggle.addEventListener('click', function () {
    if (live.isActive()) {
      live.stop();
    } else {
      live.start(els.language.value);
    }
  });

  showState('idle');

  // ---------- File tab ----------

  var fileTab = null;
  if (window.FileTab) {
    fileTab = new window.FileTab({
      input: $('file-input'),
      choose: $('file-choose'),
      fileInfo: $('file-info'),
      fileName: $('file-name'),
      fileDetails: $('file-details'),
      language: $('file-language'),
      speed: $('file-speed'),
      speedHint: $('speed-hint'),
      timestamps: $('file-timestamps'),
      modelNote: $('model-note'),
      start: $('file-start'),
      startLabel: $('file-start-label'),
      cancel: $('file-cancel'),
      progressBox: $('file-progress-box'),
      progress: $('file-progress'),
      percent: $('file-percent'),
      status: $('file-status'),
      resumeBox: $('file-resume'),
      resumeText: $('file-resume-text'),
      startOver: $('file-start-over'),
      replaceBox: $('file-replace'),
      replaceText: $('file-replace-text'),
      replaceYes: $('file-replace-yes'),
      replaceNo: $('file-replace-no'),
      transcript: els.fileTranscript
    }, {
      onText: function () { if (activeTab === 'file') updateTools(); },
      onBusy: function (busy) { fileBusy = busy; updateTools(); }
    });
  }

  showOutputFor('live');

  // Handy for testing in the browser console.
  window.transcriberApp = { live: live, file: fileTab, countWords: countWords, downloadName: downloadName };
})();
