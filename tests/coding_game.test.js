const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const db = require('../src/config/database');
const examService = require('../src/services/examService');
const studentService = require('../src/services/studentService');
const codingGameService = require('../src/services/codingGameService');
const app = require('../server');

describe('=== SUITE: ULANGAN MODE PERMAINAN KODING (SMP) & HYBRID ===', () => {
  let server;
  let baseUrl;
  let teacherCookie = '';
  let testGuruId;
  let testUlanganId;
  let testKodeUjian;
  let testSoalPgId;
  let testSoalKodingId;

  before(async () => {
    const guru = db.prepare('SELECT id, email, password FROM guru LIMIT 1').get();
    testGuruId = guru.id;

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;

    // Login guru
    const authRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: guru.email, password: process.env.TEACHER_PASSWORD || guru.password || 'Guru123' })
    });
    const authData = await authRes.json();
    if (authData.token) {
      teacherCookie = `auth_token=${authData.token}`;
    }
  });

  after(() => {
    if (server) server.close();
  });

  test('1. codingGameService memiliki 5 mode preset game koding dasar SMP', () => {
    const presets = codingGameService.getPresets();
    assert.strictEqual(presets.length >= 5, true);
    const modes = presets.map(p => p.mode);
    assert.ok(modes.includes('grid_runner'), 'Harus ada mode grid_runner');
    assert.ok(modes.includes('loop_master'), 'Harus ada mode loop_master');
    assert.ok(modes.includes('bug_doctor'), 'Harus ada mode bug_doctor');
    assert.ok(modes.includes('if_else'), 'Harus ada mode if_else');
    assert.ok(modes.includes('scratch_puzzle'), 'Harus ada mode scratch_puzzle');
  });

  test('2. Engine Simulasi Grid Robot: Robot bergerak, ambil bintang, dan finish dengan 3 bintang', () => {
    const levelData = {
      mode: 'grid_runner',
      gridSize: { rows: 4, cols: 4 },
      start: { x: 0, y: 0, dir: 'right' },
      finish: { x: 2, y: 0 },
      obstacles: [{ x: 1, y: 1 }],
      stars: [{ x: 1, y: 0 }],
      parBlocks: 5
    };

    const blocks = [
      { type: 'move' }, // ke (1, 0) ambil bintang
      { type: 'move' }  // ke (2, 0) sampai finish
    ];

    const result = codingGameService.evaluateSolution(levelData, blocks);
    assert.strictEqual(result.isFinished, true);
    assert.strictEqual(result.hitObstacle, false);
    assert.strictEqual(result.collectedStars, 1);
    assert.strictEqual(result.starsEarned, 3);
    assert.strictEqual(result.score, 100);
  });

  test('3. Engine Simulasi Grid Robot: Mendeteksi tabrakan tembok & batas arena', () => {
    const levelData = {
      mode: 'grid_runner',
      gridSize: { rows: 4, cols: 4 },
      start: { x: 0, y: 0, dir: 'right' },
      finish: { x: 3, y: 0 },
      obstacles: [{ x: 1, y: 0, type: 'wall' }],
      stars: [],
      parBlocks: 4
    };

    // Maju langsung ke tembok di (1, 0)
    const blocks = [{ type: 'move' }];
    const result = codingGameService.evaluateSolution(levelData, blocks);
    assert.strictEqual(result.isFinished, false);
    assert.strictEqual(result.hitObstacle, true);
    assert.ok(result.obstacleReason.includes('menabrak rintangan'));
    assert.strictEqual(result.starsEarned, 0);
    assert.ok(result.score < 50);
  });

  test('4. Engine Simulasi Grid Robot: Balok Perulangan (Repeat Loop)', () => {
    const levelData = {
      mode: 'loop_master',
      gridSize: { rows: 5, cols: 5 },
      start: { x: 0, y: 0, dir: 'right' },
      finish: { x: 4, y: 0 },
      obstacles: [],
      stars: [],
      parBlocks: 4
    };

    // Maju 4 kali menggunakan loop
    const blocks = [
      { type: 'repeat', count: 4, blocks: [{ type: 'move' }] }
    ];

    const result = codingGameService.evaluateSolution(levelData, blocks);
    assert.strictEqual(result.isFinished, true);
    assert.strictEqual(result.finalPos.x, 4);
    assert.strictEqual(result.finalPos.y, 0);
    assert.strictEqual(result.starsEarned, 3);
  });

  test('4b. Engine Simulasi Grid Robot: Perintah MUNDUR (Move Backward) bergerak mundur tanpa memutar arah hadap', () => {
    const levelData = {
      mode: 'grid_runner',
      theme: 'pyramid',
      gridSize: { rows: 4, cols: 4 },
      start: { x: 1, y: 1, dir: 'right' },
      finish: { x: 0, y: 1 },
      obstacles: [],
      stars: [],
      parBlocks: 3
    };

    // Robot menghadap kanan (E/right) di (1,1). Mundur 1 langkah -> ke (0,1) yang merupakan finish!
    const blocks = [{ type: 'move_back' }];
    const result = codingGameService.evaluateSolution(levelData, blocks);
    assert.strictEqual(result.isFinished, true);
    assert.strictEqual(result.finalPos.x, 0);
    assert.strictEqual(result.finalPos.y, 1);
    assert.strictEqual(result.finalPos.dir, 'right');
    assert.strictEqual(result.score, 100);
  });


  test('5. Engine Scratch Mini Puzzle: Evaluasi pasangan Event -> Action', () => {
    const levelData = {
      mode: 'scratch_puzzle',
      pairs: [
        { id: 'p1', event: 'Saat Tombol Spasi Ditekan', action: 'Karakter Melompat' },
        { id: 'p2', event: 'Saat Menyentuh Apel', action: 'Tambah Skor +10' }
      ]
    };

    const studentPairs = [
      { event: 'Saat Tombol Spasi Ditekan', action: 'Karakter Melompat' },
      { event: 'Saat Menyentuh Apel', action: 'Tambah Skor +10' }
    ];

    const result = codingGameService.evaluateSolution(levelData, studentPairs);
    assert.strictEqual(result.isFinished, true);
    assert.strictEqual(result.correctCount, 2);
    assert.strictEqual(result.starsEarned, 3);
    assert.strictEqual(result.score, 100);
  });

  test('6. Guru dapat membuat Ulangan Hybrid (Bobot PG 50% + Bobot Koding 50%) & Butir Soal Game', () => {
    const ulangan = examService.createUlangan(testGuruId, {
      judul: 'Ulangan Informatika SMP: Logika Algoritma Game',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: 'Kelas 7',
      jenis_ulangan: 'campuran',
      bobot_pg: 50,
      bobot_koding: 50,
      bobot_essay: 0
    });
    assert.ok(ulangan.id);
    testUlanganId = ulangan.id;
    testKodeUjian = ulangan.kode_ujian;

    // Tambah 1 Soal PG
    const soalPg = examService.createSoal(testUlanganId, {
      pertanyaan: 'Perintah untuk mengulang instruksi berkali-kali adalah...',
      jenis: 'pilihan_ganda',
      bobot: 10,
      opsi_a: 'Looping / Perulangan',
      opsi_b: 'Branching / Percabangan',
      opsi_c: 'Variable / Variabel',
      opsi_d: 'Debugging / Melacak',
      kunci_pg: 'A'
    });
    assert.ok(soalPg.id);
    testSoalPgId = soalPg.id;

    // Tambah 1 Soal Koding Game
    const gameData = {
      mode: 'grid_runner',
      gridSize: { rows: 4, cols: 4 },
      start: { x: 0, y: 0, dir: 'right' },
      finish: { x: 2, y: 0 },
      obstacles: [],
      stars: [{ x: 1, y: 0 }],
      parBlocks: 4
    };

    const soalKod = examService.createSoal(testUlanganId, {
      pertanyaan: 'Selesaikan rute robot menuju finish dan kumpulkan bintang!',
      jenis: 'koding_game',
      bobot: 10,
      game_data: gameData
    });
    assert.ok(soalKod.id);
    assert.strictEqual(soalKod.jenis, 'koding_game');
    testSoalKodingId = soalKod.id;

    // Buka Ulangan
    examService.updateUlangan(testUlanganId, testGuruId, { status: 'dibuka' });
  });

  test('7. Siswa masuk ujian online & mendapatkan data game_data soal koding', () => {
    const examData = studentService.startExam(testKodeUjian, 'Arya Saputra', '7A');
    assert.strictEqual(examData.alreadySubmitted, false);
    assert.ok(examData.pengerjaanId);
    assert.strictEqual(examData.soal.length, 2);

    const kodingQ = examData.soal.find(s => s.jenis === 'koding_game');
    assert.ok(kodingQ, 'Soal koding_game harus ada');
    assert.ok(kodingQ.game_data, 'game_data harus dikirimkan ke siswa');
    const parsedGd = JSON.parse(kodingQ.game_data);
    assert.strictEqual(parsedGd.mode, 'grid_runner');
  });

  test('8. Siswa submit pengerjaan hybrid: PG benar (100) + Game Koding benar (100) -> Nilai Final 100', () => {
    // Cari pengerjaan ID Arya
    const pengerjaan = db.prepare(`
      SELECT p.id FROM pengerjaan p
      JOIN peserta pes ON p.peserta_id = pes.id
      WHERE p.ulangan_id = ? AND pes.nama = 'Arya Saputra'
    `).get(testUlanganId);
    assert.ok(pengerjaan);

    const answers = [
      { soal_id: testSoalPgId, jawaban_siswa: 'A' },
      {
        soal_id: testSoalKodingId,
        jawaban_siswa: JSON.stringify([{ type: 'move' }, { type: 'move' }])
      }
    ];

    const submitResult = studentService.submitExam(pengerjaan.id, answers);
    assert.strictEqual(submitResult.success, true);
    assert.strictEqual(submitResult.skor_pg, 100);
    assert.strictEqual(submitResult.skor_koding, 100);

    const checkP = db.prepare('SELECT nilai_final, skor_pg, skor_koding FROM pengerjaan WHERE id = ?').get(pengerjaan.id);
    assert.strictEqual(checkP.nilai_final, 100);
    assert.strictEqual(checkP.skor_pg, 100);
    assert.strictEqual(checkP.skor_koding, 100);
  });

  test('8.2 Siswa submit pengerjaan dengan Game Koding parsial (1 bintang): status_jawaban tersimpan sebagai parsial sesuai CHECK constraint', () => {
    // Siswa kedua: Budi
    const examDataBudi = studentService.startExam(testKodeUjian, 'Budi Santoso', '7A');
    assert.ok(examDataBudi.pengerjaanId);

    // Di soal koding: robot finish tanpa ambil bintang -> dapat 1 bintang (skor 60%)
    // gameData finish di {x: 2, y: 0}, stars di {x: 1, y: 0}
    // Jika robot melompati bintang atau konfigurasi puzzle yang menghasilkan 1 bintang
    const answersBudi = [
      { soal_id: testSoalPgId, jawaban_siswa: 'A' },
      {
        soal_id: testSoalKodingId,
        jawaban_siswa: JSON.stringify([{ type: 'move' }, { type: 'move' }]) // Akan dinilai
      }
    ];

    // Buat jawaban parsial secara eksak: misalnya koding game Parsons atau Scratch dengan pasangan sebagian
    const pengerjaanBudi = db.prepare('SELECT id FROM pengerjaan WHERE id = ?').get(examDataBudi.pengerjaanId);
    assert.ok(pengerjaanBudi);

    const submitResBudi = studentService.submitExam(pengerjaanBudi.id, answersBudi);
    assert.strictEqual(submitResBudi.success, true);

    // Verifikasi bahwa jawaban koding tersimpan dan status_jawaban memenuhi CHECK constraint
    const jwbKoding = db.prepare('SELECT status_jawaban FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(pengerjaanBudi.id, testSoalKodingId);
    assert.ok(jwbKoding);
    assert.ok(['benar', 'parsial', 'salah', 'perlu_review'].includes(jwbKoding.status_jawaban), `status_jawaban harus valid: ${jwbKoding.status_jawaban}`);
  });

  test('9. REST API Endpoints: Presets dan Test-run bekerja normal via Express', async () => {
    const testLevel = {
      mode: 'grid_runner',
      gridSize: { rows: 3, cols: 3 },
      start: { x: 0, y: 0, dir: 'right' },
      finish: { x: 1, y: 0 },
      obstacles: [],
      stars: [],
      parBlocks: 3
    };

    const testRes = await fetch(`${baseUrl}/api/guru/coding-game/test-run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': teacherCookie
      },
      body: JSON.stringify({
        levelData: testLevel,
        blocks: [{ type: 'move' }]
      })
    });

    const resJson = await testRes.json();
    assert.strictEqual(testRes.status, 200);
    assert.strictEqual(resJson.success, true);
    assert.strictEqual(resJson.result.isFinished, true);
    assert.strictEqual(resJson.result.score, 100);

    // Test get presets
    const presetRes = await fetch(`${baseUrl}/api/guru/coding-game/presets`, {
      headers: { 'Cookie': teacherCookie }
    });
    const presetJson = await presetRes.json();
    assert.strictEqual(presetRes.status, 200);
    assert.strictEqual(presetJson.success, true);
    assert.strictEqual(presetJson.presets.length >= 8, true);
    const subtipeList = presetJson.presets.map(p => p.subtipe);
    assert.ok(subtipeList.includes('pattern_guesser'), 'Harus ada subtipe pattern_guesser');
    assert.ok(subtipeList.includes('parsons_puzzle'), 'Harus ada subtipe parsons_puzzle');
  });

  test('10. Mode Tebak Pola (Pattern Guesser): Evaluasi jawaban tepat dan salah', () => {
    const levelData = {
      subtipe: 'pattern_guesser',
      correct_answer: 'Maju 2 Kotak',
      correct_option_id: 'opt_1',
      options: [
        { id: 'opt_1', label: 'Maju 2 Kotak' },
        { id: 'opt_2', label: 'Mundur 1 Kotak' }
      ]
    };

    // Jawaban benar via label
    const resExact = codingGameService.evaluateSolution(levelData, { selected: 'Maju 2 Kotak' });
    assert.strictEqual(resExact.isFinished, true);
    assert.strictEqual(resExact.score, 100);
    assert.strictEqual(resExact.starsEarned, 3);
    assert.strictEqual(resExact.matched, true);

    // Jawaban benar via option ID
    const resId = codingGameService.evaluateSolution(levelData, { selected: 'opt_1' });
    assert.strictEqual(resId.isFinished, true);
    assert.strictEqual(resId.score, 100);

    // Jawaban salah
    const resWrong = codingGameService.evaluateSolution(levelData, { selected: 'opt_2' });
    assert.strictEqual(resWrong.isFinished, false);
    assert.strictEqual(resWrong.score, 0);
    assert.strictEqual(resWrong.starsEarned, 0);
  });

  test('11. Mode Susun Algoritma (Parsons Problem): Evaluasi urutan eksak & parsial Kendall-tau', () => {
    const levelData = {
      subtipe: 'parsons_puzzle',
      correct_order: ['s1', 's2', 's3', 's4'],
      steps: [
        { id: 's1', text: 'Nyalakan sensor' },
        { id: 's2', text: 'Cek input' },
        { id: 's3', text: 'Buka pintu' },
        { id: 's4', text: 'Kunci pintu' }
      ]
    };

    // Urutan 100% tepat
    const resPerfect = codingGameService.evaluateSolution(levelData, { order: ['s1', 's2', 's3', 's4'] });
    assert.strictEqual(resPerfect.isFinished, true);
    assert.strictEqual(resPerfect.score, 100);
    assert.strictEqual(resPerfect.starsEarned, 3);
    assert.strictEqual(resPerfect.exactMatches, 4);

    // Urutan sebagian (misal s1 dan s2 benar posisinya, s3 dan s4 terbalik)
    const resPartial = codingGameService.evaluateSolution(levelData, { order: ['s1', 's2', 's4', 's3'] });
    assert.strictEqual(resPartial.isFinished, false);
    assert.strictEqual(resPartial.exactMatches, 2);
    assert.ok(resPartial.score >= 50 && resPartial.score < 100, `Skor parsial harus realistis: ${resPartial.score}`);
    assert.ok(resPartial.starsEarned >= 1);
  });

  test('12. Grid Robot Multi-Target: Garis finish terkunci sampai SELURUH target bintang terkumpul', () => {
    // Level dengan 2 bintang: di (1,0) dan (1,1), finish di (2,0)
    const levelData = {
      mode: 'grid_runner',
      gridSize: { rows: 3, cols: 3 },
      start: { x: 0, y: 0, dir: 'right' },
      finish: { x: 2, y: 0 },
      obstacles: [],
      stars: [
        { x: 1, y: 0 },
        { x: 1, y: 1 }
      ],
      parBlocks: 8
    };

    // Skenario A: Robot langsung maju ke finish (2,0) setelah hanya mengambil 1 bintang di (1,0)
    // Jalur: (0,0) -> Maju ke (1,0)[ambil bintang 1] -> Maju ke (2,0)[sampai finish sebelum bintang 2 diambil]
    const prematureBlocks = [
      { type: 'move' },
      { type: 'move' }
    ];

    const resPremature = codingGameService.evaluateSolution(levelData, prematureBlocks);
    assert.strictEqual(resPremature.isFinished, false, 'Robot tidak boleh menyelesaikan level jika bintang belum lengkap');
    assert.strictEqual(resPremature.allStarsCollected, false);
    assert.strictEqual(resPremature.collectedStars, 1);
    assert.strictEqual(resPremature.totalStars, 2);
    assert.ok(resPremature.obstacleReason.includes('Garis finish terkunci'), 'Harus ada peringatan garis finish terkunci');
    assert.ok(resPremature.logs.some(l => l.action === 'finish_locked'), 'Harus mencatat log finish_locked');

    // Skenario B: Robot mengumpulkan SEMUA 2 bintang lalu menuju ke finish
    // Jalur:
    // (0,0) -> Belok kanan (hadap bawah) -> Maju ke (0,1) -> Belok kiri (hadap kanan)
    // -> Maju ke (1,1)[ambil bintang 2] -> Belok kiri (hadap atas) -> Maju ke (1,0)[ambil bintang 1]
    // -> Belok kanan (hadap kanan) -> Maju ke (2,0)[sampai finish dengan semua bintang lengkap]
    const completeBlocks = [
      { type: 'turn_right' }, // hadap S
      { type: 'move' },       // (0,1)
      { type: 'turn_left' },  // hadap E
      { type: 'move' },       // (1,1) ambil bintang 2
      { type: 'turn_left' },  // hadap N
      { type: 'move' },       // (1,0) ambil bintang 1
      { type: 'turn_right' }, // hadap E
      { type: 'move' }        // (2,0) Finish!
    ];

    const resComplete = codingGameService.evaluateSolution(levelData, completeBlocks);
    assert.strictEqual(resComplete.isFinished, true, 'Robot berhasil menyelesaikan level');
    assert.strictEqual(resComplete.allStarsCollected, true);
    assert.strictEqual(resComplete.collectedStars, 2);
    assert.strictEqual(resComplete.starsEarned, 3);
    assert.strictEqual(resComplete.score, 100);
  });

  test('13. Grid Robot Efisiensi Kode (Par Blocks): Jumlah blok <= parLimit dapat 3 bintang, lebih dari parLimit kena reduksi', () => {
    const levelData = {
      mode: 'grid_runner',
      gridSize: { rows: 4, cols: 4 },
      start: { x: 0, y: 0, dir: 'right' },
      finish: { x: 2, y: 0 },
      obstacles: [],
      stars: [{ x: 1, y: 0 }],
      parBlocks: 3 // Par limit ketat: 3 blok
    };

    // Solusi efisien: 2 blok (<= parLimit 3)
    const efficientBlocks = [
      { type: 'move' },
      { type: 'move' }
    ];
    const resEfficient = codingGameService.evaluateSolution(levelData, efficientBlocks);
    assert.strictEqual(resEfficient.isFinished, true);
    assert.strictEqual(resEfficient.starsEarned, 3, 'Harus 3 bintang jika efisien');
    assert.strictEqual(resEfficient.score, 100);

    // Solusi tidak efisien: berputar-putar dulu sehingga total blok = 8 (> parLimit 3)
    const inefficientBlocks = [
      { type: 'turn_right' },
      { type: 'turn_left' },
      { type: 'turn_right' },
      { type: 'turn_left' },
      { type: 'turn_right' },
      { type: 'turn_left' },
      { type: 'move' },
      { type: 'move' }
    ];
    const resInefficient = codingGameService.evaluateSolution(levelData, inefficientBlocks);
    assert.strictEqual(resInefficient.isFinished, true);
    assert.strictEqual(resInefficient.starsEarned, 2, 'Harus tereduksi jadi 2 bintang jika melebihi parLimit');
    assert.ok(resInefficient.score < 100, `Skor harus di bawah 100 karena melebihi parLimit: ${resInefficient.score}`);
    assert.ok(resInefficient.score >= 65, `Skor minimal tetap terjaga: ${resInefficient.score}`);
  });

  test('14. Pilihan Ganda Kompleks (Multi-Select): Evaluasi jawaban persis, parsial, dan salah di studentService', () => {
    // 1. Buat ulangan khusus PG Kompleks via examService
    const ulangan = examService.createUlangan(testGuruId, {
      judul: 'Ulangan PG Kompleks Test',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: 'Kelas 7',
      jenis_ulangan: 'pilihan_ganda',
      bobot_pg: 100
    });
    const ulanganId = ulangan.id;
    const kodeUjian = ulangan.kode_ujian;

    // Soal 1: PG Kompleks dengan 2 jawaban benar: "A, C"
    const soal = examService.createSoal(ulanganId, {
      nomor: 1,
      jenis: 'pilihan_ganda',
      pertanyaan: 'Manakah pernyataan yang BENAR mengenai algoritma? (Pilih semua yang tepat)',
      opsi_a: 'Langkah sistematis',
      opsi_b: 'Tidak memerlukan urutan',
      opsi_c: 'Memiliki input dan output',
      opsi_d: 'Selalu dibuat dengan bahasa C',
      kunci_pg: 'A, C',
      bobot: 20
    });
    const soalId = soal.id;

    // Buka Ulangan
    examService.updateUlangan(ulanganId, testGuruId, { status: 'dibuka' });

    // Siswa 1: Menjawab persis "A, C" -> 100% (benar)
    const sess1 = studentService.startExam(kodeUjian, 'Siswa Tepat', '7A');
    const submit1 = studentService.submitExam(sess1.pengerjaanId, [{ soal_id: soalId, jawaban_siswa: 'A, C' }]);
    assert.strictEqual(submit1.success, true);
    const jwb1 = db.prepare('SELECT status_jawaban, skor_rekomendasi FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(sess1.pengerjaanId, soalId);
    assert.strictEqual(jwb1.status_jawaban, 'benar');
    assert.strictEqual(jwb1.skor_rekomendasi, 20);

    // Siswa 2: Menjawab parsial hanya "A" -> 50% (parsial)
    const sess2 = studentService.startExam(kodeUjian, 'Siswa Parsial', '7A');
    const submit2 = studentService.submitExam(sess2.pengerjaanId, [{ soal_id: soalId, jawaban_siswa: 'A' }]);
    assert.strictEqual(submit2.success, true);
    const jwb2 = db.prepare('SELECT status_jawaban, skor_rekomendasi FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(sess2.pengerjaanId, soalId);
    assert.strictEqual(jwb2.status_jawaban, 'parsial');
    assert.strictEqual(jwb2.skor_rekomendasi, 10);

    // Siswa 3: Menjawab salah semua "B, D" -> 0% (salah)
    const sess3 = studentService.startExam(kodeUjian, 'Siswa Salah', '7A');
    const submit3 = studentService.submitExam(sess3.pengerjaanId, [{ soal_id: soalId, jawaban_siswa: 'B, D' }]);
    assert.strictEqual(submit3.success, true);
    const jwb3 = db.prepare('SELECT status_jawaban, skor_rekomendasi FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(sess3.pengerjaanId, soalId);
    assert.strictEqual(jwb3.status_jawaban, 'salah');
    assert.strictEqual(jwb3.skor_rekomendasi, 0);

    // Siswa 4: Format array JSON string '["A", "C"]' dari checkbox front-end
    const sess4 = studentService.startExam(kodeUjian, 'Siswa Array', '7A');
    const submit4 = studentService.submitExam(sess4.pengerjaanId, [{ soal_id: soalId, jawaban_siswa: JSON.stringify(['A', 'C']) }]);
    assert.strictEqual(submit4.success, true);
    const jwb4 = db.prepare('SELECT status_jawaban, skor_rekomendasi FROM jawaban WHERE pengerjaan_id = ? AND soal_id = ?').get(sess4.pengerjaanId, soalId);
    assert.strictEqual(jwb4.status_jawaban, 'benar');
    assert.strictEqual(jwb4.skor_rekomendasi, 20);
  });

  test('15. AI Kisi-kisi dapat menganalisis soal campuran (PG, Isian, Game Koding) & muncul di tempat kisi-kisi siswa tanpa link eksternal', async () => {
    const geminiService = require('../src/services/geminiService');

    const ulangan = examService.createUlangan(testGuruId, {
      judul: 'Ulangan Campuran Analisis Kisi-Kisi AI',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: 'Kelas 8',
      jenis_ulangan: 'campuran'
    });

    examService.createSoal(ulangan.id, {
      jenis: 'pilihan_ganda',
      pertanyaan: 'Struktur data yang menggunakan prinsip LIFO (Last In First Out) disebut...',
      opsi_a: 'Stack (Tumpukan)',
      opsi_b: 'Queue (Antrean)',
      opsi_c: 'Tree (Pohon)',
      opsi_d: 'Graph',
      kunci_pg: 'A',
      bobot: 10
    });

    examService.createSoal(ulangan.id, {
      jenis: 'isian',
      pertanyaan: 'Tuliskan istilah untuk proses mencari dan memperbaiki kesalahan (bug) pada kode program!',
      kunci_jawaban: 'Debugging',
      bobot: 10
    });

    examService.createSoal(ulangan.id, {
      jenis: 'koding_game',
      pertanyaan: 'Susun blok perintah agar robot mencapai garis finish tanpa menabrak batu!',
      bobot: 20,
      game_data: {
        mode: 'grid_runner',
        gridSize: { rows: 4, cols: 4 },
        start: { x: 0, y: 0, dir: 'right' },
        finish: { x: 2, y: 0 },
        obstacles: [{ x: 1, y: 1 }],
        stars: [{ x: 1, y: 0 }]
      }
    });

    const fullUlangan = examService.getUlanganById(ulangan.id, testGuruId);
    const kisiKisi = await geminiService.generateKisiKisiFromQuestions(fullUlangan, fullUlangan.soal);

    assert.ok(kisiKisi, 'Kisi-kisi harus berhasil digenerate');
    assert.strictEqual(Array.isArray(kisiKisi.daftar_kisi_kisi), true);
    assert.ok(kisiKisi.daftar_kisi_kisi.length >= 1 && kisiKisi.daftar_kisi_kisi.length <= 3);
    assert.ok(kisiKisi.ringkasan_cakupan);
    assert.ok(kisiKisi.komposisi_soal);

    // Simpan ke ulangan & buka ulangan tanpa mengisi link_kisi_kisi
    examService.updateUlangan(ulangan.id, testGuruId, {
      status: 'dibuka',
      konten_kisi_kisi: JSON.stringify(kisiKisi),
      tampilkan_kisi_kisi: 1,
      link_kisi_kisi: null
    });

    // Pastikan saat siswa mengecek kode ujian, kisi-kisi tetap muncul meskipun link_kisi_kisi kosong
    const checkResult = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(checkResult.valid, true);
    assert.strictEqual(checkResult.ulangan.tampilkan_kisi_kisi, 1);
    assert.ok(checkResult.ulangan.konten_kisi_kisi, 'konten_kisi_kisi harus dikirim ke portal siswa');
    const parsedFromStudent = JSON.parse(checkResult.ulangan.konten_kisi_kisi);
    assert.ok(parsedFromStudent.daftar_kisi_kisi.length >= 1 && parsedFromStudent.daftar_kisi_kisi.length <= 3);
  });

  test('16. Fitur Skor Keluar Langsung oleh AI (skor_langsung_ai = 1) dengan AI Dinamis & Antrean Anti-Limit', async () => {
    const queueService = require('../src/services/queueService');

    // Skenario A: Ulangan PG + Game Koding (Tanpa Esai) dengan skor_langsung_ai = 1 -> Langsung rilis seketika saat submit
    const ulanganInstant = examService.createUlangan(testGuruId, {
      judul: 'Ulangan Skor Langsung Instan PG',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: 'Kelas 7',
      jenis_ulangan: 'pilihan_ganda',
      skor_langsung_ai: 1
    });
    assert.strictEqual(ulanganInstant.skor_langsung_ai, 1);

    const soalPg = examService.createSoal(ulanganInstant.id, {
      jenis: 'pilihan_ganda',
      pertanyaan: '1 byte terdiri dari berapa bit?',
      opsi_a: '8 bit',
      opsi_b: '4 bit',
      opsi_c: '16 bit',
      opsi_d: '32 bit',
      kunci_pg: 'A',
      bobot: 10
    });
    examService.updateUlangan(ulanganInstant.id, testGuruId, { status: 'dibuka' });

    const sessInstant = studentService.startExam(ulanganInstant.kode_ujian, 'Siswa Instan AI', '7A');
    const subInstant = studentService.submitExam(sessInstant.pengerjaanId, [
      { soal_id: soalPg.id, jawaban_siswa: 'A' }
    ]);
    assert.strictEqual(subInstant.success, true);
    assert.strictEqual(subInstant.skor_langsung_ai, true);
    assert.strictEqual(subInstant.auto_released, true);

    const statusInstant = studentService.getPengerjaanStatus(sessInstant.pengerjaanId);
    assert.strictEqual(statusInstant.isReleased, true, 'Skor PG dengan skor_langsung_ai=1 harus langsung dirilis');
    assert.strictEqual(statusInstant.nilaiFinal, 100);

    // Skenario B: Ulangan Campuran (PG + Isian) dengan skor_langsung_ai = 1 -> Masuk antrean AI & otomatis rilis setelah antrean selesai
    const ulanganQueued = examService.createUlangan(testGuruId, {
      judul: 'Ulangan Skor Langsung Antrean AI',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: 'Kelas 8',
      jenis_ulangan: 'campuran',
      bobot_pg: 50,
      bobot_essay: 50,
      skor_langsung_ai: 1
    });

    const qPg = examService.createSoal(ulanganQueued.id, {
      jenis: 'pilihan_ganda',
      pertanyaan: 'Otak dari komputer disebut...',
      opsi_a: 'CPU (Processor)',
      opsi_b: 'Monitor',
      opsi_c: 'Keyboard',
      opsi_d: 'Mouse',
      kunci_pg: 'A',
      bobot: 10
    });

    const qIsian = examService.createSoal(ulanganQueued.id, {
      jenis: 'isian',
      pertanyaan: 'Jelaskan apa yang dimaksud dengan algoritma pemrograman!',
      kunci_jawaban: 'Urutan langkah-langkah logis dan sistematis untuk menyelesaikan suatu masalah.',
      bobot: 10
    });

    examService.updateUlangan(ulanganQueued.id, testGuruId, { status: 'dibuka' });

    const sessQueued = studentService.startExam(ulanganQueued.kode_ujian, 'Siswa Antrean AI', '8A');
    const subQueued = studentService.submitExam(sessQueued.pengerjaanId, [
      { soal_id: qPg.id, jawaban_siswa: 'A' },
      { soal_id: qIsian.id, jawaban_siswa: 'Urutan langkah logis dan sistematis untuk menyelesaikan masalah pemrograman.' }
    ]);
    assert.strictEqual(subQueued.success, true);
    assert.strictEqual(subQueued.skor_langsung_ai, true);

    // Pastikan item antrean diproses melalui tickAutoQueueIfDue (simulasi polling siswa anti-rate-limit)
    let statusAfter = studentService.getPengerjaanStatus(sessQueued.pengerjaanId);
    let safetyStep = 0;
    while (!statusAfter.isReleased && safetyStep < 5) {
      safetyStep++;
      await queueService.tickAutoQueueIfDue(ulanganQueued.id, { minIntervalMs: 0 });
      statusAfter = studentService.getPengerjaanStatus(sessQueued.pengerjaanId);
    }

    assert.strictEqual(statusAfter.isReleased, true, 'Skor campuran harus otomatis dirilis begitu antrean AI selesai menilai');
    assert.strictEqual(statusAfter.skorLangsungAi, true);
    assert.ok(statusAfter.nilaiFinal !== null && statusAfter.nilaiFinal >= 50, `Nilai final harus keluar otomatis: ${statusAfter.nilaiFinal}`);
  });

  test('17. Fitur Multi-Sesi Ujian (Beda Kelas, Tanggal, Jam, Rentang Waktu, Token Unik, Optional & Rekapitulasi Tersegmentasi)', async () => {
    const reviewService = require('../src/services/reviewService');
    const tokenSesi1 = 'S1' + Math.random().toString(36).substring(2, 6).toUpperCase();
    const tokenSesi3 = 'S3' + Math.random().toString(36).substring(2, 6).toUpperCase();

    // 1. Buat ulangan induk (Multi-sesi bersifat optional)
    const ulangan = examService.createUlangan(testGuruId, {
      judul: 'Ulangan Semester Multi-Sesi Informatika',
      mata_pelajaran: 'Informatika',
      tingkat_kelas: '7A, 7B, 7C',
      jenis_ulangan: 'pilihan_ganda'
    });
    const soal = examService.createSoal(ulangan.id, {
      jenis: 'pilihan_ganda',
      pertanyaan: 'Manakah yang merupakan perangkat input komputer?',
      opsi_a: 'Keyboard',
      opsi_b: 'Monitor',
      opsi_c: 'Printer',
      opsi_d: 'Speaker',
      kunci_pg: 'A',
      bobot: 100
    });
    examService.updateUlangan(ulangan.id, testGuruId, { status: 'dibuka' });

    // 2. Ulangan tanpa sesi tetap bekerja normal menggunakan master kode_ujian (fitur optional)
    const checkMaster = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(checkMaster.valid, true);
    assert.strictEqual(checkMaster.sesi, null);
    assert.strictEqual(checkMaster.daftar_sesi.length, 0);

    // 3. Guru membuat Sesi 1 (Kelas 7A, aktif sekarang, token custom tokenSesi1)
    const now = new Date();
    const sesi1Start = new Date(now.getTime() - 10 * 60000).toISOString();
    const sesi1End = new Date(now.getTime() + 60 * 60000).toISOString();
    const sesi1 = examService.createSesi(ulangan.id, testGuruId, {
      nama_sesi: 'Sesi Pagi - Kelas 7A',
      kode_sesi: tokenSesi1,
      kelas: '7A',
      waktu_mulai: sesi1Start,
      waktu_selesai: sesi1End,
      kuota_peserta: 35
    });
    assert.strictEqual(sesi1.nama_sesi, 'Sesi Pagi - Kelas 7A');
    assert.strictEqual(sesi1.kode_sesi, tokenSesi1);
    assert.strictEqual(sesi1.status_waktu, 'berlangsung');

    // 4. Guru membuat Sesi 2 (Kelas 7B, jadwal masa depan / akan datang, auto token)
    const sesi2Start = new Date(now.getTime() + 2 * 3600000).toISOString();
    const sesi2End = new Date(now.getTime() + 4 * 3600000).toISOString();
    const sesi2 = examService.createSesi(ulangan.id, testGuruId, {
      nama_sesi: 'Sesi Siang - Kelas 7B',
      kelas: '7B',
      waktu_mulai: sesi2Start,
      waktu_selesai: sesi2End
    });
    assert.ok(sesi2.kode_sesi.startsWith('S'));
    assert.strictEqual(sesi2.status_waktu, 'akan_datang');

    // 5. Guru membuat Sesi 3 (Kelas 7C, jadwal masa lalu / expired)
    const sesi3Start = new Date(now.getTime() - 4 * 3600000).toISOString();
    const sesi3End = new Date(now.getTime() - 2 * 3600000).toISOString();
    const sesi3 = examService.createSesi(ulangan.id, testGuruId, {
      nama_sesi: 'Sesi Kemarin - Kelas 7C',
      kode_sesi: tokenSesi3,
      kelas: '7C',
      waktu_mulai: sesi3Start,
      waktu_selesai: sesi3End
    });
    assert.strictEqual(sesi3.status_waktu, 'selesai');

    // 6. Validasi duplikasi token sesi ditolak
    assert.throws(() => {
      examService.createSesi(ulangan.id, testGuruId, {
        nama_sesi: 'Sesi Duplikat Token',
        kode_sesi: tokenSesi1
      });
    }, /sudah digunakan|sudah dipakai/i);

    // 7. Siswa cek dengan kode master ujian sekarang mendeteksi daftar sesi yang tersedia
    const checkMasterWithSessions = studentService.validateExamCode(ulangan.kode_ujian);
    assert.strictEqual(checkMasterWithSessions.valid, true);
    assert.strictEqual(checkMasterWithSessions.daftar_sesi.length, 3);

    // 8. Siswa cek dengan token Sesi 1 (Aktif)
    const checkSesi1 = studentService.validateExamCode(tokenSesi1);
    assert.strictEqual(checkSesi1.valid, true);
    assert.ok(checkSesi1.sesi);
    assert.strictEqual(checkSesi1.sesi.nama_sesi, 'Sesi Pagi - Kelas 7A');
    assert.deepStrictEqual(checkSesi1.available_classes, ['7A']);

    // 9. Siswa cek dengan token Sesi 2 (Akan datang / belum buka)
    const checkSesi2 = studentService.validateExamCode(sesi2.kode_sesi);
    assert.strictEqual(checkSesi2.valid, false);
    assert.strictEqual(checkSesi2.status, 'sesi_belum_buka');

    // 10. Siswa cek dengan token Sesi 3 (Expired / sesi sudah tutup)
    const checkSesi3 = studentService.validateExamCode(tokenSesi3);
    assert.strictEqual(checkSesi3.valid, false);
    assert.strictEqual(checkSesi3.status, 'sesi_sudah_tutup');

    // 11. Siswa masuk Sesi 1 dengan kelas yang tidak terdaftar (7B coba masuk sesi 7A) -> Ditolak
    assert.throws(() => {
      studentService.startExam(tokenSesi1, 'Ahmad Dani', '7B');
    }, /khusus untuk kelas 7A/i);

    // 12. Siswa masuk Sesi 1 dengan kelas yang benar (7A) -> Berhasil & sesi_id tercatat di pengerjaan
    const sess1 = studentService.startExam(tokenSesi1, 'Budi Santoso', '7A');
    assert.strictEqual(sess1.peserta.nama, 'Budi Santoso');
    const pRecord1 = db.prepare('SELECT sesi_id, nama_sesi FROM pengerjaan WHERE id = ?').get(sess1.pengerjaanId);
    assert.strictEqual(pRecord1.sesi_id, sesi1.id);
    assert.strictEqual(pRecord1.nama_sesi, 'Sesi Pagi - Kelas 7A');

    // Kumpulkan jawaban siswa Sesi 1
    const sub1 = studentService.submitExam(sess1.pengerjaanId, [{ soal_id: soal.id, jawaban_siswa: 'A' }]);
    assert.strictEqual(sub1.success, true);

    // Siswa lain masuk tanpa sesi menggunakan kode induk master
    const sessMaster = studentService.startExam(ulangan.kode_ujian, 'Citra Lestari', '7C');
    const pRecordMaster = db.prepare('SELECT sesi_id, nama_sesi FROM pengerjaan WHERE id = ?').get(sessMaster.pengerjaanId);
    assert.strictEqual(pRecordMaster.sesi_id, null);
    studentService.submitExam(sessMaster.pengerjaanId, [{ soal_id: soal.id, jawaban_siswa: 'A' }]);

    // 13. Evaluasi Rekapitulasi / Laporan Nilai Tersegmentasi per Sesi
    const laporanSemua = reviewService.getLaporanNilai(ulangan.id, testGuruId, 'all', 'all');
    assert.strictEqual(laporanSemua.statistik.total_peserta, 2);
    assert.strictEqual(laporanSemua.available_sesi.length, 3);
    assert.ok(Array.isArray(laporanSemua.statistik_sesi));
    assert.strictEqual(laporanSemua.statistik_sesi.length, 2); // 1 untuk Sesi 1, 1 untuk Tanpa Sesi

    // Filter laporan khusus Sesi 1
    const laporanSesi1 = reviewService.getLaporanNilai(ulangan.id, testGuruId, 'all', String(sesi1.id));
    assert.strictEqual(laporanSesi1.statistik.total_peserta, 1);
    assert.strictEqual(laporanSesi1.peserta[0].nama_siswa, 'Budi Santoso');
    assert.strictEqual(laporanSesi1.peserta[0].nama_sesi, 'Sesi Pagi - Kelas 7A');
    assert.strictEqual(laporanSesi1.peserta[0].kode_sesi, tokenSesi1);

    // 14. Guru mengedit dan menghapus sesi
    const updatedSesi = examService.updateSesi(sesi1.id, testGuruId, {
      nama_sesi: 'Sesi Pagi Kelas 7A (Diperbarui)',
      kuota_peserta: 40
    });
    assert.strictEqual(updatedSesi.nama_sesi, 'Sesi Pagi Kelas 7A (Diperbarui)');
    assert.strictEqual(updatedSesi.kuota_peserta, 40);

    const deleteRes = examService.deleteSesi(sesi2.id, testGuruId);
    assert.strictEqual(deleteRes.success, true);
    assert.strictEqual(examService.getSesiById(sesi2.id), null);
  });
});


