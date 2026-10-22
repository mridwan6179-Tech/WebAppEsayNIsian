const { parentPort, workerData } = require('worker_threads');
const { createClient } = require('@libsql/client');

const client = createClient({
  url: workerData.url,
  authToken: workerData.authToken
});

function jsonSafe(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = jsonSafe(item);
    return output;
  }
  return value;
}

function writeResult(sharedBuffer, result) {
  const control = new Int32Array(sharedBuffer, 0, 2);
  const data = new Uint8Array(sharedBuffer, 8);
  const payload = Buffer.from(JSON.stringify(jsonSafe(result)));
  if (payload.length > data.byteLength) {
    const error = Buffer.from(JSON.stringify({ ok: false, error: 'Hasil query terlalu besar.' }));
    data.set(error);
    Atomics.store(control, 1, error.length);
  } else {
    data.set(payload);
    Atomics.store(control, 1, payload.length);
  }
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}

function rowToObject(result, row) {
  const output = {};
  result.columns.forEach((column, index) => {
    output[column] = row[index];
  });
  return output;
}

async function execute(message) {
  const { op, sql, args = [] } = message;
  if (op === 'exec') {
    await client.executeMultiple(sql);
    return null;
  }

  const result = await client.execute({ sql, args });
  if (op === 'get') return result.rows.length ? rowToObject(result, result.rows[0]) : undefined;
  if (op === 'all') return result.rows.map(row => rowToObject(result, row));
  if (op === 'run') {
    return {
      changes: Number(result.rowsAffected || 0),
      lastInsertRowid: result.lastInsertRowid == null ? 0 : Number(result.lastInsertRowid)
    };
  }
  return null;
}

parentPort.on('message', async (message) => {
  try {
    writeResult(message.sharedBuffer, { ok: true, value: await execute(message) });
  } catch (error) {
    writeResult(message.sharedBuffer, { ok: false, error: String(error?.message || error) });
  }
});
