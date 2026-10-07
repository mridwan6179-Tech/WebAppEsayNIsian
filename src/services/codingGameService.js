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
   * Template preset bawaan untuk ragam mode dan tema visual game koding SMP
   */
  getPresets() {
    return [
      {
        id: 'preset-grid-runner-1',
        key: 'preset-grid-runner-1',
        mode: 'grid_runner',
        subtipe: 'grid_robot',
        title: 'Langkah Pertama Robot Antariksa',
        nama: 'Langkah Pertama Robot Antariksa',
        description: 'Bantu robot mengumpulkan bintang ⭐ dan mencapai gerbang warp 🏁!',
        deskripsi: 'Bantu robot mengumpulkan bintang ⭐ dan mencapai gerbang warp 🏁!',
        pertanyaan: 'Susunlah balok algoritma agar Robot Antariksa dapat mengumpulkan semua bintang energi ⭐ dan tiba di gerbang finish 🏁 dengan selamat tanpa menabrak rintangan generator laser!',
        theme: 'space',
        gridSize: { rows: 5, cols: 5 },
        grid_width: 5,
        grid_height: 5,
        start: { x: 0, y: 4, dir: 'right' },
        start_pos: { x: 0, y: 4 },
        start_dir: 'E',
        finish: { x: 4, y: 0 },
        finish_pos: { x: 4, y: 0 },
        obstacles: [
          { x: 1, y: 2, type: 'wall' },
          { x: 2, y: 2, type: 'wall' },
          { x: 3, y: 2, type: 'wall' }
        ],
        grid: [
          ['', '', '', '', ''],
          ['', '', '', '', ''],
          ['', 'wall', 'wall', 'wall', ''],
          ['', '', '', '', ''],
          ['', '', '', '', '']
        ],
        stars: [
          { x: 1, y: 3 },
          { x: 3, y: 1 }
        ],
        allowedBlocks: ['move', 'move_back', 'turn_left', 'turn_right', 'collect'],
        allowed_blocks: ['MAJU', 'MUNDUR', 'BELOK_KIRI', 'BELOK_KANAN'],
        initialBlocks: [],
        initial_blocks: [],
        parBlocks: 8,
        par_limit: 8,
        difficulty: 'mudah',
        tingkat_kesulitan: 'mudah',
        bobot: 20
      },
      {
        id: 'preset-forest-explorer-1',
        key: 'preset-forest-explorer-1',
        mode: 'grid_runner',
        subtipe: 'grid_robot',
        title: 'Penjelajah Labirin Hutan Berbatu',
        nama: 'Penjelajah Labirin Hutan Berbatu',
        description: 'Gunakan perintah Maju & Mundur untuk keluar dari celah tebing batu!',
        deskripsi: 'Gunakan perintah Maju & Mundur untuk keluar dari celah tebing batu!',
        pertanyaan: 'Di labirin hutan ini, gunakan balok MAJU, MUNDUR, dan BELOK agar Robot Penjelajah bisa mengambil kristal bintang ⭐ di ceruk sempit lalu mundur dan berbelok ke pos pengamatan 🏁!',
        theme: 'forest',
        gridSize: { rows: 5, cols: 5 },
        grid_width: 5,
        grid_height: 5,
        start: { x: 0, y: 2, dir: 'right' },
        start_pos: { x: 0, y: 2 },
        start_dir: 'E',
        finish: { x: 4, y: 2 },
        finish_pos: { x: 4, y: 2 },
        obstacles: [
          { x: 2, y: 1, type: 'wall' },
          { x: 2, y: 3, type: 'wall' },
          { x: 3, y: 1, type: 'wall' },
          { x: 3, y: 3, type: 'wall' }
        ],
        grid: [
          ['', '', '', '', ''],
          ['', '', 'wall', 'wall', ''],
          ['', '', '', '', ''],
          ['', '', 'wall', 'wall', ''],
          ['', '', '', '', '']
        ],
        stars: [
          { x: 2, y: 0 },
          { x: 2, y: 4 }
        ],
        allowedBlocks: ['move', 'move_back', 'turn_left', 'turn_right', 'collect'],
        allowed_blocks: ['MAJU', 'MUNDUR', 'BELOK_KIRI', 'BELOK_KANAN'],
        initialBlocks: [],
        initial_blocks: [],
        parBlocks: 10,
        par_limit: 10,
        difficulty: 'sedang',
        tingkat_kesulitan: 'sedang',
        bobot: 25
      },
      {
        id: 'preset-loop-master-1',
        key: 'preset-loop-master-1',
        mode: 'loop_master',
        subtipe: 'loop_master',
        title: 'Piramida Tangga Berulang (Loop Master)',
        nama: 'Piramida Tangga Berulang (Loop Master)',
        description: 'Kenali pola tangga berulang dan gunakan balok Ulangi agar efisien!',
        deskripsi: 'Kenali pola tangga berulang dan gunakan balok Ulangi agar efisien!',
        pertanyaan: 'Perhatikan pola tangga piramida ini: Maju, Belok Kiri, Maju, Belok Kanan. Gunakan balok ULANGI (Loop) agar kode kamu sangat ringkas dan tidak melebihi Par Target!',
        theme: 'pyramid',
        gridSize: { rows: 6, cols: 6 },
        grid_width: 6,
        grid_height: 6,
        start: { x: 0, y: 5, dir: 'right' },
        start_pos: { x: 0, y: 5 },
        start_dir: 'E',
        finish: { x: 5, y: 0 },
        finish_pos: { x: 5, y: 0 },
        obstacles: [
          { x: 0, y: 4, type: 'wall' },
          { x: 1, y: 3, type: 'wall' },
          { x: 2, y: 2, type: 'wall' },
          { x: 3, y: 1, type: 'wall' }
        ],
        grid: [
          ['', '', '', '', '', ''],
          ['', '', '', 'wall', '', ''],
          ['', '', 'wall', '', '', ''],
          ['', 'wall', '', '', '', ''],
          ['wall', '', '', '', '', ''],
          ['', '', '', '', '', '']
        ],
        stars: [
          { x: 1, y: 4 },
          { x: 3, y: 2 }
        ],
        allowedBlocks: ['move', 'move_back', 'turn_left', 'turn_right', 'collect', 'repeat'],
        allowed_blocks: ['MAJU', 'MUNDUR', 'BELOK_KIRI', 'BELOK_KANAN', 'ULANGI'],
        initialBlocks: [],
        initial_blocks: [],
        parBlocks: 6,
        par_limit: 6,
        difficulty: 'sedang',
        tingkat_kesulitan: 'sedang',
        bobot: 25
      },
      {
        id: 'preset-if-else-1',
        key: 'preset-if-else-1',
        mode: 'if_else',
        subtipe: 'decision_gate',
        title: 'Lembah Lava: Gerbang Sensor Percabangan',
        nama: 'Lembah Lava: Gerbang Sensor Percabangan',
        description: 'Gunakan sensor percabangan kondisi untuk menghindar jika ada kubangan lahar!',
        deskripsi: 'Gunakan sensor percabangan kondisi untuk menghindar jika ada kubangan lahar!',
        pertanyaan: 'Jalur utama dipenuhi kubangan lahar panas 🔥. Gunakan balok percabangan JIKA RINTANGAN agar robot otomatis mendeteksi bahaya dan berbelok mengambil jalan aman!',
        theme: 'volcano',
        gridSize: { rows: 6, cols: 6 },
        grid_width: 6,
        grid_height: 6,
        start: { x: 0, y: 3, dir: 'right' },
        start_pos: { x: 0, y: 3 },
        start_dir: 'E',
        finish: { x: 5, y: 3 },
        finish_pos: { x: 5, y: 3 },
        obstacles: [
          { x: 2, y: 3, type: 'wall' },
          { x: 3, y: 3, type: 'wall' }
        ],
        grid: [
          ['', '', '', '', '', ''],
          ['', '', '', '', '', ''],
          ['', '', '', '', '', ''],
          ['', '', 'wall', 'wall', '', ''],
          ['', '', '', '', '', ''],
          ['', '', '', '', '', '']
        ],
        stars: [
          { x: 2, y: 1 },
          { x: 4, y: 4 }
        ],
        allowedBlocks: ['move', 'move_back', 'turn_left', 'turn_right', 'collect', 'if_obstacle'],
        allowed_blocks: ['MAJU', 'MUNDUR', 'BELOK_KIRI', 'BELOK_KANAN', 'JIKA_RINTANGAN'],
        initialBlocks: [],
        initial_blocks: [],
        parBlocks: 8,
        par_limit: 8,
        difficulty: 'sulit',
        tingkat_kesulitan: 'sulit',
        bobot: 30
      },
      {
        id: 'preset-bug-doctor-1',
        key: 'preset-bug-doctor-1',
        mode: 'bug_doctor',
        subtipe: 'bug_doctor',
        title: 'Dokter Kode: Menyelamatkan Rover Rusak',
        nama: 'Dokter Kode: Menyelamatkan Rover Rusak',
        description: 'Kode program bawaan salah dan menabrak! Perbaiki baloknya agar berhasil.',
        deskripsi: 'Kode program bawaan salah dan menabrak! Perbaiki baloknya agar berhasil.',
        pertanyaan: 'Kode berikut memiliki kesalahan ("bug"): robot berbelok ke arah yang salah dan menabrak tebing. Temukan balok yang keliru, hapus atau ganti dengan arah yang benar!',
        theme: 'ocean',
        gridSize: { rows: 5, cols: 5 },
        grid_width: 5,
        grid_height: 5,
        start: { x: 0, y: 2, dir: 'right' },
        start_pos: { x: 0, y: 2 },
        start_dir: 'E',
        finish: { x: 4, y: 2 },
        finish_pos: { x: 4, y: 2 },
        obstacles: [
          { x: 2, y: 2, type: 'wall' },
          { x: 2, y: 3, type: 'wall' }
        ],
        grid: [
          ['', '', '', '', ''],
          ['', '', '', '', ''],
          ['', '', 'wall', '', ''],
          ['', '', 'wall', '', ''],
          ['', '', '', '', '']
        ],
        stars: [
          { x: 2, y: 0 },
          { x: 4, y: 0 }
        ],
        allowedBlocks: ['move', 'move_back', 'turn_left', 'turn_right', 'collect'],
        allowed_blocks: ['MAJU', 'MUNDUR', 'BELOK_KIRI', 'BELOK_KANAN'],
        initialBlocks: [
          { type: 'move' },
          { type: 'turn_right' },
          { type: 'move' }
        ],
        initial_blocks: [
          { type: 'MAJU' },
          { type: 'BELOK_KANAN' },
          { type: 'MAJU' }
        ],
        parBlocks: 7,
        par_limit: 7,
        difficulty: 'sedang',
        tingkat_kesulitan: 'sedang',
        bobot: 20
      },
      {
        id: 'preset-scratch-puzzle-1',
        key: 'preset-scratch-puzzle-1',
        mode: 'scratch_puzzle',
        subtipe: 'scratch_puzzle',
        title: 'Logika Scratch Mini: Mekanika Game Aksi',
        nama: 'Logika Scratch Mini: Mekanika Game Aksi',
        description: 'Pasangkan Pemicu Kejadian (Event ⚡) dengan Balok Aksi (Action ▶) yang tepat!',
        deskripsi: 'Pasangkan Pemicu Kejadian (Event ⚡) dengan Balok Aksi (Action ▶) yang tepat!',
        pertanyaan: 'Tantangan Logika Scratch Mini Game: Pasangkan setiap Pemicu Kejadian (Event) di bawah ini dengan Aksi Balok yang paling logis dan benar!',
        theme: 'scratch',
        pairs: [
          { id: 'p1', event: 'Ketika tombol Spasi ditekan', action: 'Karakter melompat ke atas' },
          { id: 'p2', event: 'Ketika robot menyentuh bintang ⭐', action: 'Skor bertambah +10 poin' },
          { id: 'p3', event: 'Ketika robot menabrak duri / lava', action: 'Kurangi nyawa karakter 1' },
          { id: 'p4', event: 'Ketika bendera hijau diklik 🚩', action: 'Mulai game & reset posisi karakter' }
        ],
        target_pairs: [
          { event: 'Ketika tombol Spasi ditekan', action: 'Karakter melompat ke atas' },
          { event: 'Ketika robot menyentuh bintang ⭐', action: 'Skor bertambah +10 poin' },
          { event: 'Ketika robot menabrak duri / lava', action: 'Kurangi nyawa karakter 1' },
          { event: 'Ketika bendera hijau diklik 🚩', action: 'Mulai game & reset posisi karakter' }
        ],
        distractors: ['Ubah kostum jadi hantu', 'Keluarkan suara meong'],
        difficulty: 'mudah',
        tingkat_kesulitan: 'mudah',
        bobot: 25
      },
      {
        id: 'preset-scratch-puzzle-2',
        key: 'preset-scratch-puzzle-2',
        mode: 'scratch_puzzle',
        subtipe: 'scratch_puzzle',
        title: 'Logika Scratch Mini: Koin & Aturan Game',
        nama: 'Logika Scratch Mini: Koin & Aturan Game',
        description: 'Cocokkan logika kondisi dan aturan kemenangan permainan!',
        deskripsi: 'Cocokkan logika kondisi dan aturan kemenangan permainan!',
        pertanyaan: 'Dalam rancangan game menangkap koin, pasangkan setiap pemicu sensor dan tombol dengan aksi balok yang tepat!',
        theme: 'scratch',
        pairs: [
          { id: 'q1', event: 'Ketika tombol Panah Kanan ditekan', action: 'Ubah posisi X sebesar +10 (bergerak ke kanan)' },
          { id: 'q2', event: 'Ketika waktu hitung mundur = 0', action: 'Tampilkan tulisan GAME OVER & hentikan semua skrip' },
          { id: 'q3', event: 'Ketika skor mencapai 100', action: 'Putar suara kemenangan & lanjut ke Level 2' },
          { id: 'q4', event: 'Ketika karakter menyentuh magnet', action: 'Tarik semua koin emas di sekitar' }
        ],
        target_pairs: [
          { event: 'Ketika tombol Panah Kanan ditekan', action: 'Ubah posisi X sebesar +10 (bergerak ke kanan)' },
          { event: 'Ketika waktu hitung mundur = 0', action: 'Tampilkan tulisan GAME OVER & hentikan semua skrip' },
          { event: 'Ketika skor mencapai 100', action: 'Putar suara kemenangan & lanjut ke Level 2' },
          { event: 'Ketika karakter menyentuh magnet', action: 'Tarik semua koin emas di sekitar' }
        ],
        distractors: ['Hapus sprite dari panggung'],
        difficulty: 'sedang',
        tingkat_kesulitan: 'sedang',
        bobot: 25
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
   * Mendukung instruksi: Maju, Mundur, Belok Kiri, Belok Kanan, Ulangi (Loop), dan Jika Rintangan
   */
  simulateGridExecution(levelData, blocks) {
    const rows = Number(levelData.grid_height || levelData.gridSize?.rows) || 5;
    const cols = Number(levelData.grid_width || levelData.gridSize?.cols) || 5;
    let x = (levelData.start_pos?.x ?? levelData.start?.x) ?? 0;
    let y = (levelData.start_pos?.y ?? levelData.start?.y) ?? 0;

    const dirMap = {
      N: 'up', E: 'right', S: 'down', W: 'left',
      up: 'up', right: 'right', down: 'down', left: 'left',
      UTARA: 'up', TIMUR: 'right', SELATAN: 'down', BARAT: 'left'
    };
    let dir = dirMap[levelData.start_dir] || dirMap[levelData.start?.dir] || 'right';

    const finishX = (levelData.finish_pos?.x ?? levelData.finish?.x) ?? (cols - 1);
    const finishY = (levelData.finish_pos?.y ?? levelData.finish?.y) ?? (rows - 1);

    const obstacles = new Set();
    if (Array.isArray(levelData.obstacles)) {
      levelData.obstacles.forEach(o => obstacles.add(`${o.x},${o.y}`));
    }
    if (Array.isArray(levelData.grid)) {
      levelData.grid.forEach((row, gy) => {
        if (Array.isArray(row)) {
          row.forEach((cell, gx) => {
            if (cell === 'wall' || cell === 'rock' || cell === 'obstacle') obstacles.add(`${gx},${gy}`);
          });
        }
      });
    }

    const starsList = Array.isArray(levelData.stars) ? levelData.stars : [];
    const remainingStars = new Set(starsList.map(s => `${s.x},${s.y}`));
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

        const rawType = (block?.type || block || '').toString();
        const type = rawType.trim();

        if (type === 'move' || type === 'MAJU' || type === 'maju') {
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

          if (remainingStars.has(`${x},${y}`)) {
            remainingStars.delete(`${x},${y}`);
            collectedStars++;
            logs.push({ step: totalStepsExecuted, action: 'collect_star', x, y, dir, starsCount: collectedStars });
          }

          if (x === finishX && y === finishY) {
            logs.push({ step: totalStepsExecuted, action: 'reached_finish', x, y, dir });
          }
        } else if (type === 'move_back' || type === 'MUNDUR' || type === 'mundur' || type === 'back') {
          // Perintah Mundur: Bergerak 1 petak ke arah berlawanan tanpa mengubah arah hadap robot
          const off = dirOffsets[dir];
          const nextX = x - off.dx;
          const nextY = y - off.dy;

          if (nextX < 0 || nextX >= cols || nextY < 0 || nextY >= rows) {
            hitObstacle = true;
            obstacleReason = 'Robot menabrak batas arena saat mundur!';
            logs.push({ step: totalStepsExecuted, action: 'crash_boundary', x, y, dir, reason: obstacleReason });
            break;
          }

          if (obstacles.has(`${nextX},${nextY}`)) {
            hitObstacle = true;
            obstacleReason = 'Robot menabrak rintangan saat mundur!';
            logs.push({ step: totalStepsExecuted, action: 'crash_obstacle', x: nextX, y: nextY, dir, reason: obstacleReason });
            break;
          }

          x = nextX;
          y = nextY;
          logs.push({ step: totalStepsExecuted, action: 'move_back', x, y, dir });

          if (remainingStars.has(`${x},${y}`)) {
            remainingStars.delete(`${x},${y}`);
            collectedStars++;
            logs.push({ step: totalStepsExecuted, action: 'collect_star', x, y, dir, starsCount: collectedStars });
          }

          if (x === finishX && y === finishY) {
            logs.push({ step: totalStepsExecuted, action: 'reached_finish', x, y, dir });
          }
        } else if (type === 'turn_right' || type === 'BELOK_KANAN' || type === 'kanan') {
          dir = turnClockwise[dir];
          logs.push({ step: totalStepsExecuted, action: 'turn_right', x, y, dir });
        } else if (type === 'turn_left' || type === 'BELOK_KIRI' || type === 'kiri') {
          dir = turnCounter[dir];
          logs.push({ step: totalStepsExecuted, action: 'turn_left', x, y, dir });
        } else if (type === 'collect') {
          if (remainingStars.has(`${x},${y}`)) {
            remainingStars.delete(`${x},${y}`);
            collectedStars++;
            logs.push({ step: totalStepsExecuted, action: 'collect_star', x, y, dir, starsCount: collectedStars });
          }
        } else if (type === 'repeat' || type === 'ULANGI' || type === 'ulangi') {
          const count = Math.min(20, Math.max(1, Number(block.count) || 2));
          const subList = Array.isArray(block.blocks) ? block.blocks : (Array.isArray(block.body) ? block.body : [{ type: 'MAJU' }]);
          for (let iter = 0; iter < count; iter++) {
            if (hitObstacle || totalStepsExecuted >= MAX_STEPS) break;
            runList(subList);
          }
        } else if (type === 'if' || type === 'if_obstacle' || type === 'JIKA_RINTANGAN') {
          const obstacleAhead = isObstacleAhead(x, y, dir);
          if (obstacleAhead) {
            if (Array.isArray(block.thenBlocks) && block.thenBlocks.length > 0) {
              runList(block.thenBlocks);
            } else {
              // Default jika percabangan sederhana: belok kanan menghindar
              dir = turnClockwise[dir];
              logs.push({ step: totalStepsExecuted, action: 'turn_right', x, y, dir });
            }
          } else {
            if (Array.isArray(block.elseBlocks) && block.elseBlocks.length > 0) {
              runList(block.elseBlocks);
            } else {
              // Default jika aman: maju
              runList([{ type: 'MAJU' }]);
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
    const correctPairs = levelData.target_pairs || levelData.pairs || [];
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
