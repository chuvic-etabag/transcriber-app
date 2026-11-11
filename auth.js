/*
 * auth.js — Signing in with an email link (Supabase Auth, no passwords).
 *
 * - Only emails on the allowed list (supabase/setup_2.sql) can sign in.
 *   Anyone else is told "This app isn't open to new users yet."
 * - The sign-in is kept on this device (and renewed by itself) until Sign Out.
 *
 *   Auth.ready                 a promise for the signed-in person ({ id, email }) or null
 *   Auth.user()                the signed-in person or null
 *   Auth.token()               a promise for their current sign-in token (or null)
 *   Auth.signIn(email)         sends the sign-in link; fails with a code (see MESSAGES)
 *   Auth.signOut()             signs out on this device
 *   Auth.onChange(fn)          fn(user) whenever someone signs in or out
 *   Auth.client                the Supabase client (used by cloud-db.js)
 *   Auth.linkProblem           why the sign-in link that opened this page did not work, if so
 *
 * Exposes window.Auth.
 */
(function (global) {
  'use strict';

  var config = global.CLOUD_CONFIG;

  var MESSAGES = {
    notAllowed: 'This app isn’t open to new users yet.',
    badEmail: 'Please type your email address, like name@example.com.',
    offline: 'No internet connection. Connect to the internet and try again.',
    network: 'Could not reach the sign-in service. Check your internet connection and try again.',
    rate: 'Too many sign-in emails were asked for. Please wait a few minutes (up to an hour), then try again.',
    notSetUp: 'Sign-in is not set up yet. Please try again later.',
    failed: 'The sign-in email could not be sent. Please try again in a minute.',
    linkExpired: 'That sign-in link has expired or was already used. Type your email below to get a new one.',
    sent: function (email) {
      return 'Check your email. A sign-in link was sent to ' + email +
        '. Open it on this device, in Chrome. It can take a minute to arrive; look in Spam too.';
    }
  };

  function AuthError(code, detail) {
    var e = new Error(detail || code);
    e.code = code;
    return e;
  }

  // A sign-in link that no longer works comes back as #error=...&error_description=...
  var linkProblem = null;
  (function readLinkError() {
    var hash = String(global.location.hash || '').replace(/^#/, '');
    if (!/(^|&)error(_code|_description)?=/.test(hash)) return;
    linkProblem = MESSAGES.linkExpired;
    try { global.history.replaceState(null, '', global.location.pathname + global.location.search); } catch (e) { /* keep the address */ }
  })();

  var client = global.supabase.createClient(config.supabaseUrl, config.publishableKey, {
    auth: {
      persistSession: true,       // stay signed in on this device
      autoRefreshToken: true,     // renew the sign-in by itself
      detectSessionInUrl: true,   // finish the sign-in when the email link opens this page
      flowType: 'implicit'        // the link works in whichever browser opens it
    }
  });

  var current = null;
  var listeners = [];

  function personOf(session) {
    var u = session && session.user;
    return u && u.id ? { id: u.id, email: u.email || '' } : null;
  }

  function update(session) {
    var next = personOf(session);
    var changed = (next && next.id) !== (current && current.id);
    current = next;
    if (changed) listeners.slice().forEach(function (fn) { fn(current); });
  }

  var ready = client.auth.getSession().then(function (res) {
    update(res && res.data && res.data.session);
    return current;
  }, function () { return current; });

  client.auth.onAuthStateChange(function (event, session) {
    // Later, so nothing here runs inside the library's own sign-in step.
    setTimeout(function () { ready.then(function () { update(session); }); }, 0);
  });

  function token() {
    return client.auth.getSession().then(function (res) {
      var s = res && res.data && res.data.session;
      return s ? s.access_token : null;
    }, function () { return null; });
  }

  /** The address the email link comes back to: this page, without "index.html". */
  function returnAddress() {
    return global.location.origin + global.location.pathname.replace(/index\.html$/, '');
  }

  function isNetworkError(error) {
    return !error.status && /fetch|network|load failed/i.test(String(error.message || ''));
  }

  function signIn(email) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Promise.reject(AuthError('badEmail'));
    if (global.navigator.onLine === false) return Promise.reject(AuthError('offline'));
    // Ask first, so someone who is not on the list gets a plain answer instead of an email.
    return client.rpc('transcriber_email_allowed', { p_email: email }).then(function (res) {
      if (res.error) {
        if (isNetworkError(res.error)) throw AuthError(global.navigator.onLine === false ? 'offline' : 'network', res.error.message);
        throw AuthError('notSetUp', res.error.message);
      }
      if (res.data !== true) throw AuthError('notAllowed');
      return client.auth.signInWithOtp({ email: email, options: { emailRedirectTo: returnAddress(), shouldCreateUser: true } });
    }).then(function (res) {
      var error = res && res.error;
      if (!error) return { email: email };
      var text = String(error.message || '') + ' ' + String(error.code || '');
      if (error.status === 429 || /rate.?limit/i.test(text)) throw AuthError('rate', text);
      // The database refuses to make an account for an email that is not on the list.
      if (/Database error saving new user|not open to new users|signup.?(s)?.?(disabled|not allowed)|otp_disabled/i.test(text)) throw AuthError('notAllowed', text);
      if (isNetworkError(error)) throw AuthError(global.navigator.onLine === false ? 'offline' : 'network', text);
      throw AuthError('failed', text);
    });
  }

  function signOut() {
    // "local": this device only. Other devices stay signed in until Sign Out is tapped there.
    return client.auth.signOut({ scope: 'local' }).then(function () { update(null); }, function () { update(null); });
  }

  global.Auth = {
    MESSAGES: MESSAGES,
    ready: ready,
    client: client,
    linkProblem: linkProblem,
    user: function () { return current; },
    token: token,
    signIn: signIn,
    signOut: signOut,
    onChange: function (fn) { listeners.push(fn); }
  };
})(window);
