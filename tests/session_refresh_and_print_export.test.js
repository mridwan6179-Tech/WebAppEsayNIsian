const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const queueService = require('../src/services/queueService');
const authService = require('../src/services/authService');

test('=== SUITE: PENGECEKAN SESI, ANTREAN 1-BY-1 FIFO, KISI-KISI REMEDIAL & EKSPOR CETAK ===', async (t) => {
  // Setup data guru dan ulangan
  const teacherEmail = `guru_opt_${Date.now()}@sekolah.id`;
  const guruInfo = db.prepare('INSERT INTO guru (nama, email, password, no_wa) VALUES (?, ?, ?, ?)').run(
    'Bapak Guru Opt',
    teacherEmail,
    'password123',
    '08123456789'
  );
  const teacherId = guruInfo.lastInsertRowid;

  const ulangan = examService.createUlangan(teacherId, {
    judul: 'Ulangan Optimalisasi & Remedial',
    mata_pelajaran: 'Informatika',
    tingkat_kelas: '8A',
    durasi_menit: 30,
    kkm: 75,
    skor_langsung_ai: 1,
    remedial_langsung: 1,
    link_kisi_kisi: 'https://sekolah.id/kisi-kisi-8a',
    konten_kisi_kisi: JSON.stringify({
      judul_kisi_kisi: 'Kisi-kisi Informatika Terpadu',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: '8A',
      daftar_kisi_kisi: [
        { nomor_soal: 1, bentuk_soal: 'PG Biasa', materi_pokok: 'Perangkat Lunak', indikator_soal: 'Mengidentifikasi sistem operasi', fokus_belajar: 'Pelajari perbedaan Linux, Windows, macOS' }
      ]
    }),
    tampilkan_kisi_kisi: 1
  });

  examService.updateStatusUlangan(ulangan.id, 'dibuka');

  // Buat 2 soal (1 PG dan 1 Isian)
  const soal1 = examService.createSoal(ulangan.id, {
    nomor: 1,
    jenis: 'pilihan_ganda',
    tipe_pg: 'pg_biasa',
    pertanyaan: 'Manakah yang termasuk sistem operasi open source?',
    opsi_a: 'Linux Ubuntu',
    opsi_b: 'Windows 11',
    opsi_c: 'macOS Monterey',
    opsi_d: 'iOS 17',
    kunci_jawaban: 'A',
    kunci_pg: 'A',
    bobot: 10
  });

  const soal2 = examService.createSoal(ulangan.id, {
    nomor: 2,
    jenis: 'isian',
    pertanyaan: 'Sebutkan kepanjangan dari CPU?',
    kunci_jawaban: 'Central Processing Unit',
    rubrik: 'Jawaban benar jika menyebutkan Central Processing Unit',
    bobot: 10
  });

  await t.test('1. getExamPrintData menyertakan opsi PG (opsi_a - opsi_e) dan kunci', () => {
    const printData = examService.getExamPrintData(ulangan.id, teacherId, {
      jumlah_cetak: 2,
      mode_pilihan: 'semua'
    });

    assert.strictEqual(printData.success, true);
    assert.strictEqual(printData.paket_list.length, 2);
    
    const p1 = printData.paket_list[0];
    const q1 = p1.soal.find(s => s.id === soal1.id);
    assert.ok(q1, 'Soal 1 harus ditemukan di paket cetak');
    assert.strictEqual(q1.opsi_a, 'Linux Ubuntu');
    assert.strictEqual(q1.opsi_b, 'Windows 11');
    assert.strictEqual(q1.kunci_pg, 'A');
    assert.strictEqual(q1.tipe_pg, 'pg_biasa');
  });

  let s1;

  await t.test('2. getPengerjaanStatus mengembalikan info kisi-kisi untuk halaman remedial', () => {
    s1 = studentService.startExam(ulangan.kode_ujian, 'Ahmad Siswa A', '8A');
    studentService.submitExam(s1.pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'B' }, // salah (skor 0)
      { soal_id: soal2.id, jawaban_siswa: 'Central Processing Unit' }
    ]);

    const status = studentService.getPengerjaanStatus(s1.pengerjaanId);
    assert.strictEqual(status.pengerjaanId, s1.pengerjaanId);
    assert.strictEqual(status.remedial_langsung, 1);
    assert.strictEqual(status.canDirectRemedial, true);
    assert.strictEqual(status.link_kisi_kisi, 'https://sekolah.id/kisi-kisi-8a');
    assert.ok(status.konten_kisi_kisi.includes('Kisi-kisi Informatika Terpadu'));
    assert.strictEqual(status.tampilkan_kisi_kisi, 1);
  });

  await t.test('3. Antrean AI FIFO: Siswa A yang submit duluan dievaluasi tuntas sebelum Siswa B', async () => {
    // Siswa B submit setelah Siswa A
    const s2 = studentService.startExam(ulangan.kode_ujian, 'Budi Siswa B', '8A');
    studentService.submitExam(s2.pengerjaanId, [
      { soal_id: soal2.id, jawaban_siswa: 'Central Process' }
    ]);

    // Enqueue ulangan
    queueService.enqueueUlangan(ulangan.id);

    // Ambil pengerjaan_id dari antrean pertama yang diproses
    const processedPengerjaanIds = [];
    const mockGrader = async (item) => {
      processedPengerjaanIds.push(item.pengerjaan_id);
      return {
        status_jawaban: 'benar',
        skor_rekomendasi: item.bobot,
        alasan_ai: 'Evaluasi akurat FIFO test'
      };
    };

    // Evaluasi step 1
    const step1 = await queueService.processNextAnswer(ulangan.id, mockGrader);
    assert.strictEqual(step1.success, true);
    assert.strictEqual(step1.done, false);

    // Pastikan item pertama yang dievaluasi adalah milik Siswa A (karena submit lebih awal)
    const pendingItem1 = db.prepare('SELECT pengerjaan_id FROM jawaban WHERE id = ?').get(step1.jawaban_id);
    assert.strictEqual(pendingItem1.pengerjaan_id, s1.pengerjaanId, 'Siswa A harus dievaluasi terlebih dahulu sebelum Siswa B');
  });

  await t.test('4. Concurrency lock = 1: jika ada pekerjaan yang sedang diproses, panggilan simultan ditolak (busy)', async () => {
    // Simulasikan ada satu pekerjaan di antrean ulangan ini yang sedang berstatus 'diproses'
    const targetRow = db.prepare(`
      SELECT a.id, a.jawaban_id 
      FROM antrean_review a
      JOIN jawaban j ON a.jawaban_id = j.id
      JOIN pengerjaan p ON j.pengerjaan_id = p.id
      WHERE p.ulangan_id = ?
      LIMIT 1
    `).get(ulangan.id);

    assert.ok(targetRow, 'Harus ada row antrean untuk ulangan ini');
    db.prepare("UPDATE antrean_review SET status = 'diproses', locked_at = CURRENT_TIMESTAMP WHERE id = ?").run(targetRow.id);

    const checkSimultan = await queueService.processNextAnswer(ulangan.id);
    assert.strictEqual(checkSimultan.busy, true, 'Harus merespons busy = true karena ada jawaban yang sedang dievaluasi');

    // Kembalikan status
    db.prepare("UPDATE antrean_review SET status = 'menunggu', locked_at = NULL WHERE id = ?").run(targetRow.id);
  });

  await t.test('5. Shared Computer Timer: pengerjaan kadaluarsa (waktu habis) di-auto-submit saat siswa masuk', () => {
    const sOld = studentService.startExam(ulangan.kode_ujian, 'Siswa Lama Abandoned', '8A');
    
    // Simulasikan waktu mulai pengerjaan siswa lama sudah 2 jam lalu (kadaluarsa > durasi 30 menit)
    db.prepare(`UPDATE pengerjaan SET started_at = datetime('now', '-2 hours') WHERE id = ?`).run(sOld.pengerjaanId);

    // Siswa lama (atau siswa di komputer yang sama) mencoba memulai kembali
    const refreshed = studentService.startExam(ulangan.kode_ujian, 'Siswa Lama Abandoned', '8A');
    assert.strictEqual(refreshed.alreadySubmitted, true, 'Sesi kadaluarsa harus otomatis di-submit, bukan memberikan sisa menit negatif');
  });
});
