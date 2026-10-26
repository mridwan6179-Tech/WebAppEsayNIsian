const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRemoteDatabase, QUERY_TIMEOUT_MS, normalizeHttpUrl } = require('../src/config/remoteDatabase');

test('remote adapter mengubah URL libsql menjadi endpoint HTTPS HTTP', () => {
  assert.equal(normalizeHttpUrl('libsql://demo.turso.io'), 'https://demo.turso.io');
  assert.equal(normalizeHttpUrl('https://demo.turso.io'), 'https://demo.turso.io');
});

test('remote query timeout dibatasi agar serverless tidak menggantung terlalu lama', () => {
  assert.ok(QUERY_TIMEOUT_MS <= 10000, `Timeout query terlalu lama: ${QUERY_TIMEOUT_MS}ms`);
});

test('remote database mempertahankan API sinkron untuk query Turso', async (t) => {
  const filePath = path.join(os.tmpdir(), `remote-db-${process.pid}-${Date.now()}.sqlite`);
  const db = createRemoteDatabase({ url: `file:${filePath}` });
  t.after(() => {
    db.close();
    try { fs.unlinkSync(filePath); } catch (err) {}
  });

  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO item (name) VALUES (?)').run('ujian');
  assert.equal(Number(insert.lastInsertRowid), 1);
  assert.deepEqual(db.prepare('SELECT id, name FROM item WHERE id = ?').get(1), { id: 1, name: 'ujian' });
  assert.deepEqual(db.prepare('SELECT name FROM item ORDER BY id').all(), [{ name: 'ujian' }]);
});
