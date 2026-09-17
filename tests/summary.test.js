const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/database');
const summaryService = require('../src/services/summaryService');
const geminiService = require('../src/services/geminiService');

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

  test('10. AI Helper dapat mengekstrak berkas dokumen (PDF/Word/TXT base64) tanpa menyimpannya ke database', async () => {
    const sampleTxtBase64 = Buffer.from('Materi Bab 1: Fotosintesis pada tumbuhan membutuhkan cahaya matahari, klorofil, dan air untuk menghasilkan oksigen dan glukosa.').toString('base64');
    const result = await summaryService.generateMasterSummaryAI({
      judul: 'Fotosintesis Tumbuhan',
      mataPelajaran: 'Biologi',
      tingkatKelas: '10 MIPA',
      deskripsi: 'Simak dokumen berikut',
      tipeMedia: 'pdf_url',
      fileBase64: sampleTxtBase64,
      fileName: 'modul_fotosintesis.txt'
    });

    assert.ok(result.master_rangkuman, 'Harus menghasilkan master rangkuman');
    assert.ok(Array.isArray(result.poin_kunci) && result.poin_kunci.length >= 3, 'Harus menghasilkan poin kunci');
  });

  test('11. Evaluasi AI Tugas Rangkuman menggunakan rotasi model dinamis, failover otomatis, dan cooldown terpusat (mirip ulangan)', async () => {
    const geminiService = require('../src/services/geminiService');
    geminiService.clearModelCooldowns();

    const ordered = await geminiService.getOrderedCandidateModels();
    assert.ok(ordered.length >= 2, 'Harus ada minimal 2 kandidat model');

    // Buat data submission uji
    const testSubId = db.prepare(`
      INSERT INTO pengerjaan_rangkuman (
        tugas_id, nama_siswa, kelas_siswa, teks_rangkuman, jumlah_kata, status, status_antrean
      ) VALUES (?, ?, ?, ?, ?, 'submitted', 'menunggu')
    `).run(
      createdTask.id,
      'Siti Nurhaliza',
      '10 MIPA 1',
      'Peradaban Islam pada masa Dinasti Abbasiyah berkembang sangat pesat dengan berdirinya Baitul Hikmah sebagai pusat riset dan penerjemahan naskah ilmu pengetahuan dunia.',
      22
    ).lastInsertRowid;

    const originalFetch = global.fetch;
    const attemptedModels = [];

    global.fetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes(ordered[0])) {
        attemptedModels.push(ordered[0]);
        // Model 1 kena Rate Limit 429
        return {
          ok: false,
          status: 429,
          text: async () => 'Rate limit 429 exceeded on primary flash-lite model'
        };
      }
      if (urlStr.includes(ordered[1])) {
        attemptedModels.push(ordered[1]);
        // Model 2 berhasil
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    skor: 88,
                    kelebihan: 'Pemahaman konsep Baitul Hikmah sangat baik.',
                    kekurangan: 'Bisa dielaborasi lebih lanjut mengenai tokoh ilmuwan.',
                    saran: 'Lanjutkan membaca literatur sejarah Islam.',
                    poin_tercapai: ['Baitul Hikmah sebagai pusat riset dunia'],
                    poin_terlewat: []
                  })
                }]
              }
            }]
          })
        };
      }
      return originalFetch(url, opts);
    };

    try {
      const evalRes = await summaryService.evaluateSingleSubmission(testSubId);
      assert.equal(evalRes.skor, 88);

      // Pastikan model pertama yang 429 dicoba lalu beralih ke model kedua
      assert.strictEqual(attemptedModels.length, 2);
      assert.strictEqual(attemptedModels[0], ordered[0]);
      assert.strictEqual(attemptedModels[1], ordered[1]);

      // Pastikan model pertama masuk masa cooldown
      assert.ok(geminiService.isModelInCooldown(ordered[0]), 'Model pertama yang 429 harus tercatat dalam cooldown');

      // Pastikan database pengerjaan mencatat nama model dinamis yang sukses
      const updatedSub = db.prepare('SELECT skor_ai, model_ai, status_antrean FROM pengerjaan_rangkuman WHERE id = ?').get(testSubId);
      assert.equal(updatedSub.skor_ai, 88);
      assert.match(updatedSub.model_ai, new RegExp(ordered[1]));
      assert.equal(updatedSub.status_antrean, 'selesai');
    } finally {
      global.fetch = originalFetch;
      geminiService.clearModelCooldowns();
    }
  });

  test('12. Guru dapat memicu cek ulang AI untuk pengerjaan siswa (individual & massal)', async () => {
    // Ambil submission yang ada
    const sub = db.prepare('SELECT id FROM pengerjaan_rangkuman WHERE tugas_id = ? LIMIT 1').get(createdTask.id);
    assert.ok(sub, 'Harus ada submission');

    // 1. Cek ulang individual
    const recheckRes = await summaryService.recheckSubmissionAi(sub.id, testGuruId);
    assert.equal(recheckRes.success, true);
    assert.ok(recheckRes.data.skor_ai >= 60);
    assert.equal(recheckRes.data.status_antrean, 'selesai');

    // 2. Cek ulang massal
    const bulkRes = summaryService.recheckAllAi(createdTask.id, testGuruId);
    assert.equal(bulkRes.success, true);

    const antreanCount = db.prepare("SELECT COUNT(*) as count FROM antrean_rangkuman WHERE status = 'menunggu'").get();
    assert.ok(antreanCount.count >= 1, 'Antrean harus terisi kembali status menunggu');
  });

  test('13. Guru dapat menghapus pengerjaan siswa sehingga siswa dapat mengumpulkan ulang', () => {
    // Buat pengerjaan baru untuk siswa Budi (minimal 20 kata)
    const subBudi = summaryService.submitSummary(createdTask.id, {
      namaSiswa: 'Budi Santoso',
      kelasSiswa: '10 MIPA 2',
      teksRangkuman: 'Peradaban Islam pada masa Dinasti Abbasiyah di Baghdad berkembang sangat pesat melalui perpustakaan Baitul Hikmah yang giat menerjemahkan aneka ilmu pengetahuan dunia.'
    });
    assert.equal(subBudi.success, true);
    assert.ok(subBudi.pengerjaan_id);

    // Coba submit lagi (harus ditolak karena double-submit guard)
    const rejectDouble = summaryService.submitSummary(createdTask.id, {
      namaSiswa: 'Budi Santoso',
      kelasSiswa: '10 MIPA 2',
      teksRangkuman: 'Peradaban Islam pada masa Dinasti Abbasiyah di Baghdad berkembang sangat pesat melalui perpustakaan Baitul Hikmah yang giat menerjemahkan aneka ilmu pengetahuan dunia.'
    });
    assert.equal(rejectDouble.success, false);
    assert.match(rejectDouble.message, /sudah pernah mengumpulkan/);

    // Guru menghapus pengerjaan Budi
    const deleteRes = summaryService.deleteSubmission(subBudi.pengerjaan_id, testGuruId);
    assert.equal(deleteRes.success, true);

    // Pastikan terhapus dari database
    const checkDb = db.prepare('SELECT id FROM pengerjaan_rangkuman WHERE id = ?').get(subBudi.pengerjaan_id);
    assert.equal(checkDb, undefined, 'Pengerjaan harus sudah terhapus');

    // Siswa Budi sekarang BISA mengumpulkan ulang tanpa terblokir
    const resubmission = summaryService.submitSummary(createdTask.id, {
      namaSiswa: 'Budi Santoso',
      kelasSiswa: '10 MIPA 2',
      teksRangkuman: 'Rangkuman revisi Budi yang berhasil dikumpulkan kembali secara lengkap dan mendalam setelah data pengerjaan lamanya dibersihkan oleh bapak ibu guru pengampu mata pelajaran.'
    });
    assert.equal(resubmission.success, true, 'Siswa harus bisa mengumpulkan kembali setelah datanya dihapus');
  });

  test('14. Guru dapat membersihkan/reset seluruh data pengumpulan untuk satu tugas', () => {
    // Bersihkan seluruh pengumpulan
    const resetRes = summaryService.deleteAllSubmissions(createdTask.id, testGuruId);
    assert.equal(resetRes.success, true);
    assert.ok(resetRes.deleted_count >= 1);

    // Cek bahwa tidak ada lagi pengerjaan untuk tugas ini
    const remaining = summaryService.getSubmissionsByTask(createdTask.id, testGuruId);
    assert.equal(remaining.length, 0);
  });

  test('15. Guru dapat mengedit tugas rangkuman termasuk memperbarui daftar kelas', () => {
    const updated = summaryService.updateTask(createdTask.id, testGuruId, {
      judul: 'Rangkuman Peradaban Islam Klasik (Revisi)',
      tingkat_kelas: '10 MIPA 1, 10 MIPA 2, 10 IPS 1',
      batas_minimum_kata: 30
    });

    assert.equal(updated.judul, 'Rangkuman Peradaban Islam Klasik (Revisi)');
    assert.equal(updated.tingkat_kelas, '10 MIPA 1, 10 MIPA 2, 10 IPS 1');
    assert.equal(updated.batas_minimum_kata, 30);
  });

  test('16. Status pengerjaan siswa menyertakan teks rangkuman, link media, dan kelas untuk fitur unduh PDF', () => {
    // Kumpulkan rangkuman baru (minimal 30 kata)
    const submitRes = summaryService.submitSummary(createdTask.id, {
      namaSiswa: 'Siti Rahma',
      kelasSiswa: '10 MIPA 1',
      teksRangkuman: 'Peradaban Islam klasik memberikan sumbangsih yang luar biasa dalam bidang ilmu pengetahuan dan sains seperti astronomi, aljabar, optik, dan kedokteran yang hingga kini terus dipelajari dan dikembangkan oleh para ilmuwan di seluruh dunia modern.'
    });

    assert.equal(submitRes.success, true);
    const statusRes = summaryService.getStudentStatus(submitRes.pengerjaan_id);

    assert.equal(statusRes.success, true);
    assert.ok(statusRes.data.teks_rangkuman, 'Harus memuat teks_rangkuman');
    assert.equal(statusRes.data.nama_siswa, 'Siti Rahma');
    assert.equal(statusRes.data.tingkat_kelas, '10 MIPA 1, 10 MIPA 2, 10 IPS 1');
    assert.equal(statusRes.data.media_url, createdTask.media_url);
    assert.equal(statusRes.data.tipe_media, 'youtube');
  });

  test('17. Guru dapat menyusun draf sebaran WhatsApp to-the-point untuk tugas rangkuman (standar & AI)', async () => {
    const defaultBroadcast = geminiService.formatDefaultWhatsAppBroadcastForSummary(createdTask, 'http://localhost:3000');
    assert.match(defaultBroadcast, /PEMBERITAHUAN TUGAS LITERASI & RANGKUMAN/);
    assert.match(defaultBroadcast, new RegExp(createdTask.kode_tugas));
    assert.match(defaultBroadcast, /Tautan Langsung Pengerjaan/);
    assert.match(defaultBroadcast, /minimal \d+ kata/i);

    // Generator AI (atau fallback instan)
    const aiBroadcast = await geminiService.generateWhatsAppBroadcastForSummary(createdTask, 'http://localhost:3000');
    assert.ok(aiBroadcast && typeof aiBroadcast === 'string');
    assert.match(aiBroadcast, new RegExp(createdTask.kode_tugas));
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
