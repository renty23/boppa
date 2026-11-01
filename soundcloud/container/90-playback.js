function log() {
  console.log('[soundcloud] ' + Array.prototype.slice.call(arguments).join(' '));
}

function warn() {
  const sink = (typeof console !== 'undefined' && console) || {};
  const fn = sink.warn || sink.log || function() {};
  fn.call(sink, '[soundcloud] WARNING ' + Array.prototype.slice.call(arguments).join(' '));
}

/// Build an Error the host treats as fatal: the package has concluded that
/// retrying will not help, so the engine ends the track instead of rebinding.
/// Use only for terminal conditions, never for a network failure.
function fatal(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

// ---- Policy (config-owned) ----
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 5000;
// Network (transport) failures are retried with no attempt cap, 400/800 ms then
// 1 s, until the track's signal is aborted. The only cure for them is time, and
// giving up means a stopped track. Status failures keep the bounded policy above.
const NETWORK_RETRY_BASE_MS = 400;
const NETWORK_RETRY_MAX_MS = 1000;
const NETWORK_RETRY_LOG_EVERY = 10;
// A resolve started while offline retries its network work for this long before
// failing, inside the host's call budget.
const RESOLVE_NETWORK_RETRY_BUDGET_MS = 24000;
// A pull answers within this long even while its fetch is still waiting on the
// network (the host's call timeout is 30 s; stay well inside it).
const PULL_WAIT_MS = 2000;
// A byte request that has not completed in this long is treated as dead and
// retried. The host buffers whole bodies, so the budget scales with the range:
// a 12 s floor plus time for the bytes at a slow-but-working 16 KiB/s.
const RANGE_STALL_FLOOR_MS = 12000;
const RANGE_STALL_MIN_BYTES_PER_SEC = 16 * 1024;

/// Transport-level failures: the request never got an HTTP answer. Mirrors the
/// host engine's NSURLError/CFNetwork set. Status codes and bad bodies are
/// deliberately excluded: repeating those cannot change the answer.
function isNetworkFailure(error) {
  const message = String((error && error.message) || error);
  return (/network connection was lost|not connected to the internet|internet connection appears to be offline|request timed out|stalled for \d+ ms|could not connect to the server|cannot connect to host|connection reset|connection refused|server with the specified hostname could not be found|hostname could not be found|\bdns\b|network is down|network is unreachable|software caused connection abort|data connection is not currently allowed|international roaming is currently off|a phone call is in progress|SSL error has occurred|secure connection to the server cannot be made|^Load failed$|: Load failed$/i.test(message)
    || /\((?:NSURLErrorDomain|kCFErrorDomainCFNetwork) error -(?:1001|1003|1004|1005|1006|1008|1009|1018|1019|1020|1200)\.\)/.test(message))
    && !/failed with \d{3}/.test(message);
}
const EXPIRY_SKEW_SECONDS = 60;
// How often to re-extract the client id. SoundCloud rotates it with its web
// build, and every API call is signed with it.
// The credentials worker has this long to load and answer before it is stopped.
const CLIENT_ID_TIMEOUT_MS = 15 * 1000;

function sleep(ms, signal) {
  return new Promise(function(resolve, reject) {
    if (signal && signal.aborted) { reject(signal.reason || new Error('aborted')); return; }
    const timer = setTimeout(resolve, ms);
    if (signal && signal.addEventListener) {
      signal.addEventListener('abort', function() {
        clearTimeout(timer);
        reject(signal.reason || new Error('aborted'));
      }, { once: true });
    }
  });
}

/// fetch() bounded by a stall budget on top of the caller's own abort signal.
/// A request that produces no answer within the budget is aborted and surfaced
/// with a message the network classifier recognises, so the caller retries.
async function fetchWithStallBudget(url, options, signal, budgetMs) {
  if (signal && signal.aborted) throw (signal.reason || new Error('aborted'));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (!controller) return fetch(url, Object.assign({}, options, { signal: signal }));
  let timedOut = false;
  const timer = setTimeout(function() { timedOut = true; controller.abort(); }, budgetMs);
  const onAbort = function() { controller.abort(); };
  if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } catch (e) {
    if (timedOut && !(signal && signal.aborted)) throw new Error('range request stalled for ' + budgetMs + ' ms');
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
  }
}

function rangeStallBudgetMs(start, end) {
  if (start === null || start === undefined || end === null || end === undefined) {
    return RANGE_STALL_FLOOR_MS;
  }
  const bytes = Math.max(0, end - start + 1);
  return RANGE_STALL_FLOOR_MS + Math.ceil(bytes / RANGE_STALL_MIN_BYTES_PER_SEC) * 1000;
}

