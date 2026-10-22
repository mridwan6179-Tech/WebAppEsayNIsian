const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRemoteDatabase } = require('../src/config/remoteDatabase');

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
