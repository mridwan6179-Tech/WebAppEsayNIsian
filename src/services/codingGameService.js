const geminiService = require('./geminiService');

/**
 * Service untuk Evaluasi, Simulasi, dan Pembuatan Game Koding Berpikir Komputasional (Tingkat SMP)
 * Mendukung 5 Mode Permainan:
 * 1. grid_runner: Algoritma sekuensial dasar (maju, belok, bintang, finish)
 * 2. loop_master: Pattern recognition & looping (par limit balok ketat)
 * 3. if_else: Percabangan kondisi & sensor gerbang
 * 4. bug_doctor: Debugging kode rusak (perbaiki blok yang salah)
 * 5. scratch_puzzle: Event-Driven matching (Kejadian -> Aksi)
 */

class CodingGameService {
  /**
   * Template preset bawaan untuk 5 mode dasar koding SMP
   */
  getPresets() {
    return [
      {
        id: 'preset-grid-runner-1',
        mode: 'grid_runner',
        title: 'Langkah Pertama Robot',
        description: 'Bantu robot mengumpulkan bintang ⭐ dan mencapai gerbang finish 🏁!',
        gridSize: { rows: 5, cols: 5 },
        start: { x: 0, y: 0, dir: 'right' },
        finish: { x: 4, y: 4 },
        obstacles: [
          { x: 1, y: 1, type: 'wall' },
          { x: 2, y: 1, type: 'wall' },
          { x: 2, y: 3, type: 'rock' }
        ],
        stars: [
          { x: 2, y: 0 },
          { x: 4, y: 2 }
        ],
        allowedBlocks: ['move', 'turn_left', 'turn_right', 'collect'],
        initialBlocks: [],
        parBlocks: 10,
        difficulty: 'mudah'
      },
      {
        id: 'preset-loop-master-1',
        mode: 'loop_master',
        title: 'Tangga Berulang (Loop Master)',
        description: 'Jalur ini memiliki pola berulang! Gunakan balok Ulangi agar hemat balok.',
        gridSize: { rows: 6, cols: 6 },
        start: { x: 0, y: 0, dir: 'right' },
        finish: { x: 5, y: 5 },
        obstacles: [
          { x: 0, y: 1, type: 'wall' },
          { x: 1, y: 2, type: 'wall' },
          { x: 2, y: 3, type: 'wall' },
          { x: 3, y: 4, type: 'wall' }
        ],
        stars: [
          { x: 1, y: 1 },
          { x: 3, y: 3 }
        ],
        allowedBlocks: ['move', 'turn_left', 'turn_right', 'collect', 'repeat'],
        initialBlocks: [],
        parBlocks: 6,
        difficulty: 'sedang'
      },
      {
        id: 'preset-bug-doctor-1',
        mode: 'bug_doctor',
        title: 'Dokter Kode: Perbaiki Jalur Rusak',
        description: 'Robot ini menabrak tembok di langkah ke-3! Temukan dan ganti balok yang salah agar robot selamat.',
        gridSize: { rows: 5, cols: 5 },
        start: { x: 0, y: 2, dir: 'right' },
        finish: { x: 4, y: 2 },
        obstacles: [
          { x: 2, y: 1, type: 'wall' },
          { x: 2, y: 3, type: 'wall' },
          { x: 2, y: 2, type: 'rock' } // rintangan di tengah
        ],
        stars: [
          { x: 2, y: 0 },
          { x: 4, y: 0 }
        ],
        allowedBlocks: ['move', 'turn_left', 'turn_right', 'collect'],
        initialBlocks: [
          { type: 'move' },
          { type: 'turn_right' }, // SALAH: belok kanan nabrak dinding, harusnya turn_left
          { type: 'move' },
          { type: 'move' }
        ],
        parBlocks: 8,
        difficulty: 'sedang'
      },
      {
        id: 'preset-if-else-1',
        mode: 'if_else',
        title: 'Gerbang Sensor Cerdas (If-Else)',
        description: 'Gunakan sensor untuk memeriksa rintangan di depan robot sebelum melangkah.',
        gridSize: { rows: 6, cols: 6 },
        start: { x: 0, y: 2, dir: 'right' },
        finish: { x: 5, y: 2 },
        obstacles: [
          { x: 2, y: 2, type: 'wall' }
        ],
        stars: [
          { x: 2, y: 1 },
          { x: 4, y: 2 }
        ],
        allowedBlocks: ['move', 'turn_left', 'turn_right', 'collect', 'if_obstacle'],
        initialBlocks: [],
        parBlocks: 8,
        difficulty: 'menantang'
      },
      {
        id: 'preset-scratch-puzzle-1',
        mode: 'scratch_puzzle',
        title: 'Logika Game Mini (Sebab & Akibat)',
        description: 'Pasangkan setiap Pemicu Kejadian (Event) dengan Aksi yang paling tepat!',
        pairs: [
          { id: 'p1', event: 'Saat Tombol Spasi Ditekan', action: 'Karakter Melompat' },
          { id: 'p2', event: 'Saat Robot Menyentuh Bintang', action: 'Tambah Skor +10' },
          { id: 'p3', event: 'Saat Robot Menabrak Lava / Duri', action: 'Kurangi Nyawa 1' },
          { id: 'p4', event: 'Saat Bendera Hijau Diklik', action: 'Mulai Game & Reset Posisi' }
        ],
        distractors: ['Ubah Kostum Jadi Hantu', 'Matikan Komputer'],
        difficulty: 'mudah'
      }
    ];
  }