/// Run `work`, retrying transport failures with the capped backoff. With no
/// `budgetMs` it retries until the signal aborts (the byte path, so a track
/// rides out an outage). With a `budgetMs` it gives up after that long (the
/// resolve path, so a user who tapped offline gets an answer, not a spinner).
async function withNetworkRetry(signal, label, work, budgetMs) {
  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    try {
      const result = await work();
      if (attempts > 0) warn(label, 'recovered after', attempts, 'network failure(s)');
      return result;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (!isNetworkFailure(e)) throw e;
      attempts++;
      const elapsed = Date.now() - startedAt;
      if (budgetMs !== undefined && budgetMs !== null && elapsed >= budgetMs) {
        warn(label, 'still failing on the network after', Math.round(elapsed / 1000), 's, giving up');
        throw e;
      }
      const delay = Math.min(NETWORK_RETRY_BASE_MS * Math.pow(2, attempts - 1), NETWORK_RETRY_MAX_MS);
      if (attempts <= 3 || attempts % NETWORK_RETRY_LOG_EVERY === 0) {
        warn(label + ':', (e && e.message) ? e.message : e,
          '| network failure #' + attempts + ', retrying in', delay,
          'ms until the connection returns or the track is stopped');
      }
      await sleep(delay, signal);
    }
  }
}

function backoffDelay(attempt) {
  const base = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_MAX_MS);
  return Math.floor(base * (0.7 + Math.random() * 0.6));
}

function withAuth(url, clientId, secretToken) {
  let target = url + (url.indexOf('?') === -1 ? '?' : '&') +
    'client_id=' + encodeURIComponent(clientId);
  if (secretToken) target += '&secret_token=' + encodeURIComponent(secretToken);
  return target;
}

function isAuthStatus(status) {
  return status === 401 || status === 403;
}

function oauthHeaders(cookies) {
  const token = cookies && (cookies.oauth_token || cookies.oauthToken);
  return token ? { Authorization: 'OAuth ' + token } : {};
}

/// Fetch JSON with bounded exponential-backoff retries. Auth failures fail fast:
/// retrying the same client id cannot help; the app's outer resolve retry re-reads
/// boppa.store, so it can pick up a freshly extracted id.
async function fetchJSONWithRetry(url, label, headers, signal) {
  let lastError = null;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { headers: headers || {}, signal: signal });
      log(label + ': status', response.status,
        attempt > 0 ? '(attempt ' + (attempt + 1) + ')' : '');
      if (isAuthStatus(response.status)) {
        const error = credentialsError('SoundCloud rejected the client id (' + response.status +
          '), open SoundCloud once to refresh it');
        error.auth = true;
        throw error;
      }
      if (response.status === 404 || response.status === 410) {
        const error = new Error(label + ' failed with ' + response.status);
        error.status = response.status;
        error.stale = true;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(label + ' failed with ' + response.status);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = e;
      if (e && (e.auth || e.stale)) throw e;
      if (isNetworkFailure(e)) throw e;   // handled by the budgeted/unbounded outer loop
      if (attempt === RETRY_MAX_ATTEMPTS - 1) break;
      const delay = backoffDelay(attempt);
      log(label + ':', (e && e.message) ? e.message : e, '| retry in', delay + 'ms');
      await sleep(delay);
      signal?.throwIfAborted();
    }
  }
  throw lastError;
}

// ---- Transcoding selection ----

function normalizeTranscodings(value) {
  return (value || [])
    .filter(x => x && x.url && x.preset
      && String(x.format?.protocol || x.protocol || '').indexOf('encrypted') === -1
      && String(x.preset).indexOf('abr_') !== 0)
    .map(x => ({
      url: x.url,
      preset: x.preset,
      protocol: x.format?.protocol || x.protocol || 'progressive',
      mimeType: x.format?.mime_type || x.mimeType || null,
      quality: x.quality || null
    }));
}

/// Prefer the best free AAC fMP4 HLS stream, then compatible MP3 fallbacks.
/// Opus/WebM is intentionally excluded because AVFoundation cannot demux it.
const TRANSCODING_PREFERENCE = [
  ['aac_160k', 'hls'],
  ['aac_96k', 'hls'],
  ['mp3_1_0', 'hls'],
  ['mp3_1_0', 'progressive'],
  ['mp3_0_1', 'hls'],
  ['mp3_0_1', 'progressive'],
  ['mp3_0_0', 'hls'],
  ['mp3_0_0', 'progressive']
];

function orderedCompatibleTranscodings(transcodings) {
  const ordered = [];
  for (const [preset, protocol] of TRANSCODING_PREFERENCE) {
    const candidate = transcodings.find(x =>
      x.preset === preset && x.protocol === protocol);
    if (candidate && !ordered.some(x => x.url === candidate.url)) ordered.push(candidate);
  }
  // Keep future MP3 preset spellings usable without ever selecting DRM or Opus.
  for (const candidate of transcodings) {
    if (candidate.mimeType === 'audio/mpeg'
      && !ordered.some(x => x.url === candidate.url)) {
      ordered.push(candidate);
    }
  }
  return ordered;
}

// ---- Signed URL expiry ----

