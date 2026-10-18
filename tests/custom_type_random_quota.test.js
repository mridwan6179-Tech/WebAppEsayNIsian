const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const reviewService = require('../src/services/reviewService');

test('T-24: Fitur Distribusi & Kuota Wajib per Tipe Soal saat Pengacakan (misal: 4 Isian + 1 Essay)', async (t) => {
  const guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  assert.ok(guru, 'Guru harus tersedia di database');

  // 1. Buat ulangan dengan bank 20 soal: target 5 soal (wajib 4 isian + 1 essay)
  const ulangan = examService.createUlangan(guru.id, {
    judul: 'Ulangan Harian Koding - Kuota Acak',
    mata_pelajaran: 'Informatika',
    tingkat_kelas: 'Kelas 8',
    jumlah_soal_tampil: 5,
    jumlah_soal_isian: 4,
    jumlah_soal_essay: 1,
    acak_soal: 1
  });

  assert.strictEqual(ulangan.jumlah_soal_tampil, 5);
  assert.strictEqual(ulangan.jumlah_soal_isian, 4);
  assert.strictEqual(ulangan.jumlah_soal_essay, 1);
  assert.strictEqual(ulangan.acak_soal, 1);

  // Masukkan 20 butir soal: 15 Isian dan 5 Essay
  const isianIds = [];
  const essayIds = [];

  for (let i = 1; i <= 15; i++) {
    const s = examService.createSoal(ulangan.id, {
      nomor: i,
      jenis: 'isian',
      pertanyaan: `Soal Isian Bank Nomor ${i}?`,
      kunci_jawaban: `Jawaban isian ${i}`,
      rubrik: `Rubrik isian ${i}`,
      bobot: 15,
      urutan: i
    });
    isianIds.push(s.id);
  }

  for (let i = 16; i <= 20; i++) {
    const s = examService.createSoal(ulangan.id, {
      nomor: i,
      jenis: 'essay',
      pertanyaan: `Soal Essay Analisis Kasus Nomor ${i}?`,
      kunci_jawaban: `Jawaban essay ${i}`,
      rubrik: `Rubrik essay ${i}`,
      bobot: 40,
      urutan: i
    });
    essayIds.push(s.id);
  }

  assert.strictEqual(isianIds.length, 15);
  assert.strictEqual(essayIds.length, 5);

  // Buka ulangan
  examService.updateUlangan(ulangan.id, guru.id, { status: 'dibuka' });

  await t.test('1. Validasi token ujian mengembalikan info kuota tipe soal', () => {
    const val = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(val.valid, true);
    assert.strictEqual(val.ulangan.total_soal, 20);
    assert.strictEqual(val.ulangan.soal_dikerjakan, 5);
    assert.strictEqual(val.ulangan.jumlah_soal_isian, 4);
    assert.strictEqual(val.ulangan.jumlah_soal_essay, 1);
  });

  let pengerjaanAId;
  let soalSiswaA;

  await t.test('2. Siswa A menerima tepat 5 soal acak yang terdiri dari 4 Isian dan 1 Essay', () => {
    const sessionA = studentService.startExam(ulangan.kode_ujian, 'Rian Pratama', '8A');
    assert.strictEqual(sessionA.alreadySubmitted, false);
    assert.strictEqual(sessionA.soal.length, 5, 'Total soal yang diterima harus tepat 5 butir');

    pengerjaanAId = sessionA.pengerjaanId;
    soalSiswaA = sessionA.soal;

    const countIsian = soalSiswaA.filter(s => s.jenis === 'isian').length;
    const countEssay = soalSiswaA.filter(s => s.jenis === 'essay').length;

    assert.strictEqual(countIsian, 4, 'Wajib mendapatkan tepat 4 butir soal isian');
    assert.strictEqual(countEssay, 1, 'Wajib mendapatkan tepat 1 butir soal essay');

    // Pastikan ID soal berasal dari masing-masing pool
    const isianDiterima = soalSiswaA.filter(s => s.jenis === 'isian').map(s => s.id);
    const essayDiterima = soalSiswaA.filter(s => s.jenis === 'essay').map(s => s.id);

    assert.ok(isianDiterima.every(id => isianIds.includes(id)));
    assert.ok(essayDiterima.every(id => essayIds.includes(id)));

    // Nomor urut rapi 1..5
    assert.deepStrictEqual(soalSiswaA.map(s => s.nomor), [1, 2, 3, 4, 5]);
  });

  await t.test('3. Siswa B menerima paket acak berbeda namun tetap tepat 4 Isian dan 1 Essay', () => {
    const sessionB = studentService.startExam(ulangan.kode_ujian, 'Siti Nurhaliza', '8A');
    assert.strictEqual(sessionB.soal.length, 5);

    const countIsian = sessionB.soal.filter(s => s.jenis === 'isian').length;
    const countEssay = sessionB.soal.filter(s => s.jenis === 'essay').length;

    assert.strictEqual(countIsian, 4);
    assert.strictEqual(countEssay, 1);

    const idsA = soalSiswaA.map(s => s.id);
    const idsB = sessionB.soal.map(s => s.id);

    // Dengan 15 isian dan 5 essay, variasi kombinasi (C(15,4) * C(5,1) = 1365 * 5 = 6825 variasi)
    // Siswa B hampir pasti menerima kombinasi soal berbeda
    const isIdentical = JSON.stringify(idsA) === JSON.stringify(idsB);
    assert.strictEqual(isIdentical, false, 'Paket soal Siswa B harus berbeda secara acak dari Siswa A');
  });

  await t.test('4. Sesi Persisten: Siswa A refresh tetap menerima 4 Isian & 1 Essay yang sama persis', () => {
    const sessionReload = studentService.startExam(ulangan.kode_ujian, 'Rian Pratama', '8A');
    assert.strictEqual(sessionReload.pengerjaanId, pengerjaanAId);

    const reloadIds = sessionReload.soal.map(s => s.id);
    const originalIds = soalSiswaA.map(s => s.id);
    assert.deepStrictEqual(reloadIds, originalIds, 'Soal tidak berubah saat browser di-refresh');
  });

  await t.test('5. Pengumpulan jawaban & penilaian skor 100 terkalibrasi akurat', () => {
    const answers = soalSiswaA.map(s => ({
      soal_id: s.id,
      jawaban_siswa: `Jawaban siswa untuk soal ${s.id}`
    }));

    const resSubmit = studentService.submitExam(pengerjaanAId, answers);
    assert.strictEqual(resSubmit.success, true);

    const jawabanRows = db.prepare('SELECT id, skor_maksimum FROM jawaban WHERE pengerjaan_id = ?').all(pengerjaanAId);
    assert.strictEqual(jawabanRows.length, 5);

    // Siswa menjawab seluruh soal dengan benar penuh (100%)
    db.transaction(() => {
      jawabanRows.forEach(j => {
        db.prepare(`
          UPDATE jawaban 
          SET skor_rekomendasi = ?, skor_maksimum = ?, status_penilaian = 'selesai', status_jawaban = 'benar'
          WHERE id = ?
        `).run(j.skor_maksimum, j.skor_maksimum, j.id);
      });
    })();

    const finalScore = reviewService.recalculatePengerjaanTotal(pengerjaanAId);
    assert.strictEqual(finalScore.nilai_final, 100);
  });

  await t.test('6. Guru dapat memperbarui kuota tipe soal melalui updateUlangan', () => {
    examService.updateUlangan(ulangan.id, guru.id, {
      jumlah_soal_tampil: 7,
      jumlah_soal_isian: 5,
      jumlah_soal_essay: 2
    });

    const updated = examService.getUlanganById(ulangan.id, guru.id);
    assert.strictEqual(updated.jumlah_soal_tampil, 7);
    assert.strictEqual(updated.jumlah_soal_isian, 5);
    assert.strictEqual(updated.jumlah_soal_essay, 2);
  });

  await t.test('7. Format broadcast WhatsApp menyertakan rincian kuota soal acak', () => {
    const geminiService = require('../src/services/geminiService');
    const u = examService.getUlanganById(ulangan.id, guru.id);
    const waText = geminiService.formatDefaultWhatsAppBroadcast(u, 'https://contoh.sch.id');

    assert.ok(waText.includes('*Jumlah Soal:* 7 Soal Acak (5 Isian + 2 Essay)'));
  });

  await t.test('8. Penanganan fleksibel jika kuota melebihi bank soal tidak menyebabkan crash', () => {
    // Ulangan kecil dengan 2 isian & 1 essay, namun kuota diminta 5 isian & 5 essay
    const ulanganKecil = examService.createUlangan(guru.id, {
      judul: 'Ulangan Mini',
      mata_pelajaran: 'Fisika',
      tingkat_kelas: 'Kelas 7',
      jumlah_soal_tampil: 10,
      jumlah_soal_isian: 5,
      jumlah_soal_essay: 5
    });

    examService.createSoal(ulanganKecil.id, { nomor: 1, jenis: 'isian', pertanyaan: 'Soal 1?', kunci_jawaban: 'A', rubrik: 'R', bobot: 50, urutan: 1 });
    examService.createSoal(ulanganKecil.id, { nomor: 2, jenis: 'isian', pertanyaan: 'Soal 2?', kunci_jawaban: 'B', rubrik: 'R', bobot: 50, urutan: 2 });
    examService.createSoal(ulanganKecil.id, { nomor: 3, jenis: 'essay', pertanyaan: 'Soal 3?', kunci_jawaban: 'C', rubrik: 'R', bobot: 50, urutan: 3 });

    examService.updateUlangan(ulanganKecil.id, guru.id, { status: 'dibuka' });

    const sessionMini = studentService.startExam(ulanganKecil.kode_ujian, 'Doni', '7A');
    assert.strictEqual(sessionMini.soal.length, 3, 'Harus mengambil semua soal yang tersedia tanpa crash');
  });

  await t.test('9. Penolakan validasi jika kuota tipe soal melebihi batas jumlah soal siswa', () => {
    // Mencoba update ulangan dengan limit 5 tapi kuota 4 isian + 2 essay = 6
    assert.throws(() => {
      examService.updateUlangan(ulangan.id, guru.id, {
        jumlah_soal_tampil: 5,
        jumlah_soal_isian: 4,
        jumlah_soal_essay: 2
      });
    }, /tidak boleh melebihi batas jumlah soal siswa/);

    // Mencoba buat ulangan baru dengan limit 5 tapi kuota 5 isian + 1 essay = 6
    assert.throws(() => {
      examService.createUlangan(guru.id, {
        judul: 'Ulangan Invalid Quota',
        mata_pelajaran: 'IPA',
        tingkat_kelas: 'Kelas 7',
        jumlah_soal_tampil: 5,
        jumlah_soal_isian: 5,
        jumlah_soal_essay: 1
      });
    }, /tidak boleh melebihi batas jumlah soal siswa/);
  });

  await t.test('10. Penolakan validasi jika kuota batas listening melebihi batas jumlah soal siswa', () => {
    assert.throws(() => {
      examService.createUlangan(guru.id, {
        judul: 'Ulangan Invalid Listening',
        mata_pelajaran: 'Bahasa Inggris',
        tingkat_kelas: 'Kelas 8',
        jumlah_soal_tampil: 5,
        jumlah_soal_listening: 7
      });
    }, /Batas soal listening/);

    assert.throws(() => {
      examService.updateUlangan(ulangan.id, guru.id, {
        jumlah_soal_tampil: 10,
        jumlah_soal_listening: 12
      });
    }, /Batas soal listening/);
  });

  await t.test('11. Batas kuota soal listening ditaati secara akurat dalam pembagian paket soal siswa', () => {
    const examListening = examService.createUlangan(guru.id, {
      judul: 'Ulangan Listening Quota Test',
      mata_pelajaran: 'Bahasa Inggris',
      tingkat_kelas: 'Kelas 8',
      jumlah_soal_tampil: 5,
      jumlah_soal_isian: 3,
      jumlah_soal_essay: 2,
      jumlah_soal_listening: 2,
      acak_soal: 1
    });

    // Buat 4 listening dan 6 non-listening
    examService.createSoal(examListening.id, { nomor: 1, jenis: 'isian', pertanyaan: 'Listen 1', bobot: 20, urutan: 1, is_listening: 1, audio_url: '/a1.mp3' });
    examService.createSoal(examListening.id, { nomor: 2, jenis: 'isian', pertanyaan: 'Listen 2', bobot: 20, urutan: 2, is_listening: 1, audio_url: '/a2.mp3' });
    examService.createSoal(examListening.id, { nomor: 3, jenis: 'essay', pertanyaan: 'Listen 3', bobot: 20, urutan: 3, is_listening: 1, audio_url: '/a3.mp3' });
    examService.createSoal(examListening.id, { nomor: 4, jenis: 'essay', pertanyaan: 'Listen 4', bobot: 20, urutan: 4, is_listening: 1, audio_url: '/a4.mp3' });

    examService.createSoal(examListening.id, { nomor: 5, jenis: 'isian', pertanyaan: 'Read 1', bobot: 20, urutan: 5, is_listening: 0 });
    examService.createSoal(examListening.id, { nomor: 6, jenis: 'isian', pertanyaan: 'Read 2', bobot: 20, urutan: 6, is_listening: 0 });
    examService.createSoal(examListening.id, { nomor: 7, jenis: 'isian', pertanyaan: 'Read 3', bobot: 20, urutan: 7, is_listening: 0 });
    examService.createSoal(examListening.id, { nomor: 8, jenis: 'essay', pertanyaan: 'Read 4', bobot: 20, urutan: 8, is_listening: 0 });
    examService.createSoal(examListening.id, { nomor: 9, jenis: 'essay', pertanyaan: 'Read 5', bobot: 20, urutan: 9, is_listening: 0 });
    examService.createSoal(examListening.id, { nomor: 10, jenis: 'essay', pertanyaan: 'Read 6', bobot: 20, urutan: 10, is_listening: 0 });

    examService.updateUlangan(examListening.id, guru.id, { status: 'dibuka' });

    const studentA = studentService.startExam(examListening.kode_ujian, 'Student Listening A', '8A');
    assert.strictEqual(studentA.soal.length, 5);
    const listeningCount = studentA.soal.filter(s => Number(s.is_listening) === 1).length;
    assert.ok(listeningCount <= 2, `Listening count (${listeningCount}) must not exceed 2`);
    const isianCount = studentA.soal.filter(s => s.jenis === 'isian').length;
    const essayCount = studentA.soal.filter(s => s.jenis === 'essay').length;
    assert.strictEqual(isianCount, 3);
    assert.strictEqual(essayCount, 2);

    // Format broadcast WhatsApp
    const geminiService = require('../src/services/geminiService');
    const uUpdated = examService.getUlanganById(examListening.id, guru.id);
    const broadcastText = geminiService.formatDefaultWhatsAppBroadcast(uUpdated, 'https://contoh.sch.id');
    assert.ok(broadcastText.includes('Maks. 2 Listening'));
  });

  await t.test('12. Distribusi kuota lengkap 5 tipe (PG, PG Kompleks, Isian, Essay, Koding) & Multi-Sesi Otomatis per Kelas', async () => {
    // Daftarkan kelas di database jika belum ada
    let k7A = db.prepare("SELECT id FROM kelas WHERE nama_kelas = '7A'").get();
    if (!k7A) {
      const ins = db.prepare("INSERT INTO kelas (nama_kelas) VALUES ('7A')").run();
      k7A = { id: ins.lastInsertRowid };
    }
    let k7B = db.prepare("SELECT id FROM kelas WHERE nama_kelas = '7B'").get();
    if (!k7B) {
      const ins = db.prepare("INSERT INTO kelas (nama_kelas) VALUES ('7B')").run();
      k7B = { id: ins.lastInsertRowid };
    }

    // Buat ulangan dengan kuota lengkap: 1 PG + 1 PG Kompleks + 1 Isian + 1 Essay + 1 Koding = 5 soal
    const examFull = examService.createUlangan(guru.id, {
      judul: 'Ulangan Informatika Komprehensif',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: '7A, 7B',
      kelas_ids: [k7A.id, k7B.id],
      jumlah_soal_tampil: 5,
      jumlah_soal_pg: 1,
      jumlah_soal_pg_kompleks: 1,
      jumlah_soal_isian: 1,
      jumlah_soal_essay: 1,
      jumlah_soal_koding: 1,
      acak_soal: 1
    });

    assert.strictEqual(examFull.jumlah_soal_pg, 1);
    assert.strictEqual(examFull.jumlah_soal_pg_kompleks, 1);
    assert.strictEqual(examFull.jumlah_soal_isian, 1);
    assert.strictEqual(examFull.jumlah_soal_essay, 1);
    assert.strictEqual(examFull.jumlah_soal_koding, 1);

    // Tambahkan bank butir soal:
    // 3 PG biasa
    examService.createSoal(examFull.id, { nomor: 1, jenis: 'pilihan_ganda', pertanyaan: 'PG 1', bobot: 10, urutan: 1, opsi_a: 'A', opsi_b: 'B', kunci_pg: 'A' });
    examService.createSoal(examFull.id, { nomor: 2, jenis: 'pilihan_ganda', pertanyaan: 'PG 2', bobot: 10, urutan: 2, opsi_a: 'A', opsi_b: 'B', kunci_pg: 'B' });
    examService.createSoal(examFull.id, { nomor: 3, jenis: 'pilihan_ganda', pertanyaan: 'PG 3', bobot: 10, urutan: 3, opsi_a: 'A', opsi_b: 'B', kunci_pg: 'A' });

    // 2 PG Kompleks (kunci memiliki koma)
    examService.createSoal(examFull.id, { nomor: 4, jenis: 'pilihan_ganda', pertanyaan: 'PGK 1', bobot: 15, urutan: 4, opsi_a: 'A', opsi_b: 'B', opsi_c: 'C', kunci_pg: 'A, B' });
    examService.createSoal(examFull.id, { nomor: 5, jenis: 'pilihan_ganda', pertanyaan: 'PGK 2', bobot: 15, urutan: 5, opsi_a: 'A', opsi_b: 'B', opsi_c: 'C', kunci_pg: 'B, C' });

    // 2 Isian
    examService.createSoal(examFull.id, { nomor: 6, jenis: 'isian', pertanyaan: 'Isian 1', bobot: 15, urutan: 6, kunci_jawaban: 'RAM' });
    examService.createSoal(examFull.id, { nomor: 7, jenis: 'isian', pertanyaan: 'Isian 2', bobot: 15, urutan: 7, kunci_jawaban: 'ROM' });

    // 2 Essay
    examService.createSoal(examFull.id, { nomor: 8, jenis: 'essay', pertanyaan: 'Essay 1', bobot: 30, urutan: 8, kunci_jawaban: 'Jelaskan...' });
    examService.createSoal(examFull.id, { nomor: 9, jenis: 'essay', pertanyaan: 'Essay 2', bobot: 30, urutan: 9, kunci_jawaban: 'Uraikan...' });

    // 2 Koding Game
    examService.createSoal(examFull.id, {
      nomor: 10,
      jenis: 'koding_game',
      pertanyaan: 'Misi Robot 1',
      bobot: 30,
      urutan: 10,
      game_data: JSON.stringify({ subtipe: 'grid_robot', grid_width: 5, grid_height: 5, par_limit: 6 })
    });
    examService.createSoal(examFull.id, {
      nomor: 11,
      jenis: 'koding_game',
      pertanyaan: 'Misi Robot 2',
      bobot: 30,
      urutan: 11,
      game_data: JSON.stringify({ subtipe: 'loop_master', grid_width: 5, grid_height: 5, par_limit: 8 })
    });

    examService.updateUlangan(examFull.id, guru.id, { status: 'dibuka' });

    // Generate sesi otomatis per kelas (Kelas 7A & 7B)
    const autoGenResult = examService.autoGenerateSessions(examFull.id, guru.id);
    assert.strictEqual(autoGenResult.success, true);
    assert.strictEqual(autoGenResult.created, 2, 'Harus membuat 2 sesi untuk 2 kelas');

    const sesiList = examService.getSessionsByUlanganId(examFull.id, guru.id);
    assert.strictEqual(sesiList.length, 2);
    const sesi7A = sesiList.find(s => s.kelas === '7A');
    assert.ok(sesi7A, 'Sesi 7A harus terbentuk');
    assert.ok(sesi7A.kode_sesi.startsWith('SESI-'), 'Kode sesi berawalan SESI-');

    // Siswa masuk lewat token sesi spesifik
    const studentSesi = studentService.startExam(sesi7A.kode_sesi, 'Budi Santoso', '7A');
    assert.strictEqual(studentSesi.soal.length, 5, 'Harus menerima tepat 5 soal');
    assert.strictEqual(studentSesi.sesi.nama_sesi, sesi7A.nama_sesi);

    // Verifikasi masing-masing tipe soal diterima tepat 1 butir
    const countPG = studentSesi.soal.filter(s => s.jenis === 'pilihan_ganda' && s.tipe_pg !== 'pg_kompleks').length;
    const countPGK = studentSesi.soal.filter(s => s.jenis === 'pilihan_ganda' && s.tipe_pg === 'pg_kompleks').length;
    const countIsian = studentSesi.soal.filter(s => s.jenis === 'isian').length;
    const countEssay = studentSesi.soal.filter(s => s.jenis === 'essay').length;
    const countKoding = studentSesi.soal.filter(s => s.jenis === 'koding_game').length;

    assert.strictEqual(countPG, 1, 'Tepat 1 PG biasa');
    assert.strictEqual(countPGK, 1, 'Tepat 1 PG Kompleks');
    assert.strictEqual(countIsian, 1, 'Tepat 1 Isian');
    assert.strictEqual(countEssay, 1, 'Tepat 1 Essay');
    assert.strictEqual(countKoding, 1, 'Tepat 1 Koding Game');

    // Pastikan kunci_pg tidak bocor ke siswa namun tipe_pg terpasang
    const qPgk = studentSesi.soal.find(s => s.tipe_pg === 'pg_kompleks');
    assert.strictEqual(qPgk.kunci_pg, undefined, 'kunci_pg harus dihapus dari respon siswa');
    assert.strictEqual(qPgk.tipe_pg, 'pg_kompleks', 'tipe_pg harus terpasang');
  });
});
