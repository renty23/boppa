// ==UserScript==
// @name         Extract Client ID
// @run-at       document-start
// ==/UserScript==

// Answers clientId() with the API client id the data scripts and playback
// container need.
//
// This is a worker rather than container code because the client id lives in the
// page's own script bundles, which have to be fetched as the site's own origin.
// The playback container starts this worker, asks once, and stops it again: there
// is nothing to keep warm between refreshes.
//
// The page is robots.txt, not the app, and the home page is read as text over
// fetch to find its script assets. The client id lives in the app config block at
// the very top of the bundle, so each asset is probed with a ranged read instead
// of downloading ~3 MB of JavaScript. Loading the app instead pulled every bundle,
// the feed's artwork and its audio, and left it all in WebKit's HTTP cache.

(function() {
  'use strict';

  var HOME = 'https://soundcloud.com/';
  var PROBE_BYTES = 16384;
  var CLIENT_ID = /client_id\s*:\s*"([0-9a-zA-Z]{32})"/;

  // The host does not forward this page's console to the app log, so lines are
  // also kept for the container, which asks for them with `logs` after every
  // call it makes (container/40-workers.js). Uncaught errors are kept too.
  var LOG_LIMIT = 200;
  var logLines = window.__boppaLogLines || (window.__boppaLogLines = []);
  function keepLog(line) {
    logLines.push(line);
    if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
  }
  if (!window.__boppaLogsHandled) {
    window.__boppaLogsHandled = true;
    window.boppa.onRequest('logs', function() { return logLines.splice(0, logLines.length); });
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('error', function(event) {
        keepLog('[page] uncaught error: ' + (event && event.message));
      });
      window.addEventListener('unhandledrejection', function(event) {
        var reason = event && event.reason;
        keepLog('[page] unhandled rejection: ' + ((reason && reason.message) || reason));
      });
    }
  }

  function log() {
    var line = '[sc-credentials] ' + Array.prototype.slice.call(arguments).join(' ');
    try { console.log(line); } catch (e) {}
    keepLog(line);
  }

  // Reversed: the client id lives in the last bundle the page loads.
  function assetUrls(markup) {
    var urls = [];
    var pattern = /<script[^>]+src="([^"]+)"/g;
    var match;
    while ((match = pattern.exec(markup))) urls.push(match[1]);
    return urls.reverse();
  }

  function probe(url) {
    return fetch(url, { headers: { Range: 'bytes=0-' + (PROBE_BYTES - 1) } })
      .then(function(response) {
        if (!response.ok && response.status !== 206) return null;
        return response.text();
      })
      .then(function(text) {
        var match = text && text.match(CLIENT_ID);
        return match ? match[1] : null;
      })
      .catch(function() {
        return null;
      });
  }

  function findClientId(urls, index) {
    if (index >= urls.length) return Promise.resolve(null);
    return probe(urls[index]).then(function(clientId) {
      return clientId || findClientId(urls, index + 1);
    });
  }

  window.boppa.onRequest('clientId', function() {
    var started = Date.now();
    log('clientId: fetching the home page');
    return fetch(HOME, { credentials: 'include' })
      .then(function(response) {
        log('clientId: home page status', response.status, 'in', (Date.now() - started) + 'ms');
        if (!response.ok) throw new Error('home page returned ' + response.status);
        return response.text();
      })
      .then(function(markup) {
        var urls = assetUrls(markup);
        log('clientId: probing', urls.length, 'script assets');
        return findClientId(urls, 0);
      })
      .then(function(clientId) {
        if (!clientId) throw new Error('no client id in any script asset');
        log('clientId: found in', (Date.now() - started) + 'ms');
        return clientId;
      }, function(e) {
        log('clientId: FAILED after', (Date.now() - started) + 'ms:', (e && e.message) || e);
        throw e;
      });
  });

  window.boppa.workerReady();
  log('worker ready');
})();