function decodeCloudFrontBase64(value) {
  // CloudFront's signed-URL alphabet is not ordinary base64url:
  //   '+' -> '-',  '/' -> '~',  '=' -> '_'
  // Reverse those substitutions before atob. `_` is padding, not '/'.
  let text = String(value || '')
    .replace(/-/g, '+')
    .replace(/~/g, '/')
    .replace(/_/g, '=');
  while (text.length % 4) text += '=';
  return atob(text);
}

/// Return the earliest expiration encoded by the signed URL. SoundCloud uses
/// both an `expires=` query and a CloudFront Policy; the Policy can expire earlier,
/// so trusting only the query would reuse an already-invalid URL.
function audioUrlExpiresAt(url) {
  const candidates = [];
  try {
    const parsed = new URL(url);
    const queryExpiry = parseInt(parsed.searchParams.get('expires') ||
      parsed.searchParams.get('Expires') || '0', 10);
    if (queryExpiry > 0) candidates.push(queryExpiry);
    const policy = parsed.searchParams.get('Policy');
    if (policy) {
      const decoded = JSON.parse(decodeCloudFrontBase64(policy));
      const statements = decoded.Statement || [];
      for (const statement of statements) {
        const epoch = statement?.Condition?.DateLessThan?.['AWS:EpochTime'];
        if (Number(epoch) > 0) candidates.push(Number(epoch));
      }
    }
  } catch (e) {
    log('audioUrlExpiresAt: could not parse signed URL:', (e && e.message) ? e.message : e);
  }
  return candidates.length ? Math.min.apply(Math, candidates) : 0;
}

function isUsableCachedAudioUrl(url, explicitExpiry) {
  if (!url || String(url).slice(0, 5) !== 'https') return false;
  const embedded = audioUrlExpiresAt(url);
  const explicit = Number(explicitExpiry) || 0;
  const expiries = [embedded, explicit].filter(x => x > 0);
  const expiry = expiries.length ? Math.min.apply(Math, expiries) : 0;
  // No detectable expiry means we cannot prove it is still valid, so resolve the
  // stable transcoding endpoint instead of gambling on it.
  return expiry > Math.floor(Date.now() / 1000) + EXPIRY_SKEW_SECONDS;
}

function playbackMimeType(audioUrl, protocol, sourceMimeType) {
  if (protocol === 'hls' || String(audioUrl).indexOf('.m3u8') !== -1) {
    return 'application/vnd.apple.mpegurl';
  }
  return sourceMimeType || 'audio/mpeg';
}

// ---- Persistence ----

/// `boppa.updateTrackMetadata` replaces the track's entire metadata object. Build
/// the new object from the track's current metadata plus `changes`, then write it
/// back. A `null` value in `changes` drops that key. The in-flight `track` is
/// updated too so later writes in the same resolve start from the latest state.
async function persistTrackMetadata(track, changes) {
  const next = Object.assign({}, track.metadata || {});
  for (const key of Object.keys(changes || {})) {
    if (changes[key] === null || changes[key] === undefined) {
      delete next[key];
    } else {
      next[key] = changes[key];
    }
  }
  track.metadata = next;

  if (typeof boppa.updateTrackMetadata !== 'function') {
    log('persist: updateTrackMetadata bridge unavailable');
    return false;
  }
  try {
    const stored = await boppa.updateTrackMetadata(track.id, next);
    log('persist:', Object.keys(changes || {}).join(','), '| stored', stored);
    return stored;
  } catch (e) {
    // Playback must not fail just because a best-effort cache write failed.
    log('persist FAILED:', (e && e.message) ? e.message : e);
    return false;
  }
}

function transcodingPatch(transcodings, selected) {
  return {
    streamRequestUrl: selected.url,
    streamPreset: selected.preset,
    streamProtocol: selected.protocol,
    streamMimeType: selected.mimeType,
    transcodings: transcodings
  };
}

async function persistAudioUrl(track, audioUrl, extra) {
  const changes = Object.assign({
    audioStreamUrl: audioUrl,
    audioStreamExpiresAt: audioUrlExpiresAt(audioUrl),
    audioStreamResolvedAt: Math.floor(Date.now() / 1000)
  }, extra || {});
  await persistTrackMetadata(track, changes);
}

// ---- Three-level resolution ----

/// Level 2: turn a stable transcoding endpoint into a signed audio URL. A stale
/// endpoint (404/410) returns null so level 3 can refresh the list; auth failures
/// and transient failures are allowed to bubble to the app's retry/recovery layer.
async function resolveTranscodingEndpoint(endpoint, clientId, secretToken, headers, signal) {
  try {
    const data = await fetchJSONWithRetry(withAuth(endpoint, clientId, secretToken),
      'transcoding endpoint', headers, signal);
    return data && data.url ? String(data.url) : null;
  } catch (e) {
    if (e && (e.status === 404 || e.status === 410)) {
      log('transcoding endpoint is stale (' + e.status + '), refreshing track metadata');
      return null;
    }
    throw e;
  }
}

function hasEncryptedStreams(value) {
  return (value || []).some(x =>
    String(x?.format?.protocol || x?.protocol || '').indexOf('encrypted') !== -1);
}

