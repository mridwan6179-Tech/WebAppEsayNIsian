const db = require('../config/database');
const examService = require('./examService');
const studentService = require('./studentService');

const reviewService = {
  // Ambil daftar seluruh siswa/pengerjaan pada suatu ulangan
  getPengerjaanListByUlangan(ulanganId, guruId) {
    const ulangan = db.prepare('SELECT id, zona_waktu FROM ulangan WHERE id = ? AND guru_id = ?').get(ulanganId, guruId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan atau bukan milik guru ini');

    // Bersihkan sesi DC kosong (>1 jam atau lewat durasi) dan auto-submit sesi terisi yang kedaluwarsa
    try {
      studentService.cleanAbandonedSessions(ulanganId);
    } catch (cleanErr) {
      console.warn('[CLEANUP WARN]', cleanErr.message);
    }

    const rows = db.prepare(`
      SELECT 
        p.id as pengerjaan_id,
        p.ulangan_id,
        p.peserta_id,
        p.status,
        p.started_at,
        p.submitted_at,
        p.last_active_at,
        p.nilai_ai,
        p.nilai_final,
        p.released_at,
        p.paste_count,
        p.paste_details,
        p.soal_ids,
        pes.nama as nama_siswa,
        pes.kelas as kelas_siswa,
        COUNT(j.id) as total_jawaban,
        SUM(CASE WHEN j.jawaban_siswa IS NOT NULL AND TRIM(j.jawaban_siswa) != '' THEN 1 ELSE 0 END) as total_terisi,
        SUM(CASE WHEN j.status_penilaian = 'selesai' THEN 1 ELSE 0 END) as total_dinilai,
        CAST(ROUND((julianday('now') - julianday(COALESCE(p.last_active_at, p.started_at))) * 86400) AS INTEGER) as detik_sejak_aktif
      FROM pengerjaan p
      JOIN peserta pes ON p.peserta_id = pes.id
      LEFT JOIN jawaban j ON p.id = j.pengerjaan_id
      WHERE p.ulangan_id = ?
      GROUP BY p.id
      ORDER BY pes.kelas ASC, pes.nama ASC
    `).all(ulanganId);

    // Ambil rincian kecurangan / paste & prompt injection dari tabel jawaban dalam 1 query efisien
    let flaggedAnswers = [];
    try {
      flaggedAnswers = db.prepare(`
        SELECT j.pengerjaan_id, j.soal_id, COALESCE(j.paste_count, 0) as paste_count, j.alasan_ai
        FROM jawaban j
        JOIN pengerjaan p ON j.pengerjaan_id = p.id
        WHERE p.ulangan_id = ? AND (
          j.paste_count > 0 
          OR j.alasan_ai LIKE '%manipulasi%' 
          OR j.alasan_ai LIKE '%prompt injection%' 
          OR j.alasan_ai LIKE '%pengelabu%'
        )
      `).all(ulanganId);
    } catch (errFlag) {
      flaggedAnswers = [];
    }

    const flaggedByPengerjaan = new Map();
    for (const fa of flaggedAnswers) {
      if (!flaggedByPengerjaan.has(fa.pengerjaan_id)) {
        flaggedByPengerjaan.set(fa.pengerjaan_id, []);
      }
      flaggedByPengerjaan.get(fa.pengerjaan_id).push(fa);
    }

    const zona_waktu = ulangan.zona_waktu || 'WIB';

    const result = rows.map(r => {
      // Pastikan total_jawaban mencerminkan kuota soal unik pengerjaan siswa
      let total_jawaban = r.total_jawaban || 0;
      let parsedSoalIds = [];
      if (r.soal_ids) {
        try {
          const parsedIds = JSON.parse(r.soal_ids);
          if (Array.isArray(parsedIds) && parsedIds.length > 0) {
            parsedSoalIds = parsedIds.map(Number);
            total_jawaban = parsedIds.length;
          }
        } catch (e) {}
      }

      let total_terisi = r.total_terisi || 0;
      let draft_lengkap = (total_jawaban > 0 && total_terisi >= total_jawaban);

      let total_dinilai = r.total_dinilai || 0;
      let nilai_ai = r.nilai_ai;
      let nilai_final = r.nilai_final;

      // Auto-recalculate jika seluruh butir soal sudah dinilai AI tapi nilai_ai belum tersimpan di pengerjaan
      if (total_jawaban > 0 && total_dinilai >= total_jawaban && (nilai_ai === null || nilai_ai === undefined)) {
        try {
          const recalculated = this.recalculatePengerjaanTotal(r.pengerjaan_id);
          if (recalculated) {
            nilai_ai = recalculated.nilai_ai;
            nilai_final = recalculated.nilai_final;
          }
        } catch (errRecalc) {
          console.warn('Peringatan auto-recalculate nilai pengerjaan:', errRecalc.message);
        }
      }

      // Deteksi nomor butir soal tempat terjadinya copy-paste dan peringatan AI
      const pasteQuestionMap = new Map(); // nomor -> count
      const aiAlertNumbers = new Set();

      // 1. Dari p.paste_details jika ada
      if (r.paste_details) {
        try {
          const pd = JSON.parse(r.paste_details);
          if (pd && typeof pd === 'object') {
            for (const [sIdStr, count] of Object.entries(pd)) {
              const sId = Number(sIdStr);
              const cnt = Number(count) || 0;
              if (cnt > 0) {
                const idx = parsedSoalIds.indexOf(sId);
                const qNum = idx !== -1 ? (idx + 1) : sId;
                pasteQuestionMap.set(qNum, Math.max(pasteQuestionMap.get(qNum) || 0, cnt));
              }
            }
          }
        } catch (e) {}
      }

      // 2. Dari jawaban yang ter-flag di database
      const studentFlags = flaggedByPengerjaan.get(r.pengerjaan_id) || [];
      for (const sf of studentFlags) {
        const idx = parsedSoalIds.indexOf(sf.soal_id);
        const qNum = idx !== -1 ? (idx + 1) : sf.soal_id;
        if (sf.paste_count > 0) {
          pasteQuestionMap.set(qNum, Math.max(pasteQuestionMap.get(qNum) || 0, sf.paste_count));
        }
        if (sf.alasan_ai && (
          sf.alasan_ai.toLowerCase().includes('manipulasi') ||
          sf.alasan_ai.toLowerCase().includes('prompt injection') ||
          sf.alasan_ai.toLowerCase().includes('pengelabu')
        )) {
          aiAlertNumbers.add(qNum);
        }
      }

      const paste_soal_nomor = Array.from(pasteQuestionMap.keys()).sort((a, b) => a - b);
      let paste_summary = '';
      if (paste_soal_nomor.length > 0) {
        paste_summary = paste_soal_nomor.map(no => `Soal #${no}`).join(', ');
      }

      const ai_alert_soal_nomor = Array.from(aiAlertNumbers).sort((a, b) => a - b);
      let ai_alert_summary = '';
      if (ai_alert_soal_nomor.length > 0) {
        ai_alert_summary = ai_alert_soal_nomor.map(no => `Soal #${no}`).join(', ');
      }

      // Format submitted_at sesuai tanggal, jam dan zona waktu ulangan (WIB / WITA / WIT)
      let submitted_at_formatted = null;
      if (r.submitted_at) {
        try {
          let s = String(r.submitted_at).trim();
          if (!s.includes('T') && s.includes(' ')) s = s.replace(' ', 'T');
          if (!s.endsWith('Z') && !s.includes('+') && !s.slice(10).includes('-')) s += 'Z';
          const d = new Date(s);
          if (!isNaN(d.getTime())) {
            const tzMap = { WIB: 'Asia/Jakarta', WITA: 'Asia/Makassar', WIT: 'Asia/Jayapura' };
            const tz = tzMap[zona_waktu] || 'Asia/Jakarta';
            const dateStr = new Intl.DateTimeFormat('id-ID', {
              timeZone: tz,
              day: '2-digit',
              month: 'short',
              year: 'numeric'
            }).format(d);
            const timeStr = new Intl.DateTimeFormat('id-ID', {
              timeZone: tz,
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false
            }).format(d).replace(/\./g, ':');
            submitted_at_formatted = `${dateStr}, ${timeStr} ${zona_waktu}`;
          }
        } catch (errDate) {}
      }

      let status_kehadiran = 'selesai';
      let terakhir_aktif_teks = 'Sudah mengumpulkan';
      let terakhir_aktif_teks_singkat = '';

      if (r.status !== 'submitted') {
        const diff = r.detik_sejak_aktif;
        // Batas toleransi heartbeat aktif: 45 detik (ping dikirim klien setiap 15 detik)
        if (diff !== null && diff !== undefined && diff >= 0 && diff <= 45) {
          status_kehadiran = 'aktif';
          terakhir_aktif_teks = 'Sedang aktif di lembar ujian (mengetik/online)';
          terakhir_aktif_teks_singkat = 'Aktif';
        } else {
          status_kehadiran = 'dc';
          if (diff === null || diff === undefined || diff > 86400 * 30) {
            terakhir_aktif_teks = 'Terputus (keluar/tutup browser/offline)';
            terakhir_aktif_teks_singkat = 'Keluar';
          } else if (diff < 60) {
            terakhir_aktif_teks = `Terputus (${diff} detik lalu)`;
            terakhir_aktif_teks_singkat = `${diff}s lalu`;
          } else if (diff < 3600) {
            const m = Math.floor(diff / 60);
            terakhir_aktif_teks = `Terputus (${m} menit lalu)`;
            terakhir_aktif_teks_singkat = `${m}m lalu`;
          } else {
            const h = Math.floor(diff / 3600);
            terakhir_aktif_teks = `Terputus (${h} jam lalu)`;
            terakhir_aktif_teks_singkat = `${h}j lalu`;
          }
        }
      }

      return {
        ...r,
        total_jawaban,
        total_terisi,
        draft_lengkap,
        total_dinilai,
        nilai_ai,
        nilai_final,
        zona_waktu,
        submitted_at_formatted,
        status_kehadiran,
        terakhir_aktif_teks,
        terakhir_aktif_teks_singkat,
        paste_soal_nomor,
        paste_summary,
        ai_alert_soal_nomor,
        ai_alert_summary
      };
    });

    // Urutan prioritas tampilan dashboard guru:
    // 1. Sedang aktif mengerjakan (teratas)
    // 2. Terputus koneksi / DC
    // 3. Sudah submit tapi belum dinilai / belum direview
    // 4. Sudah dinilai namun belum dirilis
    // 5. Sudah dirilis (terbawah)
    return result.sort((a, b) => {
      const getRank = (item) => {
        if (item.status !== 'submitted') {
          return item.status_kehadiran === 'aktif' ? 1 : 2;
        }
        if (item.released_at) return 5;
        const isReviewed = (item.total_dinilai >= item.total_jawaban) && (item.nilai_final !== null && item.nilai_final !== undefined);
        return isReviewed ? 4 : 3;
      };

      const rankA = getRank(a);
      const rankB = getRank(b);
      if (rankA !== rankB) return rankA - rankB;

      const kelasComp = (a.kelas_siswa || '').localeCompare(b.kelas_siswa || '', 'id', { sensitivity: 'base' });
      if (kelasComp !== 0) return kelasComp;

      return (a.nama_siswa || '').localeCompare(b.nama_siswa || '', 'id', { sensitivity: 'base' });
    });
  },

  // Ambil detail pengerjaan siswa untuk review butir soal
  getPengerjaanDetail(pengerjaanId, guruId) {
    const pengerjaan = db.prepare(`
      SELECT p.*, pes.nama as nama_siswa, pes.kelas as kelas_siswa, u.judul, u.mata_pelajaran, u.guru_id
      FROM pengerjaan p
      JOIN peserta pes ON p.peserta_id = pes.id
      JOIN ulangan u ON p.ulangan_id = u.id
      WHERE p.id = ?
    `).get(pengerjaanId);

    if (!pengerjaan) throw new Error('Data pengerjaan tidak ditemukan');
    if (pengerjaan.guru_id !== guruId) throw new Error('Akses ditolak: bukan ulangan milik Anda');

    const rawJawabanList = db.prepare(`
      SELECT 
        j.id as jawaban_id,
        j.pengerjaan_id,
        j.soal_id,
        j.jawaban_siswa,
        COALESCE(j.paste_count, 0) as paste_count,
        j.status_penilaian,
        j.skor_rekomendasi,
        j.skor_maksimum,
        j.status_jawaban,
        j.alasan_ai,
        j.model_ai,
        s.nomor,
        s.jenis,
        s.pertanyaan,
        s.gambar_url,
        s.kunci_jawaban,
        s.rubrik,
        s.bobot,
        rg.id as review_id,
        rg.skor_final,
        rg.keputusan,
        rg.catatan_guru
      FROM jawaban j
      JOIN soal s ON j.soal_id = s.id
      LEFT JOIN review_guru rg ON j.id = rg.jawaban_id
      WHERE j.pengerjaan_id = ?
      ORDER BY s.urutan ASC, s.nomor ASC
    `).all(pengerjaanId);

    // Jika siswa memiliki soal_ids acak, susun sesuai urutan yang dilihat siswa
    let parsedSoalIds = [];
    if (pengerjaan.soal_ids) {
      try {
        const pIds = JSON.parse(pengerjaan.soal_ids);
        if (Array.isArray(pIds)) parsedSoalIds = pIds.map(Number);
      } catch (e) {}
    }

    let parsedPasteDetails = {};
    if (pengerjaan.paste_details) {
      try {
        const pd = JSON.parse(pengerjaan.paste_details);
        if (pd && typeof pd === 'object') parsedPasteDetails = pd;
      } catch (e) {}
    }

    const jawabanList = rawJawabanList.map((j) => {
      const idx = parsedSoalIds.indexOf(j.soal_id);
      const nomor_tampil = idx !== -1 ? (idx + 1) : (j.nomor || 1);
      const pasteFromDetails = parsedPasteDetails[j.soal_id] ? Number(parsedPasteDetails[j.soal_id]) : 0;
      const effectivePaste = Math.max(j.paste_count || 0, pasteFromDetails);
      const has_injection_alert = Boolean(j.alasan_ai && (
        j.alasan_ai.toLowerCase().includes('manipulasi') ||
        j.alasan_ai.toLowerCase().includes('prompt injection') ||
        j.alasan_ai.toLowerCase().includes('pengelabu')
      ));

      return {
        ...j,
        nomor_tampil,
        paste_count: effectivePaste,
        has_injection_alert
      };
    });

    if (parsedSoalIds.length > 0) {
      jawabanList.sort((a, b) => a.nomor_tampil - b.nomor_tampil);
    }

    return {
      pengerjaan,
      jawabanList
    };
  },

  // FR-20 & FR-21: Review dan penetapan skor guru per jawaban
  updateJawabanReview(jawabanId, guruId, data) {
    const jawaban = db.prepare(`
      SELECT j.*, s.bobot, u.guru_id
      FROM jawaban j
      JOIN soal s ON j.soal_id = s.id
      JOIN pengerjaan p ON j.pengerjaan_id = p.id
      JOIN ulangan u ON p.ulangan_id = u.id
      WHERE j.id = ?
    `).get(jawabanId);

    if (!jawaban) throw new Error('Jawaban tidak ditemukan');
    if (jawaban.guru_id !== guruId) throw new Error('Akses ditolak: bukan ulangan milik Anda');

    let skorFinal = Number(data.skor_final !== undefined ? data.skor_final : (jawaban.skor_rekomendasi || 0));
    if (isNaN(skorFinal)) skorFinal = 0;

    // NFR-08: Batasi rentang skor pada 0 sampai bobot soal
    skorFinal = Math.max(0, Math.min(skorFinal, Number(jawaban.bobot)));

    const keputusan = data.keputusan || (skorFinal === jawaban.skor_rekomendasi ? 'diterima' : 'diubah');
    const catatan = data.catatan_guru || '';

    db.transaction(() => {
      // Simpan atau update ke tabel review_guru
      const existing = db.prepare('SELECT id FROM review_guru WHERE jawaban_id = ?').get(jawabanId);
      if (existing) {
        db.prepare(`
          UPDATE review_guru 
          SET skor_final = ?, keputusan = ?, catatan_guru = ?, reviewed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(skorFinal, keputusan, catatan, existing.id);
      } else {
        db.prepare(`
          INSERT INTO review_guru (jawaban_id, guru_id, skor_ai, skor_final, keputusan, catatan_guru)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(jawabanId, guruId, jawaban.skor_rekomendasi, skorFinal, keputusan, catatan);
      }

      // Hitung ulang total nilai siswa pada pengerjaan ini
      this.recalculatePengerjaanTotal(jawaban.pengerjaan_id);
    })();

    return {
      success: true,
      jawabanId,
      skorFinal,
      keputusan
    };
  },

  // Setujui seluruh skor AI untuk 1 pengerjaan siswa
  acceptAllAiScores(pengerjaanId, guruId) {
    const detail = this.getPengerjaanDetail(pengerjaanId, guruId);

    db.transaction(() => {
      for (const j of detail.jawabanList) {
        const skor = Number(j.skor_rekomendasi ?? 0);
        this.updateJawabanReview(j.jawaban_id, guruId, {
          skor_final: skor,
          keputusan: 'diterima',
          catatan_guru: 'Menyetujui rekomendasi AI'
        });
      }
    })();

    return this.getPengerjaanDetail(pengerjaanId, guruId);
  },

  // Hitung ulang nilai total siswa (AI & Final) dengan normalisasi max 100 (FR-05 & FR-23)
  recalculatePengerjaanTotal(pengerjaanId) {
    const jawabanItems = db.prepare(`
      SELECT j.skor_rekomendasi, s.bobot, rg.skor_final
      FROM jawaban j
      JOIN soal s ON j.soal_id = s.id
      LEFT JOIN review_guru rg ON j.id = rg.jawaban_id
      WHERE j.pengerjaan_id = ?
    `).all(pengerjaanId);

    // Hitung total rekomendasi AI
    const aiItems = jawabanItems.map(item => ({
      bobot: item.bobot,
      skor_final: item.skor_rekomendasi ?? 0
    }));
    const totalAiScore = examService.calculateNormalizedScore(aiItems);

    // Hitung total nilai final guru (jika belum direview, gunakan skor AI sebagai default)
    const finalItems = jawabanItems.map(item => ({
      bobot: item.bobot,
      skor_final: item.skor_final ?? item.skor_rekomendasi ?? 0
    }));
    const totalFinalScore = examService.calculateNormalizedScore(finalItems);

    db.prepare(`
      UPDATE pengerjaan 
      SET nilai_ai = ?, nilai_final = ? 
      WHERE id = ?
    `).run(totalAiScore, totalFinalScore, pengerjaanId);

    return {
      nilai_ai: totalAiScore,
      nilai_final: totalFinalScore
    };
  },

  // FR-22: Rilis hasil ujian ke siswa (bisa untuk semua kelas, kelas tertentu, atau perorangan siswa)
  toggleReleasePengerjaan(ulanganId, guruId, isReleased, kelasFilter = null, pengerjaanId = null) {
    if (pengerjaanId) {
      return this.toggleReleaseSinglePengerjaan(pengerjaanId, guruId, isReleased);
    }

    const ulangan = db.prepare('SELECT id FROM ulangan WHERE id = ? AND guru_id = ?').get(ulanganId, guruId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan atau bukan milik guru ini');

    const cleanKelas = (kelasFilter && String(kelasFilter).trim() !== '') ? String(kelasFilter).trim() : null;

    if (isReleased) {
      if (cleanKelas) {
        db.prepare(`
          UPDATE pengerjaan 
          SET released_at = CURRENT_TIMESTAMP 
          WHERE ulangan_id = ? AND status = 'submitted'
            AND peserta_id IN (SELECT id FROM peserta WHERE LOWER(kelas) = LOWER(?))
        `).run(ulanganId, cleanKelas);
      } else {
        db.prepare(`
          UPDATE pengerjaan 
          SET released_at = CURRENT_TIMESTAMP 
          WHERE ulangan_id = ? AND status = 'submitted'
        `).run(ulanganId);
      }
    } else {
      if (cleanKelas) {
        db.prepare(`
          UPDATE pengerjaan 
          SET released_at = NULL 
          WHERE ulangan_id = ?
            AND peserta_id IN (SELECT id FROM peserta WHERE LOWER(kelas) = LOWER(?))
        `).run(ulanganId, cleanKelas);
      } else {
        db.prepare(`
          UPDATE pengerjaan 
          SET released_at = NULL 
          WHERE ulangan_id = ?
        `).run(ulanganId);
      }
    }

    return { success: true, isReleased, kelas: cleanKelas || 'semua' };
  },

  // Rilis hasil ujian perorangan / siswa tertentu
  toggleReleaseSinglePengerjaan(pengerjaanId, guruId, isReleased) {
    const pengerjaan = db.prepare(`
      SELECT p.id, p.ulangan_id, p.status, p.released_at, pes.nama as nama_siswa
      FROM pengerjaan p
      JOIN ulangan u ON p.ulangan_id = u.id
      JOIN peserta pes ON p.peserta_id = pes.id
      WHERE p.id = ? AND u.guru_id = ?
    `).get(pengerjaanId, guruId);

    if (!pengerjaan) throw new Error('Data pengerjaan tidak ditemukan atau bukan milik guru ini');

    if (isReleased) {
      if (pengerjaan.status !== 'submitted') {
        throw new Error(`Nilai siswa ${pengerjaan.nama_siswa} belum dapat dirilis karena ujian belum dikumpulkan`);
      }
      db.prepare(`
        UPDATE pengerjaan 
        SET released_at = CURRENT_TIMESTAMP 
        WHERE id = ? AND status = 'submitted'
      `).run(pengerjaanId);
    } else {
      db.prepare(`
        UPDATE pengerjaan 
        SET released_at = NULL 
        WHERE id = ?
      `).run(pengerjaanId);
    }

    const updated = db.prepare('SELECT released_at FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    return {
      success: true,
      pengerjaanId: Number(pengerjaanId),
      isReleased: Boolean(isReleased),
      released_at: updated?.released_at || null,
      nama_siswa: pengerjaan.nama_siswa
    };
  },

  // Laporan Rekapitulasi Nilai per Kelas & per Ulangan untuk Dicetak
  getLaporanNilai(ulanganId, guruId, kelasFilter = null) {
    const ulangan = db.prepare(`
      SELECT u.*, g.nama as nama_guru, g.email as email_guru
      FROM ulangan u
      JOIN guru g ON u.guru_id = g.id
      WHERE u.id = ? AND u.guru_id = ?
    `).get(ulanganId, guruId);

    if (!ulangan) throw new Error('Ulangan tidak ditemukan atau bukan milik guru ini');

    // Ambil semua kelas yang tersedia pada ulangan ini
    let kelasList = db.prepare(`
      SELECT DISTINCT pes.kelas 
      FROM peserta pes 
      JOIN pengerjaan p ON pes.id = p.peserta_id 
      WHERE p.ulangan_id = ? 
      ORDER BY pes.kelas ASC
    `).all(ulanganId).map(r => r.kelas);

    // Ambil peserta dan nilai
    let query = `
      SELECT 
        p.id as pengerjaan_id,
        p.status,
        p.started_at,
        p.submitted_at,
        p.nilai_ai,
        p.nilai_final,
        p.released_at,
        p.auto_submitted,
        p.paste_count,
        pes.id as peserta_id,
        pes.nama as nama_siswa,
        pes.kelas as kelas_siswa,
        COUNT(j.id) as total_jawaban,
        SUM(CASE WHEN j.status_penilaian = 'selesai' THEN 1 ELSE 0 END) as total_dinilai
      FROM pengerjaan p
      JOIN peserta pes ON p.peserta_id = pes.id
      LEFT JOIN jawaban j ON p.id = j.pengerjaan_id
      WHERE p.ulangan_id = ?
    `;

    const params = [ulanganId];
    if (kelasFilter && kelasFilter.trim() !== '' && kelasFilter !== 'all') {
      query += ' AND pes.kelas = ?';
      params.push(kelasFilter.trim());
    }

    query += `
      GROUP BY p.id
      ORDER BY pes.kelas ASC, pes.nama ASC
    `;

    const pesertaList = db.prepare(query).all(...params);

    // Hitung statistik
    let totalPeserta = pesertaList.length;
    let submittedCount = 0;
    let totalScore = 0;
    let highestScore = null;
    let lowestScore = null;
    const examKkm = ulangan.kkm || 75;
    let tuntasCount = 0;

    pesertaList.forEach(st => {
      if (st.status === 'submitted') {
        submittedCount++;
        const finalScore = st.nilai_final !== null ? st.nilai_final : (st.nilai_ai !== null ? st.nilai_ai : null);
        if (finalScore !== null) {
          totalScore += finalScore;
          if (highestScore === null || finalScore > highestScore) highestScore = finalScore;
          if (lowestScore === null || finalScore < lowestScore) lowestScore = finalScore;
          if (finalScore >= examKkm) tuntasCount++;
        }
      }
    });

    const averageScore = submittedCount > 0 ? Number((totalScore / submittedCount).toFixed(1)) : 0;

    return {
      ulangan: {
        id: ulangan.id,
        judul: ulangan.judul,
        mata_pelajaran: ulangan.mata_pelajaran,
        tingkat_kelas: ulangan.tingkat_kelas,
        deskripsi: ulangan.deskripsi,
        kode_ujian: ulangan.kode_ujian,
        tanggal_mulai: ulangan.tanggal_mulai,
        tanggal_selesai: ulangan.tanggal_selesai,
        durasi_menit: ulangan.durasi_menit,
        kkm: examKkm,
        status: ulangan.status,
        created_at: ulangan.created_at,
        nama_guru: ulangan.nama_guru,
        email_guru: ulangan.email_guru
      },
      filter_kelas: kelasFilter || 'all',
      available_classes: kelasList,
      statistik: {
        total_peserta: totalPeserta,
        total_submitted: submittedCount,
        rata_rata: averageScore,
        nilai_tertinggi: highestScore !== null ? highestScore : 0,
        nilai_terendah: lowestScore !== null ? lowestScore : 0,
        kkm: examKkm,
        tuntas_count: tuntasCount,
        belum_tuntas_count: Math.max(0, submittedCount - tuntasCount)
      },
      peserta: pesertaList
    };
  },

  // Hapus data pengerjaan siswa beserta seluruh jawaban dan review-nya
  deletePengerjaan(pengerjaanId, guruId) {
    const pengerjaan = db.prepare(`
      SELECT p.id, p.ulangan_id, p.peserta_id, pes.nama as nama_siswa, pes.kelas as kelas_siswa, u.guru_id
      FROM pengerjaan p
      JOIN peserta pes ON p.peserta_id = pes.id
      JOIN ulangan u ON p.ulangan_id = u.id
      WHERE p.id = ?
    `).get(pengerjaanId);

    if (!pengerjaan) {
      throw new Error('Data pengerjaan tidak ditemukan');
    }
    if (pengerjaan.guru_id !== guruId) {
      throw new Error('Akses ditolak: ulangan ini bukan milik Anda');
    }

    const deleteTx = db.transaction(() => {
      // 1. Hapus review_guru terkait jawaban pengerjaan ini
      db.prepare(`
        DELETE FROM review_guru 
        WHERE jawaban_id IN (SELECT id FROM jawaban WHERE pengerjaan_id = ?)
      `).run(pengerjaanId);

      // 2. Hapus antrean_review terkait jawaban pengerjaan ini
      db.prepare(`
        DELETE FROM antrean_review 
        WHERE jawaban_id IN (SELECT id FROM jawaban WHERE pengerjaan_id = ?)
      `).run(pengerjaanId);

      // 3. Hapus jawaban pengerjaan ini
      db.prepare('DELETE FROM jawaban WHERE pengerjaan_id = ?').run(pengerjaanId);

      // 4. Hapus pengerjaan
      db.prepare('DELETE FROM pengerjaan WHERE id = ?').run(pengerjaanId);

      // 5. Bersihkan entri peserta jika tidak ada pengerjaan lain
      const remaining = db.prepare('SELECT COUNT(*) as count FROM pengerjaan WHERE peserta_id = ?').get(pengerjaan.peserta_id);
      if (remaining.count === 0) {
        db.prepare('DELETE FROM peserta WHERE id = ?').run(pengerjaan.peserta_id);
      }
    });

    deleteTx();

    return {
      success: true,
      message: `Data pengerjaan siswa ${pengerjaan.nama_siswa} (${pengerjaan.kelas_siswa}) berhasil dihapus.`
    };
  }
};

module.exports = reviewService;
