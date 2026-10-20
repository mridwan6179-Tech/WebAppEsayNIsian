const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const studentService = require('../src/services/studentService');
const queueService = require('../src/services/queueService');
const examService = require('../src/services/examService');
const authService = require('../src/services/authService');

test('=== SUITE: SISTEM ANTI-TERTUKAR AKUN LAB, AI WATCHDOG, & PROTEKSI DRAFT REFRESH ===', async (t) => {
  // Setup Guru & Ulangan
  const timestamp = Date.now();
  const guruEmail = `guru_lab_${timestamp}@test.com`;
  const guruInfo = db.prepare('INSERT INTO guru (nama, email, password, no_wa) VALUES (?, ?, ?, ?)').run(
    'Guru Lab Test',
    guruEmail,
    'password123',
    '08123456789'
  );
  const guruId = guruInfo.lastInsertRowid;

  const newUl = examService.createUlangan(guruId, {
    judul: 'Ujian Lab Komputer Bersama',
    mata_pelajaran: 'Informatika',
    tingkat_kelas: '8',
    durasi_menit: 60,
    kkm: 75,
    skor_langsung_ai: 1,
    remedial_langsung: 1
  });

  db.prepare("UPDATE ulangan SET status = 'dibuka' WHERE id = ?").run(newUl.id);
  const ulangan = examService.getUlanganById(newUl.id, guruId);
  const soal1 = examService.createSoal(ulangan.id, {
    nomor: 1,
    jenis: 'pilihan_ganda',
    pertanyaan: 'Berapakah 2 + 2?',
    bobot: 50,
    kunci_jawaban: 'A',
    kunci_pg: 'A',
    opsi_a: '4',
    opsi_b: '3',
    opsi_c: '5',
    opsi_d: '6'
  });

  const soal2 = examService.createSoal(ulangan.id, {
    nomor: 2,
    jenis: 'essay',
    pertanyaan: 'Jelaskan apa fungsi RAM pada komputer!',
    bobot: 50,
    kunci_jawaban: 'Penyimpanan memori sementara yang cepat untuk program yang sedang berjalan',
    rubrik: 'Menyebutkan memori sementara bernilai 50'
  });

  let sessionA;

  await t.test('1. Isolasi Akun Komputer Bersama: Verifikasi identitas saat memulai remedial mandiri', () => {
    // Siswa A mengerjakan ulangan dan nilainya di bawah KKM
    sessionA = studentService.startExam(ulangan.kode_ujian, 'Siswa A', '8A');
    studentService.submitExam(sessionA.pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'B' }, // Salah
      { soal_id: soal2.id, jawaban_siswa: 'Tempat simpan foto' } // Kurang tepat
    ]);

    // Rilis nilai agar remedial mandiri terbuka
    db.prepare('UPDATE pengerjaan SET released_at = CURRENT_TIMESTAMP, nilai_final = 20 WHERE id = ?').run(sessionA.pengerjaanId);

    // Siswa B (di komputer yang sama) mencoba memulai remedial menggunakan pengerjaan Siswa A dengan nama yang berbeda
    assert.throws(() => {
      studentService.startDirectRemedial(sessionA.pengerjaanId, { nama: 'Siswa B', kelas: '8B' });
    }, /Akses ditolak.*Pengerjaan ini milik "Siswa A"/i, 'Siswa B harus ditolak saat mencoba remedial atas nama Siswa A');

    // Siswa A asli yang memverifikasi identitasnya sendiri berhasil masuk remedial
    const remResult = studentService.startDirectRemedial(sessionA.pengerjaanId, { nama: 'Siswa A', kelas: '8A' });
    assert.strictEqual(remResult.success, true);
    assert.strictEqual(remResult.isRemedial, true);
  });

  await t.test('2. Proteksi Jawaban Remedial Saat Refresh: Jawaban siswa tidak hilang dari database sesi', () => {
    // Ambil pengerjaan Siswa A yang sedang dalam sesi remedial
    const pA = db.prepare("SELECT * FROM pengerjaan WHERE id = ?").get(sessionA.pengerjaanId);
    assert.ok(pA, 'Sesi remedial Siswa A harus aktif');

    // Siswa A mengisi jawaban butir remedial
    studentService.saveDraft(pA.id, [
      { soal_id: soal1.id, jawaban_siswa: 'A' }
    ]);

    // Simulasikan siswa me-refresh halaman: panggil getActiveSession
    const resumedSession = studentService.getActiveSession(pA.id);
    assert.ok(resumedSession, 'Sesi remedial harus berhasil di-resume');
    assert.strictEqual(resumedSession.isRemedial, true);

    // Pastikan butir yang dijawab tidak kembali kosong
    const soalItem = resumedSession.soal.find(s => s.id === soal1.id);
    assert.ok(soalItem);
    assert.strictEqual(soalItem.jawaban_siswa, 'A', 'Jawaban remedial yang disimpan di draft harus tetap ada saat refresh');
  });

  await t.test('3. Watchdog Auto-Recovery Antrean AI: Lock macet > 25 detik langsung diselesaikan via offline fallback', () => {
    // Siswa C mengerjakan dan submit
    const sessionC = studentService.startExam(ulangan.kode_ujian, 'Siswa C', '8A');
    studentService.submitExam(sessionC.pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'A' },
      { soal_id: soal2.id, jawaban_siswa: 'RAM adalah Random Access Memory untuk simpan data sementara' }
    ]);

    queueService.enqueueUlangan(ulangan.id);

    // Simulasikan satu butir jawaban terkunci status 'diproses' dan macet 30 detik lalu (stuck API)
    const antreanItem = db.prepare(`
      SELECT a.id, a.jawaban_id
      FROM antrean_review a
      JOIN jawaban j ON a.jawaban_id = j.id
      WHERE j.pengerjaan_id = ? AND a.status = 'menunggu'
      LIMIT 1
    `).get(sessionC.pengerjaanId);

    assert.ok(antreanItem, 'Harus ada antrean_review untuk Siswa C');

    db.prepare(`
      UPDATE antrean_review
      SET status = 'diproses', locked_at = datetime('now', '-30 seconds')
      WHERE id = ?
    `).run(antreanItem.id);

    db.prepare(`
      UPDATE jawaban
      SET status_penilaian = 'diproses'
      WHERE id = ?
    `).run(antreanItem.jawaban_id);

    // Jalankan watchdog recoverStaleLocks
    queueService.recoverStaleLocks(ulangan.id);

    // Cek bahwa butir yang stuck otomatis selesai dan dinilai
    const healed = db.prepare('SELECT status, error_message FROM antrean_review WHERE id = ?').get(antreanItem.id);
    assert.strictEqual(healed.status, 'selesai', 'Butir yang macet > 25 detik harus diselesaikan oleh watchdog');
    assert.ok(healed.error_message.includes('stale lock'));

    const healedJwb = db.prepare('SELECT status_penilaian, skor_rekomendasi, model_ai FROM jawaban WHERE id = ?').get(antreanItem.jawaban_id);
    assert.strictEqual(healedJwb.status_penilaian, 'selesai');
    assert.strictEqual(healedJwb.model_ai, 'fallback_offline');
    assert.ok(healedJwb.skor_rekomendasi > 0);
  });

  await t.test('4. Pergerakan Urutan Antrean Real-Time (FIFO): Siswa di belakang otomatis maju nomor antreannya', () => {
    // Siswa D dan Siswa E submit secara berurutan
    const sessionD = studentService.startExam(ulangan.kode_ujian, 'Siswa D', '8A');
    studentService.submitExam(sessionD.pengerjaanId, [
      { soal_id: soal2.id, jawaban_siswa: 'Memori kerja komputasi' }
    ]);

    const sessionE = studentService.startExam(ulangan.kode_ujian, 'Siswa E', '8A');
    studentService.submitExam(sessionE.pengerjaanId, [
      { soal_id: soal2.id, jawaban_siswa: 'Tempat penyimpanan data dinamis' }
    ]);

    // Siswa D antre di depan Siswa E
    let statusD = studentService.getPengerjaanStatus(sessionD.pengerjaanId);
    let statusE = studentService.getPengerjaanStatus(sessionE.pengerjaanId);

    assert.ok(statusD.antreanInfo, 'Siswa D harus mendapat info antrean');
    assert.ok(statusE.antreanInfo, 'Siswa E harus mendapat info antrean');

    assert.strictEqual(statusD.antreanInfo.posisiAntrean, 1, 'Siswa D harus di urutan 1');
    assert.strictEqual(statusE.antreanInfo.posisiAntrean, 2, 'Siswa E harus di urutan 2');

    // Selesaikan butir Siswa D
    db.prepare(`UPDATE jawaban SET status_penilaian = 'selesai', skor_rekomendasi = 45 WHERE pengerjaan_id = ?`).run(sessionD.pengerjaanId);
    db.prepare(`UPDATE antrean_review SET status = 'selesai' WHERE jawaban_id IN (SELECT id FROM jawaban WHERE pengerjaan_id = ?)`).run(sessionD.pengerjaanId);

    // Cek kembali status Siswa E: Sekarang harus naik ke posisi urutan 1 (bergerak live)
    statusE = studentService.getPengerjaanStatus(sessionE.pengerjaanId);
    assert.strictEqual(statusE.antreanInfo.posisiAntrean, 1, 'Setelah Siswa D selesai, Siswa E otomatis maju ke urutan 1');
    assert.strictEqual(statusE.antreanInfo.isGiliranSaya, true);
  });

  await t.test('5. Sesi Ujian Aktif dalam Durasi Tidak Pernah Dihapus oleh cleanAbandonedSessions', () => {
    const sessionF = studentService.startExam(ulangan.kode_ujian, 'Siswa F', '8A');
    // Siswa F baru mulai 5 menit lalu tanpa jawaban (total_terisi = 0)
    db.prepare(`UPDATE pengerjaan SET started_at = datetime('now', '-300 seconds'), last_active_at = datetime('now', '-300 seconds') WHERE id = ?`).run(sessionF.pengerjaanId);

    // Jalankan cleanAbandonedSessions
    const cleanRes = studentService.cleanAbandonedSessions(ulangan.id);
    assert.strictEqual(cleanRes.success, true);

    // Pengerjaan Siswa F TIDAK BOLEH terhapus karena masih dalam batas durasi 60 menit
    const checkF = db.prepare('SELECT id, status FROM pengerjaan WHERE id = ?').get(sessionF.pengerjaanId);
    assert.ok(checkF, 'Pengerjaan siswa yang masih dalam durasi ujian tidak boleh dihapus');
    assert.strictEqual(checkF.status, 'mengerjakan');
  });
});