/// Level 3: fetch the current track object (and its complete list of transcoding
/// endpoints), then try every compatible endpoint in preference order.
async function discoverFreshStream(track, clientId, cookies, signal) {
  const id = track.metadata?.soundcloudTrackId || track.id;
  const secretToken = track.metadata?.soundcloudSecretToken || null;
  const data = await fetchJSONWithRetry(
    withAuth('https://api-v2.soundcloud.com/tracks/' + encodeURIComponent(id), clientId, secretToken),
    'track transcodings', oauthHeaders(cookies), signal);
  const rawTranscodings = data?.media?.transcodings || [];
  const transcodings = normalizeTranscodings(rawTranscodings);
  const candidates = orderedCompatibleTranscodings(transcodings);

  for (const selected of candidates) {
    const audioUrl = await resolveTranscodingEndpoint(
      selected.url, clientId, secretToken, oauthHeaders(cookies), signal);
    if (!audioUrl) {
      log('fresh discovery:', selected.preset, selected.protocol, 'unavailable; trying next');
      continue;
    }
    await persistAudioUrl(track, audioUrl,
      Object.assign({
        soundcloudTrackId: String(id),
        soundcloudSecretToken: secretToken
      }, transcodingPatch(transcodings, selected)));
    return { audioUrl: audioUrl, selected: selected };
  }

  const encryptedOnly = hasEncryptedStreams(rawTranscodings);
  if (encryptedOnly) {
    throw new Error('non-retryable: This track has only FairPlay-protected SoundCloud streams and cannot be played in Boppa');
  }
  throw new Error('non-retryable: SoundCloud returned no working compatible AAC or MP3 transcoding');
}

// ---- Byte delivery ----

const CHUNK_BYTES = 65536;
const BUFFER_AHEAD_SECONDS = 30;
const PROBE_CONCURRENCY = 8;

function isHls(url, protocol) {
  return protocol === 'hls' || String(url).indexOf('.m3u8') !== -1;
}

function isStaleStatus(status) {
  return status === 401 || status === 403 || status === 404 || status === 410;
}

/// Fetch a byte range with the Range header. A 200 means the server ignored the
/// range and sent the whole resource, so slice out the part that was asked for.
async function fetchBytes(url, headers, start, end, signal) {
  const options = { headers: Object.assign({}, headers || {}) };
  const ranged = start !== null && start !== undefined;
  if (ranged) {
    options.headers.Range = 'bytes=' + start + '-' +
      (end === null || end === undefined ? '' : end);
  }
  const response = await fetchWithStallBudget(url, options, signal, rangeStallBudgetMs(start, end));
  if (!response.ok && response.status !== 206) {
    const error = new Error('byte fetch failed with ' + response.status);
    error.status = response.status;
    throw error;
  }
  const bytes = await response.bytes();
  if (ranged && response.status === 200) {
    const from = start;
    const to = (end === null || end === undefined) ? bytes.length - 1 : end;
    return bytes.slice(from, to + 1);
  }
  return bytes;
}

async function fetchText(url, headers, signal) {
  const response = await fetchWithStallBudget(url, { headers: headers || {} }, signal, RANGE_STALL_FLOOR_MS);
  if (!response.ok) {
    const error = new Error('fetch failed with ' + response.status);
    error.status = response.status;
    throw error;
  }
  return await response.text();
}

/// Ask for one byte and read the total out of Content-Range. Cheaper than
/// downloading anything and works on every CDN SoundCloud serves from.
async function probeLength(url, headers, signal) {
  const response = await fetchWithStallBudget(url,
    { headers: Object.assign({ Range: 'bytes=0-0' }, headers || {}) },
    signal, RANGE_STALL_FLOOR_MS);
  if (!response.ok && response.status !== 206) {
    const error = new Error('length probe failed with ' + response.status);
    error.status = response.status;
    throw error;
  }
  const contentRange = String(response.headers.get('content-range') || '');
  const total = parseInt(contentRange.slice(contentRange.indexOf('/') + 1), 10);
  if (total > 0) return total;
  const length = parseInt(response.headers.get('content-length') || '0', 10);
  if (response.status === 200 && length > 0) return length;
  throw new Error('could not determine the length of ' + url.slice(0, 80));
}

async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      out[index] = await worker(items[index], index);
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(run());
  await Promise.all(runners);
  return out;
}

// ---- Playlist ----

function resolveUri(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).toString();
  } catch (e) {
    return uri;
  }
}

function parseByteRange(value) {
  const match = /^(\d+)(?:@(\d+))?$/.exec(String(value || '').trim());
  if (!match) return null;
  const offset = match[2] === undefined ? null : parseInt(match[2], 10);
  return { length: parseInt(match[1], 10), offset: offset };
}

