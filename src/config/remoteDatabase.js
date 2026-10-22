const path = require('path');
const { Worker } = require('worker_threads');

const RESULT_BUFFER_BYTES = 8 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 30000;

function createRemoteDatabase({ url, authToken }) {
  const worker = new Worker(path.join(__dirname, 'remoteDatabaseWorker.js'), {
    workerData: { url, authToken: authToken || '' }
  });
  let closed = false;

  function execute(op, sql, args) {
    if (closed) throw new Error('Koneksi database sudah ditutup.');
    const sharedBuffer = new SharedArrayBuffer(8 + RESULT_BUFFER_BYTES);
    const control = new Int32Array(sharedBuffer, 0, 2);
    worker.postMessage({ op, sql, args, sharedBuffer });
    const waitResult = Atomics.wait(control, 0, 0, QUERY_TIMEOUT_MS);
    if (waitResult === 'timed-out') throw new Error('Query database timeout setelah 30 detik.');
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
    // PRAGMA is local connection tuning and is not supported by every Turso
    // HTTP endpoint. The main adapter calls it during startup, so treat it as
    // a harmless no-op for the remote connection.
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
      if (closed) return;
      closed = true;
      return worker.terminate();
    }
  };
}

module.exports = { createRemoteDatabase };
