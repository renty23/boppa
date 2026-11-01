// Shared YouTube-family playback container. container/lib/00-mode.js selects
// one path or an ordered matrix of visionOS/MWEB × AAC/Opus paths.
//
// fMP4/AAC (itag 140) streams from a small sidx probe and gives the app exact
// seeks. AVFoundation cannot demux WebM/Opus (251 > 250 > 249), so Opus paths
// rewrite the whole stream into CAF before serving the first byte.
// Per-config settings are injected by container/lib/00-mode.js before this file.
const PLAYBACK = globalThis.BOPPA_YOUTUBE_PLAYBACK;
if (!PLAYBACK || !Array.isArray(PLAYBACK.paths) || !PLAYBACK.paths.length) {
  throw new Error('missing BOPPA_YOUTUBE_PLAYBACK mode');
}
const ACTIVE_PATHS = PLAYBACK.paths.slice();
// A config declares at most one *web* backend: an InnerTube web client whose
// streams need player-JS solving and a WebPoClient token, served through a
// worker page. `mweb` (m.youtube.com, MWEB) and `remix` (music.youtube.com,
// WEB_REMIX) are the two kinds; the prepared-player cache holds one build, so
// one per config. Legacy modes declare it under `mweb`.
const WEB = PLAYBACK.web || (PLAYBACK.mweb ? Object.assign({ name: 'mweb', clientName: 'MWEB', clientId: 2 }, PLAYBACK.mweb) : null);
const WEB_BACKEND = WEB ? WEB.name : null;
const HAS_WEB_PATH = !!WEB_BACKEND && ACTIVE_PATHS.some(function(path) { return path.indexOf(WEB_BACKEND + '-') === 0; });
const WEB_ONLY = HAS_WEB_PATH && ACTIVE_PATHS.every(function(path) { return path.indexOf(WEB_BACKEND + '-') === 0; });
function isWebBackend(backend) { return !!WEB_BACKEND && backend === WEB_BACKEND; }
// Credentials refreshed by workers live here as well as in boppa.store. This
// lets a lazily started MWEB worker feed the current resolve immediately.
const runtimeContext = {};
const activeCredentialWorkers = new Set(PLAYBACK.credentialWorkers);
// What the primary backend (and the data scripts) cannot do without.
const PRIMARY_CREDENTIALS = PLAYBACK.visionos || WEB;
const PRIMARY_CREDENTIAL_KEYS = [PRIMARY_CREDENTIALS.apiKey, PRIMARY_CREDENTIALS.clientVersion].filter(Boolean);
let mwebReadyPromise = null;
// Set once the MWEB worker answered its first credentials call (init warm-up
// or first use). Session detection only waits for a cold worker when it is
// worth it (see detectSessionForResolve).
let mwebWorkerReady = false;
const META_PREFIX = PLAYBACK.metadataPrefix;
function metaKey(suffix) { return META_PREFIX + suffix; }
function metadataValue(metadata, suffix) { return metadata?.[metaKey(suffix)]; }

const OPUS_ITAG_PREFERENCE = [251, 250, 249];
const MP4_ITAG_PREFERENCE = [140];
const CAF_MIME_TYPE = 'audio/x-caf';
// Google Video Server answers a whole-file range as one response; fetching the
// complete WebM in a single request is far faster than 64 KiB pieces and CAF
// needs every packet size before its first byte can be written anyway.
const OPUS_FULL_FETCH = true;
// Chunk size for handing bytes to the app, matching what YouTube Music itself
// requests from googlevideo in the browser: it starts every read at 64 KiB and
// ramps up (observed 65536 → ~515088) , resetting to 64 KiB after a seek.
const CHUNK_BYTES = 65536;
// How many seconds of audio AVPlayer should read ahead. Owned here in the config
// (not in the Swift app) so playback buffering is tunable per media source. The
// proxy caches every fetched byte, so this only bounds how far ahead we pull.
const BUFFER_AHEAD_SECONDS = 30;
const STREAM_EXPIRY_SKEW_SECONDS = 60;
const MAX_PERSISTED_INIT_BYTES = 1024 * 1024;

function googlevideoExpiresAt(url) {
  try {
    const parsed = new URL(String(url));
    const host = parsed.hostname.toLowerCase();
    if (host !== 'googlevideo.com' && !host.endsWith('.googlevideo.com')) return null;
    const expiry = parseInt(parsed.searchParams.get('expire'), 10);
    return Number.isFinite(expiry) && expiry > 0 ? expiry : null;
  } catch (_) {
    return null;
  }
}