  /**
   * Menghitung total jumlah balok efektif (termasuk isi loop)
   */
  countBlocks(blocks) {
    if (!Array.isArray(blocks)) return 0;
    let count = 0;
    for (const b of blocks) {
      count++;
      if (b && b.type === 'repeat' && Array.isArray(b.blocks)) {
        count += this.countBlocks(b.blocks);
      }
      if (b && (b.type === 'if' || b.type === 'if_obstacle')) {
        if (Array.isArray(b.thenBlocks)) count += this.countBlocks(b.thenBlocks);
        if (Array.isArray(b.elseBlocks)) count += this.countBlocks(b.elseBlocks);
      }
    }
    return count;
  }

  /**
   * Eksekusi simulasi grid langkah demi langkah (0-Token Deterministic Simulation)
   */
  simulateGridExecution(levelData, blocks) {
    const rows = levelData.gridSize?.rows || 5;
    const cols = levelData.gridSize?.cols || 5;
    let x = levelData.start?.x ?? 0;
    let y = levelData.start?.y ?? 0;
    let dir = levelData.start?.dir || 'right'; // 'up', 'right', 'down', 'left'

    const finishX = levelData.finish?.x ?? (cols - 1);
    const finishY = levelData.finish?.y ?? (rows - 1);

    const obstacles = new Set(
      (levelData.obstacles || []).map(o => `${o.x},${o.y}`)
    );

    const remainingStars = new Set(
      (levelData.stars || []).map(s => `${s.x},${s.y}`)
    );
    const totalStars = remainingStars.size;
    let collectedStars = 0;

    const dirOffsets = {
      up: { dx: 0, dy: -1 },
      right: { dx: 1, dy: 0 },
      down: { dx: 0, dy: 1 },
      left: { dx: -1, dy: 0 }
    };

    const turnClockwise = { up: 'right', right: 'down', down: 'left', left: 'up' };
    const turnCounter = { up: 'left', left: 'down', down: 'right', right: 'up' };

    const logs = [];
    let hitObstacle = false;
    let obstacleReason = null;
    let totalStepsExecuted = 0;
    const MAX_STEPS = 200; // Safeguard loop tak terbatas

    const isObstacleAhead = (cx, cy, cdir) => {
      const off = dirOffsets[cdir];
      const nx = cx + off.dx;
      const ny = cy + off.dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return true;
      return obstacles.has(`${nx},${ny}`);
    };

    const runList = (subBlocks) => {
      if (!Array.isArray(subBlocks)) return;
      for (const block of subBlocks) {
        if (hitObstacle || totalStepsExecuted >= MAX_STEPS) break;
        totalStepsExecuted++;

        const type = block?.type || block;

        if (type === 'move') {
          const off = dirOffsets[dir];
          const nextX = x + off.dx;
          const nextY = y + off.dy;

          if (nextX < 0 || nextX >= cols || nextY < 0 || nextY >= rows) {
            hitObstacle = true;
            obstacleReason = 'Robot menabrak batas arena/dinding!';
            logs.push({ step: totalStepsExecuted, action: 'crash_boundary', x, y, dir, reason: obstacleReason });
            break;
          }

          if (obstacles.has(`${nextX},${nextY}`)) {
            hitObstacle = true;
            obstacleReason = 'Robot menabrak rintangan tembok/batu!';
            logs.push({ step: totalStepsExecuted, action: 'crash_obstacle', x: nextX, y: nextY, dir, reason: obstacleReason });
            break;
          }

          x = nextX;
          y = nextY;
          logs.push({ step: totalStepsExecuted, action: 'move', x, y, dir });

          // Auto-collect jika ada bintang di petak dan balok collect otomatis/opsional
          if (remainingStars.has(`${x},${y}`)) {
            remainingStars.delete(`${x},${y}`);
            collectedStars++;
            logs.push({ step: totalStepsExecuted, action: 'collect_star', x, y, dir, starsCount: collectedStars });
          }

          if (x === finishX && y === finishY) {
            logs.push({ step: totalStepsExecuted, action: 'reached_finish', x, y, dir });
          }
        } else if (type === 'turn_right') {
          dir = turnClockwise[dir];
          logs.push({ step: totalStepsExecuted, action: 'turn_right', x, y, dir });
        } else if (type === 'turn_left') {
          dir = turnCounter[dir];
          logs.push({ step: totalStepsExecuted, action: 'turn_left', x, y, dir });
        } else if (type === 'collect') {
          if (remainingStars.has(`${x},${y}`)) {
            remainingStars.delete(`${x},${y}`);
            collectedStars++;
            logs.push({ step: totalStepsExecuted, action: 'collect_star', x, y, dir, starsCount: collectedStars });
          }
        } else if (type === 'repeat') {
          const count = Math.min(20, Math.max(1, Number(block.count) || 2));
          for (let iter = 0; iter < count; iter++) {
            if (hitObstacle || totalStepsExecuted >= MAX_STEPS) break;
            runList(block.blocks);
          }
        } else if (type === 'if' || type === 'if_obstacle') {
          const obstacleAhead = isObstacleAhead(x, y, dir);
          if (obstacleAhead) {
            if (Array.isArray(block.thenBlocks) && block.thenBlocks.length > 0) {
              runList(block.thenBlocks);
            }
          } else {
            if (Array.isArray(block.elseBlocks) && block.elseBlocks.length > 0) {
              runList(block.elseBlocks);
            }
          }
        }
      }
    };

    runList(blocks);

    const isFinished = !hitObstacle && (x === finishX && y === finishY);
    const starRatio = totalStars > 0 ? (collectedStars / totalStars) : 1;
    const blockCount = this.countBlocks(blocks);
    const parLimit = Number(levelData.parBlocks) || 8;

    // Evaluasi Bintang 1-3
    let starsEarned = 0;
    if (isFinished) {
      starsEarned = 1; // ⭐ Finish
      if (starRatio >= 1) {
        starsEarned = 2; // ⭐⭐ Finish + Semua Bintang
        if (blockCount <= parLimit) {
          starsEarned = 3; // ⭐⭐⭐ Finish + Semua Bintang + Efisien (<= Par)
        }
      }
    }

    // Skor 0-100
    let score = 0;
    if (isFinished) {
      score += 50; // Dasar finish
      score += Math.round(starRatio * 30); // Bintang (max 30)
      if (blockCount <= parLimit) {
        score += 20; // Efisiensi penuh (20)
      } else {
        const penalty = Math.min(15, (blockCount - parLimit) * 3);
        score += Math.max(5, 20 - penalty);
      }
    } else {
      // Gagal finish: beri poin parsial bintang & langkah aman
      score = Math.min(40, Math.round(starRatio * 30) + (hitObstacle ? 5 : 10));
    }

    return {
      mode: levelData.mode || 'grid_runner',
      isFinished,
      hitObstacle,
      obstacleReason,
      finalPos: { x, y, dir },
      totalStars,
      collectedStars,
      starsEarned,
      blockCount,
      parLimit,
      score: Math.min(100, Math.max(0, score)),
      stepsExecuted: totalStepsExecuted,
      logs
    };
  }

