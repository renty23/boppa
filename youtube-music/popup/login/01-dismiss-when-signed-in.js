// ==UserScript==
// @name         Login popup: dismiss once signed in
// @run-at       document-start
// ==/UserScript==
//
// Google's sign-in flow ends by redirecting back to YouTube. Once the page we
// land on is YouTube and reports a signed-in session, close the popup so the
// resolve that opened it can continue; the user never has to find a close
// button. Any other page (the Google login form itself, a 2FA prompt, an error)
// stays open until the user finishes or dismisses it manually.
(function() {
  'use strict';
  if (window !== window.top) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  function signedIn() {
    var data = window.ytcfg && window.ytcfg.data_;
    if (data && data.LOGGED_IN === true) return true;
    return /(^|; )(__Secure-3PAPISID|SAPISID)=/.test(document.cookie);
  }

  var attempts = 0;
  function check() {
    if (signedIn() && typeof window.boppa.dismissPopup === 'function') {
      window.boppa.dismissPopup();
      return;
    }
    if (++attempts < 40) setTimeout(check, 250);  // up to ~10 s for ytcfg to appear
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
})();