function effectiveStreamExpiry(url, persistedExpiry) {
  const urlExpiry = googlevideoExpiresAt(url);
  if (!urlExpiry) return null;
  const persisted = Number(persistedExpiry);
  return Number.isFinite(persisted) && persisted > 0
    ? Math.min(urlExpiry, persisted)
    : urlExpiry;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(value, expectedLength) {
  if (typeof value !== 'string' || !value) return null;
  if (value.length !== 4 * Math.ceil(expectedLength / 3)) return null;
  try {
    const binary = atob(value);
    if (binary.length !== expectedLength) return null;
    const bytes = new Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (_) {
    return null;
  }
}

function cachedFragmentedDescriptor(track, videoId, context, signedIn) {
  // Engine recovery means the descriptor implicated in the failure must not be
  // replayed even if its URL has not expired yet.
  if (track.recovery) return null;
  const metadata = track.metadata || {};
  const url = metadataValue(metadata, 'StreamUrl');
  const backend = String(metadataValue(metadata, 'Backend') || '');
  const storedAuth = metadataValue(metadata, 'Authenticated');
  const authenticated = storedAuth === true || storedAuth === 'true';
  // A signed-in URL must not be served after the user signs out. An anonymous
  // URL is a working public stream and serves anyone; a signed-in user with a
  // live anonymous visionOS descriptor plays it rather than re-resolving via
  // remix (that play is then not on the account's history; accepted).
  const sessionMatches = !authenticated || !!signedIn;
  if (!url || String(metadataValue(metadata, 'VideoId') || '') !== String(videoId)
    || !sessionMatches
    || !ACTIVE_PATHS.includes(backend + '-aac')) return null;

  const expiry = effectiveStreamExpiry(url, metadataValue(metadata, 'StreamExpiresAt'));
  if (!expiry || expiry <= Math.floor(Date.now() / 1000) + STREAM_EXPIRY_SKEW_SECONDS) return null;

  const contentLength = Number(metadataValue(metadata, 'ContentLength'));
  const duration = Number(metadataValue(metadata, 'Duration'));
  const mimeType = String(metadataValue(metadata, 'MimeType') || '');
  const rawInit = metadataValue(metadata, 'InitSegment');
  const rawFragments = metadataValue(metadata, 'Fragments');
  if (!Number.isInteger(contentLength) || contentLength <= 0
    || !Number.isFinite(duration) || duration <= 0
    || !mimeType.startsWith('audio/')
    || !rawInit || !Array.isArray(rawFragments) || !rawFragments.length) return null;

  const initSegment = { offset: Number(rawInit.offset), length: Number(rawInit.length) };
  if (!Number.isInteger(initSegment.offset) || initSegment.offset !== 0
    || !Number.isInteger(initSegment.length) || initSegment.length <= 0) return null;

  let minimumOffset = initSegment.offset + initSegment.length;
  if (minimumOffset > contentLength) return null;
  const fragments = [];
  for (const raw of rawFragments) {
    const fragment = {
      offset: Number(raw?.offset),
      length: Number(raw?.length),
      duration: Number(raw?.duration)
    };
    if (!Number.isInteger(fragment.offset) || fragment.offset < minimumOffset
      || !Number.isInteger(fragment.length) || fragment.length <= 0
      || !Number.isFinite(fragment.duration) || fragment.duration <= 0) return null;
    minimumOffset = fragment.offset + fragment.length;
    if (minimumOffset > contentLength) return null;
    fragments.push(fragment);
  }

  const segments = [{
    byteStart: initSegment.offset,
    byteEnd: initSegment.offset + initSegment.length - 1,
    startTime: 0,
    dur: 0
  }].concat(fragments.map(function(fragment) {
    return {
      byteStart: fragment.offset,
      byteEnd: fragment.offset + fragment.length - 1,
      startTime: 0,
      dur: fragment.duration
    };
  }));
  const handle = {
    url: String(url),
    videoId: videoId,
    // Only MP4 fragment maps are ever persisted (CAF is rebuilt per session),
    // so a re-auth of a restored handle must rebuild the MP4 format.
    itag: MP4_ITAG_PREFERENCE[0],
    backend: backend,
    authenticated: authenticated,
    trackId: track.id,
    metadata: Object.assign({}, metadata),
    context: context,
    contentLength: contentLength,
    duration: duration,
    segments: segments
  };
  const initBytes = initSegment.length <= MAX_PERSISTED_INIT_BYTES
    ? base64ToBytes(metadataValue(metadata, 'InitBytesBase64'), initSegment.length)
    : null;
  if (initBytes) {
    handle.__spans = [{ start: 0, end: initBytes.length - 1, data: initBytes }];
  }
  return {
    kind: 'fragmented',
    mimeType: mimeType,
    contentLength: contentLength,
    duration: duration,
    bufferAheadSeconds: BUFFER_AHEAD_SECONDS,
    chunkBytes: CHUNK_BYTES,
    initSegment: initSegment,
    fragments: fragments,
    handle: handle
  };
}

/// `boppa.updateTrackMetadata` replaces the track's entire metadata object. The
/// carrier (a resolve `track` or a stream `handle`) holds the current metadata;
/// apply `changes` to a copy, write the whole result, and keep the carrier's copy
/// current so later writes in the same session build on it. A `null` value in
/// `changes` drops that key.
async function persistTrackMetadata(carrier, changes) {
  if (!carrier || carrier.trackId == null && carrier.id == null) return false;
  const trackId = carrier.trackId != null ? carrier.trackId : carrier.id;
  const next = Object.assign({}, carrier.metadata || {});
  for (const key of Object.keys(changes || {})) {
    if (changes[key] === null || changes[key] === undefined) {
      delete next[key];
    } else {
      next[key] = changes[key];
    }
  }
  carrier.metadata = next;

  if (typeof boppa.updateTrackMetadata !== 'function') return false;
  try {
    const stored = await boppa.updateTrackMetadata(trackId, next);
    log('persist:', Object.keys(changes || {}).join(','), '| stored', stored);
    return stored;
  } catch (e) {
    log('persist FAILED:', (e && e.message) ? e.message : e);
    return false;
  }
}

const CACHED_STREAM_KEYS = [
  'VideoId', 'Backend', 'Authenticated', 'StreamUrl', 'StreamExpiresAt', 'StreamResolvedAt',
  'ContentLength', 'MimeType', 'Duration', 'InitSegment', 'InitBytesBase64', 'Fragments'
].map(metaKey);

function cachedStreamClearPatch() {
  const changes = {};
  for (const key of CACHED_STREAM_KEYS) changes[key] = null;
  return changes;
}

async function clearCachedStream(carrier) {
  return persistTrackMetadata(carrier, cachedStreamClearPatch());
}

async function persistFragmentedDescriptor(carrier, videoId, backend, url, descriptor, initBytes, authenticated) {
  const changes = {};
  changes[metaKey('VideoId')] = String(videoId);
  changes[metaKey('Backend')] = String(backend);
  changes[metaKey('Authenticated')] = !!authenticated;
  changes[metaKey('StreamUrl')] = String(url);
  changes[metaKey('StreamExpiresAt')] = googlevideoExpiresAt(url);
  changes[metaKey('StreamResolvedAt')] = Math.floor(Date.now() / 1000);
  changes[metaKey('ContentLength')] = descriptor.contentLength;
  changes[metaKey('MimeType')] = descriptor.mimeType;
  changes[metaKey('Duration')] = descriptor.duration;
  changes[metaKey('InitSegment')] = descriptor.initSegment;
  changes[metaKey('InitBytesBase64')] = initBytes.length <= MAX_PERSISTED_INIT_BYTES
    ? bytesToBase64(initBytes)
    : null;
  changes[metaKey('Fragments')] = descriptor.fragments;
  return persistTrackMetadata(carrier, changes);
}

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint64(bytes, offset) {
  return readUint32(bytes, offset) * 4294967296 + readUint32(bytes, offset + 4);
}

function parseSidx(bytes, indexRangeEnd) {
  let offset = 0;
  let sidxOffset = -1;
  while (offset + 8 <= bytes.length) {
    const size = readUint32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === 'sidx') { sidxOffset = offset; break; }
    if (!size) break;
    offset += size;
  }
  if (sidxOffset < 0) throw new Error('sidx box not found in the index range');

  let p = sidxOffset + 8;
  const version = bytes[p];
  p += 4;
  p += 4;
  const timescale = readUint32(bytes, p);
  p += 4;
  let earliest, firstOffset;
  if (version === 0) {
    earliest = readUint32(bytes, p); p += 4;
    firstOffset = readUint32(bytes, p); p += 4;
  } else {
    earliest = readUint64(bytes, p); p += 8;
    firstOffset = readUint64(bytes, p); p += 8;
  }
  p += 2;
  const refCount = readUint16(bytes, p);
  p += 2;

  let byteOffset = indexRangeEnd + 1 + firstOffset;
  let timeTicks = earliest;
  const segments = [{ byteStart: 0, byteEnd: indexRangeEnd, startTime: 0, dur: 0 }];
  for (let i = 0; i < refCount; i++) {
    const word = readUint32(bytes, p); p += 4;
    const refSize = word & 0x7fffffff;
    const subDur = readUint32(bytes, p); p += 4;
    p += 4;
    segments.push({
      byteStart: byteOffset,
      byteEnd: byteOffset + refSize - 1,
      startTime: timeTicks / timescale,
      dur: subDur / timescale
    });
    byteOffset += refSize;
    timeTicks += subDur;
  }
  return segments;
}

/// fetch() bounded by a stall budget. The budget aborts only this request; the
/// caller's own signal still aborts it too. A timed-out request fails with a
/// message the network classifier recognises so the caller retries.
async function fetchWithStallBudget(url, signal, budgetMs) {
  if (signal && signal.aborted) throw (signal.reason || new Error('aborted'));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (!controller) return fetch(url, { signal: signal });
  let timedOut = false;
  const timer = setTimeout(function() { timedOut = true; controller.abort(); }, budgetMs);
  const onAbort = function() { controller.abort(); };
  if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (e) {
    if (timedOut && !(signal && signal.aborted)) throw new Error('range request stalled for ' + budgetMs + ' ms');
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
  }
}

/// Transport-level failures: the request never got an HTTP answer. These are
/// retried without limit while the track is alive, because the only cure is
/// time (the connection comes back) and giving up means a stopped track.
/// HTTP status failures are not in this set; they are handled by status.
// Mirrors the engine's `isNetworkError` (NSURLError -1001/-1003/-1004/-1005/
// -1006/-1008/-1009/-1018/-1019/-1020/-1200). The host passes `localizedDescription` only,
// so this matches CFNetwork's and WebKit's user-facing texts. Answers the server
// already gave (status codes, bad bodies, redirect loops) are deliberately not
// here: repeating those requests does not change the answer.
function isNetworkFailure(error) {
  const message = String((error && error.message) || error);
  return (/network connection was lost|not connected to the internet|internet connection appears to be offline|request timed out|stalled for \d+ ms|could not connect to the server|cannot connect to host|connection reset|connection refused|server with the specified hostname could not be found|hostname could not be found|\bdns\b|network is down|network is unreachable|software caused connection abort|data connection is not currently allowed|international roaming is currently off|a phone call is in progress|SSL error has occurred|secure connection to the server cannot be made|^Load failed$|: Load failed$/i.test(message)
    || /\((?:NSURLErrorDomain|kCFErrorDomainCFNetwork) error -(?:1001|1003|1004|1005|1006|1008|1009|1018|1019|1020|1200)\.\)/.test(message))
    && !/failed with \d{3}/.test(message);
}

// A range request that has not completed within its budget is treated as dead.
// On a broken connection URLSession can sit for 80+ s before reporting a lost
// connection (all (26).log: one 160 KiB range took 84 s), which is longer than
// anything upstream will wait; cut it off and let the retry loop try again.
// The host's fetch resolves only once the whole body is buffered, so the
// budget covers the transfer, not just the first byte: a fixed floor plus time
// for the bytes at a slow-but-working link rate (16 KiB/s ≈ 128 kbit/s). A
// 160 KiB fragment gets 22 s; a 4 MiB whole-file Opus fetch about 4.5 min.
const RANGE_STALL_FLOOR_MS = 12000;
const RANGE_STALL_MIN_BYTES_PER_SEC = 16 * 1024;

function rangeStallBudgetMs(start, end) {
  const bytes = Math.max(0, end - start + 1);
  return RANGE_STALL_FLOOR_MS + Math.ceil(bytes / RANGE_STALL_MIN_BYTES_PER_SEC) * 1000;
}

/// `signal` is the caller's abort; the stall budget is combined with it.
async function fetchRange(url, start, end, signal) {
  const query = '&range=' + start + '-' + end;
  let target = url + query + '&alr=yes';
  const budgetMs = rangeStallBudgetMs(start, end);
  for (let depth = 0; depth < 5; depth++) {
    const response = await fetchWithStallBudget(target, signal, budgetMs);
    if (!response.ok && response.status !== 206) {
      throw new Error('range fetch failed with ' + response.status);
    }
    const contentType = String(response.headers.get('content-type') || '');
    if (contentType.indexOf('text/plain') === -1) return response.bytes();

    const body = String(await response.text()).trim();
    if (body.slice(0, 5) !== 'https') {
      throw new Error('unexpected text/plain body for range ' + start + '-' + end);
    }
    log('fetchRange: alr redirect to', body.slice(0, 120));
    target = body;
    if (target.indexOf('range=') === -1) target += query;
    if (target.indexOf('alr=') === -1) target += '&alr=yes';
  }
  throw new Error('too many redirects fetching range ' + start + '-' + end);
}

/// Resolve a context key named by the mode file. YouTube Music uses its own
/// credentials for visionOS, but MWEB always uses www.youtube.com's credentials
/// and WebPoClient worker; plain YouTube uses the same context for both.
function backendConfig(backend) {
  return isWebBackend(backend) ? WEB : PLAYBACK[backend];
}

function backendCredentials(context, backend) {
  const cfg = backendConfig(backend);
  return {
    apiKey: context[cfg.apiKey] || runtimeContext[cfg.apiKey],
    clientVersion: context[cfg.clientVersion] || runtimeContext[cfg.clientVersion] || '',
    playerPath: context[cfg.playerPath] || runtimeContext[cfg.playerPath] || '',
    visitorData: context[cfg.visitorData] || runtimeContext[cfg.visitorData] || ''
  };
}

function credentialKeys() {
  const keys = new Set();
  for (const cfg of [PLAYBACK.visionos, PLAYBACK.mweb, PLAYBACK.web]) {
    if (!cfg) continue;
    for (const field of ['apiKey', 'clientVersion', 'playerPath', 'visitorData']) {
      if (cfg[field]) keys.add(cfg[field]);
    }
  }
  return keys;
}

function storedCredentials() {
  const values = {};
  for (const key of credentialKeys()) {
    const value = boppa.store.get(key);
    if (value !== null) values[key] = value;
  }
  return values;
}

function storeCredentials(values) {
  for (const key of Object.keys(values)) {
    if (values[key] !== undefined && values[key] !== null) boppa.store.set(key, String(values[key]));
  }
}

const VISIONOS_CLIENT = {
  clientName: 'VISIONOS',
  clientVersion: '1.02',
  deviceMake: 'Apple',
  deviceModel: 'RealityDevice17,1',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  osName: 'visionOS',
  osVersion: '26.5.23O471',
  hl: 'en',
  gl: 'US'
};
// ---- visionOS visitor identity ----
// visionOS is a native client. Its visitor must not come from the source's
// WebView: that visitor is shared with the web UI and (in mixed configs) the
// www.youtube.com WebPO worker page, and GVS has rejected URLs minted for it
// (`all (11)`: 0/116 with the WebView visitor vs 82/82 with a fresh one on the
// same device, IP and account). InnerTube's visitor_id endpoint issues one for
// the client itself; it is kept in the store and rotated on a GVS 403 repair
// or after a day, so a flagged visitor never sticks.
const STORE_KEY_VISIONOS_VISITOR = 'visionos.visitorData';
const STORE_KEY_VISIONOS_VISITOR_AT = 'visionos.visitorMintedAt';
const VISIONOS_VISITOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VISIONOS_VISITOR_MINT_TIMEOUT_MS = 3000;
// After a failed mint the WebView visitor is used without re-minting for a
// while, so an outage costs one round trip per minute, not one per resolve.
const VISIONOS_VISITOR_MINT_COOLDOWN_MS = 60 * 1000;
// In-memory copy of the stored visitor (same age rule), so a store that cannot
// persist still rotates on time.
let visionosVisitorState = null;
let visionosVisitorPromise = null;
let visionosVisitorMintFailedAt = 0;

function currentVisionosVisitor() {
  if (!visionosVisitorState) {
    try {
      const value = boppa.store.get(STORE_KEY_VISIONOS_VISITOR);
      const at = parseInt(boppa.store.get(STORE_KEY_VISIONOS_VISITOR_AT) || '0', 10);
      if (value && at) visionosVisitorState = { visitorData: value, mintedAt: at };
    } catch (e) {}
  }
  if (visionosVisitorState && Date.now() - visionosVisitorState.mintedAt < VISIONOS_VISITOR_MAX_AGE_MS) {
    return visionosVisitorState.visitorData;
  }
  return null;
}

function discardVisionosVisitor(reason, visitorData) {
  // When the caller knows which visitor its URL was minted under, only that
  // one is discarded: a newer, working visitor is not thrown away for a URL
  // from an older one.
  if (visitorData && visionosVisitorState && visionosVisitorState.visitorData !== visitorData) {
    log('visionos visitor: keeping current visitor; the rejected URL belonged to an older one');
    return;
  }
  log('visionos visitor: discarding -', reason);
  visionosVisitorState = null;
  visionosVisitorPromise = null;
  try {
    boppa.store.remove(STORE_KEY_VISIONOS_VISITOR);
    boppa.store.remove(STORE_KEY_VISIONOS_VISITOR_AT);
  } catch (e) {}
}

// Not tied to any resolve's signal: the mint is shared, and one caller's skip
// must not fail the others. Bounded by its own timeout instead.
async function mintVisionosVisitor(apiKey) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(function() { if (controller) controller.abort(); }, VISIONOS_VISITOR_MINT_TIMEOUT_MS);
  try {
    const response = await fetch(
      PLAYBACK.visionos.host + '/youtubei/v1/visitor_id?prettyPrint=false&key=' + encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { client: VISIONOS_CLIENT } }),
        signal: controller ? controller.signal : undefined
      }
    );
    if (response.status !== 200) throw new Error('visitor_id returned HTTP ' + response.status);
    let payload;
    try { payload = await response.json(); } catch (e) { throw new Error('visitor_id returned non-JSON'); }
    const visitor = payload && payload.responseContext && payload.responseContext.visitorData;
    if (!visitor) throw new Error('visitor_id returned no visitorData');
    const mintedAt = Date.now();
    visionosVisitorState = { visitorData: visitor, mintedAt: mintedAt };
    try {
      boppa.store.set(STORE_KEY_VISIONOS_VISITOR, visitor);
      boppa.store.set(STORE_KEY_VISIONOS_VISITOR_AT, String(mintedAt));
    } catch (e) {}
    log('visionos visitor: minted', visitor.length, 'chars');
    return visitor;
  } finally {
    clearTimeout(timer);
  }
}

