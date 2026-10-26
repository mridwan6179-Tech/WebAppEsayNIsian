const path = require('path');
const { Worker } = require('worker_threads');

const RESULT_BUFFER_BYTES = 8 * 1024 * 1024;
// Batasi waktu tunggu satu query agar serverless tidak menggantung lama saat
// endpoint Turso sedang bermasalah. Database adapter akan dibuat ulang oleh
// database.js setelah timeout terdeteksi sebagai error koneksi.
const QUERY_TIMEOUT_MS = 8000;

function createRemoteDatabase({ url, authToken }) {
  const worker = new Worker(path.join(__dirname, 'remoteDatabaseWorker.js'), {
    workerData: { url, authToken: authToken || '' }
  });
  let closed = false;
  let workerFailure = null;
  worker.on('error', (error) => {
    workerFailure = error;
  });
  worker.on('exit', (code) => {
    if (code !== 0 && !closed && !workerFailure) {
      workerFailure = new Error(`Worker database berhenti dengan kode ${code}.`);
    }
  });

  function execute(op, sql, args) {
    if (closed) throw new Error('Koneksi database sudah ditutup.');
    if (workerFailure) throw workerFailure;
    const sharedBuffer = new SharedArrayBuffer(8 + RESULT_BUFFER_BYTES);
    const control = new Int32Array(sharedBuffer, 0, 2);
    worker.postMessage({ op, sql, args, sharedBuffer });
    const waitResult = Atomics.wait(control, 0, 0, QUERY_TIMEOUT_MS);
    if (waitResult === 'timed-out') {
      // Worker yang masih menunggu jaringan tidak boleh menerima query baru;
      // caller akan membuat instance pengganti melalui mekanisme reconnect.
      try { worker.terminate(); } catch (e) {}
      closed = true;
      throw new Error(`Query database timeout setelah ${QUERY_TIMEOUT_MS / 1000} detik.`);
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

module.exports = { createRemoteDatabase, QUERY_TIMEOUT_MS };
