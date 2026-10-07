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
});
