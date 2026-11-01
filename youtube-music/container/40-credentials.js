// Credentials a source scrapes from its own site (an API key, a client version,
// a visitor id, a client id) live in boppa.store and are used as they are. Every
// data and playback call checks their age, and once they are an hour old starts
// a refresh in the background; nothing refreshes them on a timer. A call waits
// for new credentials only when there are none yet, or when a request rejected
// the ones it used, and then only for CREDENTIALS_WAIT_MS before it carries on
// (or retries) with whatever the store holds.
//
// The source defines fetchCredentials() in a later container file: read fresh
// credentials from the site and store them. This file times it, stamps it, and
// keeps one refresh in flight at a time.
//
// Device log, 2026-10-16: init awaited the www.youtube.com credentials worker
// on every launch although the store already held working credentials. When
// that page stopped answering, init and every resolve after it ran into the
// host's 30 s call timeout, and no YouTube track played until a relaunch.

const CREDENTIALS_MAX_AGE_MS = 60 * 60 * 1000;
// How long a call waits for new credentials. The host times a call out after
// 30 s, and the call still needs time to run once it has them.
const CREDENTIALS_WAIT_MS = 10 * 1000;
// A refresh still running after this long is abandoned, so a page that never
// answers cannot hold up every refresh after it.
const CREDENTIALS_REFRESH_TIMEOUT_MS = 25 * 1000;
// A call whose credentials were rejected starts no new refresh when one began
// this recently: those credentials are as new as they get, and a broken site
// should cost one wait per window, not one per call.
const CREDENTIALS_RETRY_COOLDOWN_MS = 30 * 1000;
const CREDENTIAL_REJECTION_STATUSES = [400, 401, 403];
const STORE_KEY_CREDENTIALS_AT = 'credentials.refreshedAt';

let credentialsRefresh = null;
let credentialsRefreshStartedAt = 0;

function credentialsLog() {
  console.log('[credentials] ' + Array.prototype.slice.call(arguments).join(' '));
}

/// Settle with `promise`, or reject with `message` after `ms`.
function withTimeout(promise, ms, message) {
  let timer = null;
  const deadline = new Promise(function(_, reject) {
    timer = setTimeout(function() { reject(new Error(message)); }, ms);
  });
  return Promise.race([promise, deadline]).finally(function() { clearTimeout(timer); });
}

function credentialsError(message) {
  const error = new Error(message);
  error.credentials = true;
  return error;
}

/// True for an error new credentials could fix. The message test also covers
/// errors whose text was folded into another error's message on the way up.
function isCredentialsError(error) {
  if (!error) return false;
  if (error.credentials === true) return true;
  return /\bcredentials (were rejected|are incomplete|are missing)\b/.test(String(error.message || error));
}

function credentialsRefreshedAt() {
  const at = parseInt(boppa.store.get(STORE_KEY_CREDENTIALS_AT) || '0', 10);
  return Number.isFinite(at) ? at : 0;
}

/// fetch for a request that carries the stored credentials. A status that
/// means the site refused them throws a credentials error instead of handing
/// the response back.
async function credentialFetch(url, init) {
  const response = await fetch(url, init);
  if (CREDENTIAL_REJECTION_STATUSES.indexOf(response.status) !== -1) {
    let where = String(url);
    try { const parsed = new URL(where); where = parsed.hostname + parsed.pathname; } catch (e) {}
    throw credentialsError('credentials were rejected (HTTP ' + response.status + ' from ' + where + ')');
  }
  return response;
}

