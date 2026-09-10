const test = require('node:test');
const assert = require('node:assert');
const authService = require('../src/services/authService');
require('dotenv').config();

test('T-01 FR-01: Autentikasi Guru', async (t) => {
  await t.test('Login gagal dengan password salah', () => {
    const result = authService.login('guru@sekolah.id', 'passwordsalah');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.token, undefined);
  });

  await t.test('Login gagal dengan email salah', () => {
    const result = authService.login('unknown@sekolah.id', 'guru123');
    assert.strictEqual(result.success, false);
  });

  await t.test('Login berhasil dengan kredensial valid', () => {
    const validEmail = process.env.TEACHER_EMAIL || 'guru@sekolah.id';
    const validPassword = process.env.TEACHER_PASSWORD || 'guru123';
    const result = authService.login(validEmail, validPassword);

    assert.strictEqual(result.success, true);
    assert.ok(result.token);
    assert.strictEqual(result.guru.email, validEmail);

    // Verify token
    const session = authService.verifyToken(result.token);
    assert.ok(session);
    assert.strictEqual(session.email, validEmail);

    // Logout
    authService.logout(result.token);
    assert.strictEqual(authService.verifyToken(result.token), null);
  });

  await t.test('Token palsu atau kosong ditolak', () => {
    assert.strictEqual(authService.verifyToken(null), null);
    assert.strictEqual(authService.verifyToken('token-ngawur'), null);
  });
});
