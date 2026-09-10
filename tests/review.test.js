const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');

test('T-06: Review dan Perubahan Nilai Guru (FR-20 - FR-23)', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();

  // Buat guru kedua untuk tes proteksi akses
  let guruLain = db.prepare('SELECT id FROM guru WHERE email = ?').get('gurulain@sekolah.id');
  if (!guruLain) {
    const info = db.prepare('INSERT INTO guru (email, nama) VALUES (?, ?)').run('gurulain@sekolah.id', 'Guru Lain');
    guruLain = { id: info.lastInsertRowid };
  }

  // Setup ulangan
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Review Test',
    mata_pelajaran: 'Bahasa Indonesia',
    tingkat_kelas: 'Kelas 9'
  });
  examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

  const soal1 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Jelaskan apa yang dimaksud dengan majas personifikasi!',
    jenis: 'essay',
    bobot: 20,
    kunci_jawaban: 'Gaya bahasa yang melekatkan sifat insani/manusiawi pada benda mati.'
  });

  const soal2 = examService.createSoal(ulangan.id, {
    pertanyaan: 'Berikan satu contoh majas personifikasi!',
    jenis: 'isian',
    bobot: 10,
    kunci_jawaban: 'Nyiur melambai di tepi pantai.'
  });

  // Pengerjaan Siswa
  const st = studentService.startExam(ulangan.kode_ujian, 'Rina Marlina', '9B');
  studentService.submitExam(st.pengerjaanId, [
    { soal_id: soal1.id, jawaban_siswa: 'Majas yang menganggap benda mati seperti hidup' },
    { soal_id: soal2.id, jawaban_siswa: 'Ombak berkejar-kejaran' }
  ]);

  // Simulasikan hasil penilaian AI tersimpan
  const jawabanItems = db.prepare('SELECT id, soal_id FROM jawaban WHERE pengerjaan_id = ?').all(st.pengerjaanId);
  const j1 = jawabanItems.find(j => j.soal_id === soal1.id);
  const j2 = jawabanItems.find(j => j.soal_id === soal2.id);

  db.prepare(`
    UPDATE jawaban 
    SET status_penilaian = 'selesai', skor_rekomendasi = 15, status_jawaban = 'parsial', alasan_ai = 'Konsep mendekati benar'
    WHERE id = ?
  `).run(j1.id);

  db.prepare(`
    UPDATE jawaban 
    SET status_penilaian = 'selesai', skor_rekomendasi = 10, status_jawaban = 'benar', alasan_ai = 'Contoh tepat'
    WHERE id = ?
  `).run(j2.id);

  await t.test('FR-20: Guru dapat melihat daftar peserta dan rekomendasi AI', () => {
    const list = reviewService.getPengerjaanListByUlangan(ulangan.id, guru.id);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].nama_siswa, 'Rina Marlina');
    assert.strictEqual(list[0].total_dinilai, 2);

    const detail = reviewService.getPengerjaanDetail(st.pengerjaanId, guru.id);
    assert.strictEqual(detail.jawabanList.length, 2);
    assert.strictEqual(detail.jawabanList[0].skor_rekomendasi, 15);
    assert.strictEqual(detail.jawabanList[0].alasan_ai, 'Konsep mendekati benar');
  });

  await t.test('Proteksi Guru Lain', () => {
    assert.throws(() => {
      reviewService.getPengerjaanDetail(st.pengerjaanId, guruLain.id);
    }, /Akses ditolak/);
  });

  await t.test('FR-21 & FR-23: Guru mengubah nilai rekomendasi dan total terhitung normalisasi 100', () => {
    // Guru menaikkan skor soal 1 dari 15 menjadi 18 (dari maks 20)
    const rev1 = reviewService.updateJawabanReview(j1.id, guru.id, {
      skor_final: 18,
      catatan_guru: 'Penjelasan siswa sudah sangat baik'
    });
    assert.strictEqual(rev1.skorFinal, 18);
    assert.strictEqual(rev1.keputusan, 'diubah');

    // Guru menyetujui skor soal 2 (10 dari maks 10)
    const rev2 = reviewService.updateJawabanReview(j2.id, guru.id, {
      skor_final: 10,
      keputusan: 'diterima'
    });
    assert.strictEqual(rev2.skorFinal, 10);
    assert.strictEqual(rev2.keputusan, 'diterima');

    // Cek hasil normalisasi pada pengerjaan siswa:
    // Total bobot = 20 + 10 = 30
    // Total final = 18 + 10 = 28 -> (28 / 30) * 100 = 93.33
    const pengerjaanUpdated = db.prepare('SELECT nilai_ai, nilai_final FROM pengerjaan WHERE id = ?').get(st.pengerjaanId);
    assert.strictEqual(pengerjaanUpdated.nilai_final, 93.33);

    // AI score sebelumnya: (15 + 10) / 30 * 100 = 25 / 30 * 100 = 83.33
    assert.strictEqual(pengerjaanUpdated.nilai_ai, 83.33);
  });

  await t.test('FR-22: Rilis hasil ujian ke siswa', () => {
    // Awalnya belum dirilis
    let stStatus = studentService.getPengerjaanStatus(st.pengerjaanId);
    assert.strictEqual(stStatus.isReleased, false);
    assert.strictEqual(stStatus.nilaiFinal, null);
    assert.strictEqual(stStatus.jawaban.length, 0); // Jawaban disembunyikan

    // Guru merilis hasil
    reviewService.toggleReleasePengerjaan(ulangan.id, guru.id, true);

    // Sekarang siswa dapat melihat nilainya
    stStatus = studentService.getPengerjaanStatus(st.pengerjaanId);
    assert.strictEqual(stStatus.isReleased, true);
    assert.strictEqual(stStatus.nilaiFinal, 93.33);
    assert.strictEqual(stStatus.jawaban.length, 2);
  });
});
