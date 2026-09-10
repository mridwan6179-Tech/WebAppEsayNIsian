const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../server');
const db = require('../src/config/database');
const authService = require('../src/services/authService');

test('=== PENGUJIAN FITUR BACKUP & RESTORE DATABASE DI PORTAL ADMIN ===', async (t) => {
  let server;
  let baseUrl;
  let adminToken;

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });

  t.after(() => {
    server.close();
  });

  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const loginRes = authService.loginAdmin('admin', adminPass);
  adminToken = loginRes.token;

  await t.test('1. Akses backup & restore ditolak jika tanpa autentikasi admin (401)', async () => {
    const resBackup = await fetch(`${baseUrl}/api/admin/database/backup`);
    assert.strictEqual(resBackup.status, 401);

    const resRestore = await fetch(`${baseUrl}/api/admin/database/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_base64: 'abc' })
    });
    assert.strictEqual(resRestore.status, 401);
  });

  let backupBuffer;

  await t.test('2. Admin dapat mengunduh file cadangan database (valid SQLite format 3)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/database/backup`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });

    assert.strictEqual(res.status, 200);
    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition && disposition.includes('ulangan_ai_backup_'));

    const arrayBuffer = await res.arrayBuffer();
    backupBuffer = Buffer.from(arrayBuffer);
    
    // Header SQLite 16 byte
    const header = backupBuffer.slice(0, 16).toString('utf8');
    assert.strictEqual(header, 'SQLite format 3\0');
  });

  await t.test('3. Restore menolak file yang rusak atau bukan SQLite 3', async () => {
    const fakeFileBase64 = Buffer.from('Ini bukan file database SQLite yang valid sama sekali').toString('base64');
    const res = await fetch(`${baseUrl}/api/admin/database/restore`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file_base64: fakeFileBase64 })
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.message.includes('Format file tidak valid') || data.message.includes('SQLite'));
  });

  await t.test('4. Alur Lengkap: Backup Data -> Modifikasi Data -> Restore -> Verifikasi Data Pulih', async () => {
    // 1. Tambah data guru A sebelum backup
    const testGuruEmail = `guru_backup_test_${Date.now()}@sekolah.id`;
    db.prepare('INSERT INTO guru (email, nama, password) VALUES (?, ?, ?)').run(testGuruEmail, 'Guru Asli Terbackup', 'guru123');

    // 2. Ambil backup terbaru yang memuat testGuruEmail
    const backupRes = await fetch(`${baseUrl}/api/admin/database/backup`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(backupRes.status, 200);
    const snapBuffer = Buffer.from(await backupRes.arrayBuffer());

    // 3. Tambah guru B sesudah backup (data sementara yang nantinya harus hilang saat restore)
    const extraEmail = `extra_guru_${Date.now()}@sekolah.id`;
    db.prepare('INSERT INTO guru (email, nama, password) VALUES (?, ?, ?)').run(extraEmail, 'Extra Guru Pasca Backup', 'pass');

    const checkBefore = db.prepare('SELECT COUNT(*) as c FROM guru WHERE email = ?').get(extraEmail);
    assert.strictEqual(checkBefore.c, 1);

    // 4. Lakukan Restore menggunakan snapshot tadi
    const restoreRes = await fetch(`${baseUrl}/api/admin/database/restore`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        file_base64: snapBuffer.toString('base64'),
        filename: 'snapshot.sqlite'
      })
    });

    assert.strictEqual(restoreRes.status, 200);
    const restoreData = await restoreRes.json();
    assert.strictEqual(restoreData.success, true);
    assert.ok(restoreData.summary);
    assert.ok(restoreData.summary.guru >= 1);

    // 5. Verifikasi: extraEmail harus lenyap karena data kembali ke kondisi snapshot
    const checkExtraAfter = db.prepare('SELECT COUNT(*) as c FROM guru WHERE email = ?').get(extraEmail);
    assert.strictEqual(checkExtraAfter.c, 0, 'Guru pasca backup harus lenyap setelah restore');

    // 6. Verifikasi: testGuruEmail harus tetap ada
    const checkOriginal = db.prepare('SELECT COUNT(*) as c FROM guru WHERE email = ?').get(testGuruEmail);
    assert.strictEqual(checkOriginal.c, 1, 'Guru asli sebelum backup harus tetap ada');
  });
});