/// Parse a media playlist into an init segment (fMP4 only) and its media segments.
/// Handles both shapes SoundCloud can serve: one URI per segment, and a single
/// resource carved up by EXT-X-BYTERANGE.
function parsePlaylist(text, baseUrl) {
  const result = { init: null, segments: [] };
  let duration = 0;
  let range = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.indexOf('#EXT-X-MAP:') === 0) {
      const uriMatch = /URI="([^"]+)"/.exec(line);
      const rangeMatch = /BYTERANGE="([^"]+)"/.exec(line);
      if (uriMatch) {
        result.init = {
          uri: resolveUri(uriMatch[1], baseUrl),
          range: rangeMatch ? parseByteRange(rangeMatch[1]) : null
        };
      }
    } else if (line.indexOf('#EXTINF:') === 0) {
      duration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
    } else if (line.indexOf('#EXT-X-BYTERANGE:') === 0) {
      range = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
    } else if (line[0] === '#') {
      continue;
    } else {
      result.segments.push({ uri: resolveUri(line, baseUrl), duration: duration, range: range });
      duration = 0;
      range = null;
    }
  }
  return result;
}

/// Lay the init segment and every media segment out as one byte stream. The offsets
/// are ours, not the source's: pull maps a requested range back onto the pieces that
/// cover it. Lengths come from the playlist when it uses byte ranges, and from a
/// one-byte probe per segment otherwise, so they are exact either way.
async function buildLayout(playlist, headers, cachedLengths, signal) {
  const targets = [];
  if (playlist.init) targets.push(playlist.init);
  for (const segment of playlist.segments) targets.push(segment);

  let lengths = null;
  if (cachedLengths && cachedLengths.length === targets.length
    && cachedLengths.every(x => Number.isInteger(x) && x > 0)) {
    lengths = cachedLengths.slice();
    log('layout: reusing cached piece lengths (' + lengths.length + ' pieces)');
  } else {
    log('layout: probing', targets.length, 'piece length(s)');
    lengths = await mapWithConcurrency(targets, PROBE_CONCURRENCY, async function(target) {
      if (target.range && target.range.length > 0) return target.range.length;
      return await probeLength(target.uri, headers, signal);
    });
  }

  const pieces = [];
  const fragments = [];
  let offset = 0;
  let initSegment = null;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const length = lengths[i];
    const sourceOffset = target.range && target.range.offset !== null
      ? target.range.offset
      : (target.range ? 0 : null);
    pieces.push({ offset: offset, length: length, uri: target.uri, sourceOffset: sourceOffset });
    if (i === 0 && playlist.init) {
      initSegment = { offset: offset, length: length };
    } else {
      fragments.push({ offset: offset, length: length, duration: target.duration });
    }
    offset += length;
  }

  return {
    contentLength: offset,
    initSegment: initSegment,
    fragments: fragments,
    pieces: pieces,
    lengths: lengths,
    duration: fragments.reduce(function(total, f) { return total + f.duration; }, 0)
  };
}

// ---- Byte cache (per handle, so a seek never refetches) ----

function readCached(handle, start, end) {
  for (const span of handle.__spans) {
    if (span.start <= start && start <= span.end) {
      const from = start - span.start;
      const to = Math.min(end - span.start, span.data.length - 1);
      return span.data.slice(from, to + 1);
    }
  }
  return [];
}

function cachedEndAt(handle, start) {
  for (const span of handle.__spans) {
    if (span.start <= start && start <= span.end) return span.end;
  }
  return -1;
}

function storeSpan(handle, start, data) {
  if (!data || !data.length) return;
  let newSpan = { start: start, end: start + data.length - 1, data: data };
  const merged = [];
  let inserted = false;
  for (const span of handle.__spans) {
    if (span.end + 1 < newSpan.start) {
      merged.push(span);
    } else if (newSpan.end + 1 < span.start) {
      if (!inserted) { merged.push(newSpan); inserted = true; }
      merged.push(span);
    } else {
      const from = Math.min(newSpan.start, span.start);
      const to = Math.max(newSpan.end, span.end);
      const buffer = new Array(to - from + 1);
      for (let i = 0; i < newSpan.data.length; i++) buffer[newSpan.start - from + i] = newSpan.data[i];
      for (let i = 0; i < span.data.length; i++) buffer[span.start - from + i] = span.data[i];
      newSpan = { start: from, end: to, data: buffer };
    }
  }
  if (!inserted) merged.push(newSpan);
  merged.sort(function(a, b) { return a.start - b.start; });
  handle.__spans = merged;
}

function pieceFor(handle, offset) {
  for (const piece of handle.pieces) {
    if (piece.offset <= offset && offset < piece.offset + piece.length) return piece;
  }
  return null;
}

async function fetchPiece(handle, piece) {
  if (piece.sourceOffset === null || piece.sourceOffset === undefined) {
    return await fetchBytes(piece.uri, handle.headers, null, null, handle.signal);
  }
  return await fetchBytes(piece.uri, handle.headers,
    piece.sourceOffset, piece.sourceOffset + piece.length - 1, handle.signal);
}

