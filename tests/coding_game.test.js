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
    assert.strictEqual(presetJson.presets.length >= 5, true);
  });
});
