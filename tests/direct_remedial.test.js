const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const app = require('../server');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');

test('=== SUITE: REMEDIAL LANGSUNG MANDIRI SISWA ===', async (t) => {
  let server;
  let baseUrl;

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  t.after(() => {
    server.close();
  });

  // Setup Guru & Ulangan
  const timestamp = Date.now();
  const guruEmail = `guru_remedial_${timestamp}@test.com`;
  const guruInfo = db.prepare('INSERT INTO guru (nama, email, password, no_wa) VALUES (?, ?, ?, ?)').run(
    'Guru Remedial Test',
    guruEmail,
    'password123',
    '08123456789'
  );
  const guruId = guruInfo.lastInsertRowid;

  await t.test('1. Pengaturan remedial_langsung pada createUlangan dan updateUlangan', () => {
    // Buat ulangan dengan remedial_langsung = 1
    const exam1 = examService.createUlangan(guruId, {
      judul: 'Ulangan Remedial Langsung Test',
      mata_pelajaran: 'Matematika',
      tingkat_kelas: '7',
      kkm: 75,
      remedial_langsung: 1
    });

    assert.ok(exam1.id, 'Exam berhasil dibuat');
    const row1 = db.prepare('SELECT remedial_langsung FROM ulangan WHERE id = ?').get(exam1.id);
    assert.strictEqual(row1.remedial_langsung, 1, 'remedial_langsung harus bernilai 1');

    // Update ulangan mematikan remedial_langsung
    examService.updateUlangan(exam1.id, guruId, {
      remedial_langsung: 0
    });
    const row2 = db.prepare('SELECT remedial_langsung FROM ulangan WHERE id = ?').get(exam1.id);
    assert.strictEqual(row2.remedial_langsung, 0, 'remedial_langsung harus bernilai 0 setelah di-update');

    // Aktifkan kembali
    examService.updateUlangan(exam1.id, guruId, {
      remedial_langsung: 1
    });
    const row3 = db.prepare('SELECT remedial_langsung FROM ulangan WHERE id = ?').get(exam1.id);
    assert.strictEqual(row3.remedial_langsung, 1, 'remedial_langsung harus aktif kembali');
  });

  await t.test('2. Skenario Ujian, Kerahasiaan Kunci & Status Salah/Benar saat Nilai < KKM', async () => {
    // Buat ulangan dengan 3 soal (2 PG, 1 Isian), KKM = 75, remedial_langsung = 1
    const exam = examService.createUlangan(guruId, {
      judul: 'Ulangan Remedial Anti-Bocor',
      mata_pelajaran: 'IPA',
      tingkat_kelas: '8',
      kkm: 75,
      remedial_langsung: 1,
      skor_langsung_ai: 1
    });

    const s1 = examService.createSoal(exam.id, {
      nomor: 1,
      jenis: 'pilihan_ganda',
      pertanyaan: 'Ibukota Indonesia saat ini?',
      opsi_a: 'Jakarta',
      opsi_b: 'Surabaya',
      opsi_c: 'Bandung',
      opsi_d: 'Medan',
      kunci_pg: 'A',
      bobot: 10
    });

    const s2 = examService.createSoal(exam.id, {
      nomor: 2,
      jenis: 'pilihan_ganda',
      pertanyaan: 'Planet terdekat dengan Matahari?',
      opsi_a: 'Venus',
      opsi_b: 'Merkurius',
      opsi_c: 'Bumi',
      opsi_d: 'Mars',
      kunci_pg: 'B',
      bobot: 10
    });

    const s3 = examService.createSoal(exam.id, {
      nomor: 3,
      jenis: 'isian',
      pertanyaan: 'Lambang unsur kimia untuk Oksigen adalah?',
      kunci_jawaban: 'O',
      rubrik: 'Simbol kimia satu huruf kapital O',
      bobot: 10
    });

    // Buka ulangan
    db.prepare("UPDATE ulangan SET status = 'dibuka' WHERE id = ?").run(exam.id);

    // Siswa mulai ulangan
    const startRes = studentService.startExam(exam.kode_ujian, 'Siswa Remedial A', '8A');
    assert.ok(startRes.pengerjaanId, 'Pengerjaan dimulai');
    const pengerjaanId = startRes.pengerjaanId;

    // Siswa kumpulkan jawaban:
    // Soal 1: A (BENAR)
    // Soal 2: D (SALAH)
    // Soal 3: 'H' (SALAH)
    const submitRes = studentService.submitExam(pengerjaanId, [
      { soal_id: s1.id, jawaban_siswa: 'A' },
      { soal_id: s2.id, jawaban_siswa: 'D' },
      { soal_id: s3.id, jawaban_siswa: 'H' }
    ]);
    assert.strictEqual(submitRes.success, true);

    // Tandai rilis nilai dan periksa skor
    // Set s3 nilai 0
    const j3 = db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(pengerjaanId, s3.id);
    db.prepare("UPDATE jawaban SET skor_rekomendasi = 0, status_jawaban = 'salah', status_penilaian = 'selesai' WHERE id = ?").run(j3.id);

    const reviewService = require('../src/services/reviewService');
    reviewService.recalculatePengerjaanTotal(pengerjaanId);
    db.prepare('UPDATE pengerjaan SET released_at = CURRENT_TIMESTAMP WHERE id = ?').run(pengerjaanId);

    // Cek status pengerjaan siswa
    const status = studentService.getPengerjaanStatus(pengerjaanId);
    assert.ok(status.nilaiFinal < 75, `Nilai harus < KKM (skor saat ini: ${status.nilaiFinal})`);
    assert.strictEqual(status.isRemedial, true, 'isRemedial harus bernilai true');
    assert.strictEqual(status.canDirectRemedial, true, 'canDirectRemedial harus bernilai true');

    // VALIDASI ANTI-BOCOR: jawabanList harus dikosongkan agar siswa tidak tahu mana salah/benar atau kunci jawaban!
    assert.strictEqual(status.jawaban.length, 0, 'Kerahasiaan terjaga: jawabanList harus kosong saat remedial langsung aktif');
  });

  await t.test('3. Proteksi KKM ketat & opsi nonaktif', () => {
    // 3a. Ulangan dengan remedial_langsung = 0 ditolak
    const examOff = examService.createUlangan(guruId, {
      judul: 'Ulangan Remedial OFF',
      mata_pelajaran: 'IPA',
      tingkat_kelas: '8',
      kkm: 75,
      remedial_langsung: 0
    });
    const sOff = examService.createSoal(examOff.id, {
      nomor: 1,
      jenis: 'pilihan_ganda',
      pertanyaan: 'Soal 1',
      kunci_pg: 'A',
      bobot: 10
    });
    db.prepare("UPDATE ulangan SET status = 'dibuka' WHERE id = ?").run(examOff.id);

    const startOff = studentService.startExam(examOff.kode_ujian, 'Siswa Off', '8A');
    studentService.submitExam(startOff.pengerjaanId, [{ soal_id: sOff.id, jawaban_siswa: 'B' }]);
    db.prepare('UPDATE pengerjaan SET released_at = CURRENT_TIMESTAMP, nilai_final = 0 WHERE id = ?').run(startOff.pengerjaanId);

    assert.throws(() => {
      studentService.startDirectRemedial(startOff.pengerjaanId);
    }, /Fitur remedial langsung tidak diaktifkan/);

    // 3b. Siswa yang nilainya >= KKM ditolak mengikuti remedial
    const examOn = examService.createUlangan(guruId, {
      judul: 'Ulangan Remedial ON',
      mata_pelajaran: 'IPA',
      tingkat_kelas: '8',
      kkm: 75,
      remedial_langsung: 1
    });
    const sOn = examService.createSoal(examOn.id, {
      nomor: 1,
      jenis: 'pilihan_ganda',
      pertanyaan: 'Soal 1',
      kunci_pg: 'A',
      bobot: 10
    });
    db.prepare("UPDATE ulangan SET status = 'dibuka' WHERE id = ?").run(examOn.id);

    const startOn = studentService.startExam(examOn.kode_ujian, 'Siswa Lulus', '8A');
    studentService.submitExam(startOn.pengerjaanId, [{ soal_id: sOn.id, jawaban_siswa: 'A' }]);
    db.prepare('UPDATE pengerjaan SET released_at = CURRENT_TIMESTAMP, nilai_final = 100 WHERE id = ?').run(startOn.pengerjaanId);

    assert.throws(() => {
      studentService.startDirectRemedial(startOn.pengerjaanId);
    }, /sudah mencapai atau melampaui KKM/);
  });

  await t.test('4. Alur Remedial Langsung: Hanya Soal yang Salah Disajikan & Nilai Baru Otomatis Dihitung', async () => {
    // Buat ulangan: 3 soal (2 PG, 1 Isian)
    const exam = examService.createUlangan(guruId, {
      judul: 'Ulangan Alur Remedial Lengkap',
      mata_pelajaran: 'Bahasa Indonesia',
      tingkat_kelas: '7',
      kkm: 75,
      remedial_langsung: 1
    });

    const s1 = examService.createSoal(exam.id, {
      nomor: 1,
      jenis: 'pilihan_ganda',
      pertanyaan: 'Antonim kata besar?',
      opsi_a: 'Kecil',
      opsi_b: 'Tinggi',
      opsi_c: 'Lebar',
      opsi_d: 'Luas',
      kunci_pg: 'A',
      bobot: 10
    });

    const s2 = examService.createSoal(exam.id, {
      nomor: 2,
      jenis: 'pilihan_ganda',
      pertanyaan: 'Sinonim kata pandai?',
      opsi_a: 'Malas',
      opsi_b: 'Pintar',
      opsi_c: 'Bodoh',
      opsi_d: 'Lambat',
      kunci_pg: 'B',
      bobot: 10
    });

    const s3 = examService.createSoal(exam.id, {
      nomor: 3,
      jenis: 'isian',
      pertanyaan: 'Kata dasar dari membaca adalah?',
      kunci_jawaban: 'baca',
      rubrik: 'Kata dasar baca',
      bobot: 10
    });

    // Buka ulangan
    db.prepare("UPDATE ulangan SET status = 'dibuka' WHERE id = ?").run(exam.id);

    // Mulai pengerjaan pertama
    const start1 = studentService.startExam(exam.kode_ujian, 'Budi Santoso', '7B');
    const pid = start1.pengerjaanId;

    // Percobaan 1:
    // Soal 1: A (BENAR)
    // Soal 2: C (SALAH)
    // Soal 3: 'tulis' (SALAH)
    studentService.submitExam(pid, [
      { soal_id: s1.id, jawaban_siswa: 'A' },
      { soal_id: s2.id, jawaban_siswa: 'C' },
      { soal_id: s3.id, jawaban_siswa: 'tulis' }
    ]);

    // Beri nilai 0 untuk isian salah & rilis
    const j3 = db.prepare('SELECT id FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(pid, s3.id);
    db.prepare("UPDATE jawaban SET skor_rekomendasi = 0, status_jawaban = 'salah', status_penilaian = 'selesai' WHERE id = ?").run(j3.id);
    const reviewService = require('../src/services/reviewService');
    reviewService.recalculatePengerjaanTotal(pid);
    db.prepare('UPDATE pengerjaan SET released_at = CURRENT_TIMESTAMP WHERE id = ?').run(pid);

    // Cek skor awal siswa: hanya soal 1 yang benar (skor 33.3)
    const stInitial = studentService.getPengerjaanStatus(pid);
    assert.strictEqual(stInitial.isRemedial, true);
    assert.strictEqual(stInitial.canDirectRemedial, true);

    // Siswa memulai remedial langsung
    const remedialRes = studentService.startDirectRemedial(pid);
    assert.strictEqual(remedialRes.success, true);
    assert.strictEqual(remedialRes.isRemedial, true);
    assert.strictEqual(remedialRes.remedial_ke, 1);

    // HANYA SOAL YANG SALAH YANG DISAJIKAN: Soal 2 dan Soal 3
    const presentedIds = remedialRes.soal.map(s => s.id);
    assert.strictEqual(presentedIds.length, 2, 'Harus hanya menyajikan 2 butir yang salah');
    assert.ok(!presentedIds.includes(s1.id), 'Soal 1 yang sudah benar TIDAK boleh muncul di lembar remedial');
    assert.ok(presentedIds.includes(s2.id), 'Soal 2 yang salah harus muncul di lembar remedial');
    assert.ok(presentedIds.includes(s3.id), 'Soal 3 yang salah harus muncul di lembar remedial');

    // Kerahasiaan kunci: jangan sertakan kunci_pg atau kunci_jawaban
    for (const item of remedialRes.soal) {
      assert.strictEqual(item.kunci_pg, undefined, 'kunci_pg tidak boleh bocor');
      assert.strictEqual(item.kunci_jawaban, undefined, 'kunci_jawaban tidak boleh bocor');
    }

    // Siswa mengerjakan ulang butir-butir yang salah:
    // Soal 2: B (BENAR)
    // Soal 3: 'baca' (BENAR)
    const remedialSubmit = studentService.submitExam(pid, [
      { soal_id: s2.id, jawaban_siswa: 'B' },
      { soal_id: s3.id, jawaban_siswa: 'baca' }
    ]);

    assert.strictEqual(remedialSubmit.success, true);

    // Periksa status pengerjaan pasca remedial:
    // Soal 1 (lama, benar) + Soal 2 (baru, benar) + Soal 3 (baru, benar) = 100
    const stFinal = studentService.getPengerjaanStatus(pid);
    assert.strictEqual(stFinal.nilaiFinal, 100, 'Nilai baru harus otomatis menjadi 100 setelah remedial berhasil');
    assert.strictEqual(stFinal.isRemedial, false, 'Setelah mencapai 100 (>= KKM), status tidak lagi remedial');
    assert.strictEqual(stFinal.canDirectRemedial, false, 'canDirectRemedial harus bernilai false karena sudah tuntas');
    assert.strictEqual(stFinal.jawaban.length, 3, 'Seluruh 3 butir soal kembali tampil lengkap setelah tuntas');
  });

  await t.test('5. Endpoint API POST /api/siswa/remedial/mulai', async () => {
    // Buat ulangan cepat
    const exam = examService.createUlangan(guruId, {
      judul: 'Ulangan API Remedial',
      mata_pelajaran: 'Fisika',
      tingkat_kelas: '9',
      kkm: 80,
      remedial_langsung: 1
    });

    const s1 = examService.createSoal(exam.id, {
      nomor: 1,
      jenis: 'pilihan_ganda',
      pertanyaan: 'Satuan daya dalam SI?',
      opsi_a: 'Watt',
      opsi_b: 'Joule',
      kunci_pg: 'A',
      bobot: 10
    });

    db.prepare("UPDATE ulangan SET status = 'dibuka' WHERE id = ?").run(exam.id);

    const start = studentService.startExam(exam.kode_ujian, 'Doni', '9A');
    studentService.submitExam(start.pengerjaanId, [{ soal_id: s1.id, jawaban_siswa: 'B' }]);
    db.prepare('UPDATE pengerjaan SET released_at = CURRENT_TIMESTAMP, nilai_final = 0 WHERE id = ?').run(start.pengerjaanId);

    // Panggil endpoint HTTP
    const res = await fetch(`${baseUrl}/api/siswa/remedial/mulai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pengerjaan_id: start.pengerjaanId })
    });

    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.isRemedial, true);
    assert.strictEqual(body.soal.length, 1);
    assert.strictEqual(body.soal[0].id, s1.id);
  });
});
