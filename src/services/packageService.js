const db = require('../config/database');

const packageService = {
  // Ambil daftar nama paket standar
  getPackageNames(count = 1) {
    const validCount = Math.max(1, Math.min(4, Number(count) || 1));
    return ['A', 'B', 'C', 'D'].slice(0, validCount);
  },

  // Seeded deterministic shuffle agar pengacakan paket konsisten dan reproducible
  seededShuffle(array, seedStr) {
    const arr = [...array];
    let seed = 0;
    for (let i = 0; i < seedStr.length; i++) {
      seed = (seed * 31 + seedStr.charCodeAt(i)) & 0xffffffff;
    }
    const pseudoRandom = () => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return (seed >>> 0) / 4294967296;
    };

    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(pseudoRandom() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },

  // Helper: deteksi kategori/tipe soal untuk pembagian rasio adil
  getQuestionCategory(q) {
    const isPg = q.jenis === 'pilihan_ganda' || (q.opsi_a && q.opsi_b);
    if (isPg) {
      const keys = (q.kunci_pg || q.kunci_jawaban || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
      const isKompleks = (
        q.tipe_pg === 'pg_kompleks' ||
        q.jenis_pg === 'pg_kompleks' ||
        keys.length > 1 ||
        (typeof q.kunci_pg === 'string' && (q.kunci_pg.includes(',') || q.kunci_pg.trim().length > 1))
      );
      return isKompleks ? 'pg_kompleks' : 'pg_biasa';
    }
    if (q.jenis === 'koding_game') return 'koding_game';
    if (q.jenis === 'isian') return 'isian';
    if (q.jenis === 'essay') return 'essay';
    return q.jenis || 'lainnya';
  },

  // Helper: hitung alokasi kuota proporsional adil menggunakan Largest Remainder (Hare-Niemeyer) Method
  calculateProportionalQuotas(groups, targetCount) {
    const groupKeys = Object.keys(groups).filter(k => groups[k] && groups[k].length > 0);
    const totalAvailable = groupKeys.reduce((acc, k) => acc + groups[k].length, 0);

    const quotas = {};
    if (totalAvailable <= 0) return quotas;

    const safeTarget = Math.max(1, Math.min(totalAvailable, Number(targetCount) || totalAvailable));

    if (safeTarget >= totalAvailable) {
      groupKeys.forEach(k => quotas[k] = groups[k].length);
      return quotas;
    }

    const stats = groupKeys.map(k => {
      const count = groups[k].length;
      const exact = (safeTarget * count) / totalAvailable;
      const floor = Math.floor(exact);
      const rem = exact - floor;
      return { key: k, count, exact, floor, rem };
    });

    let assignedTotal = stats.reduce((acc, s) => acc + s.floor, 0);
    let remainderNeeded = safeTarget - assignedTotal;

    // Urutkan berdasarkan sisa desimal terbesar
    stats.sort((a, b) => {
      if (Math.abs(b.rem - a.rem) > 1e-6) return b.rem - a.rem;
      if (b.count !== a.count) return b.count - a.count;
      return a.key.localeCompare(b.key);
    });

    stats.forEach(s => quotas[s.key] = s.floor);

    // Bagikan sisa kuota ke kategori dengan remainder tertinggi
    for (let i = 0; i < remainderNeeded; i++) {
      const s = stats[i % stats.length];
      if (quotas[s.key] < s.count) {
        quotas[s.key] += 1;
      }
    }

    // Pastikan setiap kategori yang ada terwakili minimal 1 butir jika kuota cukup
    if (safeTarget >= groupKeys.length) {
      for (const s of stats) {
        if (quotas[s.key] === 0 && s.count > 0) {
          const donor = stats
            .filter(d => quotas[d.key] > 1)
            .sort((a, b) => a.rem - b.rem)[0];
          if (donor) {
            quotas[donor.key] -= 1;
            quotas[s.key] += 1;
          }
        }
      }
    }

    return quotas;
  },

  // Helper: buat ringkasan teks rasio pembagian soal
  getRatioSummary(questions) {
    if (!Array.isArray(questions) || questions.length === 0) return { counts: {}, total: 0, text: '' };
    const summary = {};
    const total = questions.length;
    questions.forEach(q => {
      const cat = this.getQuestionCategory(q);
      summary[cat] = (summary[cat] || 0) + 1;
    });

    const parts = [];
    const catLabels = {
      pg_biasa: 'PG Biasa',
      pg_kompleks: 'PG Kompleks',
      isian: 'Isian',
      essay: 'Essay',
      koding_game: 'Koding'
    };

    for (const [cat, count] of Object.entries(summary)) {
      const label = catLabels[cat] || cat;
      const pct = Math.round((count / total) * 100);
      parts.push(`${count} ${label} (${pct}%)`);
    }

    return {
      counts: summary,
      total,
      text: parts.join(' + ') + ` = ${total} Soal`
    };
  },

  // Helper: pilih subset butir soal secara acak namun dengan pembagian rasio seimbang & adil
  sampleQuestionsWithFairRatio(allQuestions, targetCount, seedStr = null) {
    if (!Array.isArray(allQuestions) || allQuestions.length === 0) return [];
    const totalAvail = allQuestions.length;
    const safeTarget = (targetCount && targetCount !== 'semua' && !isNaN(targetCount))
      ? Math.max(1, Math.min(totalAvail, Number(targetCount)))
      : totalAvail;

    if (safeTarget >= totalAvail) {
      return [...allQuestions];
    }

    // Kelompokkan butir soal berdasarkan kategori jenis / tipe
    const groups = {};
    allQuestions.forEach(q => {
      const cat = this.getQuestionCategory(q);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(q);
    });

    // Jika hanya ada 1 kategori (misal semua PG Biasa), periksa apakah tingkat_kesulitan bervariasi
    const groupKeys = Object.keys(groups);
    if (groupKeys.length === 1) {
      const subGroups = {};
      allQuestions.forEach(q => {
        const diff = (q.tingkat_kesulitan || 'sedang').toLowerCase();
        if (!subGroups[diff]) subGroups[diff] = [];
        subGroups[diff].push(q);
      });
      if (Object.keys(subGroups).length > 1) {
        const subQuotas = this.calculateProportionalQuotas(subGroups, safeTarget);
        let sampled = [];
        for (const [diff, needed] of Object.entries(subQuotas)) {
          const pool = subGroups[diff];
          const shuffledPool = seedStr
            ? this.seededShuffle(pool, `${seedStr}-diff-${diff}`)
            : this.seededShuffle(pool, `diff-${diff}-${Math.random()}`);
          sampled.push(...shuffledPool.slice(0, needed));
        }
        return sampled;
      }
    }

    const quotas = this.calculateProportionalQuotas(groups, safeTarget);
    let selected = [];

    // Prioritas urutan kategori saat disusun: pg_biasa, pg_kompleks, isian, essay, koding_game, lainnya
    const catPriority = ['pg_biasa', 'pg_kompleks', 'isian', 'essay', 'koding_game', 'lainnya'];
    const sortedCats = Object.keys(quotas).sort((a, b) => {
      const idxA = catPriority.indexOf(a);
      const idxB = catPriority.indexOf(b);
      return (idxA !== -1 ? idxA : 99) - (idxB !== -1 ? idxB : 99);
    });

    for (const cat of sortedCats) {
      const needed = quotas[cat] || 0;
      if (needed <= 0) continue;
      const pool = groups[cat];
      const shuffledPool = seedStr
        ? this.seededShuffle(pool, `${seedStr}-cat-${cat}`)
        : this.seededShuffle(pool, `cat-${cat}-${Math.random()}`);
      selected.push(...shuffledPool.slice(0, needed));
    }

    return selected;
  },

  // Pilih soal remedial berdasarkan persentase tipe soal yang ditentukan guru.
  // Largest remainder menjaga jumlah akhir tetap sama dengan target, lalu
  // mengisi kekurangan bila bank soal suatu tipe tidak mencukupi.
  sampleQuestionsWithRatios(allQuestions, targetCount, ratios = {}, seedStr = 'remedial') {
    if (!Array.isArray(allQuestions) || allQuestions.length === 0) return [];
    const safeTarget = Math.max(1, Math.min(allQuestions.length, Number(targetCount) || allQuestions.length));
    if (!ratios || typeof ratios !== 'object' || Object.keys(ratios).length === 0) {
      return this.sampleQuestionsWithFairRatio(allQuestions, safeTarget, seedStr);
    }

    const aliases = {
      pilihan_ganda: 'pg_biasa',
      pg: 'pg_biasa',
      pg_biasa: 'pg_biasa',
      pg_kompleks: 'pg_kompleks',
      isian: 'isian',
      essay: 'essay',
      koding: 'koding_game',
      koding_game: 'koding_game'
    };
    const requested = {};
    let totalRequested = 0;
    for (const [rawKey, rawValue] of Object.entries(ratios)) {
      const key = aliases[String(rawKey).trim().toLowerCase()];
      if (!key) throw new Error(`Tipe soal remedial tidak dikenal: ${rawKey}`);
      if (rawValue === '' || rawValue === null || rawValue === undefined) continue;
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error(`Persentase tipe soal ${rawKey} harus berada di antara 0 dan 100`);
      }
      requested[key] = value;
      totalRequested += value;
    }
    if (totalRequested > 100.0001) {
      throw new Error('Total persentase tipe soal remedial tidak boleh melebihi 100%');
    }

    const groups = {};
    allQuestions.forEach(q => {
      const key = this.getQuestionCategory(q);
      if (!groups[key]) groups[key] = [];
      groups[key].push(q);
    });
    const availableKeys = Object.keys(groups).filter(key => groups[key].length > 0);
    if (availableKeys.length === 0) return [];

    // Sisa persentase diberikan ke kategori yang tidak diatur guru,
    // proporsional terhadap isi bank soal. Ini membuat field persentase opsional.
    const effective = { ...requested };
    const omitted = availableKeys.filter(key => effective[key] === undefined);
    const remainingPercent = Math.max(0, 100 - totalRequested);
    if (omitted.length > 0 && remainingPercent > 0) {
      const omittedTotal = omitted.reduce((sum, key) => sum + groups[key].length, 0);
      omitted.forEach(key => {
        effective[key] = omittedTotal > 0 ? remainingPercent * groups[key].length / omittedTotal : 0;
      });
    } else if (remainingPercent > 0) {
      // Semua kategori tersedia sudah disebutkan tetapi jumlahnya kurang dari
      // 100%; pertahankan rasio yang dimasukkan dengan menormalkan sisa.
      const effectiveTotal = availableKeys.reduce((sum, key) => sum + (effective[key] || 0), 0);
      if (effectiveTotal <= 0) {
        availableKeys.forEach(key => { effective[key] = 100 / availableKeys.length; });
      } else {
        availableKeys.forEach(key => { effective[key] = (effective[key] || 0) * 100 / effectiveTotal; });
      }
    }

    const stats = availableKeys.map(key => {
      const exact = safeTarget * ((effective[key] || 0) / 100);
      return { key, exact, floor: Math.floor(exact), remainder: exact - Math.floor(exact), capacity: groups[key].length };
    });
    const quotas = {};
    stats.forEach(item => { quotas[item.key] = Math.min(item.floor, item.capacity); });
    let assigned = Object.values(quotas).reduce((sum, count) => sum + count, 0);
    const byRemainder = [...stats].sort((a, b) => b.remainder - a.remainder || b.capacity - a.capacity || a.key.localeCompare(b.key));
    while (assigned < safeTarget) {
      const donor = byRemainder.find(item => (quotas[item.key] || 0) < item.capacity);
      if (!donor) break;
      quotas[donor.key] = (quotas[donor.key] || 0) + 1;
      assigned++;
      donor.remainder = -1;
      byRemainder.sort((a, b) => b.remainder - a.remainder || b.capacity - a.capacity || a.key.localeCompare(b.key));
    }

    const selected = [];
    const selectedIds = new Set();
    for (const key of availableKeys) {
      const needed = quotas[key] || 0;
      if (needed <= 0) continue;
      const pool = seedStr ? this.seededShuffle(groups[key], `${seedStr}-${key}`) : [...groups[key]];
      for (const question of pool.slice(0, needed)) {
        selected.push(question);
        selectedIds.add(question.id);
      }
    }

    // Jika kategori yang diminta kurang tersedia, penuhi target dari soal lain
    // tanpa pernah menggandakan ID soal.
    if (selected.length < safeTarget) {
      const remainderPool = allQuestions.filter(q => !selectedIds.has(q.id));
      const shuffled = seedStr ? this.seededShuffle(remainderPool, `${seedStr}-fill`) : remainderPool;
      selected.push(...shuffled.slice(0, safeTarget - selected.length));
    }
    return seedStr ? this.seededShuffle(selected, `${seedStr}-order`) : selected;
  },

  // Generate / regenerasi paket soal untuk satu ulangan
  generatePackages(ulanganId, options = {}) {
    const ulangan = db.prepare('SELECT * FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) {
      throw new Error('Ulangan tidak ditemukan');
    }

    const packageCount = Math.max(1, Math.min(4, Number(options.packageCount || options.jumlah_paket || ulangan.jumlah_paket || 1)));
    const packageNames = this.getPackageNames(packageCount);

    // Ambil soal pilihan ganda yang terkait dengan ulangan ini
    // Catatan: Jika ada soal esai/isian juga, kita pisahkan agar PG tetap berurutan di awal
    const pgQuestions = db.prepare(`
      SELECT id, nomor, pertanyaan, opsi_a, opsi_b, opsi_c, opsi_d, opsi_e, kunci_pg, bobot, urutan, tingkat_kesulitan
      FROM soal
      WHERE ulangan_id = ? AND jenis = 'pilihan_ganda'
      ORDER BY urutan ASC, nomor ASC
    `).all(ulanganId);

    let targetQuestions = [...pgQuestions];

    if (targetQuestions.length === 0) {
      // Jika belum ada jenis 'pilihan_ganda', cek apakah ada soal umum yang memiliki kunci_pg
      const fallbackPg = db.prepare(`
        SELECT id, nomor, pertanyaan, opsi_a, opsi_b, opsi_c, opsi_d, opsi_e, kunci_pg, bobot, urutan, tingkat_kesulitan
        FROM soal
        WHERE ulangan_id = ? AND kunci_pg IS NOT NULL AND TRIM(kunci_pg) != ''
        ORDER BY urutan ASC, nomor ASC
      `).all(ulanganId);
      if (fallbackPg.length > 0) {
        targetQuestions.push(...fallbackPg);
      }
    }

    if (targetQuestions.length === 0) {
      // Jika ulangan tidak memiliki soal berjenis pilihan_ganda, ambil seluruh butir soal yang ada
      const allQ = db.prepare(`
        SELECT id, nomor, pertanyaan, opsi_a, opsi_b, opsi_c, opsi_d, opsi_e, kunci_pg, kunci_jawaban, jenis, bobot, urutan, tingkat_kesulitan
        FROM soal
        WHERE ulangan_id = ?
        ORDER BY urutan ASC, nomor ASC
      `).all(ulanganId);
      if (allQ.length > 0) {
        targetQuestions.push(...allQ);
      }
    }

    if (targetQuestions.length === 0) {
      throw new Error('Ulangan ini belum memiliki butir soal untuk dibuatkan paket soal acak.');
    }

    // Tentukan jumlah target soal yang diinginkan guru
    const rawTarget = options.questionCount ?? options.jumlah_soal;
    let targetCount = targetQuestions.length;
    if (rawTarget && rawTarget !== 'semua' && !isNaN(rawTarget)) {
      targetCount = Math.max(1, Math.min(targetQuestions.length, Number(rawTarget)));
    }

    // Pilihlah subset soal secara acak dengan rasio pembagian yang adil dan proporsional
    // Seed memungkinkan seleksi berbeda tiap kali guru mengklik "Generate / Acak Ulang"
    const selectionSeed = options.seed || `ulangan-${ulanganId}-seed-${Date.now()}`;
    const selectedQuestions = (targetCount < targetQuestions.length)
      ? this.sampleQuestionsWithFairRatio(targetQuestions, targetCount, selectionSeed)
      : [...targetQuestions];

    const ratioSummary = this.getRatioSummary(selectedQuestions);

    // Hapus paket lama jika ada
    db.prepare('DELETE FROM paket_soal WHERE ulangan_id = ?').run(ulanganId);

    const createdPackages = [];

    for (const pkgName of packageNames) {
      let orderedQuestions;
      if (pkgName === 'A') {
        // Paket A menggunakan urutan asli dari butir soal terpilih
        orderedQuestions = [...selectedQuestions].sort((a, b) => (a.urutan - b.urutan) || (a.nomor - b.nomor));
      } else {
        // Paket B, C, D diacak dengan seed deterministik dari butir soal terpilih
        orderedQuestions = this.seededShuffle(selectedQuestions, `ulangan-${ulanganId}-paket-${pkgName}-${selectionSeed}`);
      }

      const questionIds = orderedQuestions.map(q => q.id);
      const answerKeyMap = {};

      orderedQuestions.forEach((q, index) => {
        const displayNum = index + 1;
        const key = q.kunci_pg || q.kunci_jawaban || '-';
        answerKeyMap[String(displayNum)] = String(key).toUpperCase().trim();
      });

      const stmt = db.prepare(`
        INSERT INTO paket_soal (ulangan_id, nama_paket, urutan_soal_ids, kunci_jawaban_map)
        VALUES (?, ?, ?, ?)
      `);

      const info = stmt.run(
        ulanganId,
        pkgName,
        JSON.stringify(questionIds),
        JSON.stringify(answerKeyMap)
      );

      createdPackages.push({
        id: info.lastInsertRowid,
        ulangan_id: ulanganId,
        nama_paket: pkgName,
        total_soal_pg: orderedQuestions.length,
        total_soal: orderedQuestions.length,
        kunci_jawaban_map: answerKeyMap,
        kunci_jawaban: answerKeyMap,
        urutan_soal_ids: questionIds,
        mapping_soal: questionIds,
        ratio_summary: ratioSummary.counts || {},
        summary_text: ratioSummary.text || ''
      });
    }

    // Update jumlah paket di tabel ulangan
    db.prepare('UPDATE ulangan SET jumlah_paket = ? WHERE id = ?').run(packageCount, ulanganId);
    if (typeof db.syncCloud === 'function') db.syncCloud(true);

    return {
      success: true,
      ulangan_id: ulanganId,
      jumlah_paket: packageCount,
      target_soal: targetCount,
      ratio_summary: ratioSummary.counts || {},
      summary_text: ratioSummary.text || '',
      packages: createdPackages
    };
  },

  // Ambil daftar paket untuk ulangan tertentu
  getPackagesByUlangan(ulanganId) {
    const packages = db.prepare(`
      SELECT id, ulangan_id, nama_paket, urutan_soal_ids, kunci_jawaban_map, created_at
      FROM paket_soal
      WHERE ulangan_id = ?
      ORDER BY nama_paket ASC
    `).all(ulanganId);

    return packages.map(p => {
      let urutan = [];
      try {
        urutan = typeof p.urutan_soal_ids === 'string' ? JSON.parse(p.urutan_soal_ids) : (p.urutan_soal_ids || []);
      } catch (e) {
        urutan = [];
      }
      let keys = {};
      try {
        keys = typeof p.kunci_jawaban_map === 'string' ? JSON.parse(p.kunci_jawaban_map) : (p.kunci_jawaban_map || {});
      } catch (e) {
        keys = {};
      }
      p.urutan_soal_ids = urutan;
      p.mapping_soal = urutan;
      p.kunci_jawaban_map = keys;
      p.kunci_jawaban = keys;
      p.total_soal = Array.isArray(urutan) ? urutan.length : 0;
      return p;
    });
  },

  // Ambil kunci jawaban spesifik suatu paket
  getAnswerKey(ulanganId, packageName = 'A') {
    const pkg = db.prepare(`
      SELECT kunci_jawaban_map FROM paket_soal
      WHERE ulangan_id = ? AND UPPER(nama_paket) = UPPER(?)
    `).get(ulanganId, packageName);

    if (pkg && pkg.kunci_jawaban_map) {
      try {
        return JSON.parse(pkg.kunci_jawaban_map);
      } catch (e) {
        return {};
      }
    }

    // Fallback jika belum di-generate ke paket_soal: generate on-the-fly dari tabel soal
    const questions = db.prepare(`
      SELECT nomor, kunci_pg FROM soal
      WHERE ulangan_id = ? AND jenis = 'pilihan_ganda'
      ORDER BY urutan ASC, nomor ASC
    `).all(ulanganId);

    const map = {};
    questions.forEach((q, idx) => {
      map[String(idx + 1)] = (q.kunci_pg || 'A').toUpperCase().trim();
    });
    return map;
  },

  // Ambil naskah soal lengkap per paket untuk dicetak
  getPrintableQuestionsByPackage(ulanganId, packageName = 'A') {
    const ulangan = db.prepare('SELECT * FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');

    const pkg = db.prepare(`
      SELECT * FROM paket_soal
      WHERE ulangan_id = ? AND UPPER(nama_paket) = UPPER(?)
    `).get(ulanganId, packageName);

    let orderedPg = [];

    if (pkg && pkg.urutan_soal_ids) {
      const ids = JSON.parse(pkg.urutan_soal_ids);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const rawSoals = db.prepare(`SELECT * FROM soal WHERE id IN (${placeholders})`).all(...ids);
        const soalMap = new Map(rawSoals.map(s => [s.id, s]));
        orderedPg = ids.map((id, idx) => {
          const s = soalMap.get(id);
          return s ? { ...s, nomor_tampil: idx + 1 } : null;
        }).filter(Boolean);
      }
    } else {
      orderedPg = db.prepare(`
        SELECT *, ROW_NUMBER() OVER (ORDER BY urutan, nomor) as nomor_tampil
        FROM soal
        WHERE ulangan_id = ? AND jenis = 'pilihan_ganda'
        ORDER BY urutan, nomor
      `).all(ulanganId);
    }

    // Ambil juga soal esai/isian jika ulangan jenis campuran
    const essayQuestions = db.prepare(`
      SELECT * FROM soal
      WHERE ulangan_id = ? AND jenis IN ('isian', 'essay')
      ORDER BY urutan ASC, nomor ASC
    `).all(ulanganId);

    return {
      ulangan,
      paket: packageName.toUpperCase(),
      nama_paket: packageName.toUpperCase(),
      opsi_count: Number(ulangan.opsi_pg_count) || 4,
      soal_pg: orderedPg,
      soal_essay: essayQuestions,
      soal_list: [...orderedPg, ...essayQuestions]
    };
  }
};

module.exports = packageService;
