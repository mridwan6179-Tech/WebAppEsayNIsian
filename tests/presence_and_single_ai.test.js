const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');
const queueService = require('../src/services/queueService');

test('Deteksi Status Kehadiran Siswa (Aktif vs DC) & Review AI Perorangan', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  // Setup ulangan & soal
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Deteksi Presence & Single AI',
    mata_pelajaran: 'Teknologi Informasi',
    tingkat_kelas: 'Kelas 9'
  });
  examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

  const soal1 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Jelaskan fungsi utama CPU pada komputer!',
    jenis: 'essay',
    bobot: 20,
    kunci_jawaban: 'CPU memproses dan mengeksekusi instruksi data'
  });

  const soal2 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Sebutkan 1 contoh perangkat input!',
    jenis: 'isian',
    bobot: 10,
    kunci_jawaban: 'Keyboard'
  });

  // Siswa 1: Aktif Mengerjakan
  const s1 = studentService.startExam(ulangan.kode_ujian, 'Ahmad Fadhil', '9A');

  // Siswa 2: Terputus (DC / Disconnect)
  const s2 = studentService.startExam(ulangan.kode_ujian, 'Dewi Lestari', '9A');

  // Siswa 3: Sudah Mengumpulkan
  const s3 = studentService.startExam(ulangan.kode_ujian, 'Rian Pratama', '9A');
  studentService.submitExam(s3.pengerjaanId, [
    { soal_id: soal1.id, jawaban_siswa: 'CPU adalah otak komputer untuk mengolah data' },
    { soal_id: soal2.id, jawaban_siswa: 'Keyboard dan mouse' }
  ]);

  await t.test('1. Heartbeat ping memperbarui last_active_at', () => {
    const pingRes = studentService.recordPing(s1.pengerjaanId, 'active');
    assert.strictEqual(pingRes.success, true);
    assert.strictEqual(pingRes.status, 'active');

    const pRow = db.prepare('SELECT last_active_at FROM pengerjaan WHERE id = ?').get(s1.pengerjaanId);
    assert.ok(pRow.last_active_at !== null, 'last_active_at harus terisi');
  });

  await t.test('2. Disconnect eksplisit (offline) menandai last_active_at ke masa lampau', () => {
    const dcRes = studentService.recordPing(s2.pengerjaanId, 'offline');
    assert.strictEqual(dcRes.success, true);
    assert.strictEqual(dcRes.status, 'offline');

    const pRow = db.prepare('SELECT last_active_at FROM pengerjaan WHERE id = ?').get(s2.pengerjaanId);
    assert.ok(pRow.last_active_at.startsWith('2000-01-01'), 'last_active_at harus di-set lampau untuk offline');
  });

  await t.test('3. reviewService mendeteksi status_kehadiran: aktif, dc, dan selesai', () => {
    const list = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    assert.strictEqual(list.length, 3);

    const ahmad = list.find(p => p.nama_siswa === 'Ahmad Fadhil');
    const dewi = list.find(p => p.nama_siswa === 'Dewi Lestari');
    const rian = list.find(p => p.nama_siswa === 'Rian Pratama');

    // Ahmad baru saja ping -> aktif
    assert.strictEqual(ahmad.status, 'mengerjakan');
    assert.strictEqual(ahmad.status_kehadiran, 'aktif');
    assert.ok(ahmad.terakhir_aktif_teks.includes('aktif'));

    // Dewi offline -> dc
    assert.strictEqual(dewi.status, 'mengerjakan');
    assert.strictEqual(dewi.status_kehadiran, 'dc');
    assert.ok(dewi.terakhir_aktif_teks.includes('Terputus'));

    // Rian sudah submit -> selesai
    assert.strictEqual(rian.status, 'submitted');
    assert.strictEqual(rian.status_kehadiran, 'selesai');
  });

  await t.test('4. Review AI Perorangan (startReviewSingle) menilai hanya siswa yang dipilih', async () => {
    // Buat siswa 4 yang juga submit
    const s4 = studentService.startExam(ulangan.kode_ujian, 'Zaskia Nur', '9A');
    studentService.submitExam(s4.pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'Pusat kontrol komputer' },
      { soal_id: soal2.id, jawaban_siswa: 'Scanner' }
    ]);

    let mockCallCount = 0;
    const mockGrader = async (item) => {
      mockCallCount++;
      return {
        skor_rekomendasi: item.bobot,
        status_jawaban: 'benar',
        alasan_ai: 'Penjelasan relevan dan tepat.',
        model_ai: 'mock-gemini-single'
      };
    };

    // Nilai HANYA Siswa 3 (Rian Pratama)
    const reviewResult = await queueService.startReviewSingle(s3.pengerjaanId, guru.id, mockGrader, 0);

    assert.strictEqual(reviewResult.success, true);
    assert.strictEqual(reviewResult.pengerjaan_id, s3.pengerjaanId);
    assert.strictEqual(reviewResult.total_dinilai, 2);
    assert.strictEqual(mockCallCount, 2, 'Hanya jawaban siswa terpilih (2 soal) yang diproses AI');
    assert.strictEqual(reviewResult.nilai_ai, 100);
    assert.strictEqual(reviewResult.nilai_final, 100);

    // Cek di DB bahwa nilai Rian terisi
    const rianDB = db.prepare('SELECT nilai_ai, nilai_final FROM pengerjaan WHERE id = ?').get(s3.pengerjaanId);
    assert.strictEqual(rianDB.nilai_ai, 100);
    assert.strictEqual(rianDB.nilai_final, 100);

    // Cek bahwa Siswa 4 (Zaskia) BELUM dinilai
    const zaskiaDB = db.prepare('SELECT nilai_ai, nilai_final FROM pengerjaan WHERE id = ?').get(s4.pengerjaanId);
    assert.strictEqual(zaskiaDB.nilai_ai, null);

    const zaskiaAnswers = db.prepare('SELECT status_penilaian FROM jawaban WHERE pengerjaan_id = ?').all(s4.pengerjaanId);
    for (const a of zaskiaAnswers) {
      assert.strictEqual(a.status_penilaian, 'menunggu');
    }
  });

  await t.test('5. Nilai AI perorangan dapat dijalankan ulang (re-grade) jika dibutuhkan', async () => {
    const mockGraderHalf = async (item) => {
      return {
        skor_rekomendasi: item.bobot / 2,
        status_jawaban: 'sebagian',
        alasan_ai: 'Jawaban kurang lengkap.',
        model_ai: 'mock-gemini-single'
      };
    };

    // Jalankan ulang penilaian pada Rian
    const reResult = await queueService.startReviewSingle(s3.pengerjaanId, guru.id, mockGraderHalf, 0);
    assert.strictEqual(reResult.success, true);
    assert.strictEqual(reResult.nilai_ai, 50);
    assert.strictEqual(reResult.nilai_final, 50);

    const rianDB = db.prepare('SELECT nilai_ai, nilai_final FROM pengerjaan WHERE id = ?').get(s3.pengerjaanId);
    assert.strictEqual(rianDB.nilai_ai, 50);
  });

  await t.test('6. Validasi hak akses & status pengerjaan saat startReviewSingle', async () => {
    // Tolak jika bukan milik guru yang bersangkutan
    await assert.rejects(
      async () => queueService.startReviewSingle(s3.pengerjaanId, 999999),
      /Akses ditolak/
    );

    // Tolak jika siswa belum mengumpulkan ujian
    await assert.rejects(
      async () => queueService.startReviewSingle(s1.pengerjaanId, guru.id),
      /belum dikumpulkan/
    );
  });

  await t.test('7. Proteksi Unique Index pada jawaban(pengerjaan_id, soal_id) mencegah duplikasi', () => {
    // Coba simpan draft berulang kali untuk soal yang sama
    const draftRes = studentService.saveDraft(s1.pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'Draft jawaban 1' },
      { soal_id: soal1.id, jawaban_siswa: 'Draft jawaban 1 versi 2' },
      { soal_id: soal2.id, jawaban_siswa: 'Draft jawaban 2' }
    ]);
    assert.strictEqual(draftRes.success, true);

    const countRows = db.prepare('SELECT COUNT(*) as c FROM jawaban WHERE pengerjaan_id = ?').get(s1.pengerjaanId).c;
    assert.strictEqual(countRows, 2, 'Jumlah baris jawaban tidak boleh lebih dari jumlah soal yang dikerjakan');

    // Cek isi jawaban terupdate ke versi terakhir
    const j1 = db.prepare('SELECT jawaban_siswa FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(s1.pengerjaanId, soal1.id);
    assert.strictEqual(j1.jawaban_siswa, 'Draft jawaban 1 versi 2');
  });

  await t.test('8. Kuota total_jawaban akurat sesuai soal_ids (tidak melebihi batas jumlah_soal)', () => {
    const list = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    const ahmad = list.find(p => p.pengerjaan_id === s1.pengerjaanId);
    assert.ok(ahmad);
    assert.strictEqual(ahmad.total_jawaban, 2, 'total_jawaban harus tepat 2');
  });

  await t.test('9. Format waktu submit menyertakan zona waktu & nilai AI tampil di depan tanpa langsung rilis', async () => {
    // Set zona_waktu ke WITA
    examService.updateUlangan(ulangan.id, guru.id, { zona_waktu: 'WITA' });

    const list = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    const rian = list.find(p => p.pengerjaan_id === s3.pengerjaanId);
    assert.ok(rian);
    assert.strictEqual(rian.zona_waktu, 'WITA');
    assert.ok(rian.submitted_at_formatted.includes('WITA'), 'submitted_at_formatted harus menyertakan label WITA');
    assert.strictEqual(rian.nilai_ai, 50, 'Nilai AI harus terhitung dan muncul');
    assert.strictEqual(rian.nilai_final, 50, 'Nilai Final harus terhitung dan muncul');
    assert.strictEqual(rian.released_at, null, 'Nilai AI belum dirilis (released_at harus tetap NULL agar aman ditinjau guru)');
  });

  await t.test('10. submitExam mencatat submitted_at berformat ISO UTC standar (ISO 8601 dengan Z)', () => {
    const sTest = studentService.startExam(ulangan.kode_ujian, 'Tes Format Waktu', '9A');
    const submitRes = studentService.submitExam(sTest.pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'Jawaban waktu' }
    ]);
    assert.strictEqual(submitRes.success, true);
    assert.ok(submitRes.submitted_at.endsWith('Z'), 'submitted_at harus berakhiran Z (UTC ISO 8601)');
    assert.ok(submitRes.submitted_at.includes('T'), 'submitted_at harus memuat separator T');
  });

  await t.test('11. Deteksi Jawaban Lengkap Siswa Terputus (DC) & Force Submit oleh Guru', () => {
    // Buat pengerjaan baru yang belum disubmit (status = 'mengerjakan')
    const sDc = studentService.startExam(ulangan.kode_ujian, 'Siswa DC Lengkap', '9A');
    studentService.saveDraft(sDc.pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'Jawaban soal 1 lengkap' },
      { soal_id: soal2.id, jawaban_siswa: 'Jawaban soal 2 lengkap' }
    ]);

    // Simulasikan DC (heartbeat 20 menit lalu)
    db.prepare("UPDATE pengerjaan SET last_active_at = datetime('now', '-20 minutes') WHERE id = ?").run(sDc.pengerjaanId);

    const list = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    const dcStudent = list.find(p => p.pengerjaan_id === sDc.pengerjaanId);
    assert.ok(dcStudent);
    assert.strictEqual(dcStudent.status_kehadiran, 'dc');
    assert.strictEqual(dcStudent.total_jawaban, 2);
    assert.strictEqual(dcStudent.total_terisi, 2);
    assert.strictEqual(dcStudent.draft_lengkap, true, 'draft_lengkap harus true karena 2 dari 2 soal terisi');

    // Guru melakukan force submit
    const forceRes = studentService.forceSubmitByGuru(sDc.pengerjaanId, guru.id);
    assert.strictEqual(forceRes.success, true);
    assert.strictEqual(forceRes.alreadySubmitted, undefined);

    const updatedP = db.prepare('SELECT status, submitted_at, auto_submitted FROM pengerjaan WHERE id = ?').get(sDc.pengerjaanId);
    assert.strictEqual(updatedP.status, 'submitted');
    assert.strictEqual(updatedP.auto_submitted, 1);
    assert.ok(updatedP.submitted_at);
  });

  await t.test('12. Pelacakan Butir Soal Copy-Paste (Nomor Soal & Rincian per Jawaban)', () => {
    const sPaste = studentService.startExam(ulangan.kode_ujian, 'Siswa Tukang Paste', '9B');
    // Siswa paste pada soal2 sebanyak 3 kali
    const pasteMap = { [soal2.id]: 3 };
    studentService.submitExam(sPaste.pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'Murni ketik sendiri' },
      { soal_id: soal2.id, jawaban_siswa: 'Hasil paste dari internet', paste_count: 3 }
    ], 3, false, pasteMap);

    const list = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    const pStudent = list.find(p => p.pengerjaan_id === sPaste.pengerjaanId);
    assert.ok(pStudent);
    assert.strictEqual(pStudent.paste_count, 3);
    assert.ok(pStudent.paste_soal_nomor.length > 0, 'Harus mencatat nomor soal yang dipaste');
    assert.ok(pStudent.paste_summary.includes('Soal #'), 'paste_summary harus memuat nomor soal');

    // Cek di getPengerjaanDetail
    const detail = reviewService.getPengerjaanDetail(sPaste.pengerjaanId, guru.id);
    const j2 = detail.jawabanList.find(j => j.soal_id === soal2.id);
    assert.ok(j2);
    assert.strictEqual(j2.paste_count, 3, 'j2.paste_count harus 3');
  });

  await t.test('13. Review AI Perorangan Otomatis Memfinalisasi Pengerjaan Draft yang Terisi', async () => {
    const sDraft = studentService.startExam(ulangan.kode_ujian, 'Siswa Draft Auto AI', '9C');
    studentService.saveDraft(sDraft.pengerjaanId, [
      { soal_id: soal1.id, jawaban_siswa: 'Jawaban draft untuk dinilai' },
      { soal_id: soal2.id, jawaban_siswa: 'Jawaban draft 2 untuk dinilai' }
    ]);

    const res = await queueService.startReviewSingle(sDraft.pengerjaanId, guru.id, async (queueItem) => {
      return {
        skor_rekomendasi: 10,
        status_jawaban: 'benar',
        alasan_ai: 'Penjelasan AI untuk draft'
      };
    }, 0);

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.nilai_ai, 66.67);

    const pFinal = db.prepare('SELECT status FROM pengerjaan WHERE id = ?').get(sDraft.pengerjaanId);
    assert.strictEqual(pFinal.status, 'submitted', 'Status pengerjaan harus otomatis beralih ke submitted');
  });

  await t.test('14. Prioritas Urutan Siswa di Dashboard Guru: Aktif -> DC -> Belum Review -> Belum Rilis -> Sudah Rilis', async () => {
    // Buat ulangan khusus untuk verifikasi urutan
    const uOrder = examService.createUlangan(guru.id, {
      judul: 'Ulangan Urutan Prioritas',
      mata_pelajaran: 'Informatika',
      durasi_menit: 60
    });
    examService.updateUlangan(uOrder.id, guru.id, { status: 'dibuka' });
    const sSoal = examService.createSoal(uOrder.id, {
      pertanyaan: 'Soal urutan 1',
      jenis: 'essay',
      kunci_jawaban: 'Jawaban benar',
      bobot: 10
    });

    // 1. Siswa Sudah Rilis (Urutan Rank 5 - terbawah)
    const sRilis = studentService.startExam(uOrder.kode_ujian, 'Zulfa Sudah Rilis', '9A');
    studentService.submitExam(sRilis.pengerjaanId, [{ soal_id: sSoal.id, jawaban_siswa: 'Kumpul' }]);
    db.prepare("UPDATE pengerjaan SET nilai_ai = 100, nilai_final = 100, released_at = datetime('now') WHERE id = ?").run(sRilis.pengerjaanId);
    db.prepare("UPDATE jawaban SET status_penilaian = 'selesai' WHERE pengerjaan_id = ?").run(sRilis.pengerjaanId);

    // 2. Siswa Belum Rilis tapi Sudah Review (Urutan Rank 4)
    const sBelumRilis = studentService.startExam(uOrder.kode_ujian, 'Yanto Sudah Dinilai Belum Rilis', '9A');
    studentService.submitExam(sBelumRilis.pengerjaanId, [{ soal_id: sSoal.id, jawaban_siswa: 'Kumpul' }]);
    db.prepare("UPDATE pengerjaan SET nilai_ai = 80, nilai_final = 80, released_at = NULL WHERE id = ?").run(sBelumRilis.pengerjaanId);
    db.prepare("UPDATE jawaban SET status_penilaian = 'selesai' WHERE pengerjaan_id = ?").run(sBelumRilis.pengerjaanId);

    // 3. Siswa Belum di-Review / Belum Dinilai (Urutan Rank 3)
    const sBelumReview = studentService.startExam(uOrder.kode_ujian, 'Xavier Belum Dinilai', '9A');
    studentService.submitExam(sBelumReview.pengerjaanId, [{ soal_id: sSoal.id, jawaban_siswa: 'Kumpul' }]);
    db.prepare("UPDATE pengerjaan SET nilai_ai = NULL, nilai_final = NULL, released_at = NULL WHERE id = ?").run(sBelumReview.pengerjaanId);

    // 4. Siswa DC / Terputus (Urutan Rank 2)
    const sDc = studentService.startExam(uOrder.kode_ujian, 'Wawan Terputus DC', '9A');
    db.prepare("UPDATE pengerjaan SET last_active_at = datetime('now', '-10 minutes') WHERE id = ?").run(sDc.pengerjaanId);

    // 5. Siswa Aktif Mengerjakan (Urutan Rank 1 - teratas)
    const sAktif = studentService.startExam(uOrder.kode_ujian, 'Anton Aktif Mengerjakan', '9A');
    studentService.recordPing(sAktif.pengerjaanId, 'active');

    // Ambil daftar peserta dari reviewService
    const list = reviewService.getPengerjaanListByUlangan(uOrder.id, guru.id);
    assert.strictEqual(list.length, 5, 'Harus ada 5 peserta terdaftar');

    // Cek urutan pengerjaan ID sesuai prioritas
    assert.strictEqual(list[0].pengerjaan_id, sAktif.pengerjaanId, 'Rank 1: Siswa Aktif harus berada di urutan teratas (indeks 0)');
    assert.strictEqual(list[0].status_kehadiran, 'aktif');

    assert.strictEqual(list[1].pengerjaan_id, sDc.pengerjaanId, 'Rank 2: Siswa DC harus berada di urutan kedua (indeks 1)');
    assert.strictEqual(list[1].status_kehadiran, 'dc');

    assert.strictEqual(list[2].pengerjaan_id, sBelumReview.pengerjaanId, 'Rank 3: Siswa Belum Dinilai/Review harus di urutan ketiga (indeks 2)');
    assert.strictEqual(list[2].status, 'submitted');
    assert.strictEqual(list[2].released_at, null);

    assert.strictEqual(list[3].pengerjaan_id, sBelumRilis.pengerjaanId, 'Rank 4: Siswa Dinilai Belum Dirilis harus di urutan keempat (indeks 3)');
    assert.strictEqual(list[3].status, 'submitted');
    assert.strictEqual(list[3].released_at, null);

    assert.strictEqual(list[4].pengerjaan_id, sRilis.pengerjaanId, 'Rank 5: Siswa Sudah Dirilis harus berada di urutan terbawah (indeks 4)');
    assert.ok(list[4].released_at !== null, 'Siswa kelima sudah dirilis');
  });
});