  /**
   * Evaluasi Mode Scratch Puzzle (Matching Event -> Action)
   */
  evaluateScratchPuzzle(levelData, studentPairs) {
    const correctPairs = levelData.pairs || [];
    if (correctPairs.length === 0) {
      return { score: 100, starsEarned: 3, isFinished: true, correctCount: 0, total: 0 };
    }

    const pairMap = new Map();
    correctPairs.forEach(p => {
      pairMap.set(String(p.event || p.id).trim().toLowerCase(), String(p.action).trim().toLowerCase());
    });

    let correctCount = 0;
    const feedback = [];

    if (Array.isArray(studentPairs)) {
      for (const sp of studentPairs) {
        const evKey = String(sp.event || sp.id || '').trim().toLowerCase();
        const expectedAct = pairMap.get(evKey);
        const actualAct = String(sp.action || '').trim().toLowerCase();

        const match = expectedAct && (expectedAct === actualAct);
        if (match) correctCount++;
        feedback.push({
          event: sp.event,
          action: sp.action,
          isCorrect: Boolean(match)
        });
      }
    }

    const ratio = correctCount / correctPairs.length;
    const score = Math.round(ratio * 100);
    const starsEarned = ratio === 1 ? 3 : (ratio >= 0.5 ? 2 : (ratio > 0 ? 1 : 0));

    return {
      mode: 'scratch_puzzle',
      isFinished: ratio === 1,
      correctCount,
      total: correctPairs.length,
      starsEarned,
      score,
      feedback
    };
  }

