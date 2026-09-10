const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const app = require('../server');

test('T-07: Integrasi Penuh API & Header Google Sites (FR-22 - FR-23, NFR-09, NFR-13)', async (t) => {
  let server;
  let baseUrl;
  let teacherToken;
  let examId;
  let examCode;
  let soalId;
  let pengerjaanId;

  // Jalankan server di ephemeral port untuk testing
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

  await t.test('Header Iframe Google Sites Kompatibel (CSP & No Frame-Options blocking)', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.strictEqual(res.status, 200);

    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'CSP header harus ada');
    assert.ok(csp.includes('https://sites.google.com'), 'CSP harus mengizinkan sites.google.com');

    const xfo = res.headers.get('x-frame-options');
    assert.strictEqual(xfo, null, 'X-Frame-Options tidak boleh memblokir iframe (harus null)');
  });

  await t.test('API Guru: Login dan Verifikasi Token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'guru@sekolah.id', password: 'guru123' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.token);
    teacherToken = data.token;
  });

  await t.test('API Guru: Buat Ulangan & Tambah Soal', async () => {
    // Buat Ulangan
    const resUlangan = await fetch(`${baseUrl}/api/guru/ulangan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${teacherToken}`
      },
      body: JSON.stringify({
        judul: 'Ulangan Akhir Semester API Test',
        mata_pelajaran: 'Informatika',
        tingkat_kelas: 'Kelas 12',
        deskripsi: 'Ujian komprehensif'
      })
    });
    assert.strictEqual(resUlangan.status, 200);
    const uData = await resUlangan.json();
    assert.ok(uData.data.id);
    examId = uData.data.id;
    examCode = uData.data.kode_ujian;

    // Tambah Soal
    const resSoal = await fetch(`${baseUrl}/api/guru/ulangan/${examId}/soal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${teacherToken}`
      },
      body: JSON.stringify({
        jenis: 'essay',
        bobot: 50,
        pertanyaan: 'Jelaskan konsep dasar Artificial Intelligence!',
        kunci_jawaban: 'Kecerdasan buatan yang memungkinkan mesin meniru fungsi kognitif manusia.'
      })
    });
    assert.strictEqual(resSoal.status, 200);
    const sData = await resSoal.json();
    soalId = sData.data.id;

    // Buka Ulangan
    await fetch(`${baseUrl}/api/guru/ulangan/${examId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${teacherToken}`
      },
      body: JSON.stringify({ status: 'dibuka' })
    });
  });

  await t.test('API Siswa: Cek Kode, Masuk Ujian, dan Kumpulkan Jawaban', async () => {
    // Cek Kode
    const resCek = await fetch(`${baseUrl}/api/siswa/cek-kode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kode_ujian: examCode })
    });
    assert.strictEqual(resCek.status, 200);
    const cekData = await resCek.json();
    assert.strictEqual(cekData.valid, true);

    // Mulai Ujian
    const resMulai = await fetch(`${baseUrl}/api/siswa/mulai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kode_ujian: examCode, nama: 'Dinda Kirana', kelas: '12 IPA 2' })
    });
    assert.strictEqual(resMulai.status, 200);
    const mData = await resMulai.json();
    assert.ok(mData.pengerjaanId);
    pengerjaanId = mData.pengerjaanId;

    // Submit Jawaban
    const resSubmit = await fetch(`${baseUrl}/api/siswa/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pengerjaan_id: pengerjaanId,
        jawaban: [{ soal_id: soalId, jawaban_siswa: 'Sistem komputer yang mampu belajar dan memecahkan masalah seperti manusia.' }]
      })
    });
    assert.strictEqual(resSubmit.status, 200);
    const subData = await resSubmit.json();
    assert.strictEqual(subData.success, true);
  });

  await t.test('FR-22 & NFR-09: Siswa belum dapat melihat nilai sebelum dirilis', async () => {
    const res = await fetch(`${baseUrl}/api/siswa/hasil/${pengerjaanId}`);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.isReleased, false);
    assert.strictEqual(data.data.nilaiFinal, null);
  });

  await t.test('API Guru: Review Nilai & Rilis Hasil Ujian', async () => {
    // Ambil detail pengerjaan guru
    const resP = await fetch(`${baseUrl}/api/guru/pengerjaan/${pengerjaanId}`, {
      headers: { 'Authorization': `Bearer ${teacherToken}` }
    });
    const pData = await resP.json();
    const jawabanItem = pData.data.jawabanList[0];

    // Guru beri skor 45 dari bobot 50
    const resRev = await fetch(`${baseUrl}/api/guru/jawaban/${jawabanItem.jawaban_id}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${teacherToken}`
      },
      body: JSON.stringify({
        skor_final: 45,
        catatan_guru: 'Jawaban tepat dan runtut.'
      })
    });
    assert.strictEqual(resRev.status, 200);

    // Guru Rilis Nilai ke Siswa
    const resRelease = await fetch(`${baseUrl}/api/guru/ulangan/${examId}/release`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${teacherToken}`
      },
      body: JSON.stringify({ isReleased: true })
    });
    assert.strictEqual(resRelease.status, 200);
  });

  await t.test('FR-23: Siswa dapat melihat nilai final (skala 100) setelah dirilis', async () => {
    const res = await fetch(`${baseUrl}/api/siswa/hasil/${pengerjaanId}`);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.data.isReleased, true);
    // 45 / 50 * 100 = 90
    assert.strictEqual(data.data.nilaiFinal, 90);
    assert.strictEqual(data.data.jawaban.length, 1);
    assert.strictEqual(data.data.jawaban[0].catatan_guru, 'Jawaban tepat dan runtut.');
  });
});
