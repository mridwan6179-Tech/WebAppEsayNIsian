const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/database');
const bankSoalService = require('../src/services/bankSoalService');
const examService = require('../src/services/examService');

test('Bank Soal - Pilihan Ganda (PG) & Mode Game Koding (SMP)', async (t) => {
  // 1. Setup Guru & Ulangan untuk pengujian
  let guru = db.prepare('SELECT id FROM guru LIMIT 1').get();
  if (!guru) {
    const res = db.prepare('INSERT INTO guru (nama, email, password) VALUES (?, ?, ?)').run('Guru Bank Test', 'gurubank@test.com', 'hash123');
    guru = { id: res.lastInsertRowid };
  }
  const guruId = guru.id;

  await t.test('1. Create Soal Pilihan Ganda di Bank Soal', () => {
    const dataPg = {
      kategori: 'Informatika SMP',
      sub_topik: 'Perangkat Keras',
      tingkat_kelas: 'Kelas 7',
      jenis: 'pilihan_ganda',
      pertanyaan: 'Manakah dari komponen berikut yang bertindak sebagai otak utama dari sebuah komputer?',
      opsi_a: 'Random Access Memory (RAM)',
      opsi_b: 'Central Processing Unit (CPU)',
      opsi_c: 'Hard Disk Drive (HDD)',
      opsi_d: 'Power Supply Unit (PSU)',
      opsi_e: 'Graphics Card (GPU)',
      kunci_pg: 'B',
      pembahasan: 'CPU adalah Central Processing Unit yang memproses seluruh instruksi aritmatika dan logika.',
      bobot_standar: 15,
      tingkat_kesulitan: 'mudah'
    };

    const created = bankSoalService.create(guruId, dataPg);
    assert.ok(created.id, 'Soal PG berhasil dibuat dan memiliki ID');
    assert.equal(created.jenis, 'pilihan_ganda');
    assert.equal(created.kunci_pg, 'B');
    assert.equal(created.opsi_a, 'Random Access Memory (RAM)');
    assert.equal(created.opsi_b, 'Central Processing Unit (CPU)');
    assert.equal(created.opsi_e, 'Graphics Card (GPU)');
    assert.equal(created.bobot_standar, 15);
  });

  await t.test('2. Create Soal Game Koding di Bank Soal', () => {
    const mockGameConfig = {
      subtipe: 'grid_robot',
      grid_width: 5,
      grid_height: 5,
      grid: [
        ['empty', 'empty', 'empty', 'empty', 'finish'],
        ['empty', 'wall',  'empty', 'wall',  'empty'],
        ['empty', 'empty', 'star',  'empty', 'empty'],
        ['wall',  'empty', 'empty', 'empty', 'empty'],
        ['start', 'empty', 'empty', 'wall',  'empty']
      ],
      start_pos: { x: 0, y: 4 },
      start_dir: 'N',
      finish_pos: { x: 4, y: 0 },
      stars: [{ x: 2, y: 2 }],
      par_limit: 6,
      max_steps: 25,
      allowed_blocks: ['MAJU', 'BELOK_KIRI', 'BELOK_KANAN', 'ULANGI']
    };

    const dataCoding = {
      kategori: 'Berpikir Komputasional SMP',
      sub_topik: 'Algoritma Navigasi Robot',
      tingkat_kelas: 'Kelas 8',
      jenis: 'koding_game',
      pertanyaan: 'Bantulah robot roket mencapai garis finish dengan mengambil bintang di tengah!',
      game_data: mockGameConfig,
      kunci_jawaban: 'Menyelesaikan rute dengan balok efisien',
      pembahasan: 'Gunakan loop ULANGI atau kombinasi MAJU dan BELOK_KANAN untuk menghindari rintangan tembok.',
      bobot_standar: 25,
      tingkat_kesulitan: 'sedang'
    };

    const created = bankSoalService.create(guruId, dataCoding);
    assert.ok(created.id, 'Soal Koding berhasil dibuat dan memiliki ID');
    assert.equal(created.jenis, 'koding_game');
    assert.ok(created.game_data, 'game_data tersimpan di database');

    const parsed = JSON.parse(created.game_data);
    assert.equal(parsed.subtipe, 'grid_robot');
    assert.equal(parsed.par_limit, 6);
  });

  await t.test('3. Filter getAll berdasarkan jenis pilihan_ganda dan koding_game', () => {
    const pgList = bankSoalService.getAll(guruId, { jenis: 'pilihan_ganda' });
    assert.ok(pgList.length > 0, 'Daftar soal PG ditemukan');
    assert.ok(pgList.every(s => s.jenis === 'pilihan_ganda'), 'Semua hasil filter adalah pilihan_ganda');

    const codingList = bankSoalService.getAll(guruId, { jenis: 'koding_game' });
    assert.ok(codingList.length > 0, 'Daftar soal Game Koding ditemukan');
    assert.ok(codingList.every(s => s.jenis === 'koding_game'), 'Semua hasil filter adalah koding_game');
  });

  await t.test('4. Update Soal Bank PG & Koding', () => {
    const testItem = bankSoalService.create(guruId, {
      kategori: 'Update Test',
      jenis: 'pilihan_ganda',
      pertanyaan: 'Sebelum update',
      opsi_a: 'A',
      opsi_b: 'B',
      opsi_c: 'C',
      opsi_d: 'D',
      kunci_pg: 'A'
    });

    const updated = bankSoalService.update(testItem.id, guruId, {
      pertanyaan: 'Sesudah update',
      opsi_a: 'A Baru',
      kunci_pg: 'C'
    });

    assert.equal(updated.pertanyaan, 'Sesudah update');
    assert.equal(updated.opsi_a, 'A Baru');
    assert.equal(updated.kunci_pg, 'C');
  });

  await t.test('5. Transfer 2 Arah: Ulangan ke Bank Soal & Bank Soal ke Ulangan', () => {
    // Buat Ulangan dummy
    const exam = examService.createUlangan(guruId, {
      judul: 'Ulangan Uji Transfer Bank Soal',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: 'Kelas 7 & 8',
      durasi_menit: 60
    });

    // Buat soal PG di ulangan tersebut
    const soalExamPg = examService.createSoal(exam.id, {
      jenis: 'pilihan_ganda',
      pertanyaan: 'Soal PG asli dari Ulangan: Manakah protokol aman untuk web?',
      bobot: 10,
      opsi_a: 'HTTP',
      opsi_b: 'HTTPS',
      opsi_c: 'FTP',
      opsi_d: 'SMTP',
      kunci_pg: 'B'
    });

    // Salin soal exam ini ke Bank Soal
    const copiedToBank = bankSoalService.copyFromExamSoal(soalExamPg.id, guruId, 'Keamanan Jaringan');
    assert.ok(copiedToBank.id, 'Soal berhasil disalin ke bank');
    assert.equal(copiedToBank.jenis, 'pilihan_ganda');
    assert.equal(copiedToBank.kunci_pg, 'B');
    assert.equal(copiedToBank.opsi_b, 'HTTPS');

    // Buat ulangan target baru untuk import
    const targetExam = examService.createUlangan(guruId, {
      judul: 'Ulangan Target Impor',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: 'Kelas 7',
      durasi_menit: 45
    });

    // Impor soal dari bank ke ulangan target
    const imported = bankSoalService.importToExam(targetExam.id, guruId, [copiedToBank.id]);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].jenis, 'pilihan_ganda');
    assert.equal(imported[0].kunci_pg, 'B');
    assert.equal(imported[0].opsi_b, 'HTTPS');
  });

  await t.test('6. AI Smart Pick dengan pool PG & Koding', () => {
    const picked = bankSoalService.aiSmartPick(guruId, null, {
      jumlah_pg: 1,
      jumlah_koding: 1,
      jumlah_soal: 2
    });

    assert.ok(picked.success);
    assert.equal(picked.total_dipilih, 2);
    const kinds = picked.selected_soal.map(s => s.jenis);
    assert.ok(kinds.includes('pilihan_ganda'), 'Pool PG terpilih');
    assert.ok(kinds.includes('koding_game'), 'Pool Koding terpilih');
  });
});