/// Start a refresh unless one is in flight. Resolves true once new credentials
/// are stored and false if the refresh failed or timed out; never rejects.
function startCredentialsRefresh(reason) {
  if (credentialsRefresh) return credentialsRefresh;
  const startedAt = Date.now();
  credentialsRefreshStartedAt = startedAt;
  credentialsLog('refreshing:', reason);
  const pending = withTimeout(Promise.resolve().then(fetchCredentials), CREDENTIALS_REFRESH_TIMEOUT_MS,
    'no credentials within ' + CREDENTIALS_REFRESH_TIMEOUT_MS + ' ms')
    .then(function() {
      boppa.store.set(STORE_KEY_CREDENTIALS_AT, String(Date.now()));
      credentialsLog('refreshed in', (Date.now() - startedAt) + 'ms');
      return true;
    }, function(e) {
      credentialsLog('refresh FAILED after', (Date.now() - startedAt) + 'ms:', (e && e.message) || e);
      return false;
    })
    .finally(function() {
      if (credentialsRefresh === pending) credentialsRefresh = null;
    });
  credentialsRefresh = pending;
  return pending;
}

/// Wait for `refresh`, but no longer than CREDENTIALS_WAIT_MS. True if it
/// stored new credentials in time; a refresh still running carries on.
async function awaitCredentialsRefresh(refresh) {
  try {
    return await withTimeout(refresh, CREDENTIALS_WAIT_MS, 'credentials wait expired');
  } catch (e) {
    credentialsLog('no new credentials within', CREDENTIALS_WAIT_MS + 'ms; carrying on, the refresh continues in the background');
    return false;
  }
}

function credentialsInCooldown() {
  return !credentialsRefresh && Date.now() - credentialsRefreshStartedAt < CREDENTIALS_RETRY_COOLDOWN_MS;
}

/// Run at the start of every data and playback call. Stored credentials are
/// used as they are; old ones are refreshed in the background. Only missing
/// ones are waited for.
async function ensureCredentials(keys) {
  const missing = keys.filter(function(key) { return boppa.store.get(key) === null; });
  if (missing.length) {
    if (credentialsInCooldown()) {
      credentialsLog('missing', missing.join(','), '- a refresh ran moments ago, not waiting for another');
      return;
    }
    await awaitCredentialsRefresh(startCredentialsRefresh('missing ' + missing.join(',')));
    return;
  }
  const refreshedAt = credentialsRefreshedAt();
  if (Date.now() - refreshedAt < CREDENTIALS_MAX_AGE_MS) return;
  void startCredentialsRefresh(refreshedAt
    ? 'last refreshed ' + Math.round((Date.now() - refreshedAt) / 60000) + ' min ago'
    : 'no refresh recorded');
}

/// The credentials a call read at `usedAt` were rejected. True when newer ones
/// are in the store by the time this returns.
async function renewCredentials(usedAt, reason) {
  if (credentialsRefreshedAt() > usedAt) return true;
  if (credentialsInCooldown()) {
    credentialsLog('rejected, but a refresh ran', Math.round((Date.now() - credentialsRefreshStartedAt) / 1000) + 's ago; not refreshing again:', reason);
    return false;
  }
  return awaitCredentialsRefresh(startCredentialsRefresh('rejected: ' + reason));
}

/// Run `call` with the stored credentials. If they are rejected and new ones
/// arrive in time, run it once more with those.
async function callWithCredentials(keys, call, signal) {
  await ensureCredentials(keys);
  const usedAt = credentialsRefreshedAt();
  try {
    return await call();
  } catch (e) {
    if (signal?.aborted || !isCredentialsError(e)) throw e;
    const reason = (e && e.message) || String(e);
    if (!(await renewCredentials(usedAt, reason))) throw e;
    signal?.throwIfAborted();
    credentialsLog('retrying with new credentials');
    return call();
  }
}

/// Wrap every data handler in `handlers` with callWithCredentials.
function credentialedData(keys, handlers) {
  for (const path of Object.keys(handlers)) {
    const handler = handlers[path];
    handlers[path] = function(params, options) {
      return callWithCredentials(keys, function() { return handler(params, options); }, options?.signal);
    };
  }
  return handlers;
}

/// Wrap the resolve handler in `handlers` with callWithCredentials.
function credentialedPlayback(keys, handlers) {
  const resolve = handlers.resolve;
  handlers.resolve = function(track, options) {
    return callWithCredentials(keys, function() { return resolve(track, options); }, options?.signal);
  };
  return handlers;
}