/// The visitor the visionOS player request runs under. Owned by this client;
/// the WebView visitor from `credentials` is used only if minting fails, so a
/// visitor_id outage degrades to the previous behaviour rather than to no
/// playback.
async function visionosVisitor(credentials, signal) {
  const current = currentVisionosVisitor();
  if (current) return { visitorData: current, source: 'owned' };
  const fallback = function(error) {
    if (!credentials.visitorData) throw error;
    warn('visionos visitor: minting failed (' + ((error && error.message) || error) + ') - falling back to the WebView visitor');
    return { visitorData: credentials.visitorData, source: 'webview' };
  };
  if (Date.now() - visionosVisitorMintFailedAt < VISIONOS_VISITOR_MINT_COOLDOWN_MS) {
    return fallback(new Error('recent visitor_id failure, in cooldown'));
  }
  if (!visionosVisitorPromise) {
    const pending = mintVisionosVisitor(credentials.apiKey);
    visionosVisitorPromise = pending;
    pending.then(function() {
      // Keep nothing in flight once settled; the state/store carry the result.
      if (visionosVisitorPromise === pending) visionosVisitorPromise = null;
    }, function() {
      visionosVisitorMintFailedAt = Date.now();
      if (visionosVisitorPromise === pending) visionosVisitorPromise = null;
    });
  }
  try {
    const visitor = await visionosVisitorPromise;
    signal?.throwIfAborted();
    return { visitorData: visitor, source: 'owned' };
  } catch (e) {
    if (signal?.aborted) throw e;
    return fallback(e);
  }
}

/// Mixed configs keep MWEB as a true fallback: start its full YouTube page
/// only when resolution reaches an MWEB path. Single-MWEB configs may already
/// have started it during init; worker.start() is idempotent.
async function ensureMwebReady() {
  if (mwebReadyPromise) return mwebReadyPromise;
  const workerName = WEB.worker;
  mwebReadyPromise = (async function() {
    await boppa.worker(workerName).start();
    const values = await workerCall(workerName, 'credentials');
    if (!values) throw new Error('MWEB worker returned no credentials');
    // Once a mixed config has reached MWEB, that worker's visitor context is
    // refreshed along with the primary credentials.
    activeCredentialWorkers.add(workerName);
    Object.assign(runtimeContext, values);
    storeCredentials(values);
    mwebWorkerReady = true;
    return values;
  })().catch(function(error) {
    mwebReadyPromise = null;
    throw error;
  });
  return mwebReadyPromise;
}

// ---- Signed-in sessions ----
// Whether the user is signed in is answered by the MWEB worker, which owns the
// WKWebsiteDataStore jar the login popup writes to. Only MWEB paths can use it.
const ANONYMOUS_SESSION = { signedIn: false };

// Google's account cookies. SAPISID is set on sign-in and cleared on sign-out;
// YouTube's own page keys SAPISIDHASH on it. Either name proves a session.
const SESSION_COOKIE_NAMES = ['__Secure-3PAPISID', 'SAPISID'];

/// Session state from the source's cookies, read fresh from WebKit with
/// boppa.cookies(), so this is authoritative and costs nothing. Returns null
/// when no jar could be read, so callers can fall back to the worker.
function sessionFromCookies(cookies) {
  if (!cookies || typeof cookies !== 'object') return null;
  for (const name of SESSION_COOKIE_NAMES) {
    if (cookies[name]) return { signedIn: true };
  }
  return ANONYMOUS_SESSION;
}

async function readCookies() {
  try {
    return await boppa.cookies();
  } catch (e) {
    return null;
  }
}
// Last session state the worker reported, persisted so a cold start knows
// whether waiting for the WebView is worth it.
const STORE_KEY_SESSION = 'session.signedIn';
// Budgets. A cold MWEB WebView takes ~3 s on device. An anonymous user must
// never wait for it (the visionOS order does not need it); a user last seen
// signed in needs the worker for MWEB anyway, so waiting is not wasted.
const SESSION_DETECT_WARM_MS = 3000;
const SESSION_DETECT_COLD_SIGNED_IN_MS = 10000;
// After the login popup closes, the cookie can take a moment to reach the
// worker's document. Poll briefly before concluding the user did not sign in.
const SESSION_AFTER_LOGIN_POLLS = 4;
const SESSION_AFTER_LOGIN_POLL_MS = 500;
let lastKnownSignedIn = null;

function rememberSession(state) {
  lastKnownSignedIn = !!state.signedIn;
  try { boppa.store.set(STORE_KEY_SESSION, state.signedIn ? 'true' : 'false'); } catch (e) {}
  return state;
}

/// The worker page (www.youtube.com) was loaded under one session. Its
/// WebPoClient attestation, visitor and page config all belong to that session;
/// after a sign-in or sign-out they no longer match the cookies, and GVS
/// rejected every URL minted that way on device (all (14).log: signed in via
/// the popup, every Yeat track 403'd on mweb-aac until cookies were cleared).
/// Reload the page so everything comes from the current session.
async function restartMwebWorker(reason) {
  const workerName = WEB.worker;
  warn('mweb worker: restarting so its page matches the current session -', reason);
  try { boppa.worker(workerName).stop(); } catch (e) {}
  mwebReadyPromise = null;
  mwebWorkerReady = false;
  await ensureMwebReady();
}

/// Reconcile a freshly observed session state with the worker page. Called
/// with the cookie-derived state; when it differs from what the worker was
/// last known to run under, the page is reloaded (if the worker is up at all).
async function noteSession(state) {
  if (mwebWorkerReady && lastKnownSignedIn !== null && lastKnownSignedIn !== !!state.signedIn) {
    await restartMwebWorker(state.signedIn ? 'user signed in' : 'user signed out');
  }
  return rememberSession(state);
}

async function querySession() {
  await ensureMwebReady();
  let state = await workerCall(WEB.worker, 'session');
  state = state && state.signedIn ? state : ANONYMOUS_SESSION;
  if (lastKnownSignedIn !== null && lastKnownSignedIn !== !!state.signedIn) {
    await restartMwebWorker(state.signedIn ? 'user signed in' : 'user signed out');
  }
  return rememberSession(state);
}

