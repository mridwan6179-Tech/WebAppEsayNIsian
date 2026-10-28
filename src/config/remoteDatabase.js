const path = require('path');
const { Worker } = require('worker_threads');

const RESULT_BUFFER_BYTES = 8 * 1024 * 1024;
// Batasi waktu tunggu satu query (10 detik) agar serverless cukup longgar
// saat endpoint LibSQL STB/Tunnel mengalami lonjakan request.
const QUERY_TIMEOUT_MS = 10000;

function normalizeHttpUrl(url) {
  const value = String(url || '').trim();
  if (value.toLowerCase().startsWith('libsql://')) {
    return `https://${value.slice('libsql://'.length)}`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value;
  }
  if (!/^https?:\/\//i.test(value)) {
    return `https://${value}`;
  }
  return value;
}

function isRemoteConnectionError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('koneksi database sudah ditutup') ||
    message.includes('database sudah ditutup') ||
    message.includes('ditutup') ||
    message.includes('query database timeout') ||
    message.includes('timeout') ||
    message.includes('stream not found') ||
    message.includes('hrana') ||
    message.includes('connection closed') ||
    message.includes('connection reset') ||
    message.includes('socket hang up') ||
    message.includes('broken pipe') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('fetch failed') ||
    (message.includes('status=404') && message.includes('stream')) ||
    message.includes('worker database berhenti') ||
    message.includes('worker')
  );
}

function createRemoteDatabase({ url, authToken }) {
  let worker = null;
  let explicitlyClosed = false;
  let workerFailure = null;

  function initWorker() {
    if (worker) {
      try { worker.terminate(); } catch (e) {}
    }
    worker = new Worker(path.join(__dirname, 'remoteDatabaseWorker.js'), {
      workerData: { url: normalizeHttpUrl(url), authToken: authToken || '' }
    });
    workerFailure = null;
    worker.on('error', (error) => {
      workerFailure = error;
    });
    worker.on('exit', (code) => {
      if (code !== 0 && !explicitlyClosed && !workerFailure) {
        workerFailure = new Error(`Worker database berhenti dengan kode ${code}.`);
      }
    });
  }

  initWorker();

  function execute(op, sql, args) {
    if (explicitlyClosed) throw new Error('Koneksi database sudah ditutup.');
    if (workerFailure || !worker) {
      // Auto-recover / re-spawn worker on next query attempt
      initWorker();
    }
    const sharedBuffer = new SharedArrayBuffer(8 + RESULT_BUFFER_BYTES);
    const control = new Int32Array(sharedBuffer, 0, 2);
    worker.postMessage({ op, sql, args, sharedBuffer });
    const waitResult = Atomics.wait(control, 0, 0, QUERY_TIMEOUT_MS);
    if (waitResult === 'timed-out') {
      try { worker.terminate(); } catch (e) {}
      worker = null;
      workerFailure = new Error(`Query database timeout setelah ${QUERY_TIMEOUT_MS / 1000} detik.`);
      throw workerFailure;
    }
    const length = Atomics.load(control, 1);
    const payload = Buffer.from(new Uint8Array(sharedBuffer, 8, length)).toString('utf8');
    const result = JSON.parse(payload);
    if (!result.ok) throw new Error(result.error || 'Query database gagal.');
    return result.value;
  }

  function statement(sql) {
    return {
      get(...args) { return execute('get', sql, args); },
      all(...args) { return execute('all', sql, args); },
      run(...args) { return execute('run', sql, args); }
    };
  }

  return {
    prepare: statement,
    exec(sql) { return execute('exec', sql, []); },
    pragma() { return null; },
    sync() { return true; },
    transaction(fn) {
      const wrapped = (...args) => fn(...args);
      wrapped.default = wrapped;
      wrapped.deferred = wrapped;
      wrapped.immediate = wrapped;
      wrapped.exclusive = wrapped;
      return wrapped;
    },
    close() {
      if (explicitlyClosed) return;
      explicitlyClosed = true;
      if (worker) {
        try { worker.terminate(); } catch (e) {}
        worker = null;
      }
    }
  };
}

module.exports = {
  createRemoteDatabase,
  QUERY_TIMEOUT_MS,
  normalizeHttpUrl,
  isRemoteConnectionError
};
