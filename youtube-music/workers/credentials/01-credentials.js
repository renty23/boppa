// ==UserScript==
// @name         YouTube Music InnerTube Credentials
// @run-at       document-start
// ==/UserScript==
(function() {
  'use strict';
  if (window !== window.top) return;

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
    var line = '[ytm-credentials] ' + Array.prototype.slice.call(arguments).join(' ');
    try { console.log(line); } catch (e) {}
    keepLog(line);
  }

  function readConfig() {
    var data = window.ytcfg && window.ytcfg.data_;
    if (data && data.INNERTUBE_API_KEY && data.INNERTUBE_CLIENT_VERSION) {
      log('credentials: read from this page\'s ytcfg');
      return Promise.resolve({
        apiKey: data.INNERTUBE_API_KEY,
        clientVersion: data.INNERTUBE_CLIENT_VERSION,
        visitorData: data.VISITOR_DATA || ''
      });
    }
    var started = Date.now();
    log('credentials: fetching the homepage');
    return fetch('https://music.youtube.com/', { credentials: 'include' })
      .then(function(r) {
        log('credentials: homepage status', r.status, 'in', (Date.now() - started) + 'ms');
        return r.text();
      })
      .then(function(html) {
        var apiKey = (html.match(/INNERTUBE_API_KEY["']:\s*["']([^"']+)["']/) || [])[1];
        var clientVersion = (html.match(/INNERTUBE_CLIENT_VERSION["']:\s*["']([^"']+)["']/) || [])[1];
        var visitorData = (html.match(/VISITOR_DATA["']:\s*["']([^"']+)["']/) || [])[1];
        if (!apiKey || !clientVersion) throw new Error('could not read music.youtube.com InnerTube config');
        return { apiKey: apiKey, clientVersion: clientVersion, visitorData: visitorData || '' };
      });
  }

  window.boppa.onRequest('credentials', async function() {
    var cfg;
    try {
      cfg = await readConfig();
    } catch (e) {
      log('credentials: FAILED:', (e && e.message) || e);
      throw e;
    }
    var values = {
      YOUTUBE_MUSIC_API_KEY: cfg.apiKey,
      YOUTUBE_MUSIC_CLIENT_VERSION: cfg.clientVersion
    };
    if (cfg.visitorData) values.YOUTUBE_MUSIC_VISITOR_DATA = cfg.visitorData;
    log('credentials: read; visitor id', cfg.visitorData ? 'present' : 'MISSING');
    return values;
  });

  function start() {
    window.boppa.workerReady();
    log('worker ready');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
