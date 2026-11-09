/*
 * app.js — Screen logic: tabs, the Live tab controls, and the transcript box.
 */
(function () {
  'use strict';

  var LANGUAGE_KEY = 'transcriber.liveLanguage';

  var els = {
    tabs: Array.prototype.slice.call(document.querySelectorAll('[role="tab"]')),
    language: document.getElementById('live-language'),
    toggle: document.getElementById('live-toggle'),
    toggleLabel: document.getElementById('live-toggle-label'),
    status: document.getElementById('live-status'),
    transcript: document.getElementById('transcript'),
    interim: document.getElementById('interim'),
    interimBox: document.querySelector('.interim-box')
  };

  // ---------- Tabs ----------

  function selectTab(tab, focus) {
    els.tabs.forEach(function (t) {
      var selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
    });
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

  // ---------- Transcript ----------

  function appendText(text) {
    var box = els.transcript;
    var current = box.value;
    var joiner = current && !/\s$/.test(current) ? ' ' : '';
    box.value = current + joiner + text;
    box.scrollTop = box.scrollHeight;
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

  // Handy for testing in the browser console.
  window.transcriberApp = { live: live };
})();
