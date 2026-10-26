const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');

test('Turso di Vercel memakai adapter HTTP dan embedded hanya di runtime non-serverless', () => {
  assert.strictEqual(db.resolveTursoMode({ isVercel: true, hasUrl: true, hasToken: true }), 'remote');
  assert.strictEqual(db.resolveTursoMode({ isVercel: true, hasUrl: true, hasToken: true, useRemoteHttp: true }), 'remote');
  assert.strictEqual(db.resolveTursoMode({ isVercel: false, hasUrl: true, hasToken: true }), 'embedded');
  assert.strictEqual(db.resolveTursoMode({ isVercel: true, hasUrl: false, hasToken: false }), 'sqlite');
  assert.strictEqual(db.resolveTursoMode({ isVercel: true, hasUrl: true, hasToken: true, requestedMode: 'sqlite' }), 'sqlite');
  assert.strictEqual(db.resolveTursoMode({ isVercel: false, hasUrl: true, hasToken: true, requestedMode: 'local' }), 'sqlite');
});