/// Run a fetch, and if the source rejects it as expired, re-authenticate this
/// handle and run it once more. The media itself never changes, so the layout that
/// was already handed to the app stays valid.
async function withReauth(handle, reason, work) {
  try {
    return await work();
  } catch (e) {
    if (!isStaleStatus(e && e.status)) throw e;
    await refreshHandleUrls(handle, (e && e.message) ? e.message : reason);
    try {
      return await work();
    } catch (again) {
      // Re-authentication did not clear the rejection, so it will not clear on
      // a rebind either; tell the host to stop.
      if (isStaleStatus(again && again.status)) {
        throw fatal((again && again.message) ? again.message : String(again));
      }
      throw again;
    }
  }
}

async function ensureCached(handle, offset, minLength) {
  const wantedEnd = Math.min(offset + minLength - 1, handle.contentLength - 1);
  if (cachedEndAt(handle, offset) >= wantedEnd) {
    log('cache HIT', offset + '+' + minLength);
    return;
  }

  if (handle.rangedSource) {
    let start = offset;
    const cachedEnd = cachedEndAt(handle, offset);
    if (cachedEnd >= offset) start = cachedEnd + 1;
    const end = Math.min(Math.max(wantedEnd, start + CHUNK_BYTES - 1), handle.contentLength - 1);
    if (start > end) return;
    log('cache MISS', offset + '+' + minLength, '-> fetching', start + '-' + end);
    const data = await withNetworkRetry(handle.signal, 'ranged byte fetch', function() {
      return withReauth(handle, 'ranged fetch rejected', function() {
        return fetchBytes(handle.pieces[0].uri, handle.headers, start, end, handle.signal);
      });
    });
    storeSpan(handle, start, data);
    return;
  }

  let cursor = offset;
  while (cursor <= wantedEnd) {
    const piece = pieceFor(handle, cursor);
    if (!piece) break;
    if (cachedEndAt(handle, piece.offset) < piece.offset + piece.length - 1) {
      log('cache MISS', offset + '+' + minLength, '-> fetching piece at', piece.offset);
      const data = await withNetworkRetry(handle.signal, 'segment fetch', function() {
        return withReauth(handle, 'segment fetch rejected', function() {
          return fetchPiece(handle, piece);
        });
      });
      if (data.length !== piece.length) {
        throw fatal('segment at ' + piece.offset + ' returned ' + data.length +
          ' bytes, expected ' + piece.length);
      }
      storeSpan(handle, piece.offset, data);
    }
    cursor = piece.offset + piece.length;
  }
}

/// One in-flight fill per (handle, offset+length). During an outage AVPlayer and
/// the engine's rebinds re-request the same bytes through new JS streams; they
/// all wait on the one retry loop instead of each starting their own.
function ensureCachedShared(handle, offset, minLength) {
  if (!handle.__inflight) handle.__inflight = {};
  const key = offset + '+' + minLength;
  if (handle.__inflight[key]) return handle.__inflight[key];
  const pending = ensureCached(handle, offset, minLength);
  handle.__inflight[key] = pending;
  return pending.then(
    function(value) { delete handle.__inflight[key]; return value; },
    function(error) { delete handle.__inflight[key]; throw error; }
  );
}

/// Re-authenticate every piece of an in-flight stream. Signed segment URLs come
/// from the playlist, so a fresh playlist is what renews them; the byte layout is a
/// property of the transcoding, so it must come back identical or the map we handed
/// the app would be wrong.
function refreshHandleUrls(handle, reason) {
  if (handle.__refreshing) return handle.__refreshing;
  log('refreshHandleUrls: re-authenticating |', reason);
  handle.__refreshing = (async function() {
    const media = await callWithCredentials(['SOUNDCLOUD_CLIENT_ID'], function() {
      // Read again: the client id may have been refreshed since the resolve.
      handle.clientId = boppa.store.get('SOUNDCLOUD_CLIENT_ID') || handle.clientId;
      return resolveMediaUrl(handle.track, handle.clientId, handle.cookies,
        { force: true, signal: handle.signal });
    }, handle.signal);
    if (handle.rangedSource) {
      handle.pieces[0].uri = media.url;
      handle.media = media;
      log('refreshHandleUrls: progressive url renewed');
      return true;
    }
    const playlist = parsePlaylist(await fetchText(media.url, handle.headers, handle.signal),
      media.url);
    const targets = [];
    if (playlist.init) targets.push(playlist.init);
    for (const segment of playlist.segments) targets.push(segment);
    if (targets.length !== handle.pieces.length) {
      throw fatal('playlist changed shape on re-authentication (' +
        handle.pieces.length + ' -> ' + targets.length + ')');
    }
    for (let i = 0; i < targets.length; i++) {
      handle.pieces[i].uri = targets[i].uri;
      if (targets[i].range && targets[i].range.offset !== null) {
        handle.pieces[i].sourceOffset = targets[i].range.offset;
      }
    }
    handle.media = media;
    log('refreshHandleUrls: renewed', targets.length, 'segment url(s)');
    return true;
  })().then(function(value) {
    handle.__refreshing = null;
    return value;
  }, function(e) {
    handle.__refreshing = null;
    log('refreshHandleUrls FAILED:', (e && e.message) ? e.message : e);
    throw e;
  });
  return handle.__refreshing;
}

