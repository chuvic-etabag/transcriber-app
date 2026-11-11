/*
 * app.js — Screen logic: signing in and out, the tabs (Live, File,
 * My Transcripts), the Live tab controls, and the shared output area (Copy,
 * Download, Clear, word count).
 *
 * Nothing works until someone signs in (auth.js): the sign-in screen is all
 * there is. The File tab and My Transcripts share one transcript view
 * (transcript-view.js), so an opened item looks and works exactly like a
 * fresh transcript.
 */
(function () {
  'use strict';

  var LIVE_LANGUAGE = 'en-US';   // English only
  var LIVE_TEXT_KEY = 'transcriber.liveTranscript';

  function $(id) { return document.getElementById(id); }

  var els = {
    tabs: Array.prototype.slice.call(document.querySelectorAll('[role="tab"]')),
    toggle: $('live-toggle'),
    toggleLabel: $('live-toggle-label'),
    status: $('live-status'),
    transcript: $('transcript'),
    fileOutput: $('file-output'),
    output: $('output'),
    savedNote: $('saved-note'),
    account: $('account'),
    accountEmail: $('account-email'),
    signOut: $('sign-out'),
    signInForm: $('sign-in-form'),
    signInEmail: $('sign-in-email'),
    signInButton: $('sign-in-button'),
    signInStatus: $('sign-in-status'),
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

  /** The text of the open tab's transcript (File and My Transcripts: in the view that is showing). */
  function outputText() {
    if (activeTab === 'file') return fileTab ? fileTab.text() : '';
    if (activeTab === 'folder') return folder ? folder.text() : '';
    return els.transcript.value;
  }

  /** Words, not counting timestamps like [1:05] or [1:02:05]. */
  function countWords(text) {
    var words = String(text || '').replace(/\[\d{1,2}(?::\d{2}){1,2}\]/g, ' ').match(/[^\s]+/g);
    return words ? words.length : 0;
  }

  function updateTools() {
    var text = outputText();
    var n = activeTab === 'file' && fileTab ? fileTab.wordCount()
      : activeTab === 'folder' && folder ? folder.wordCount() : countWords(text);
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

  var HEADINGS = { live: 'Live Transcript', file: 'File Transcript', folder: 'Saved Transcript' };
  var SAVED_NOTES = {
    live: 'The Live transcript is saved on this device, so a refresh will not lose it.',
    file: 'Finished transcripts are saved in My Transcripts, with their recordings, until you delete them there.',
    folder: 'Changes to speaker names and words are saved to My Transcripts.'
  };

  function showOutputFor(tab) {
    activeTab = tab;
    document.body.dataset.tab = tab;
    els.transcript.hidden = tab !== 'live';
    els.fileOutput.hidden = tab === 'live';
    // The File tab and My Transcripts share the transcript view: hand it to the one on screen.
    if (fileTab) fileTab.setActive(false);
    if (folder) folder.setActive(false);
    if (tab === 'file' && fileTab) fileTab.setActive(true);
    if (tab === 'folder' && folder) folder.setActive(true);
    els.heading.textContent = HEADINGS[tab];
    els.savedNote.textContent = SAVED_NOTES[tab];
    els.clear.hidden = tab === 'folder';     // a saved item is deleted with Delete, not cleared
    els.clearConfirm.hidden = true;
    showOrHideOutput();
    outputMessage('');
    updateTools();
  }

  /** In My Transcripts the transcript area only shows while an item is open. */
  function showOrHideOutput() {
    els.output.hidden = activeTab === 'folder' && !(folder && folder.open);
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
      var box = document.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.position = 'fixed';
      box.style.opacity = '0';
      document.body.appendChild(box);
      box.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      box.remove();
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  els.copy.addEventListener('click', function () {
    var text = outputText();
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
    if (activeTab !== 'live') {
      var name = (activeTab === 'folder' ? folder && folder.openName() : fileTab && fileTab.fileName()) || 'file';
      label = name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9À-ɏ_-]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 40) || 'file';
    }
    return 'transcript-' + label + '-' + stamp(new Date()) + '.txt';
  }
  els.download.addEventListener('click', function () {
    var text = outputText();
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
      if (fileTab) fileTab.cleared();
    } else {
      els.transcript.value = '';
      saveLiveNow();
    }
    updateTools();
    outputMessage('Cleared.');
  });

  els.transcript.addEventListener('input', function () { saveLiveSoon(); updateTools(); });

  // ---------- Tabs ----------

  function selectTab(tab, focus) {
    els.tabs.forEach(function (t) {
      var selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
    });
    showOutputFor(tab.id === 'tab-file' ? 'file' : tab.id === 'tab-folder' ? 'folder' : 'live');
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
      live.start(LIVE_LANGUAGE);
    }
  });

  showState('idle');

  // ---------- The transcript view, the File tab and My Transcripts ----------

  var fileTab = null;
  var folder = null;
  var view = new window.TranscriptView({
    transcript: $('file-transcript'),
    timestamps: $('file-timestamps'),
    fillers: $('file-fillers'),
    speakerList: $('speaker-list'),
    turnHint: $('turn-hint'),
    renameBox: $('rename-box'),
    renameLabel: $('rename-label'),
    renameInput: $('rename-input'),
    renameSave: $('rename-save'),
    renameCancel: $('rename-cancel')
  }, {
    onText: function () { updateTools(); },
    onMessage: function (text, kind) {
      if (activeTab === 'folder' && folder) folder.itemMessage(text, kind);
      else if (fileTab) fileTab.message(text, kind);
    }
  });

  fileTab = new window.FileTab({
    input: $('file-input'),
    choose: $('file-choose'),
    fileInfo: $('file-info'),
    fileName: $('file-name'),
    fileDetails: $('file-details'),
    player: $('file-player'),
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
    replaceNo: $('file-replace-no')
  }, {
    view: view,
    onText: function () { if (activeTab === 'file') updateTools(); },
    onBusy: function (busy) { fileBusy = busy; updateTools(); },
    onSaved: function () { if (folder) folder.changed(); }
  });

  folder = new window.Folder({
    listView: $('folder-list-view'),
    itemView: $('folder-item-view'),
    meterText: $('storage-text'),
    meterBar: $('storage-bar'),
    count: $('folder-count'),
    refresh: $('folder-refresh'),
    deleteAll: $('folder-delete-all'),
    deleteAllBox: $('delete-all-box'),
    deleteAllText: $('delete-all-text'),
    deleteAllInput: $('delete-all-input'),
    deleteAllYes: $('delete-all-yes'),
    deleteAllNo: $('delete-all-no'),
    status: $('folder-status'),
    list: $('folder-list'),
    back: $('item-back'),
    itemName: $('item-name'),
    itemMeta: $('item-meta'),
    player: $('item-player'),
    itemRename: $('item-rename'),
    itemDelete: $('item-delete'),
    itemRenameBox: $('item-rename-box'),
    itemRenameInput: $('item-rename-input'),
    itemRenameSave: $('item-rename-save'),
    itemRenameCancel: $('item-rename-cancel'),
    itemDeleteBox: $('item-delete-box'),
    itemDeleteText: $('item-delete-text'),
    itemDeleteYes: $('item-delete-yes'),
    itemDeleteNo: $('item-delete-no'),
    itemStatus: $('item-status'),
    moveBox: $('move-box'),
    moveText: $('move-text'),
    moveYes: $('move-yes'),
    moveNo: $('move-no'),
    moveStatus: $('move-status')
  }, {
    view: view,
    localStore: window.CloudStore,
    onText: function () { if (activeTab === 'folder') updateTools(); },
    onOpen: function () { showOrHideOutput(); outputMessage(''); updateTools(); },
    onChanged: function (id, fields) { fileTab.cloudChanged(id, fields); },
    onDeleted: function (ids) { fileTab.forget(ids); }
  });

  showOutputFor('live');

  // ---------- Signing in and out ----------

  var Auth = window.Auth;
  var shownUser;   // undefined until the first check is done

  function signInMessage(text, kind) {
    els.signInStatus.textContent = text || '';
    els.signInStatus.dataset.kind = kind || 'info';
  }

  /** Show the app to a signed-in person, or only the sign-in screen. */
  function applyAuth(user) {
    var id = user ? user.id : null;
    if (shownUser !== undefined && shownUser === id) return;
    var before = shownUser;
    shownUser = id;
    document.body.dataset.auth = user ? 'in' : 'out';
    els.account.hidden = !user;
    els.accountEmail.textContent = user ? user.email : '';
    if (user) {
      signInMessage('');
      els.signInEmail.value = '';
      fileTab.signedIn(user);
      folder.signedIn(user);
    } else {
      if (live.isActive()) live.stop();
      if (before) {
        // Signed out: nothing of that person's stays on screen.
        fileTab.signedOut();
        folder.signedOut();
        selectTab(els.tabs[0], false);
      }
    }
  }

  if (Auth) {
    Auth.onChange(applyAuth);
    Auth.ready.then(function (user) {
      applyAuth(user);
      if (!user && Auth.linkProblem) signInMessage(Auth.linkProblem, 'warn');
    });
  } else {
    document.body.dataset.auth = 'out';
    signInMessage('The app could not start. Check your internet connection and reload the page.', 'error');
    els.signInButton.disabled = true;
  }

  els.signInForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!Auth || els.signInButton.disabled) return;
    var email = els.signInEmail.value;
    els.signInButton.disabled = true;
    signInMessage('Sending your sign-in link…');
    Auth.signIn(email).then(function (sent) {
      signInMessage(Auth.MESSAGES.sent(sent.email), 'done');
    }, function (err) {
      var text = Auth.MESSAGES[err && err.code];
      signInMessage(typeof text === 'string' ? text : Auth.MESSAGES.failed, err && err.code === 'badEmail' ? 'warn' : 'error');
    }).then(function () { els.signInButton.disabled = false; });
  });

  els.signOut.addEventListener('click', function () {
    if (!Auth) return;
    els.signOut.disabled = true;
    Auth.signOut().then(function () {
      els.signOut.disabled = false;
      applyAuth(null);
      signInMessage('You are signed out on this device.');
    });
  });

  // Handy for testing in the browser console.
  window.transcriberApp = { live: live, file: fileTab, folder: folder, view: view, countWords: countWords, downloadName: downloadName };
})();
