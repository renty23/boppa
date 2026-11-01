// ==UserScript==
// @name         YouTube Music WEB_REMIX player + WebPoClient
// @run-at       document-start
// ==/UserScript==
//
// WEB_REMIX backend. Runs the real music.youtube.com shell as desktop Safari in
// the source's own data store (so it sees the user's session), and owns:
// `credentials` (the page's InnerTube config), `session` (SAPISID cookie),
// `player` (WEB_REMIX /player, signed with SAPISIDHASH when asked), `mint`
// (YouTube's WebPoClient.mws, bound to the video id) and `probe`.
//
// Why WEB_REMIX rather than MWEB: for the same video, WEB_REMIX issues per-itag
// URLs with the short `spc` (67) that GVS accepts the moment /player returns,
// while MWEB's long-`spc` (94) URLs sit in a ~11 s activation window. Both need
// player-JS solving and a per-video PO token; measured 2026-10-05, head and
// tail probes 200 at t+1.2 s with a video-bound token, tail 403 without one.
(function() {
  'use strict';
  if (window !== window.top) return;

  // Context prefix for the credentials this worker publishes.
  var CONTEXT_PREFIX = 'YOUTUBE_REMIX';
  var CLIENT_NAME = 'WEB_REMIX';
  var CLIENT_ID = '67';
  var WPC_ROOT = 'havuokmhhs-0';
  var WPC_OBJECT = 'bevasrs';

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
    var line = '[webpo] ' + Array.prototype.slice.call(arguments).join(' ');
    try { console.log(line); } catch (e) {}
    keepLog(line);
  }

  // The SAPISID cookie is the session: Google sets it on sign-in (JS-visible by
  // design, YouTube's own page reads it for SAPISIDHASH) and clears it on
  // sign-out. The login popup writes into this WebView's jar.
  function sapisid() {
    var m = String(document.cookie || '').match(/(?:^|; )(?:__Secure-3PAPISID|SAPISID)=([^;]+)/);
    return m ? m[1] : null;
  }

  function configFromPage() {
    var data = window.ytcfg && window.ytcfg.data_;
    if (data && data.INNERTUBE_API_KEY && data.INNERTUBE_CLIENT_VERSION) {
      return {
        apiKey: data.INNERTUBE_API_KEY,
        clientVersion: data.INNERTUBE_CLIENT_VERSION,
        visitorData: data.VISITOR_DATA || '',
        playerJsUrl: data.PLAYER_JS_URL || playerPathFromHtml(document.documentElement ? document.documentElement.outerHTML : '') || '',
        signatureTimestamp: data.STS || 20725,
        loggedIn: data.LOGGED_IN === true,
        sessionIndex: String(data.SESSION_INDEX || '0'),
        delegatedSessionId: data.DELEGATED_SESSION_ID || null
      };
    }
    return null;
  }

  // music.youtube.com's shell does not publish PLAYER_JS_URL; the build id is
  // still in the HTML as a /s/player/<id>/... script reference.
  function playerPathFromHtml(html) {
    var m = String(html).match(/\/s\/player\/([a-zA-Z0-9_-]+)\/[a-z_0-9.-]+\/[a-zA-Z_]+\/base\.js/);
    return m ? '/s/player/' + m[1] + '/player_ias.vflset/en_US/base.js' : '';
  }

  function configFromHtml(html) {
    function pick(name) { return (html.match(new RegExp(name + '["\']:\\s*["\']([^"\']+)["\']')) || [])[1]; }
    var apiKey = pick('INNERTUBE_API_KEY');
    var clientVersion = pick('INNERTUBE_CLIENT_VERSION');
    if (!apiKey || !clientVersion) throw new Error('could not read ' + location.host + ' InnerTube config');
    var sts = (html.match(/"STS":(\d+)/) || [])[1];
    return {
      apiKey: apiKey,
      clientVersion: clientVersion,
      visitorData: pick('VISITOR_DATA') || '',
      playerJsUrl: pick('PLAYER_JS_URL') || playerPathFromHtml(html) || '',
      signatureTimestamp: sts ? parseInt(sts, 10) : 20725,
      loggedIn: /"LOGGED_IN":true/.test(html),
      sessionIndex: String(pick('SESSION_INDEX') || (html.match(/"SESSION_INDEX":(\d+)/) || [])[1] || '0'),
      delegatedSessionId: pick('DELEGATED_SESSION_ID') || null
    };
  }

  // Config re-read over the current cookies, valid for one session state.
  // Single-flighted: concurrent callers share one homepage download.
  var refreshedConfig = null;
  var refreshingConfig = null;

  // The page's ytcfg is authoritative only while it agrees with the cookie
  // jar. After a popup sign-in (or a sign-out) this page is stale: its
  // LOGGED_IN, SESSION_INDEX, DELEGATED_SESSION_ID and VISITOR_DATA belong to
  // the previous session. Rather than reload the worker page, re-read the
  // homepage config once per session state.
  async function readConfig() {
    var sessionKey = sapisid() || '';
    var current = configFromPage();
    if (current && current.loggedIn === !!sessionKey) return current;
    if (refreshedConfig && refreshedConfig.sessionKey === sessionKey) return refreshedConfig.cfg;
    if (refreshingConfig && refreshingConfig.sessionKey === sessionKey) return refreshingConfig.promise;
    var promise = fetch('/', { credentials: 'include' })
      .then(function(r) { return r.text(); })
      .then(function(html) {
        var cfg = configFromHtml(html);
        refreshedConfig = { sessionKey: sessionKey, cfg: cfg };
        log('readConfig: re-read page config for', sessionKey ? 'signed-in' : 'anonymous', 'session');
        return cfg;
      })
      .finally(function() {
        if (refreshingConfig && refreshingConfig.promise === promise) refreshingConfig = null;
      });
    refreshingConfig = { sessionKey: sessionKey, promise: promise };
    return promise;
  }

  function webPoClientFactory() {
    var top = window.top;
    var keys;
    try { keys = Object.keys(top); } catch (e) { return null; }
    // Fast path: the namespace root is `havuokmhhs-<n>`. The suffix was 0 for a
    // long time and became a per-build timestamp with player f2999a12
    // (havuokmhhs-1791400627882), so match the prefix rather than a literal.
    var rootPrefix = WPC_ROOT.replace(/-\d*$/, '-');
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(rootPrefix) !== 0) continue;
      try {
        var fast = top[keys[i]]?.[WPC_OBJECT]?.wpc;
        if (typeof fast === 'function') return fast;
      } catch (e) {}
    }
    // The player also exposes the factory directly on its own namespace.
    try {
      var direct = top._yt_player?.wpc;
      if (typeof direct === 'function') return direct;
    } catch (e) {}
    // Last resort: a shallow scan for any `.wpc` function one or two levels
    // down. Every access is guarded on its own; a getter that throws on one
    // object must not abort the search (that is what hid the renamed root).
    for (var r = 0; r < keys.length; r++) {
      var root;
      try { root = top[keys[r]]; } catch (e) { continue; }
      if (!root || (typeof root !== 'object' && typeof root !== 'function')) continue;
      if (root === top || root === document) continue;
      try { if (typeof root.wpc === 'function') return root.wpc; } catch (e) {}
      var inner;
      try { inner = Object.keys(root); } catch (e) { continue; }
      for (var j = 0; j < inner.length; j++) {
        try {
          var candidate = root[inner[j]];
          if (candidate && typeof candidate.wpc === 'function') return candidate.wpc;
        } catch (e) {}
      }
    }
    return null;
  }

  async function getWebPoClient() {
    for (var attempt = 0; attempt < 15; attempt++) {
      var factory = webPoClientFactory();
      if (typeof factory === 'function') {
        var client = await factory();
        if (client && typeof client.mws === 'function') return client;
      }
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
    }
    var enabled = window.ytcfg?.get?.('EXPERIMENT_FLAGS')?.bg_st_hr;
    throw new Error('YouTube WebPoClient unavailable (bg_st_hr=' + enabled + ')');
  }

  function contentBinding(videoId, cfg) {
    // The current WEB_PLAYER_CONTEXT_CONFIGS flag explicitly switches GVS from
    // visitor binding to video-id binding. Keep the other branch for sessions
    // where YouTube has not enrolled that experiment.
    var contexts = window.ytcfg?.data_?.WEB_PLAYER_CONTEXT_CONFIGS || {};
    var serialized = '';
    for (var key of Object.keys(contexts)) serialized += contexts[key]?.serializedExperimentFlags || '';
    // Content binding is the current default; only an explicit opt-out falls
    // back to the visitor. (The homepage's player configs do not always carry
    // the flag, and GVS rejects a visitor-bound token on content-bound URLs.)
    if (/html5_generate_content_po_token=false/.test(serialized)) return cfg.visitorData || String(videoId);
    return String(videoId);
  }

  window.boppa.onRequest('credentials', async function() {
    var cfg = await readConfig();
    var values = {};
    values[CONTEXT_PREFIX + '_API_KEY'] = cfg.apiKey;
    values[CONTEXT_PREFIX + '_CLIENT_VERSION'] = cfg.clientVersion;
    if (cfg.visitorData) values[CONTEXT_PREFIX + '_VISITOR_DATA'] = cfg.visitorData;
    if (cfg.playerJsUrl) values[CONTEXT_PREFIX + '_PLAYER_JS_URL'] = cfg.playerJsUrl;
    return values;
  });

  // ---- Signed-in session ----
  // A cookie-bearing InnerTube call is still treated as logged out unless it
  // also carries the SAPISIDHASH Authorization header YouTube's own page
  // computes, so do the same here.
  // Answered from the cookie alone so it is instant even right after a popup
  // sign-in, when the page config still has to be re-read. The account details
  // are resolved lazily by authHeaders(), the only place that needs them.
  function sessionState() {
    return { signedIn: !!sapisid() };
  }

  async function sha1Hex(text) {
    var digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.prototype.map.call(new Uint8Array(digest), function(b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  async function authHeaders() {
    var id = sapisid();
    if (!id) return null;
    var origin = location.origin;
    var ts = Math.floor(Date.now() / 1000);
    var cfg = await readConfig();
    var headers = {
      'Authorization': 'SAPISIDHASH ' + ts + '_' + (await sha1Hex(ts + ' ' + id + ' ' + origin)),
      'X-Origin': origin,
      'X-Goog-AuthUser': cfg.sessionIndex
    };
    // Brand/channel accounts act on behalf of a delegated session.
    if (cfg.delegatedSessionId) headers['X-Goog-PageId'] = cfg.delegatedSessionId;
    return headers;
  }

  window.boppa.onRequest('session', function() {
    return sessionState();
  });

  // Run the /player request inside this WebView so it inherits the page's
  // User-Agent, cookies (the user's session) and visitor.
  window.boppa.onRequest('player', async function(request) {
    var videoId = request && request.videoId;
    if (!videoId) throw new Error('player requires a video id');
    var cfg = await readConfig();
    var client = {
      clientName: CLIENT_NAME,
      clientVersion: cfg.clientVersion,
      // The page's own UA: what the server already saw load this page.
      userAgent: navigator.userAgent + ',gzip(gfe)',
      visitorData: cfg.visitorData,
      hl: 'en',
      gl: 'US'
    };
    var headers = {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': CLIENT_ID,
      'X-YouTube-Client-Version': cfg.clientVersion,
      'X-Goog-Visitor-Id': cfg.visitorData
    };
    var authenticated = false;
    if (request.signedIn) {
      var auth = await authHeaders();
      if (auth) {
        Object.assign(headers, auth);
        authenticated = true;
      }
    }
    var response = await fetch('/youtubei/v1/player?prettyPrint=false&key=' + encodeURIComponent(cfg.apiKey), {
      method: 'POST',
      // Cookies always ride along (same jar as WebPoClient); whether the call is
      // treated as signed in is decided by the Authorization header above.
      credentials: 'include',
      headers: headers,
      body: JSON.stringify({
        context: { client: client },
        videoId: String(videoId),
        playbackContext: {
          contentPlaybackContext: {
            html5Preference: 'HTML5_PREF_WANTS',
            signatureTimestamp: request.signatureTimestamp || cfg.signatureTimestamp || 20725
          }
        },
        contentCheckOk: true,
        racyCheckOk: true
      })
    });
    var payload = await response.json();
    return {
      status: response.status,
      playabilityStatus: payload.playabilityStatus || null,
      streamingData: payload.streamingData ? { adaptiveFormats: payload.streamingData.adaptiveFormats || [] } : null,
      playerJsUrl: cfg.playerJsUrl || null,
      authenticated: authenticated
    };
  });

  // Diagnostic: fetch one byte of a GVS URL from this page (the identity that
  // minted the token), so a container-side 403 can be compared against the
  // same request made from here. Reports status only.
  window.boppa.onRequest('probe', async function(request) {
    var url = request && request.url;
    if (!url) throw new Error('probe requires a url');
    var started = Date.now();
    // Environment facts BotGuard depends on: a page WebKit does not treat as
    // visible never gets animation frames, and its minted tokens are rejected.
    var rafMs = await new Promise(function(resolve) {
      var t = Date.now();
      var timer = setTimeout(function() { resolve(-1); }, 1000);
      requestAnimationFrame(function() { clearTimeout(timer); resolve(Date.now() - t); });
    });
    var env = { visibility: document.visibilityState, hasFocus: document.hasFocus(), rafMs: rafMs,
      viewport: window.innerWidth + 'x' + window.innerHeight, ua: navigator.userAgent.slice(0, 60) };
    try {
      var response = await fetch(url, { credentials: 'omit', mode: 'cors' });
      return { status: response.status, ms: Date.now() - started, env: env };
    } catch (e) {
      return { status: 0, error: String(e && e.message ? e.message : e), ms: Date.now() - started, env: env };
    }
  });

  window.boppa.onRequest('mint', async function(videoId) {
    if (!videoId) throw new Error('mint requires a video id');
    var cfg = await readConfig();
    var client = await getWebPoClient();
    var binding = contentBinding(videoId, cfg);
    // A minted token is ~110-130 chars. Before the minter has attested, mws
    // hands out a much longer cold-start token; InnerTube accepts it but GVS
    // does not (all (17).log: 800-char tokens, every URL 403). Give the minter
    // a few seconds to warm up and prefer a minted token; fall back to the
    // cold one only if nothing better arrives.
    var cold = null;
    for (var attempt = 0; attempt < 10; attempt++) {
      try {
        // Exactly what YouTube's own web player calls (captured from the live
        // page: mws({c: <videoId>, mc: true, me: true})).
        var token = await client.mws({ c: binding, mc: true, me: true });
        if (token && token !== 'backoff') {
          if (token.length <= 300) {
            if (cold) log('mint: minted token after cold start (' + cold.length + ' -> ' + token.length + ' chars)');
            return token;
          }
          if (!cold) log('mint: cold-start token (' + token.length + ' chars), waiting for the minter');
          cold = token;
        }
      } catch (e) {
        if (String(e).indexOf('SDF:notready') === -1) throw e;
      }
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
    }
    if (cold) {
      log('mint: minter never warmed up, returning the cold-start token');
      return cold;
    }
    throw new Error('WebPoClient remained unavailable');
  });

  function start() {
    window.boppa.workerReady();
    log('worker ready');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
