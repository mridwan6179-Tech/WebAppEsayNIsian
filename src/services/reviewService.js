const db = require('../config/database');
const examService = require('./examService');

const reviewService = {
  // Ambil daftar seluruh siswa/pengerjaan pada suatu ulangan
  getPengerjaanListByUlangan(ulanganId, guruId) {
    const ulangan = db.prepare('SELECT id FROM ulangan WHERE id = ? AND guru_id = ?').get(ulanganId, guruId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan atau bukan milik guru ini');

    const rows = db.prepare(`
      SELECT 
        p.id as pengerjaan_id,
        p.ulangan_id,
        p.peserta_id,
        p.status,
        p.started_at,
        p.submitted_at,
        p.nilai_ai,
        p.nilai_final,
        p.released_at,
        p.paste_count,
        pes.nama as nama_siswa,
        pes.kelas as kelas_siswa,
        COUNT(j.id) as total_jawaban,
        SUM(CASE WHEN j.status_penilaian = 'selesai' THEN 1 ELSE 0 END) as total_dinilai
      FROM pengerjaan p
      JOIN peserta pes ON p.peserta_id = pes.id
      LEFT JOIN jawaban j ON p.id = j.pengerjaan_id
      WHERE p.ulangan_id = ?
      GROUP BY p.id
      ORDER BY pes.kelas ASC, pes.nama ASC
    `).all(ulanganId);

    return rows;
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

    const jawabanList = db.prepare(`
      SELECT 
        j.id as jawaban_id,
        j.pengerjaan_id,
        j.soal_id,
        j.jawaban_siswa,
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

  // FR-22: Rilis hasil ujian ke siswa
  toggleReleasePengerjaan(ulanganId, guruId, isReleased) {
    const ulangan = db.prepare('SELECT id FROM ulangan WHERE id = ? AND guru_id = ?').get(ulanganId, guruId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan atau bukan milik guru ini');

    if (isReleased) {
      db.prepare(`
        UPDATE pengerjaan 
        SET released_at = CURRENT_TIMESTAMP 
        WHERE ulangan_id = ? AND status = 'submitted'
      `).run(ulanganId);
    } else {
      db.prepare(`
        UPDATE pengerjaan 
        SET released_at = NULL 
        WHERE ulangan_id = ?
      `).run(ulanganId);
    }

    return { success: true, isReleased };
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