// ---- Media URL resolution ----

/// The three levels, shared by resolve and by re-authentication. `force` skips the
/// cached signed URL, which is what a rejected fetch needs.
async function resolveMediaUrl(track, clientId, cookies, options) {
  const metadata = track.metadata || {};
  const force = !!(options && options.force);
  const signal = options?.signal;

  if (!force && isUsableCachedAudioUrl(metadata.audioStreamUrl, metadata.audioStreamExpiresAt)) {
    log('media url: level 1 — cached signed url (expires',
      metadata.audioStreamExpiresAt || audioUrlExpiresAt(metadata.audioStreamUrl), ')');
    return {
      url: metadata.audioStreamUrl,
      protocol: metadata.streamProtocol || null,
      mimeType: metadata.streamMimeType || null,
      preset: metadata.streamPreset || null
    };
  }

  if (metadata.streamRequestUrl) {
    const audioUrl = await resolveTranscodingEndpoint(metadata.streamRequestUrl, clientId,
      metadata.soundcloudSecretToken, oauthHeaders(cookies), signal);
    if (audioUrl) {
      log('media url: level 2 — resolved cached transcoding endpoint');
      await persistAudioUrl(track, audioUrl);
      return {
        url: audioUrl,
        protocol: metadata.streamProtocol || null,
        mimeType: metadata.streamMimeType || null,
        preset: metadata.streamPreset || null
      };
    }
  }

  log('media url: level 3 — refreshing transcoding list');
  const fresh = await discoverFreshStream(track, clientId, cookies, signal);
  return {
    url: fresh.audioUrl,
    protocol: fresh.selected.protocol,
    mimeType: fresh.selected.mimeType,
    preset: fresh.selected.preset
  };
}

function cachedLengthsFor(metadata, media) {
  if (!metadata || !Array.isArray(metadata.soundcloudPieceLengths)) return null;
  if (String(metadata.soundcloudLayoutPreset || '') !== String(media.preset || '')) return null;
  if (String(metadata.soundcloudLayoutProtocol || '') !== String(media.protocol || '')) return null;
  return metadata.soundcloudPieceLengths;
}

async function persistLayout(track, media, layout) {
  await persistTrackMetadata(track, {
    soundcloudLayoutPreset: media.preset || null,
    soundcloudLayoutProtocol: media.protocol || null,
    soundcloudPieceLengths: layout.lengths,
    soundcloudContentLength: layout.contentLength
  });
}

// ---- Credentials ----

/// Extract the client id and store it in boppa.store, which is where the data
/// scripts and resolve() read it from. Run by container/40-credentials.js, in
/// the background unless a call has none.
///
/// The extraction needs the site's own origin, so it runs in a worker WebView.
/// Nothing needs that page between refreshes — unlike a token minter there is no
/// warm state worth keeping — so it is stopped again as soon as it has answered.
async function fetchCredentials() {
  const worker = boppa.worker('credentials');
  try {
    await withTimeout(worker.start(), CLIENT_ID_TIMEOUT_MS, 'credentials page not ready within ' + CLIENT_ID_TIMEOUT_MS + ' ms');
    const clientId = await workerCallWithin(CLIENT_ID_TIMEOUT_MS, 'credentials', 'clientId');
    if (!clientId) throw new Error('the worker found no client id');
    boppa.store.set('SOUNDCLOUD_CLIENT_ID', clientId);
    log('fetchCredentials: stored client id');
    return clientId;
  } catch (e) {
    log('fetchCredentials FAILED:', (e && e.message) ? e.message : e);
    throw e;
  } finally {
    worker.stop();
  }
}

const streams = {};
let nextStreamId = 1;

