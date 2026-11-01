// The host does not forward a worker page's console to the app log, so worker
// scripts keep their log lines and answer `logs` with whatever accumulated
// since the last ask. Every call made through workerCall collects them right
// after it settles, including when it fails or times out, and prints them here.

const WORKER_LOGS_TIMEOUT_MS = 2000;

/// Print the lines `name` logged since the last collection. Best effort: a
/// page that cannot answer, or a worker without `logs`, prints nothing.
async function relayWorkerLogs(name) {
  try {
    const lines = await withTimeout(boppa.worker(name).call('logs'), WORKER_LOGS_TIMEOUT_MS, 'no answer');
    if (!Array.isArray(lines)) return;
    for (const line of lines) console.log('[worker ' + name + '] ' + line);
  } catch (e) {}
}

function callWorker(name, args, timeoutMs) {
  const worker = boppa.worker(name);
  const pending = worker.call.apply(worker, args);
  if (!timeoutMs) return pending;
  return withTimeout(pending, timeoutMs, 'worker ' + name + ' did not answer ' + args[0] + ' within ' + timeoutMs + ' ms');
}

/// boppa.worker(name).call(method, value), then relay the page's log lines.
async function workerCall(name) {
  const args = Array.prototype.slice.call(arguments, 1);
  try {
    return await callWorker(name, args, 0);
  } finally {
    await relayWorkerLogs(name);
  }
}

/// workerCall that rejects after `timeoutMs`; the page's lines up to then are
/// still relayed.
async function workerCallWithin(timeoutMs, name) {
  const args = Array.prototype.slice.call(arguments, 2);
  try {
    return await callWorker(name, args, timeoutMs);
  } finally {
    await relayWorkerLogs(name);
  }
}