  /**
   * Evaluasi solusi siswa secara serbaguna
   */
  evaluateSolution(gameDataRaw, studentSubmission) {
    let levelData = gameDataRaw;
    if (typeof levelData === 'string') {
      try {
        levelData = JSON.parse(levelData);
      } catch (e) {
        levelData = {};
      }
    }

    let submission = studentSubmission;
    if (typeof submission === 'string') {
      try {
        submission = JSON.parse(submission);
      } catch (e) {
        submission = [];
      }
    }

    if (levelData.mode === 'scratch_puzzle') {
      const studentPairs = Array.isArray(submission) ? submission : (submission?.pairs || []);
      return this.evaluateScratchPuzzle(levelData, studentPairs);
    }

    // Grid modes: grid_runner, loop_master, if_else, bug_doctor
    const blocks = Array.isArray(submission) ? submission : (submission?.blocks || []);
    return this.simulateGridExecution(levelData, blocks);
  }

  /**
   * Generate Level Permainan Koding Baru dengan Gemini AI
   */
  async generateLevelAI(topic, difficulty = 'sedang', mode = 'grid_runner') {
    const prompt = `Anda adalah seorang desainer kurikulum game edukasi berpikir komputasional tingkat SMP (Sekolah Menengah Pertama, usia 12-15 tahun).
Rancanglah 1 buah level permainan pemahaman koding interaktif berdasarkan topik: "${topic || 'Algoritma dan Berpikir Komputasional'}".
Tingkat kesulitan: "${difficulty}".
Mode permainan: "${mode}".

Pilihan mode permainan yang harus dipatuhi:
- "grid_runner": Arena grid robot mencari jalan ke finish menghindari rintangan dan mengambil bintang.
- "loop_master": Arena grid dengan pola gerakan berulang bertingkat, batas balok (parBlocks) ketat agar siswa harus menggunakan balok "repeat" (Ulangi).
- "if_else": Arena dengan rintangan/sensor di depan jalur di mana robot harus memakai balok "if_obstacle" untuk belok menghindar.
- "bug_doctor": Arena dengan "initialBlocks" yang sengaja dibuat SALAH (ada 1 balok yang membuat robot menabrak), dan siswa harus memperbaikinya.
- "scratch_puzzle": Pasangan 3-4 pemicu (event) dengan aksi (action) logika game sederhana.

Wajib kembalikan format HANYA JSON murni tanpa markdown/penjelasan dengan struktur:
Jika mode grid (grid_runner, loop_master, if_else, bug_doctor):
{
  "mode": "${mode}",
  "title": "Judul tantangan yang menarik untuk anak SMP",
  "description": "Petunjuk pengerjaan ramah anak",
  "gridSize": { "rows": 5, "cols": 5 },
  "start": { "x": 0, "y": 0, "dir": "right" },
  "finish": { "x": 4, "y": 4 },
  "obstacles": [ { "x": 1, "y": 1, "type": "wall" }, { "x": 2, "y": 3, "type": "rock" } ],
  "stars": [ { "x": 2, "y": 0 }, { "x": 4, "y": 2 } ],
  "allowedBlocks": ["move", "turn_left", "turn_right", "collect", "repeat", "if_obstacle"],
  "initialBlocks": [],
  "parBlocks": 8,
  "difficulty": "${difficulty}"
}

Jika mode "scratch_puzzle":
{
  "mode": "scratch_puzzle",
  "title": "Judul tantangan",
  "description": "Petunjuk",
  "pairs": [
    { "id": "p1", "event": "Saat Tombol Spasi Ditekan", "action": "Karakter Melompat" },
    { "id": "p2", "event": "Saat Menyentuh Apel", "action": "Tambah Skor +10" },
    { "id": "p3", "event": "Saat Menyentuh Duri", "action": "Kurangi Nyawa 1" }
  ],
  "distractors": ["Tembak Laser"],
  "difficulty": "${difficulty}"
}`;

    const rawJson = await geminiService.callJsonPrompt(prompt, 'gemini-3.5-flash-lite');
    let parsed;
    try {
      parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
    } catch (e) {
      // Fallback ke preset terdekat jika json error
      const presets = this.getPresets();
      parsed = presets.find(p => p.mode === mode) || presets[0];
    }

    if (!parsed.mode) parsed.mode = mode;
    if (!parsed.title) parsed.title = `Tantangan Koding: ${topic}`;
    return parsed;
  }
}

module.exports = new CodingGameService();
