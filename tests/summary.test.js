const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/database');
const summaryService = require('../src/services/summaryService');

describe('=== SUITE: FITUR TUGAS RANGKUMAN BERBANTUAN AI ===', () => {
  let testGuruId = 1;
  let createdTask = null;

  before(() => {
    // Pastikan ada guru aktif untuk pengujian
    const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
    if (guru) {
      testGuruId = guru.id;
    }
  });

  test('1. Guru dapat membuat tugas rangkuman baru dengan kode akses unik', () => {
    const taskData = {
      judul: 'Rangkuman Peradaban Islam Klasik',
      mata_pelajaran: 'Sejarah Kebudayaan Islam',
      tingkat_kelas: '10 MIPA',
      deskripsi: 'Tonton video berikut lalu rangkum 3 poin kepemimpinan khalifah.',
      tipe_media: 'youtube',
      media_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      batas_minimum_kata: 20,
      batas_maksimum_kata: 100,
      master_rangkuman: 'Peradaban Islam klasik berkembang pesat pada era Bani Umayyah dan Abbasiyah dengan pusat ilmu di Baghdad dan Damaskus.',
      poin_kunci: [
        'Perkembangan sains dan teknologi',
        'Penerjemahan manuskrip Yunani ke bahasa Arab',
        'Baitul Hikmah sebagai pusat riset dunia'
      ],
      status: 'dibuka'
    };

    createdTask = summaryService.createTask(testGuruId, taskData);

    assert.ok(createdTask.id, 'ID tugas harus ter-generate');
    assert.equal(createdTask.judul, 'Rangkuman Peradaban Islam Klasik');
    assert.match(createdTask.kode_tugas, /^RGK-[A-Z0-9]{4}$/, 'Kode tugas harus format RGK-XXXX');
    assert.equal(createdTask.batas_minimum_kata, 20);
    assert.equal(createdTask.poin_kunci.length, 3);
  });

  test('2. Siswa dapat memvalidasi kode tugas rangkuman', () => {
    // Kode valid
    const resValid = summaryService.validateTaskCodeForStudent(createdTask.kode_tugas);
    assert.equal(resValid.valid, true);
    assert.equal(resValid.task.judul, 'Rangkuman Peradaban Islam Klasik');
    assert.equal(resValid.task.tipe_media, 'youtube');

    // Kode salah
    const resInvalid = summaryService.validateTaskCodeForStudent('SALAH123');
    assert.equal(resInvalid.valid, false);
  });

  test('3. Filter Nol-Token: Menolak pengumpulan jika jumlah kata di bawah batas minimum', () => {
    // Kurang dari 20 kata
    const res = summaryService.submitSummary(createdTask.id, {
      namaSiswa: 'Ahmad Faiz',
      kelasSiswa: '10 MIPA 1',
      teksRangkuman: 'Ini rangkuman yang sangat pendek sekali.'
    });

    assert.equal(res.success, false);
    assert.match(res.message, /Batas minimum/);
  });

  test('4. Filter Nol-Token: Menolak pengumpulan jika teks terdeteksi spam pengulangan kata', () => {
    // 25 kata tapi cuma mengulang kalimat yang sama
    const spamText = 'Saya belajar sejarah Islam. '.repeat(10);
    const res = summaryService.submitSummary(createdTask.id, {
      namaSiswa: 'Ahmad Faiz',
      kelasSiswa: '10 MIPA 1',
      teksRangkuman: spamText
    });

    assert.equal(res.success, false);
    assert.match(res.message, /pengulangan kata yang tidak wajar/);
  });

  test('5. Pengumpulan valid tersimpan ke DB seketika dan masuk antrean AI', () => {
    const validSummary = `
      Peradaban Islam pada masa Abbasiyah mengalami masa keemasan dengan berdirinya Baitul Hikmah. 
      Pusat ilmu pengetahuan ini menjadi tempat penerjemahan karya-karya Yunani, India, dan Persia ke bahasa Arab.
      Para cendekiawan muslim seperti Al-Khawarizmi dan Ibnu Sina memberikan kontribusi besar bagi matematika dan kedokteran dunia.
    `;

    const res = summaryService.submitSummary(createdTask.id, {
      namaSiswa: 'Ahmad Faiz',
      kelasSiswa: '10 MIPA 1',
      teksRangkuman: validSummary
    });

    assert.equal(res.success, true);
    assert.ok(res.pengerjaan_id);
    assert.ok(res.jumlah_kata >= 20);

    // Cek status pengerjaan
    const statusRes = summaryService.getStudentStatus(res.pengerjaan_id);
    assert.equal(statusRes.success, true);
    assert.equal(statusRes.data.nama_siswa, 'Ahmad Faiz');
    assert.equal(statusRes.data.status_antrean, 'menunggu');
  });

  test('6. Mencegah siswa mengumpulkan tugas rangkuman dua kali', () => {
    const validSummary = `
      Peradaban Islam pada masa Abbasiyah mengalami masa keemasan dengan berdirinya Baitul Hikmah. 
      Pusat ilmu pengetahuan ini menjadi tempat penerjemahan karya-karya Yunani, India, dan Persia ke bahasa Arab.
      Para cendekiawan muslim memberikan kontribusi besar bagi peradaban dunia.
    `;

    const res = summaryService.submitSummary(createdTask.id, {
      namaSiswa: 'Ahmad Faiz',
      kelasSiswa: '10 MIPA 1',
      teksRangkuman: validSummary
    });

    assert.equal(res.success, false);
    assert.match(res.message, /sudah pernah mengumpulkan/);
  });

  test('7. Guru dapat melihat rekap pengumpulan, mengedit nilai final, dan mengekspor CSV', () => {
    // Ambil daftar submission
    const subs = summaryService.getSubmissionsByTask(createdTask.id, testGuruId);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].nama_siswa, 'Ahmad Faiz');

    // Guru verifikasi nilai (misal 90)
    const updateRes = summaryService.updateScoreByGuru(subs[0].id, testGuruId, {
      skorFinal: 90,
      statusKelulusan: 'final'
    });
    assert.equal(updateRes.success, true);
    assert.equal(updateRes.skor_final, 90);

    // Ekspor CSV
    const csv = summaryService.exportSubmissionsCSV(createdTask.id, testGuruId);
    assert.ok(csv.includes('Ahmad Faiz'));
    assert.ok(csv.includes('10 MIPA 1'));
    assert.ok(csv.includes('90'));
  });

  test('8. REST API Endpoints: Cek kode siswa & daftar tugas guru dapat diakses via Express', async () => {
    const app = require('../server');
    const http = require('http');
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      // Test POST /api/siswa/rangkuman/cek-kode
      const resCek = await fetch(`http://localhost:${port}/api/siswa/rangkuman/cek-kode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kode_tugas: createdTask.kode_tugas })
      });
      const dataCek = await resCek.json();
      assert.equal(resCek.status, 200);
      assert.equal(dataCek.valid, true);
      assert.equal(dataCek.task.judul, createdTask.judul);

      // Test GET /api/siswa/rangkuman/status/:id
      const pengerjaan = db.prepare('SELECT id FROM pengerjaan_rangkuman WHERE tugas_id = ? LIMIT 1').get(createdTask.id);
      if (pengerjaan) {
        const resStatus = await fetch(`http://localhost:${port}/api/siswa/rangkuman/status/${pengerjaan.id}`);
        const dataStatus = await resStatus.json();
        assert.equal(resStatus.status, 200);
        assert.equal(dataStatus.success, true);
        assert.equal(dataStatus.data.nama_siswa, 'Ahmad Faiz');
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('9. Worker Antrean AI memproses pengerjaan, memberi skor AI & ulasan konstruktif', async () => {
    // Tunggu worker latar belakang menyelesaikan pemrosesan antrean
    for (let i = 0; i < 25; i++) {
      const p = db.prepare('SELECT status_antrean FROM pengerjaan_rangkuman WHERE tugas_id = ? LIMIT 1').get(createdTask.id);
      if (p && p.status_antrean === 'selesai') break;
      await new Promise(r => setTimeout(r, 200));
    }

    const pengerjaan = db.prepare('SELECT * FROM pengerjaan_rangkuman WHERE tugas_id = ? LIMIT 1').get(createdTask.id);
    assert.ok(pengerjaan, 'Pengerjaan harus ada di database');
    assert.equal(pengerjaan.status_antrean, 'selesai', 'Status antrean harus selesai setelah diproses worker');
    assert.ok(pengerjaan.skor_ai >= 60 && pengerjaan.skor_ai <= 100, `Skor AI harus berada di rentang 60-100, dapat: ${pengerjaan.skor_ai}`);
    assert.ok(pengerjaan.feedback_ai && pengerjaan.feedback_ai.length > 10, 'Feedback AI harus terisi');
  });

  after(() => {
    // Bersihkan data uji
    if (createdTask?.id) {
      try {
        summaryService.deleteTask(createdTask.id, testGuruId);
      } catch (e) {}
    }
  });
});