boppa.playback.register(credentialedPlayback(['SOUNDCLOUD_CLIENT_ID'], {
  // Runs before the source goes live, and again at every launch. A stored client
  // id is used as it is; only a first launch waits for one.
  init: async function() {
    await ensureCredentials(['SOUNDCLOUD_CLIENT_ID']);
  },

  resolve: async function(track, options) {
    const signal = options?.signal;
    return await withNetworkRetry(signal, 'resolve', async function() {
    const metadata = track.metadata || {};
    const clientId = boppa.store.get('SOUNDCLOUD_CLIENT_ID') || metadata.soundcloudClientId;
    const cookies = await boppa.cookies();

    log('resolve: track', track.id,
      '| cached audio', metadata.audioStreamUrl ? 'yes' : 'no',
      '| stream endpoint', metadata.streamRequestUrl ? 'yes' : 'no',
      '| clientId', clientId ? 'yes' : 'NO');
    if (!clientId) {
      throw credentialsError('Missing SoundCloud client id, open SoundCloud once to refresh it');
    }

    const headers = oauthHeaders(cookies);
    const media = await resolveMediaUrl(track, clientId, cookies,
      { force: false, signal: signal });
    const handle = {
      track: track,
      clientId: clientId,
      cookies: cookies,
      headers: headers,
      media: media,
      signal: signal,
      __spans: []
    };

    if (isHls(media.url, media.protocol)) {
      const playlist = parsePlaylist(await fetchText(media.url, headers, signal), media.url);
      if (!playlist.segments.length) {
        throw new Error('SoundCloud returned an empty HLS playlist');
      }
      const layout = await buildLayout(playlist, headers, cachedLengthsFor(metadata, media),
        signal);
      handle.contentLength = layout.contentLength;
      handle.pieces = layout.pieces;
      handle.rangedSource = false;
      await persistLayout(track, media, layout);

      // fMP4 carries its codec setup in the init segment; an MP3 playlist is packed
      // audio, where every segment is self-describing and there is no init segment.
      const descriptor = {
        kind: 'fragmented',
        mimeType: playlist.init ? 'audio/mp4' : (media.mimeType || 'audio/mpeg'),
        contentLength: layout.contentLength,
        duration: layout.duration || (track.duration || 0) / 1000,
        fragments: layout.fragments,
        chunkBytes: CHUNK_BYTES,
        bufferAheadSeconds: BUFFER_AHEAD_SECONDS,
        handle: handle
      };
      if (layout.initSegment) descriptor.initSegment = layout.initSegment;
      log('resolve: fragmented |', layout.fragments.length, 'fragments |',
        layout.contentLength, 'bytes |', descriptor.mimeType);
      return descriptor;
    }

    const contentLength = await probeLength(media.url, headers, signal);
    handle.contentLength = contentLength;
    handle.pieces = [{ offset: 0, length: contentLength, uri: media.url, sourceOffset: 0 }];
    handle.rangedSource = true;
    await persistTrackMetadata(track, { soundcloudContentLength: contentLength });
    log('resolve: progressive |', contentLength, 'bytes');
    return {
      kind: 'progressive',
      mimeType: playbackMimeType(media.url, media.protocol, media.mimeType),
      contentLength: contentLength,
      duration: (track.duration || 0) / 1000,
      chunkBytes: CHUNK_BYTES,
      bufferAheadSeconds: BUFFER_AHEAD_SECONDS,
      handle: handle
    };
    }, RESOLVE_NETWORK_RETRY_BUDGET_MS);
  },

  openStream: function(handle, request) {
    const streamId = 'js-' + (nextStreamId++);
    const offset = (request && request.offset) || 0;
    streams[streamId] = { handle: handle, cursor: offset };
    log('openStream', streamId, 'at offset', offset,
      '| contentLength', handle.contentLength, '| cached spans', handle.__spans.length);
    return { streamId: streamId };
  },

  pull: async function(_handle, request) {
    const streamId = request.streamId;
    const maxBytes = request.maxBytes || CHUNK_BYTES;
    const stream = streams[streamId];
    if (!stream) throw new Error('pull: unknown stream ' + streamId);

    const handle = stream.handle;
    if (stream.cursor >= handle.contentLength) {
      return { bytes: [], eof: true };
    }

    // The fill may be riding out a network outage (ensureCached retries every
    // range for as long as the track is alive), so never let one pull block
    // past the host's call timeout: after PULL_WAIT_MS answer 'waiting' and let
    // the host pull again. The fill keeps running and the next pull picks it up.
    const throwPendingError = function() {
      if (!stream.pendingError) return;
      const error = stream.pendingError;
      stream.pendingError = null;
      throw error;
    };
    throwPendingError();
    const wanted = Math.min(maxBytes, handle.contentLength - stream.cursor);
    if (!stream.pending) {
      stream.pending = ensureCachedShared(handle, stream.cursor, wanted).then(
        function() { stream.pending = null; },
        function(error) { stream.pending = null; stream.pendingError = error; }
      );
    }
    let settled = false;
    const done = stream.pending.then(function() { settled = true; return true; });
    let timer = null;
    const wait = new Promise(function(resolve) { timer = setTimeout(resolve, PULL_WAIT_MS); });
    await Promise.race([done, wait]);
    clearTimeout(timer);
    if (!settled) await Promise.race([done, Promise.resolve()]);
    throwPendingError();
    if (!settled) {
      return { bytes: [], eof: false, waiting: true };
    }

    const start = stream.cursor;
    const end = Math.min(start + maxBytes - 1, handle.contentLength - 1);
    const out = readCached(handle, start, end);
    if (!out.length) {
      throw fatal('pull: no bytes cached at ' + start + ' (wanted ' + (end - start + 1) + ')');
    }
    stream.cursor = start + out.length;
    return { bytes: out, eof: stream.cursor >= handle.contentLength };
  },

  progress: function() {},

  closeStream: function(_handle, request) {
    const streamId = request && request.streamId;
    if (streamId && streams[streamId]) {
      log('closeStream', streamId, 'at cursor', streams[streamId].cursor);
      delete streams[streamId];
    }
  },

  release: function(handle) {
    if (handle) handle.__spans = [];
  }
}));