/// Ask the MWEB worker whether the user is signed in, bounded by `budgetMs`.
/// Any failure or timeout means anonymous.
async function detectSession(budgetMs) {
  if (!HAS_WEB_PATH) return ANONYMOUS_SESSION;
  let timer = null;
  try {
    const query = querySession();
    return await Promise.race([query, new Promise(function(_, reject) {
      timer = setTimeout(function() { reject(new Error('session detection exceeded ' + budgetMs + ' ms')); }, budgetMs);
    })]);
  } catch (e) {
    log('detectSession: unavailable, treating as anonymous:', (e && e.message) || e);
    return ANONYMOUS_SESSION;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/// Session state at the start of a resolve. Only MWEB paths can carry a
/// session; a visionOS-only config has nothing to gain from knowing, and must
/// not start a worker it does not ship.
async function detectSessionForResolve(track) {
  if (!HAS_WEB_PATH) return ANONYMOUS_SESSION;
  const fromCookies = sessionFromCookies(await readCookies());
  if (fromCookies) return noteSession(fromCookies);
  // No jar could be read: ask the worker page.
  if (mwebWorkerReady) return detectSession(SESSION_DETECT_WARM_MS);
  // A cold worker page is loaded under the current cookies, so whatever it
  // reports first is consistent with itself: no restart on the first answer.
  lastKnownSignedIn = null;
  // Every path needs the worker anyway: waiting costs nothing extra.
  if (WEB_ONLY) return detectSession(SESSION_DETECT_COLD_SIGNED_IN_MS);
  let lastKnown = false;
  try { lastKnown = boppa.store.get(STORE_KEY_SESSION) === 'true'; } catch (e) {}
  if (lastKnown) return detectSession(SESSION_DETECT_COLD_SIGNED_IN_MS);
  // Cold worker, no session expected: do not delay the anonymous order. Refresh
  // the stored state in the background for the next resolve.
  querySession().catch(function() {});
  return ANONYMOUS_SESSION;
}

/// After the login popup. The jar read fresh from WebKit decides immediately,
/// and the worker is polled only if no jar could be read.
async function detectSessionAfterLogin() {
  const fromCookies = sessionFromCookies(await readCookies());
  if (fromCookies) return noteSession(fromCookies);
  for (let poll = 0; poll < SESSION_AFTER_LOGIN_POLLS; poll++) {
    const state = await detectSession(SESSION_DETECT_WARM_MS);
    if (state.signedIn) return state;
    await new Promise(function(resolve) { setTimeout(resolve, SESSION_AFTER_LOGIN_POLL_MS); });
  }
  return ANONYMOUS_SESSION;
}

/// Paths to try for this resolve, in order.
///
/// Anonymous: the configured order (visionOS first in the main configs: one
/// request, no solving, no token, never in the GVS activation window).
/// Signed in: the web backend's paths first, then the rest. The web /player
/// then carries the session, so account-gated tracks play directly and public
/// tracks are played as the account (history, preferences). This only makes
/// sense for a web backend that is not activation-gated (WEB_REMIX, spc 67); an
/// MWEB-first signed-in order would pay the ~11 s window on every enforced track,
/// so legacy `mweb` modes keep the configured order.
function pathsForSession(signedIn) {
  if (!signedIn || !WEB || WEB.name !== 'remix') return ACTIVE_PATHS.slice();
  const web = ACTIVE_PATHS.filter(function(path) { return path.indexOf(WEB_BACKEND + '-') === 0; });
  const rest = ACTIVE_PATHS.filter(function(path) { return path.indexOf(WEB_BACKEND + '-') !== 0; });
  return web.concat(rest);
}

/// InnerTube answered but refused to hand out streams (see fetchStreamingData).
function isPlayabilityRefusal(error) {
  return / returned no stream \(/.test(String((error && error.message) || error));
}

/// The refusal is about the account, not the client: age gate, private video,
/// members-only. Only a signed-in session can change it.
function isLoginRequired(error) {
  return isPlayabilityRefusal(error) && /\(LOGIN_REQUIRED:/.test(String((error && error.message) || error));
}

/// One InnerTube response serves both codec attempts for a backend.
async function fetchStreamingData(videoId, context, signal, backend, signedIn) {
  if (isWebBackend(backend)) await ensureMwebReady();
  const credentials = backendCredentials(context, backend);
  // visionOS owns its visitor (see visionosVisitor); MWEB's comes from its worker.
  const incomplete = !credentials.apiKey
    || isWebBackend(backend) && (!credentials.visitorData || !credentials.clientVersion);
  if (incomplete) throw new Error(backend + ' credentials are incomplete');

  let player = null;
  let payload;
  let visionosVisitorUsed = null;
  if (isWebBackend(backend)) {
    // The worker request shares www.youtube.com's configured WebView UA and
    // cookies with WebPoClient. Load the exact player path it published first,
    // then use that build's STS for the request. If the page rotated between
    // credentials and this call, load the new build and repeat once.
    signal?.throwIfAborted();
    player = await loadPlayer(credentials.playerPath);
    let result = await workerCall(WEB.worker, 'player', {
      videoId: videoId,
      signatureTimestamp: player.signatureTimestamp,
      signedIn: !!signedIn
    });
    signal?.throwIfAborted();
    payload = result || {};
    const responsePath = mainPlayerPath(payload.playerJsUrl);
    if (responsePath && responsePath !== player.url) {
      runtimeContext[WEB.playerPath] = payload.playerJsUrl;
      player = await loadPlayer(payload.playerJsUrl);
      result = await workerCall(WEB.worker, 'player', {
        videoId: videoId,
        signatureTimestamp: player.signatureTimestamp,
        signedIn: !!signedIn
      });
      signal?.throwIfAborted();
      payload = result || {};
    }
    if (payload.playerJsUrl) runtimeContext[WEB.playerPath] = payload.playerJsUrl;
    log('fetchStreamingData:', backend, 'worker status', payload.status, payload.authenticated ? '(signed in)' : '(anonymous)');
  } else if (backend === 'visionos') {
    const visitor = await visionosVisitor(credentials, signal);
    visionosVisitorUsed = visitor.visitorData;
    const client = Object.assign({}, VISIONOS_CLIENT);
    client.visitorData = visitor.visitorData;
    const response = await credentialFetch(
      backendConfig(backend).host + '/youtubei/v1/player?prettyPrint=false&key=' + encodeURIComponent(credentials.apiKey),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Visitor-Id': visitor.visitorData },
        body: JSON.stringify({
          context: { client: client },
          videoId: videoId,
          contentCheckOk: true,
          racyCheckOk: true
        }),
        signal: signal
      }
    );
    log('fetchStreamingData: visionos status', response.status, '| visitor', visitor.source, visitor.visitorData.length, 'chars');
    payload = await response.json();
  } else {
    throw new Error('unknown playback backend ' + backend);
  }

  const playability = payload.playabilityStatus || {};
  if (!payload.streamingData) {
    const status = payload.status && payload.status !== 200 ? ' player failed with ' + payload.status : ' returned no stream';
    throw new Error(backend + status + ' (' + playability.status + ': ' +
      (playability.reason || 'no reason') + ')');
  }
  return {
    backend: backend,
    player: player,
    streamingData: payload.streamingData,
    authenticated: !!payload.authenticated,
    visitorData: visionosVisitorUsed
  };
}

/// Modern www.youtube.com MWEB streams require the token produced by the
/// site's WebPoClient.mws API. The older raw BotGuard minter envelope is rejected
/// by GVS even though it looks like a PO token. The worker owns the live page.
async function mintPoToken(videoId) {
  await ensureMwebReady();
  for (let attempt = 0; attempt < MINT_MAX_ATTEMPTS; attempt++) {
    try {
      const token = await workerCall(WEB.worker, 'mint', videoId);
      if (token) return token;
      log('mintPoToken: empty token, attempt', attempt + 1);
    } catch (e) {
      log('mintPoToken:', (e && e.message) || e, 'attempt', attempt + 1);
    }
    if (attempt < MINT_MAX_ATTEMPTS - 1) await sleep(backoffDelay(attempt));
  }
  throw new Error('WebPoClient could not mint a video token');
}

async function signFormat(fetched, format, videoId, signal, state) {
  if (fetched.backend === 'visionos') {
    if (!format.url) throw new Error('visionos format ' + format.itag + ' has no URL');
    return { url: format.url, format: format, authenticated: !!fetched.authenticated, visitorData: fetched.visitorData || null };
  }
  let url = await decipher(fetched.player, format);
  if (!state.mwebToken) state.mwebToken = await mintPoToken(videoId);
  signal?.throwIfAborted();
  url += '&pot=' + encodeURIComponent(state.mwebToken);
  return { url: url, format: format, authenticated: !!fetched.authenticated, visitorData: fetched.visitorData || null };
}

/// Rebuild one backend's URL for an in-flight stream, pinning the itag.
async function buildStreamUrl(videoId, context, signal, preferItag, backend, signedIn) {
  const fetched = await fetchStreamingDataResilient(videoId, context, signal, backend, signedIn);
  const format = pickAudioFormat(fetched.streamingData, [preferItag], true);
  if (!format) throw new Error(backend + ' no longer offers itag ' + preferItag);
  return signFormat(fetched, format, videoId, signal, {});
}


/// Fetch the full WebM for a signed Opus URL. One request for the whole file:
/// GVS honours a complete `range=0-N` and this is much faster than the 64 KiB
/// pieces the fragmented path uses. Reuses fetchRange so `alr` redirects and
/// the PO-token stub detection behave exactly as they do for MP4.
async function fetchWholeOpus(url, contentLength, signal) {
  const bytes = await fetchRange(url, 0, contentLength - 1, signal);
  if (bytes.length !== contentLength) {
    // A short body here is the token-less 1 MiB stub or a truncated transfer;
    // either way the WebM is unusable, so let the caller fall back to MP4.
    throw new Error('opus fetch short: got ' + bytes.length + ' of ' + contentLength);
  }
  return bytes;
}

/// Prove the URL can serve the entire object, not just its initial allowance.
/// Some GVS risk decisions return 200 for roughly the first MiB and 403 beyond
/// it; an sidx-only resolve would otherwise start playing and stall later. One
/// byte at the tail turns that into a normal path failure while fallback is
/// still possible.
/// Compact fingerprint of a signed GVS URL for diagnostics. Device logs truncate
/// URLs, which hid why identical visionOS requests from two configs could get
/// different GVS decisions. Only authorization-relevant parameters are logged;
/// the signature/token values themselves are reduced to length + prefix.
function gvsFingerprint(url) {
  try {
    const u = new URL(String(url));
    const q = u.searchParams;
    const brief = function(name) {
      const v = q.get(name);
      return v ? name + '=' + v.slice(0, 6) + '..' + v.length : name + '=-';
    };
    return [
      'host=' + u.hostname,
      'c=' + (q.get('c') || '-'),
      'itag=' + (q.get('itag') || '-'),
      'expire=' + (q.get('expire') || '-'),
      'ip=' + (q.get('ip') || '-'),
      'sparams=' + (q.get('sparams') || '-'),
      brief('spc'), brief('sig'), brief('lsig'), brief('pot'), brief('n'),
      'sefc=' + (q.get('sefc') || '-'),
      'svpuc=' + (q.get('svpuc') || '-')
    ].join(' ');
  } catch (e) {
    return 'unparseable';
  }
}

// A freshly minted GVS URL whose session is token-enforced (long `spc`) is
// refused with 403 for roughly the first 11 s after /player issues it, then
// accepted; the token is not the gated part (a brand-new token on an old URL
// is accepted at once). Measured on the simulator and from a Mac polling the
// same URL every second: 403 until +10.4 s, 200 from +11.7 s on. The app
// probed within 300 ms and re-minted on failure, so it always landed in the
// window. Wait it out on the same URL instead.
const GVS_ACTIVATION_RETRY_MS = [2000, 2500, 3500, 4000, 4000];
// Only MWEB sessions with the long `spc` enforce the token and show the
// activation window; visionOS and short-spc MWEB URLs either play at once or
// are rejected for good (visitor/identity), where waiting cannot help.
const GVS_TOKEN_ENFORCED_SPC_MIN = 90;

function isActivationGated(url) {
  try {
    const q = new URL(String(url)).searchParams;
    const c = q.get('c'); return (c === 'MWEB' || c === 'WEB_REMIX') && String(q.get('spc') || '').length >= GVS_TOKEN_ENFORCED_SPC_MIN;
  } catch (e) {
    return false;
  }
}

/// Same test on a /player format, before any deciphering or fetching.
function formatIsActivationGated(format) {
  if (!format) return false;
  if (format.url) return isActivationGated(format.url);
  try {
    const cipher = new URLSearchParams(String(format.signatureCipher || format.cipher || ''));
    return isActivationGated(cipher.get('url') || '');
  } catch (e) {
    return false;
  }
}

/// Whether an MWEB /player response puts this track in the token-enforced
/// bucket. Deterministic per video in every device log; the bucket is not
/// about gating or ownership (an age-gated track was short-spc, a public label
/// release long-spc), and the blob itself is opaque.
function streamingDataIsActivationGated(streamingData) {
  const formats = (streamingData && streamingData.adaptiveFormats) || [];
  for (const format of formats) {
    if (String(format.mimeType || '').indexOf('audio') === 0 && formatIsActivationGated(format)) return true;
  }
  return false;
}

/// `options.grace`: a per-resolve budget object ({ used: false }). The window
/// is waited out at most once per resolve: a URL that is still refused after
/// the full window is a genuine rejection, and the same-path repair that
/// follows must not spend another 16 s, or the engine's 30 s call timeout fires
/// before the ordered fallback gets its turn.
async function validateWholeStreamAccess(url, contentLength, signal, label, options) {
  if (!Number.isInteger(contentLength) || contentLength <= 0) return;
  const grace = options && options.grace;
  const eligible = !!grace && !grace.used && isActivationGated(url);
  try {
    let tail;
    for (let attempt = 0; ; attempt++) {
      try {
        tail = await fetchRange(url, contentLength - 1, contentLength - 1, signal);
        break;
      } catch (e) {
        const message = (e && e.message) || String(e);
        if (!eligible || !/failed with 403\b/.test(message) || attempt >= GVS_ACTIVATION_RETRY_MS.length) {
          if (eligible && attempt > 0) grace.used = true;
          throw e;
        }
        if (signal?.aborted) throw e;
        grace.used = true;
        warn('gvs probe', label || '', 'refused a just-minted URL (403) - waiting',
          GVS_ACTIVATION_RETRY_MS[attempt], 'ms for it to activate (attempt', (attempt + 1) + '/' + GVS_ACTIVATION_RETRY_MS.length + ')');
        await sleep(GVS_ACTIVATION_RETRY_MS[attempt], signal);
        signal?.throwIfAborted();
      }
    }
    if (tail.length !== 1) throw new Error('tail access probe returned ' + tail.length + ' bytes');
    log('gvs probe OK', label || '', gvsFingerprint(url));
  } catch (e) {
    if (!signal?.aborted) {
      warn('gvs probe FAILED', label || '', (e && e.message) || e, '|', gvsFingerprint(url));
      if (WEB_BACKEND && String(label).indexOf(WEB_BACKEND + ' ') === 0 && isAuthFailure((e && e.message) || e)) {
        await diagnoseRejectedMwebUrl(url, contentLength, signal);
      }
    }
    throw e;
  }
}

/// Diagnostic for device logs: GVS rejected a URL the MWEB worker page minted
/// the token for. Fetch the same byte from that page and record the status, to
/// tell a URL-level rejection (page fails too) from a channel-level one (page
/// succeeds, container fails).
async function diagnoseRejectedMwebUrl(url, contentLength, signal) {
  try {
    const probeUrl = url + '&range=' + (contentLength - 1) + '-' + (contentLength - 1);
    const result = await workerCall(WEB.worker, 'probe', { url: probeUrl });
    signal?.throwIfAborted();
    warn('gvs diag: same URL fetched from the worker page ->', result && result.status,
      result && result.error ? result.error : '', (result && result.ms) + ' ms',
      '| container fetch 403; if the minter page gets 200 the rejection is per channel, not per URL');
    if (result && result.env) warn('gvs diag: worker page env', JSON.stringify(result.env));
    // Full URL so the rejection can be replayed off-device while it is valid.
    warn('gvs diag: rejected url', probeUrl);
  } catch (diagError) {
    if (signal?.aborted) return;
    log('gvs diag: worker probe unavailable:', (diagError && diagError.message) || diagError);
  }
}

/// Resolve an AAC path: sign/select itag 140, validate tail access, probe its
/// sidx, and hand the app a fragment map. Returns null when this backend has no
/// AAC format.
async function resolveMp4Descriptor(track, videoId, context, fetched, signal, state) {
  const mp4Format = pickAudioFormat(fetched.streamingData, MP4_ITAG_PREFERENCE, true);
  if (!mp4Format) return null;
  const built = await signFormat(fetched, mp4Format, videoId, signal, state);
  const format = built.format;
  const url = built.url;

  const contentLength = parseInt(format.contentLength, 10);
  const duration = (parseInt(format.approxDurationMs, 10) || 0) / 1000;
  const indexRangeEnd = format.indexRange ? parseInt(format.indexRange.end, 10) : 0;

  await validateWholeStreamAccess(url, contentLength, signal, fetched.backend + ' itag ' + format.itag, { grace: state.activationGrace });
  log('resolve: tail access validated for', fetched.backend, 'itag', format.itag);
  log('resolve: contentLength', contentLength || 'NONE', '| duration', duration, '| mime', format.mimeType);
  if (!contentLength || !indexRangeEnd) {
    log('resolve: no contentLength/indexRange, handing the url straight to the player');
    await clearCachedStream(track);
    return { kind: 'direct', url: url, mimeType: format.mimeType, duration: duration };
  }

  // Everything needed to re-authenticate this stream later without another
  // resolve() round trip from the app.
  const handle = {
    url: url,
    videoId: videoId,
    itag: format.itag,
    backend: fetched.backend,
    authenticated: !!fetched.authenticated,
    visitorData: fetched.visitorData || null,
    trackId: track.id,
    metadata: Object.assign({}, track.metadata || {}),
    context: context,
    contentLength: contentLength,
    duration: duration,
    signal: signal
  };

  const indexBytes = await fetchRangeWithRecovery(handle, 0, indexRangeEnd);
  const expectedIndexLength = indexRangeEnd + 1;
  if (indexBytes.length < expectedIndexLength) {
    throw new Error('short sidx range (' + indexBytes.length + ' < ' + expectedIndexLength + ')');
  }
  const initBytes = indexBytes.slice(0, expectedIndexLength);
  const segments = parseSidx(initBytes, indexRangeEnd);
  log('resolve: sidx gave', segments.length, 'segments, first media byte',
    segments.length > 1 ? segments[1].byteStart : 'none',
    '| last', segments[segments.length - 1].byteEnd);
  handle.segments = segments;
  // The SIDX probe is exactly the fMP4 initialization segment. Seed it into
  // this handle's private cache so AVPlayer's first /media/init request does
  // not fetch the same bytes from googlevideo again.
  handle.__spans = [{ start: 0, end: initBytes.length - 1, data: initBytes }];

  // Expose the fragment map so the app can serve this as HLS (fMP4): entry 0 is
  // the initialisation segment (ftyp+moov+sidx), the rest are media fragments with
  // exact byte ranges and durations.
  const initSegment = { offset: segments[0].byteStart, length: segments[0].byteEnd - segments[0].byteStart + 1 };
  const mediaFragments = segments.slice(1).map(function(s) {
    return { offset: s.byteStart, length: s.byteEnd - s.byteStart + 1, duration: s.dur };
  });
  const fragmentsDuration = mediaFragments.reduce(function(sum, s) { return sum + s.duration; }, 0);
  log('resolve: hls map -> init', initSegment.length, 'bytes |', mediaFragments.length,
    'fragments | summed duration', fragmentsDuration.toFixed(3));

  const descriptor = {
    kind: 'fragmented',
    mimeType: format.mimeType || 'audio/mp4; codecs="mp4a.40.2"',
    contentLength: contentLength,
    duration: duration,
    bufferAheadSeconds: BUFFER_AHEAD_SECONDS,
    chunkBytes: CHUNK_BYTES,
    initSegment: initSegment,
    fragments: mediaFragments,
    handle: handle
  };
  // Persistence is best-effort; start it without adding SQLite latency to playback.
  void persistFragmentedDescriptor(handle, videoId, fetched.backend, url, descriptor, initBytes, fetched.authenticated);
  return descriptor;
}

/// Resolve an Opus path by rewriting WebM into a progressive CAF descriptor.
/// Returns null when the format, fetch, demux or mux is unavailable; aborts throw.
async function resolveOpusDescriptor(track, videoId, context, fetched, signal, state) {
  const lib = globalThis.BoppaOpusCaf;
  if (!lib) { log('opus: converter library not loaded, skipping'); return null; }

  const format = pickAudioFormat(fetched.streamingData, OPUS_ITAG_PREFERENCE, true);
  if (!format) return null;

  const contentLength = parseInt(format.contentLength, 10);
  if (!contentLength) { log('opus: format has no contentLength, skipping'); return null; }

  let built;
  try {
    built = await signFormat(fetched, format, videoId, signal, state);
  } catch (e) {
    if (signal?.aborted || isAuthFailure((e && e.message) || e) || isStalePlayerError(e)) throw e;
    log('opus: could not sign format:', (e && e.message) || e);
    return null;
  }

  // One-byte probe first: it is what gives a just-minted token-enforced URL
  // its activation grace, and it is cheap next to the whole-file download.
  await validateWholeStreamAccess(built.url, contentLength, signal, fetched.backend + ' itag ' + format.itag, { grace: state.activationGrace });

  const startedAt = Date.now();
  let webm;
  try {
    webm = await fetchWholeOpus(built.url, contentLength, signal);
  } catch (e) {
    if (signal?.aborted || isAuthFailure((e && e.message) || e)) throw e;
    log('opus: fetch failed:', (e && e.message) || e);
    return null;
  }
  const fetchedMs = Date.now() - startedAt;

  let caf;
  let demuxed;
  try {
    demuxed = lib.demuxWebmOpus(webm);
    caf = lib.muxOpusToCaf(demuxed);
  } catch (e) {
    log('opus: WebM->CAF conversion failed:', (e && e.message) || e);
    return null;
  }
  log('opus: itag', format.itag, '| webm', webm.length, 'B in', fetchedMs + 'ms',
    '| packets', demuxed.packets.length, '| preSkip', demuxed.preSkipSamples,
    '| ch', demuxed.channels, '| caf', caf.length, 'B in', (Date.now() - startedAt - fetchedMs) + 'ms');

  const duration = demuxed.durationSeconds
    || (parseInt(format.approxDurationMs, 10) || 0) / 1000;

  // The whole CAF is already in memory. Seed it as the handle's single cached
  // span so the generic openStream/pull/closeStream serve it with no upstream
  // fetching, no re-auth and no segment map. `itag` is recorded so any future
  // re-auth of this handle rebuilds the same format.
  const handle = {
    url: built.url,
    videoId: videoId,
    itag: format.itag,
    backend: fetched.backend,
    authenticated: !!fetched.authenticated,
    visitorData: fetched.visitorData || null,
    trackId: track.id,
    metadata: Object.assign({}, track.metadata || {}),
    context: context,
    contentLength: caf.length,
    duration: duration,
    signal: signal,
    segments: [{ byteStart: 0, byteEnd: caf.length - 1, startTime: 0, dur: duration }],
    __spans: [{ start: 0, end: caf.length - 1, data: caf }]
  };

  return {
    kind: 'progressive',
    mimeType: CAF_MIME_TYPE,
    contentLength: caf.length,
    duration: duration,
    chunkBytes: CHUNK_BYTES,
    handle: handle
  };
}

/// Fetch streaming data for a resolve. Kept as a seam so transient InnerTube
/// failures can be retried in one place.
async function fetchStreamingDataResilient(videoId, context, signal, backend, signedIn) {
  let fetched = await fetchStreamingData(videoId, context, signal, backend, signedIn);
  if (!isWebBackend(backend)) return fetched;
  try {
    const probe = pickAudioFormat(fetched.streamingData, MP4_ITAG_PREFERENCE.concat(OPUS_ITAG_PREFERENCE), false);
    await decipher(fetched.player, probe);
    return fetched;
  } catch (e) {
    if (signal?.aborted || !isStalePlayerError(e)) throw e;
    log('fetchStreamingDataResilient:', e.message, '- rebuilding player');
    await rebuildPlayerNow(e.message);
    return fetchStreamingData(videoId, context, signal, backend, signedIn);
  }
}

async function buildStreamUrlResilient(videoId, context, signal, preferItag, backend, signedIn) {
  try {
    return await buildStreamUrl(videoId, context, signal, preferItag, backend, signedIn);
  } catch (e) {
    if (!isWebBackend(backend) || signal?.aborted || !isStalePlayerError(e)) throw e;
    await rebuildPlayerNow(e.message);
    return buildStreamUrl(videoId, context, signal, preferItag, backend, signedIn);
  }
}

/// Re-authenticate an in-flight stream whose URL stopped working (expired
/// `expire=` deadline, or a token that is no longer accepted). Single-flighted so
/// concurrent segment failures share one refresh. The media itself is unchanged,
/// so the existing segment map stays valid — we verify that via contentLength.
/// `handle.itag` pins the format so an Opus stream is not re-authed as MP4.
function refreshHandleUrl(handle, reason) {
  if (handle.__refreshing) return handle.__refreshing;
  log('refreshHandleUrl: re-authenticating stream for', handle.videoId, '| reason:', reason);
  // A visionOS URL rejected mid-stream is tied to its visitor; refetching under
  // the same one reproduced the 403 on device. GVS also answers an expired URL
  // with 403, and that says nothing about the visitor, so expiry is checked
  // first.
  if (handle.backend === 'visionos' && isAuthFailure(reason)) {
    const expiresAt = googlevideoExpiresAt(handle.url);
    if (expiresAt && expiresAt * 1000 <= Date.now()) {
      log('refreshHandleUrl: URL had expired; keeping the visionOS visitor');
    } else {
      discardVisionosVisitor(reason, handle.visitorData);
    }
  }
  handle.__refreshing = callWithCredentials(PRIMARY_CREDENTIAL_KEYS, function() {
    // Read again: the credentials may have been refreshed since the resolve.
    handle.context = storedCredentials();
    return buildStreamUrlResilient(handle.videoId, handle.context, handle.signal, handle.itag, handle.backend, handle.authenticated);
  }, handle.signal)
    .then(function(built) {
      const refreshedLength = parseInt(built.format.contentLength, 10);
      if (refreshedLength !== handle.contentLength) {
        throw fatal('format changed on re-auth (' + handle.contentLength + ' -> ' +
          refreshedLength + '), cannot reuse the segment map');
      }
      handle.url = built.url;
      // The refetch reports the session state it actually used (the user may
      // have signed out since); the handle and the cache follow it.
      handle.authenticated = !!built.authenticated;
      handle.visitorData = built.visitorData || null;
      handle.__refreshedAt = Date.now();
      // Do not hold the failed range retry on a best-effort SQLite write.
      const changes = {};
      changes[metaKey('VideoId')] = String(handle.videoId);
      changes[metaKey('Backend')] = String(handle.backend);
      changes[metaKey('Authenticated')] = !!built.authenticated;
      changes[metaKey('StreamUrl')] = String(built.url);
      changes[metaKey('StreamExpiresAt')] = googlevideoExpiresAt(built.url);
      changes[metaKey('StreamResolvedAt')] = Math.floor(Date.now() / 1000);
      void persistTrackMetadata(handle, changes);
      log('refreshHandleUrl: stream re-authenticated for', handle.videoId);
      return built.url;
    })
    .catch(async function(e) {
      if (handle.signal?.aborted) throw e;
      await clearCachedStream(handle);
      log('refreshHandleUrl: FAILED:', (e && e.message) ? e.message : e);
      throw e;
    })
    .then(function(url) { handle.__refreshing = null; return url; },
          function(e) { handle.__refreshing = null; throw e; });
  return handle.__refreshing;
}

// Network failures: exponential backoff from 400 ms, capped at 1 s, no attempt
// limit. The track stays recoverable for as long as the engine keeps it; when
// the connection returns, the next attempt succeeds within a second. Status
// failures keep the bounded policy (RETRY_MAX_ATTEMPTS), since repeating a
// request the server already answered rarely changes the answer.
const NETWORK_RETRY_BASE_MS = 400;
const NETWORK_RETRY_MAX_MS = 1000;
// Log every attempt while the outage is young, then once per ~10 s.
const NETWORK_RETRY_LOG_EVERY = 10;


/// Fetch a byte range, recovering from transient failures and authorisation
/// failures (re-authenticate, then retry).
async function fetchRangeWithRecovery(handle, start, end) {
  let reauthorised = false;
  let lastError = null;
  let statusAttempts = 0;
  let networkAttempts = 0;
  for (;;) {
    try {
      const bytes = await fetchRange(handle.url, start, end, handle.signal);
      if (networkAttempts > 0) {
        warn('fetchRangeWithRecovery:', start + '-' + end, 'recovered after', networkAttempts, 'network failure(s)');
      }
      return bytes;
    } catch (e) {
      if (handle.signal?.aborted) throw e;
      lastError = e;
      const message = (e && e.message) ? e.message : String(e);
      if (isAuthFailure(message) && !reauthorised) {
        reauthorised = true;
        await refreshHandleUrl(handle, message);
        continue;                       // retry immediately with the new URL
      }
      if (isNetworkFailure(e)) {
        networkAttempts++;
        const delay = Math.min(NETWORK_RETRY_BASE_MS * Math.pow(2, networkAttempts - 1), NETWORK_RETRY_MAX_MS);
        if (networkAttempts <= 3 || networkAttempts % NETWORK_RETRY_LOG_EVERY === 0) {
          warn('fetchRangeWithRecovery:', start + '-' + end, 'network failure #' + networkAttempts,
            '(' + message + ') - retrying in', delay, 'ms until the connection returns or the track is stopped');
        }
        await sleep(delay, handle.signal);
        continue;
      }
      statusAttempts++;
      if (statusAttempts >= RETRY_MAX_ATTEMPTS) break;
      const delay = backoffDelay(statusAttempts - 1);
      log('fetchRangeWithRecovery:', start + '-' + end, 'failed (' + message + '), retry in ' + delay + 'ms');
      await sleep(delay, handle.signal);
    }
  }
  if (isWebBackend(handle.backend)) markPlayerUnverified('range fetch failed after retries');
  // Status failures only reach here after RETRY_MAX_ATTEMPTS; a rebind would
  // just repeat them, so tell the host not to retry. Network failures never
  // reach here (they loop above until the signal aborts).
  throw fatal((lastError && lastError.message) ? lastError.message : String(lastError));
}

const FALLBACK_BASE_JS = '/s/player/8ab5c328/player_ias.vflset/en_US/base.js';
const preprocessedPlayers = {};
let playerPromise = null;
let playerPromisePath = null;
const STORE_KEY_PATH = 'player.path';
const STORE_KEY_CHECKED_AT = 'player.checkedAt';
const MINT_MAX_ATTEMPTS = 3;

/// Open JS streams by id. Each AVPlayer range request becomes one stream; the
/// byte cache lives on the track handle, not here (see openStream).
const streams = {};
let nextStreamId = 1;

/// Build an Error the host treats as fatal: the package has concluded that
/// retrying will not help, so the engine ends the track instead of rebinding.
/// Use only for terminal conditions (a status the server will keep returning,
/// a changed format, a broken invariant), never for a network failure.
function fatal(message) {
  const error = new Error(message);
  error.fatal = true;
  return error;
}

function log() {
  console.log('[' + PLAYBACK.logTag + '] ' + Array.prototype.slice.call(arguments).join(' '));
}

function warn() {
  console.warn('[' + PLAYBACK.logTag + '] WARNING ' + Array.prototype.slice.call(arguments).join(' '));
}

// A pull answers within this long even when its fetch is still waiting on the
// network (the host's call timeout is 30 s; stay well inside it).
const PULL_WAIT_MS = 2000;
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 5000;
// A credentials worker that has not answered in this long is stopped, so the
// next refresh loads its page afresh instead of asking a page that hung.
const WORKER_CREDENTIALS_TIMEOUT_MS = 15 * 1000;

function sleep(ms, signal) {
  return new Promise(function(resolve, reject) {
    if (signal?.aborted) { reject(signal.reason || new Error('aborted')); return; }
    const timer = setTimeout(function() {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() { clearTimeout(timer); reject(signal.reason || new Error('aborted')); }
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffDelay(attempt) {
  const base = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_MAX_MS);
  return Math.floor(base * (0.7 + Math.random() * 0.6));
}

function isAuthFailure(message) {
  return /failed with (401|403|410)\b/.test(String(message));
}

/// Stop a worker whose page stopped answering. The web worker is started again
/// on its next use, and only rejoins the credential refresh once it answers.
function abandonWorker(workerName, reason) {
  warn('worker', workerName, 'stopped:', reason);
  try { boppa.worker(workerName).stop(); } catch (e) {}
  if (WEB && workerName === WEB.worker) {
    mwebReadyPromise = null;
    mwebWorkerReady = false;
    if (PLAYBACK.credentialWorkers.indexOf(workerName) === -1) activeCredentialWorkers.delete(workerName);
  }
}

/// Read fresh credentials from the workers and store them. Run by
/// container/40-credentials.js, in the background unless a call has none.
async function fetchCredentials() {
  const merged = {};
  let primaryAnswered = false;
  // Each worker is refreshed independently. A failing MWEB worker (for example
  // the www WebView being killed by the OS) must not prevent the primary
  // visionOS credentials from being updated in the same pass.
  for (const workerName of Array.from(activeCredentialWorkers)) {
    try {
      const values = await withTimeout(boppa.worker(workerName).start(), WORKER_CREDENTIALS_TIMEOUT_MS,
        'page not ready within ' + WORKER_CREDENTIALS_TIMEOUT_MS + ' ms')
        .then(function() { return workerCallWithin(WORKER_CREDENTIALS_TIMEOUT_MS, workerName, 'credentials'); });
      if (values) {
        Object.assign(merged, values);
        if (PLAYBACK.credentialWorkers.indexOf(workerName) !== -1) primaryAnswered = true;
      }
    } catch (e) {
      const message = (e && e.message) || String(e);
      warn('credentials: worker', workerName, 'failed to refresh:', message);
      if (/ within \d+ ms$/.test(message)) abandonWorker(workerName, message);
    }
  }
  if (!primaryAnswered) throw new Error('workers returned no credentials');
  Object.assign(runtimeContext, merged);
  storeCredentials(merged);
  log('credentials:', Object.keys(merged).join(','));
  return merged;
}


function storeKeySafe(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

function storeKeyPrepared(path) { return 'player.prepared.' + storeKeySafe(path); }
function storeKeySts(path) { return 'player.sts.' + storeKeySafe(path); }

function extractSignatureTimestamp(source) {
  const match = source.match(/(?:signatureTimestamp|sts)\s*[:=]\s*(\d{5})/);
  return match ? parseInt(match[1], 10) : 20710;
}

/// Map whatever player URL the live page advertises to the main IAS variant
/// whose signature/n transforms MWEB GVS accepts.
function mainPlayerPath(path) {
  const match = String(path || '').match(/\/s\/player\/([a-zA-Z0-9_\-]+)\//);
  return match ? '/s/player/' + match[1] + '/player_ias.vflset/en_US/base.js' : null;
}

function discardStoredPlayer(path, reason) {
  if (!boppa.store || !path) return;
  boppa.store.remove(storeKeyPrepared(path));
  boppa.store.remove(storeKeySts(path));
  boppa.store.remove(STORE_KEY_PATH);
  boppa.store.remove(STORE_KEY_CHECKED_AT);
  delete preprocessedPlayers[path];
  log('player cache discarded:', path, '|', reason);
}

/// Ask the source which player build is current.
function fetchCurrentPlayerPath() {
  return fetch('https://www.youtube.com/iframe_api')
    .then(function(response) { return response.ok ? response.text() : ''; })
    .then(function(source) {
      const match = source.match(/player\\?\/([a-zA-Z0-9_\-]{6,})\\?\//);
      if (match) return '/s/player/' + match[1] + '/player_ias.vflset/en_US/base.js';
      return fetch('https://www.youtube.com/').then(function(response) { return response.text(); })
        .then(function(html) {
          const found = html.match(/\/s\/player\/[a-zA-Z0-9_\-]+\/player_(?:es6|ias)[^"']*base\.js/);
          return found ? found[0].replace(/\/player_(?:es6|ias)[^/]*\//, '/player_ias.vflset/') : FALLBACK_BASE_JS;
        });
    });
}

/// Download a player build, prepare it for the solver, and persist both so the
/// next launch can skip all of this.
function buildPlayer(path) {
  return fetch('https://www.youtube.com' + path).then(function(response) {
    log('loadPlayer: base.js status', response.status);
    if (!response.ok) throw new Error('Could not load base.js (' + response.status + ')');
    return response.text();
  }).then(function(source) {
    log('loadPlayer: base.js', source.length, 'chars');
    const player = {
      url: path,
      source: source,
      signatureTimestamp: extractSignatureTimestamp(source)
    };
    // Freshly downloaded source must be prepared afresh: drop any prepared copy
    // held for this path so warmSolver cannot short-circuit on a stale one.
    delete preprocessedPlayers[path];
    warmSolver(player);
    persistPlayer(player);
    return player;
  });
}

function persistPlayer(player) {
  if (!boppa.store) return;
  const prepared = preprocessedPlayers[player.url];
  if (!prepared) return;
  try {
    boppa.store.set(storeKeyPrepared(player.url), prepared);
    boppa.store.set(storeKeySts(player.url), String(player.signatureTimestamp));
    boppa.store.set(STORE_KEY_PATH, player.url);
    boppa.store.set(STORE_KEY_CHECKED_AT, String(Date.now()));
    log('persistPlayer: cached prepared player for', player.url);
  } catch (e) {
    log('persistPlayer: failed:', (e && e.message) ? e.message : e);
  }
}

/// Rebuild the player from the store with no network and no parsing.
function restorePlayer() {
  if (!boppa.store) return null;
  try {
    const path = boppa.store.get(STORE_KEY_PATH);
    if (!path) return null;
    // MWEB's signature challenges correspond to the main player_ias variant.
    // A prepared player_es6 program can still produce plausible output, but GVS
    // rejects it for some signatures. Do not carry that cache across this fix.
    if (String(path).indexOf('/player_ias.') === -1) {
      discardStoredPlayer(path, 'not the IAS variant');
      return null;
    }
    const prepared = boppa.store.get(storeKeyPrepared(path));
    const sts = boppa.store.get(storeKeySts(path));
    if (!prepared || !sts) return null;
    preprocessedPlayers[path] = prepared;
    const checkedAt = parseInt(boppa.store.get(STORE_KEY_CHECKED_AT) || '0', 10) || 0;
    log('restorePlayer: restored prepared player for', path, '(' + prepared.length + ' chars)');
    return { url: path, source: null, signatureTimestamp: parseInt(sts, 10), checkedAt: checkedAt };
  } catch (e) {
    log('restorePlayer: failed:', (e && e.message) ? e.message : e);
    return null;
  }
}

/// Forget that the player was recently validated, so the next launch re-checks it
/// even though the TTL has not expired. Cheap (one homepage request) and the right
/// response to a network failure: the cache may be fine, but it is worth verifying.
function markPlayerUnverified(reason) {
  if (!boppa.store) return;
  try {
    boppa.store.remove(STORE_KEY_CHECKED_AT);
    log('markPlayerUnverified:', reason, '- will revalidate on next load');
  } catch (e) {
    log('markPlayerUnverified: failed:', (e && e.message) ? e.message : e);
  }
}

/// The cached player looks wrong (a challenge could not be solved), so rebuild it
/// from the network now, bypassing the cached prepared copy.
function rebuildPlayerNow(reason) {
  log('rebuildPlayerNow:', reason);
  markPlayerUnverified(reason);
  const configured = mainPlayerPath(runtimeContext[WEB.playerPath]);
  playerPromisePath = configured;
  playerPromise = (configured ? Promise.resolve(configured) : fetchCurrentPlayerPath())
    .then(function(path) { playerPromisePath = path; return buildPlayer(path); })
    .catch(function(error) {
      playerPromise = null;
      playerPromisePath = null;
      throw error;
    });
  return playerPromise;
}

/// Errors that mean the cached player is no longer usable, as opposed to a
/// transient network problem.
function isStalePlayerError(error) {
  return /^stale player:/.test(String((error && error.message) || error));
}

function loadPlayer(advertisedPath) {
  const wanted = mainPlayerPath(advertisedPath);
  if (playerPromise && (!wanted || wanted === playerPromisePath)) {
    log('loadPlayer: reusing', playerPromisePath || 'current promise');
    return playerPromise;
  }
  if (playerPromise && wanted !== playerPromisePath) {
    log('loadPlayer: worker player rotated', playerPromisePath, '->', wanted);
    playerPromise = null;
    playerPromisePath = null;
  }

  let restored = restorePlayer();
  if (restored && wanted && restored.url !== wanted) {
    discardStoredPlayer(restored.url, 'worker advertises ' + wanted);
    restored = null;
  }
  if (restored) {
    playerPromisePath = restored.url;
    playerPromise = Promise.resolve(restored);
    log('loadPlayer: restored exact worker player', restored.url);
    return playerPromise;
  }

  playerPromisePath = wanted;
  playerPromise = (wanted ? Promise.resolve(wanted) : fetchCurrentPlayerPath())
    .then(function(path) { playerPromisePath = path; return buildPlayer(path); })
    .catch(function(error) {
      log('loadPlayer: FAILED', error && error.message ? error.message : error);
      playerPromise = null;
      playerPromisePath = null;
      throw error;
    });
  return playerPromise;
}

function solveChallenges(player, requests) {
  if (!requests.length) {
    log('solveChallenges: nothing to solve');
    return {};
  }
  if (typeof jsc !== 'function') {
    throw new Error('the ejs solver did not load, typeof jsc is ' + typeof jsc);
  }

  const cached = preprocessedPlayers[player.url];
  if (!cached && !player.source) {
    // A restored player carries no source (we persisted only the prepared form).
    // If its prepared form is somehow missing, rebuild rather than solve with null.
    throw new Error('no prepared player for ' + player.url + ' and no source to prepare from');
  }
  log('solveChallenges:', requests.length, 'request(s),', cached ? 'using cached preprocessed player' : 'preprocessing player');
  const result = cached
    ? jsc({ type: 'preprocessed', preprocessed_player: cached, requests: requests })
    : jsc({ type: 'player', player: player.source, requests: requests, output_preprocessed: true });

  if (!cached && result && result.preprocessed_player) {
    preprocessedPlayers[player.url] = result.preprocessed_player;
  }

  const solved = {};
  for (const response of (result && result.responses) || []) {
    if (response.type === 'result') {
      for (const challenge in response.data) solved[challenge] = response.data[challenge];
    } else {
      log('solveChallenges: solver error', response.error);
    }
  }
  log('solveChallenges: solved', Object.keys(solved).length, 'of', requests.length);
  return solved;
}

/// Preprocess the player for the challenge solver ahead of time and cache it.
/// This is the expensive part of the first play (~1.5s), so doing it during init
/// (which the app now runs at launch) keeps the first track as fast as later ones.
function warmSolver(player) {
  if (preprocessedPlayers[player.url]) {
    log('warmSolver: already preprocessed');
    return;
  }
  if (typeof jsc !== 'function') {
    log('warmSolver: solver not loaded, skipping');
    return;
  }
  const startedAt = Date.now();
  try {
    // A solve with no challenges still returns the preprocessed player, which is
    // the part we want cached.
    const result = jsc({ type: 'player', player: player.source, requests: [], output_preprocessed: true });
    if (result && result.preprocessed_player) {
      preprocessedPlayers[player.url] = result.preprocessed_player;
      log('warmSolver: preprocessed player cached in', (Date.now() - startedAt) + 'ms');
    } else {
      log('warmSolver: no preprocessed player returned');
    }
  } catch (e) {
    log('warmSolver: failed:', (e && e.message) ? e.message : e);
  }
}


function videoIdFrom(track) {
  const match = String(track.url || '').match(/[?&]v=([^&]+)/);
  return match ? match[1] : track.id;
}

/// Pick an audio format by itag preference. With `strict` the caller only wants
/// one of the listed itags and gets null otherwise (used for the Opus attempt);
/// without it the first available audio format is a last resort.
function pickAudioFormat(streamingData, preference, strict) {
  const all = streamingData.adaptiveFormats || [];
  const audio = all.filter(function(format) {
    if (String(format.mimeType || '').indexOf('audio') !== 0) return false;
    // www.youtube.com lists each itag twice when a loudness-normalised (DRC)
    // variant exists, and once per language for dubbed videos. Keep the plain
    // original; the DRC copy and non-default dubs are not what the uploader made.
    if (format.isDrc || /drc=1/.test(String(format.xtags || ''))) return false;
    if (format.audioTrack && format.audioTrack.audioIsDefault === false) return false;
    return true;
  });
  log('pickAudioFormat:', all.length, 'formats,', audio.length, 'audio, itags',
    JSON.stringify(audio.map(function(f) { return f.itag; })));
  if (!audio.length) throw new Error('This track has no audio formats');

  for (const itag of preference) {
    const match = audio.find(function(format) { return format.itag === itag; });
    if (match) {
      log('pickAudioFormat: picked preferred itag', itag);
      return match;
    }
  }
  if (strict) {
    log('pickAudioFormat: none of', JSON.stringify(preference), 'available');
    return null;
  }
  log('pickAudioFormat: no preferred itag, falling back to', audio[0].itag);
  return audio[0];
}

async function decipher(player, format) {
  let signature = null;
  let signatureParam = 'sig';
  let url = format.url;

  const cipher = format.signatureCipher || format.cipher;
  log('decipher: itag', format.itag, cipher ? 'has signatureCipher' : 'has a plain url');
  if (cipher) {
    const params = new URLSearchParams(cipher);
    signature = params.get('s');
    signatureParam = params.get('sp') || 'sig';
    url = params.get('url');
  }
  if (!url) throw new Error('Format has no URL');

  let nParam = null;
  try {
    nParam = new URL(url).searchParams.get('n');
  } catch (e) {
    log('decipher: could not parse url for n param:', e && e.message ? e.message : e);
  }
  log('decipher: signature', signature ? 'present' : 'absent', '| n param', nParam || 'absent');

  const requests = [];
  if (signature) requests.push({ type: 'sig', challenges: [signature] });
  if (nParam) requests.push({ type: 'n', challenges: [nParam] });

  const solved = solveChallenges(player, requests);

  let final = url;
  if (signature && solved[signature]) {
    final += '&' + signatureParam + '=' + encodeURIComponent(solved[signature]);
  }
  if (signature && !solved[signature]) {
    // The player could not descramble the signature: googlevideo would reject this
    // URL outright. Treat it as a stale player rather than shipping a dead URL.
    throw new Error('stale player: signature was not solved');
  }
  if (nParam && !solved[nParam]) {
    // An unsolved n param means heavy server-side throttling, which is effectively
    // unplayable. Same conclusion: the cached player no longer matches the source.
    throw new Error('stale player: n param was not solved');
  }
  if (nParam && solved[nParam]) {
    const parsed = new URL(final);
    parsed.searchParams.set('n', solved[nParam]);
    final = parsed.toString();
  }
  log('decipher: final url', final.slice(0, 160));
  return final;
}


/// Show the source's login popup and report the resulting session.
///
/// Interactive and not idempotent, so: only on a track's first resolve attempt
/// (`track.resolveAttempt`), and single-flighted so concurrent resolves of
/// several gated tracks share one popup instead of stacking them.
// Closing the popup without signing in is not remembered: a track that needs
// an account asks again next time it is played. Only automatic retries of the
// same resolve (resolveAttempt > 0) are exempt.
let loginPopupInFlight = null;
async function requestSignIn(track, videoId) {
  if (typeof boppa.popup !== 'function') return ANONYMOUS_SESSION;
  if ((track.resolveAttempt || 0) > 0) {
    log('requestSignIn: not re-opening the popup on automatic retry', track.resolveAttempt);
    return ANONYMOUS_SESSION;
  }
  if (!loginPopupInFlight) {
    warn('resolve: InnerTube requires sign-in for', videoId, '- opening login popup');
    loginPopupInFlight = boppa.popup(PLAYBACK.loginPopup)
      .then(function() { return detectSessionAfterLogin(); })
      .finally(function() { loginPopupInFlight = null; });
  } else {
    log('requestSignIn: login popup already open, waiting for it');
  }
  return loginPopupInFlight;
}

// A resolve started while the connection is down (or that loses it mid-way)
// retries its path attempts with the same capped backoff as range fetches, as
// long as every failure was a transport failure and the budget has room. The
// budget is deliberately short (the host allows a resolve far longer): a user
// who tapped while offline should get an answer, not a spinner. Beyond it the
// resolve fails like before; the user taps again once online.
const RESOLVE_NETWORK_RETRY_BUDGET_MS = 24000;

async function attemptPathsWhileOffline(track, videoId, context, signal, paths, signedIn) {
  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    const outcome = await attemptPaths(track, videoId, context, signal, paths, signedIn);
    if (outcome.descriptor) {
      if (attempt > 0) warn('resolve: network recovered after', attempt, 'retry attempt(s)');
      return outcome;
    }
    const allNetwork = outcome.failures.length > 0 && outcome.failures.every(function(f) { return isNetworkFailure(f); });
    const elapsed = Date.now() - startedAt;
    if (!allNetwork || elapsed >= RESOLVE_NETWORK_RETRY_BUDGET_MS) return outcome;
    attempt++;
    const delay = Math.min(NETWORK_RETRY_BASE_MS * Math.pow(2, attempt - 1), NETWORK_RETRY_MAX_MS);
    if (attempt <= 3 || attempt % NETWORK_RETRY_LOG_EVERY === 0) {
      warn('resolve: every path failed on the network (' + outcome.failures[0] + ') - retrying in', delay,
        'ms (' + Math.round((RESOLVE_NETWORK_RETRY_BUDGET_MS - elapsed) / 1000) + ' s of budget left)');
    }
    await sleep(delay, signal);
    signal?.throwIfAborted();
  }
}

/// Try `paths` in order. Returns `{ descriptor }` on the first success, else
/// `{ failures, loginRequired }` where `loginRequired` means InnerTube refused
/// with LOGIN_REQUIRED and no backend issued streams. One InnerTube response per backend is shared
/// by its codecs; one MWEB token is shared likewise. A backend gets one
/// same-path repair on an authentication/signing failure before fallback moves on.
async function attemptPaths(track, videoId, context, signal, requestedPaths, signedIn) {
  const paths = requestedPaths.slice();
  const fetchedByBackend = {};
  // One activation wait per resolve (see validateWholeStreamAccess).
  const activationGrace = { used: false };
  // InnerTube's answer is deterministic within one resolve: when it refuses a
  // backend (LOGIN_REQUIRED, UNPLAYABLE...), the sibling codec path fails with
  // the same message without asking again. Transport errors are not remembered.
  const refusedByBackend = {};
  const state = { mwebToken: null, activationGrace: activationGrace };
  const failures = [];
  const repairedBackends = new Set();
  let loginRequiredFailures = 0;
  let streamsIssued = false;
  for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
    const path = paths[pathIndex];
    const split = path.split('-');
    const backend = split[0];
    const codec = split[1];
    try {
      if (refusedByBackend[backend]) throw refusedByBackend[backend];
      let fetched = fetchedByBackend[backend];
      if (!fetched) {
        try {
          fetched = await fetchStreamingDataResilient(videoId, context, signal, backend, signedIn);
        } catch (e) {
          if (isPlayabilityRefusal(e)) refusedByBackend[backend] = e;
          throw e;
        }
        fetchedByBackend[backend] = fetched;
        streamsIssued = true;
        if (isWebBackend(backend) && streamingDataIsActivationGated(fetched.streamingData)) {
          log('resolve: MWEB URL for', videoId, 'is token-enforced; a 403 within the activation window is waited out on the same URL');
        }
      }
      signal?.throwIfAborted();
      const descriptor = codec === 'aac'
        ? await resolveMp4Descriptor(track, videoId, context, fetched, signal, state)
        : await resolveOpusDescriptor(track, videoId, context, fetched, signal, state);
      if (!descriptor) throw new Error(codec + ' format or conversion unavailable');
      log('resolve: selected', path, descriptor.kind, descriptor.mimeType, fetched.authenticated ? '(signed in)' : '');
      return { descriptor: descriptor };
    } catch (e) {
      if (signal?.aborted) throw e;
      let message = (e && e.message) || String(e);
      const repairableFailure = isAuthFailure(message) || isWebBackend(backend) && isStalePlayerError(e);
      if (repairableFailure && !repairedBackends.has(backend)) {
        repairedBackends.add(backend);
        warn('playback path', path, 'had an authentication/signing failure - refreshing', backend,
          'session and retrying the same path once:', message);
        try {
          if (isWebBackend(backend)) {
            await rebuildPlayerNow(message);
            state.mwebToken = null;
          } else if (backend === 'visionos') {
            // A rejected visionOS URL is tied to the visitor it was minted
            // for; refetching under the same visitor reproduced the 403 every
            // time on device. Retry as a new visitor.
            discardVisionosVisitor(message, fetchedByBackend[backend] && fetchedByBackend[backend].visitorData);
          }
          delete fetchedByBackend[backend];
          pathIndex--;
          continue;
        } catch (repairError) {
          const repairMessage = (repairError && repairError.message) || String(repairError);
          message += '; same-path repair failed: ' + repairMessage;
          warn('playback path', path, 'same-path repair failed:', repairMessage, '- continuing ordered fallback');
        }
      }
      failures.push(path + ': ' + message);
      if (isLoginRequired(e)) loginRequiredFailures++;
      const nextPath = paths[pathIndex + 1];
      warn('playback path', path, 'failed:', message,
        nextPath ? '- falling back to ' + nextPath : '- no fallback remains');
    }
  }
  // Sign-in is the answer when InnerTube refused the account and no backend
  // handed out streams. A GVS 403 means streams were issued, so the content is
  // not gated and signing in would not help. A dead worker or a transport
  // error on another path says nothing about the content, and must not hide
  // the refusal (all (12).log: MWEB worker killed in the background masked an
  // age gate for two hours).
  return {
    failures: failures,
    loginRequired: loginRequiredFailures > 0 && !streamsIssued
  };
}

boppa.playback.register(credentialedPlayback(PRIMARY_CREDENTIAL_KEYS, {
  init: async function() {
    log('init:', PLAYBACK.family, JSON.stringify(ACTIVE_PATHS));
    Object.assign(runtimeContext, storedCredentials());
    // Stored credentials are used as they are; only a first launch waits.
    await ensureCredentials(PRIMARY_CREDENTIAL_KEYS);
    if (WEB_ONLY) {
      // A MWEB-only source pays the player-JS preprocessing cost at init.
      await loadPlayer(runtimeContext[WEB.playerPath]);
    } else if (HAS_WEB_PATH) {
      // Mixed sources: warm the MWEB worker WebView in the background so a
      // fallback does not pay a ~3 s cold start. Nothing awaits this; init
      // returns immediately and visionOS remains the primary path. A failure
      // here is harmless: ensureMwebReady() retries on first real use.
      // Only the WebView is warmed. The player is restored from the store if a
      // prepared copy already exists (no network, no CPU); a cold build is left
      // to the fallback because EJS preprocessing runs synchronously on this JS
      // thread for 2-4 s and would stall a concurrent visionOS resolve.
      ensureMwebReady().then(function() {
        const wanted = mainPlayerPath(runtimeContext[WEB.playerPath]);
        const restored = restorePlayer();
        if (restored && (!wanted || restored.url === wanted) && !playerPromise) {
          playerPromisePath = restored.url;
          playerPromise = Promise.resolve(restored);
          log('init: restored prepared MWEB player', restored.url);
        }
      }).catch(function(error) {
        log('init: background MWEB warm-up failed (will retry on demand):', (error && error.message) || error);
      });
    }
  },

  resolve: async function(track, options) {
    const signal = options?.signal;
    const context = storedCredentials();
    const videoId = videoIdFrom(track);
    if (!videoId) throw new Error('This track has no video id');

    let session = await detectSessionForResolve(track);
    signal?.throwIfAborted();
    let paths = pathsForSession(session.signedIn);
    log('resolve:', videoId, session.signedIn ? 'signed in' : 'anonymous', JSON.stringify(paths));

    const cached = cachedFragmentedDescriptor(track, videoId, context, session.signedIn);
    if (cached) {
      cached.handle.signal = signal;
      try {
        await validateWholeStreamAccess(cached.handle.url, cached.contentLength, signal, 'cached ' + cached.handle.backend + ' itag ' + cached.handle.itag);
        log('resolve: cached', cached.handle.backend, 'aac (tail validated)');
        return cached;
      } catch (e) {
        if (signal?.aborted) throw e;
        warn('cached', cached.handle.backend + '-aac', 'failed tail probe:', (e && e.message) || e, '- resolving a new path');
        await clearCachedStream(track);
      }
    }

    let outcome = await attemptPathsWhileOffline(track, videoId, context, signal, paths, session.signedIn);
    if (outcome.descriptor) return outcome.descriptor;

    // InnerTube refused with LOGIN_REQUIRED (age gate, private, members-only)
    // and nothing issued streams: only a session can change that. Never on a
    // 403, which signing in would not fix.
    //
    // Host contract: presenting a popup stops playback, which cancels this
    // resolve (by design: the popup is a modal hand-off, not a wait). The user
    // signs in and taps the track again; that next resolve sees the cookies and
    // takes the signed-in order. The retry below only runs on a host that keeps
    // the resolve alive across the popup.
    let signInOffered = false;
    if (outcome.loginRequired && !session.signedIn && PLAYBACK.loginPopup && HAS_WEB_PATH) {
      // Without a cookie jar the initial detection may have skipped or timed
      // out; the worker is warm now, so ask it before showing a popup to a
      // user who is already signed in.
      if (!sessionFromCookies(await readCookies())) {
        session = await detectSession(SESSION_DETECT_WARM_MS);
        signal?.throwIfAborted();
      }
      if (!session.signedIn) {
        signInOffered = true;
        session = await requestSignIn(track, videoId);
        signal?.throwIfAborted();
      }
      if (session.signedIn) {
        paths = pathsForSession(true);
        log('resolve: signed in, retrying', JSON.stringify(paths));
        outcome = await attemptPathsWhileOffline(track, videoId, context, signal, paths, true);
        if (outcome.descriptor) return outcome.descriptor;
      } else {
        throw new Error('non-retryable: Sign in to play this track');
      }
    }

    await clearCachedStream(track);
    // A LOGIN_REQUIRED that a session cannot fix (already signed in, or the
    // popup was just offered) will not change on the engine's automatic retry.
    // Without a popup (visionOS-only configs) it stays retryable, as before.
    const prefix = outcome.loginRequired && (session.signedIn || signInOffered) ? 'non-retryable: ' : '';
    throw new Error(prefix + 'No playback path succeeded (' + outcome.failures.join(' | ') + ')');
  },

  // ---- Pull-based streaming: the proxy is a dumb pipe. It opens a stream at an
  // offset, then repeatedly pulls bytes; this JS side owns the byte cache, the
  // upstream range fetching (with alr redirect handling), and read-ahead. Swift
  // reports the play head via progress() so we can fetch the next region before
  // the buffer runs dry. ----

  openStream: function(handle, request) {
    const streamId = 'js-' + (nextStreamId++);
    // The byte cache lives on the HANDLE, not the stream: under HLS the app opens
    // one stream per segment request, so a per-stream cache would refetch any
    // segment the player asks for again (e.g. after a seek). Sharing it per track
    // means each byte is fetched from the source at most once.
    if (!handle.__spans) handle.__spans = [];
    streams[streamId] = {
      handle: handle,
      cursor: (request && request.offset) || 0,   // next byte to hand to the proxy
      playHeadBytes: (request && request.offset) || 0,
      fetching: false
    };
    log('openStream', streamId, 'at offset', (request && request.offset) || 0,
      '| contentLength', handle.contentLength, '| cached spans', handle.__spans.length);
    return { streamId: streamId };
  },

  pull: async function(_handle, request) {
    const streamId = request.streamId;
    const maxBytes = request.maxBytes || CHUNK_BYTES;
    const stream = streams[streamId];
    if (!stream) throw new Error('pull: unknown stream ' + streamId);

    const contentLength = stream.handle.contentLength;
    if (stream.cursor >= contentLength) {
      return { bytes: [], eof: true };
    }

    // Make sure the cursor's bytes are cached. The fetch may be riding out a
    // network outage (see fetchRangeWithRecovery), so never let one pull block
    // past the host's call timeout: after PULL_WAIT_MS return an empty,
    // non-eof chunk and let the host pull again. The fetch keeps running in
    // the background and the next pull picks up its bytes.
    const throwPendingError = function() {
      if (!stream.pendingError) return;
      const error = stream.pendingError;
      stream.pendingError = null;
      throw error;
    };
    throwPendingError();                 // a fetch that failed since the last pull
    const needed = Math.min(maxBytes, contentLength - stream.cursor);
    if (!stream.pending) {
      stream.pending = ensureCached(stream, stream.cursor, needed).then(
        function() { stream.pending = null; },
        function(error) { stream.pending = null; stream.pendingError = error; }
      );
    }
    // The pending fetch wins ties: a fetch that has already settled must be
    // served now, not reported as still waiting.
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
    const end = Math.min(start + maxBytes - 1, contentLength - 1);
    const out = readCached(stream, start, end);
    if (!out.length) {
      // Should never happen: ensureCached just guaranteed these bytes. Fail loudly
      // rather than returning empty forever (which would hang the caller).
      throw fatal('pull: no bytes cached at ' + start + ' (wanted ' + (end - start + 1) + ')');
    }
    stream.cursor = start + out.length;

    return { bytes: out, eof: stream.cursor >= contentLength };
  },

  progress: function(_handle, request) {
    const stream = streams[request.streamId];
    if (!stream) return { ok: false };
    const rate = stream.handle.contentLength / (stream.handle.duration || 1);
    stream.playHeadBytes = Math.floor((request.seconds || 0) * rate);
    return { ok: true };
  },

  closeStream: function(_handle, request) {
    const stream = streams[request.streamId];
    if (stream) { log('closeStream', request.streamId, 'at cursor', stream.cursor); }
    delete streams[request.streamId];
    return { ok: true };
  }
}));

// ---- streaming state + cache (JS-owned) ----

function segmentAlignedFetch(segments, offset, minLength) {
  // Fetch from `offset` extending forward to the segment boundary at/after
  // offset+minLength, so we grab whole fragments. Never aligns start backward.
  const wantedEnd = offset + minLength - 1;
  let last = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    if (wantedEnd >= segments[i].byteStart && wantedEnd <= segments[i].byteEnd) { last = i; break; }
    if (segments[i].byteStart > wantedEnd) { last = Math.max(0, i - 1); break; }
    last = i;
  }
  return { start: offset, end: Math.max(wantedEnd, segments[last].byteEnd) };
}

function readCached(stream, start, end) {
  for (const span of stream.handle.__spans) {
    if (span.start <= start && start <= span.end) {
      const from = start - span.start;
      const to = Math.min(end - span.start, span.data.length - 1);
      return span.data.slice(from, to + 1);
    }
  }
  return [];
}

function hasCached(stream, start) {
  for (const span of stream.handle.__spans) {
    if (span.start <= start && start <= span.end) return span.end;
  }
  return -1;
}

function storeSpan(stream, start, data) {
  if (!data || !data.length) return;
  const end = start + data.length - 1;
  // Merge with existing spans (keep sorted, coalesced) so nothing overlaps.
  let newSpan = { start: start, end: end, data: data };
  const merged = [];
  let inserted = false;
  for (const span of stream.handle.__spans) {
    if (span.end + 1 < newSpan.start) {
      merged.push(span);
    } else if (newSpan.end + 1 < span.start) {
      if (!inserted) { merged.push(newSpan); inserted = true; }
      merged.push(span);
    } else {
      // overlap/adjacent -> fold together (existing bytes win on overlap)
      const s = Math.min(newSpan.start, span.start);
      const e = Math.max(newSpan.end, span.end);
      const buf = new Array(e - s + 1);
      for (let i = 0; i < newSpan.data.length; i++) buf[newSpan.start - s + i] = newSpan.data[i];
      for (let i = 0; i < span.data.length; i++) buf[span.start - s + i] = span.data[i];
      newSpan = { start: s, end: e, data: buf };
    }
  }
  if (!inserted) merged.push(newSpan);
  merged.sort(function(a, b) { return a.start - b.start; });
  stream.handle.__spans = merged;
}

async function ensureCached(stream, offset, minLength) {
  if (hasCached(stream, offset) >= offset + minLength - 1) {
    log('cache HIT', offset + '+' + minLength);        // served without touching the source
    return;
  }
  const fetchRangeSpec = segmentAlignedFetch(stream.handle.segments, offset, minLength);
  // Don't refetch bytes we already hold: advance start past any cached prefix.
  let start = offset;
  const cachedEnd = hasCached(stream, offset);
  if (cachedEnd >= offset) start = cachedEnd + 1;
  if (start > fetchRangeSpec.end) return;
  log('cache MISS', offset + '+' + minLength, '-> fetching', start + '-' + fetchRangeSpec.end);
  const data = await fetchRangeShared(stream.handle, start, fetchRangeSpec.end);
  storeSpan(stream, start, data);
}

/// One in-flight fetch per (handle, range). During an outage AVPlayer and the
/// engine's rebinds re-request the same fragment through new JS streams; they
/// all wait on the one retry loop instead of each starting their own.
function fetchRangeShared(handle, start, end) {
  if (!handle.__inflight) handle.__inflight = {};
  const key = start + '-' + end;
  if (handle.__inflight[key]) return handle.__inflight[key];
  const promise = fetchRangeWithRecovery(handle, start, end)
    .finally(function() { delete handle.__inflight[key]; });
  handle.__inflight[key] = promise;
  return promise;
}
