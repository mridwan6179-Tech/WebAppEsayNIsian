const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');

test('Turso di Vercel memilih koneksi remote tanpa embedded file sync', () => {
  assert.strictEqual(db.resolveTursoMode({ isVercel: true, hasUrl: true, hasToken: true }), 'remote');
  assert.strictEqual(db.resolveTursoMode({ isVercel: false, hasUrl: true, hasToken: true }), 'embedded');
  assert.strictEqual(db.resolveTursoMode({ isVercel: true, hasUrl: false, hasToken: false }), 'sqlite');
});
