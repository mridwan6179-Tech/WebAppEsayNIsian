const db = require('../config/database');
const examService = require('./examService');
const studentService = require('./studentService');

// Throttle pembersihan sesi kedaluwarsa agar tidak membebani database pada setiap request polling guru
const lastCleanAbandonedMap = new Map();

function normalizedStudentKey(name, kelas) {
  return `${String(name || '').trim().toLocaleLowerCase('id-ID')}::${String(kelas || '').trim().toLocaleLowerCase('id-ID')}`;
}

function scoreOfAttempt(row) {
  const value = row?.nilai_final ?? row?.nilai_ai;
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRemedialRatios(input) {
  if (input === null || input === undefined || input === '') return null;
  let raw = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch (e) { throw new Error('Format persentase tipe soal remedial tidak valid.'); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Persentase tipe soal remedial harus berupa objek.');
  }
  const aliases = { pilihan_ganda: 'pg_biasa', pg: 'pg_biasa', pg_biasa: 'pg_biasa', pg_kompleks: 'pg_kompleks', isian: 'isian', essay: 'essay', koding: 'koding_game', koding_game: 'koding_game' };
  const normalized = {};
  let total = 0;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = aliases[String(rawKey).trim().toLowerCase()];
    if (!key) throw new Error(`Tipe soal remedial tidak dikenal: ${rawKey}`);
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`Persentase tipe soal ${rawKey} harus berada di antara 0 dan 100`);
    }
    normalized[key] = value;
    total += value;
  }
  if (total > 100.0001) throw new Error('Total persentase tipe soal remedial tidak boleh melebihi 100%.');
  return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeRemedialStudentIds(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.map(Number).filter(value => Number.isInteger(value) && value > 0))).sort((a, b) => a - b);
}

function mergeDuplicateStudentRows(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = normalizedStudentKey(row.nama_siswa, row.kelas_siswa);
    const score = scoreOfAttempt(row);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...row,
        nilai_terbaik: row.nilai_terbaik ?? score,
        nilai_laporan: score,
        duplicate_name_count: 1
      });
      continue;
    }

    const existingScore = scoreOfAttempt(existing);
    const shouldReplace = (score !== null && (existingScore === null || score > existingScore))
      || (score !== null && existingScore === score && Number(row.pengerjaan_id) > Number(existing.pengerjaan_id));
    if (shouldReplace) {
      const replacement = {
        ...row,
        total_attempts: Number(existing.total_attempts || 0) + Number(row.total_attempts || 0),
        submitted_attempts: Number(existing.submitted_attempts || 0) + Number(row.submitted_attempts || 0),
        duplicate_name_count: Number(existing.duplicate_name_count || 1) + 1,
        nilai_terbaik: Math.max(existing.nilai_terbaik ?? -Infinity, row.nilai_terbaik ?? score ?? -Infinity),
        nilai_laporan: score
      };
      merged.set(key, replacement);
    } else {
      existing.total_attempts = Number(existing.total_attempts || 0) + Number(row.total_attempts || 0);
      existing.submitted_attempts = Number(existing.submitted_attempts || 0) + Number(row.submitted_attempts || 0);
      existing.duplicate_name_count = Number(existing.duplicate_name_count || 1) + 1;
      if (row.nilai_terbaik !== null && row.nilai_terbaik !== undefined) {
        existing.nilai_terbaik = Math.max(existing.nilai_terbaik ?? -Infinity, row.nilai_terbaik);
      }
      if (score !== null) existing.nilai_laporan = Math.max(existing.nilai_laporan ?? -Infinity, score);
    }
  }
  return Array.from(merged.values());
}

function generateShortSessionToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = '';
  for (let i = 0; i < 3; i++) token += chars.charAt(Math.floor(Math.random() * chars.length));
  return token;
}

const reviewService = {
  // Ambil daftar seluruh siswa/pengerjaan pada suatu ulangan
  getPengerjaanListByUlangan(ulanganId, guruId) {
    const ulangan = db.prepare('SELECT id, zona_waktu FROM ulangan WHERE id = ? AND guru_id = ?').get(ulanganId, guruId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan atau bukan milik guru ini');

    // Sinkronisasi background dengan Turso Cloud (dengan throttle wajar tanpa force)
    if (typeof db.syncCloud === 'function') {
      try {
        db.syncCloud(false);
      } catch (syncErr) {}
    }

    // Bersihkan sesi DC kosong (>1 jam) dan auto-submit sesi terisi yang kedaluwarsa (dibatasi maksimal 1x per 60 detik per ulangan)
    const now = Date.now();
    const lastClean = lastCleanAbandonedMap.get(Number(ulanganId)) || 0;
    if (now - lastClean > 60000) {
      lastCleanAbandonedMap.set(Number(ulanganId), now);
      try {
        studentService.cleanAbandonedSessions(ulanganId);
      } catch (cleanErr) {
        console.warn('[CLEANUP WARN]', cleanErr.message);
      }
    }

    const rows = db.prepare(`
      SELECT 
        p.id as pengerjaan_id,
        p.ulangan_id,
        p.peserta_id,
        p.sesi_id,
        p.attempt_ke,
        p.nilai_terbaik,
        COALESCE(us.nama_sesi, p.nama_sesi) as nama_sesi,
        us.kode_sesi,
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
        p.original_soal_ids,
        p.remedial_ke,
        p.is_in_remedial,
        p.pre_remedial_nilai_final,
        p.pre_remedial_nilai_ai,
        p.pre_remedial_submitted_at,
        p.pre_remedial_released_at,
        p.remedial_started_at,
        pes.nama as nama_siswa,
        pes.kelas as kelas_siswa,
        COUNT(j.id) as total_jawaban,
        SUM(CASE WHEN j.jawaban_siswa IS NOT NULL AND TRIM(j.jawaban_siswa) != '' THEN 1 ELSE 0 END) as total_terisi,
        SUM(CASE WHEN j.status_penilaian = 'selesai' THEN 1 ELSE 0 END) as total_dinilai,
        SUM(CASE WHEN j.status_penilaian = 'selesai' AND ABS(COALESCE(j.skor_maksimum, 0) - COALESCE(s.bobot, 0)) > 0.001 THEN 1 ELSE 0 END) as total_out_of_sync,
        CAST(ROUND((julianday('now') - julianday(COALESCE(p.last_active_at, p.started_at))) * 86400) AS INTEGER) as detik_sejak_aktif
      FROM pengerjaan p
      JOIN peserta pes ON p.peserta_id = pes.id
      LEFT JOIN ulangan_sesi us ON p.sesi_id = us.id
      LEFT JOIN jawaban j ON p.id = j.pengerjaan_id
      LEFT JOIN soal s ON j.soal_id = s.id
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
      if (r.original_soal_ids) {
        try {
          const origIds = JSON.parse(r.original_soal_ids);
          if (Array.isArray(origIds) && origIds.length > 0) {
            total_jawaban = origIds.length;
            parsedSoalIds = origIds.map(Number);
          }
        } catch (e) {}
      } else if (r.soal_ids) {
        try {
          const parsedIds = JSON.parse(r.soal_ids);
          if (Array.isArray(parsedIds) && parsedIds.length > 0) {
            parsedSoalIds = parsedIds.map(Number);
            total_jawaban = parsedIds.length;
          }
        } catch (e) {}
      }

      // Pastikan penyebut total_jawaban tidak pernah lebih kecil dari total_dinilai atau total_terisi
      total_jawaban = Math.max(total_jawaban, Number(r.total_dinilai || 0), Number(r.total_terisi || 0));

      let total_terisi = r.total_terisi || 0;
      let draft_lengkap = (total_jawaban > 0 && total_terisi >= total_jawaban);

      let total_dinilai = r.total_dinilai || 0;
      let nilai_ai = r.nilai_ai;
      let nilai_final = r.nilai_final;

      // Auto-recalculate jika seluruh butir soal sudah dinilai AI tapi nilai_ai belum tersimpan di pengerjaan,
      // atau jika terdeteksi bobot butir soal yang out-of-sync
      const needsRecalc = (total_jawaban > 0 && total_dinilai >= total_jawaban && (nilai_ai === null || nilai_ai === undefined))
                          || (Number(r.total_out_of_sync) > 0);
      if (needsRecalc) {
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

      const isRemedial = Boolean(Number(r.is_in_remedial) === 1 || (r.status !== 'submitted' && Number(r.remedial_ke) > 0));

      if (r.status !== 'submitted') {
        const diff = r.detik_sejak_aktif;
        // Batas toleransi heartbeat aktif: 45 detik (ping dikirim klien setiap 15 detik)
        if (diff !== null && diff !== undefined && diff >= 0 && diff <= 45) {
          status_kehadiran = 'aktif';
          terakhir_aktif_teks = isRemedial ? 'Sedang aktif mengerjakan perbaikan remedial' : 'Sedang aktif di lembar ujian (mengetik/online)';
          terakhir_aktif_teks_singkat = isRemedial ? 'Aktif Remedial' : 'Aktif';
        } else {
          status_kehadiran = 'dc';
          if (diff === null || diff === undefined || diff > 86400 * 30) {
            terakhir_aktif_teks = isRemedial ? 'Terputus saat remedial (keluar/tutup browser/offline)' : 'Terputus (keluar/tutup browser/offline)';
            terakhir_aktif_teks_singkat = isRemedial ? 'DC Remedial' : 'Keluar';
          } else if (diff < 60) {
            terakhir_aktif_teks = isRemedial ? `Terputus saat remedial (${diff} detik lalu)` : `Terputus (${diff} detik lalu)`;
            terakhir_aktif_teks_singkat = isRemedial ? `DC (${diff}s)` : `${diff}s lalu`;
          } else if (diff < 3600) {
            const m = Math.floor(diff / 60);
            terakhir_aktif_teks = isRemedial ? `Terputus saat remedial (${m} menit lalu)` : `Terputus (${m} menit lalu)`;
            terakhir_aktif_teks_singkat = isRemedial ? `DC (${m}m)` : `${m}m lalu`;
          } else {
            const h = Math.floor(diff / 3600);
            terakhir_aktif_teks = isRemedial ? `Terputus saat remedial (${h} jam lalu)` : `Terputus (${h} jam lalu)`;
            terakhir_aktif_teks_singkat = isRemedial ? `DC (${h}j)` : `${h}j lalu`;
          }
        }
      }

      const preNilaiFinal = r.pre_remedial_nilai_final !== null && r.pre_remedial_nilai_final !== undefined ? Number(r.pre_remedial_nilai_final) : null;
      const preNilaiAi = r.pre_remedial_nilai_ai !== null && r.pre_remedial_nilai_ai !== undefined ? Number(r.pre_remedial_nilai_ai) : null;
      const nilaiSebelumnya = preNilaiFinal ?? preNilaiAi;

      return {
        ...r,
        total_jawaban,
        total_terisi,
        draft_lengkap,
        total_dinilai,
        nilai_ai,
        nilai_final,
        is_in_remedial: isRemedial,
        remedial_ke: Number(r.remedial_ke || 0),
        pre_remedial_nilai_final: preNilaiFinal,
        pre_remedial_nilai_ai: preNilaiAi,
        nilai_sebelumnya: nilaiSebelumnya,
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
    if (Number(pengerjaan.guru_id) !== Number(guruId)) {
      throw new Error('Akses ditolak: bukan ulangan milik Anda');
    }

    // Sinkronkan dan pulihkan nilai otomatis jika ada perbedaan bobot soal
    try {
      const recalculated = this.recalculatePengerjaanTotal(pengerjaanId);
      if (recalculated) {
        pengerjaan.nilai_ai = recalculated.nilai_ai;
        pengerjaan.nilai_final = recalculated.nilai_final;
      }
    } catch (eRecalc) {}

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
        s.game_data,
        j.jawaban_koding,
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
  recalculatePengerjaanTotal(pengerjaanId, options = {}) {
    const jawabanItems = db.prepare(`
      SELECT j.id as jawaban_id, j.status_penilaian, j.skor_rekomendasi, j.skor_maksimum,
             s.bobot, s.jenis, rg.id as rg_id, rg.skor_final
      FROM jawaban j
      JOIN soal s ON j.soal_id = s.id
      LEFT JOIN review_guru rg ON j.id = rg.jawaban_id
      WHERE j.pengerjaan_id = ?
    `).all(pengerjaanId);

    if (!jawabanItems || jawabanItems.length === 0) {
      return { nilai_ai: 0, nilai_final: 0 };
    }

    // Auto-heal & synchronize jika bobot soal di tabel soal berbeda dari skor_maksimum saat penilaian
    let hasHealed = false;
    for (const item of jawabanItems) {
      const curBobot = Number(item.bobot) || 1;
      const oldMax = Number(item.skor_maksimum) || curBobot;

      if (item.status_penilaian === 'selesai' && oldMax > 0 && Math.abs(oldMax - curBobot) > 0.001) {
        const aiRatio = Math.max(0, Math.min(1, Number(item.skor_rekomendasi ?? 0) / oldMax));
        const newSkorAi = Math.min(curBobot, Math.max(0, Math.round(aiRatio * curBobot * 100) / 100));

        db.prepare('UPDATE jawaban SET skor_rekomendasi = ?, skor_maksimum = ? WHERE id = ?').run(newSkorAi, curBobot, item.jawaban_id);
        item.skor_rekomendasi = newSkorAi;
        item.skor_maksimum = curBobot;

        if (item.rg_id && item.skor_final !== null && item.skor_final !== undefined) {
          const guruRatio = Math.max(0, Math.min(1, Number(item.skor_final) / oldMax));
          const newSkorFinal = Math.min(curBobot, Math.max(0, Math.round(guruRatio * curBobot * 100) / 100));
          db.prepare('UPDATE review_guru SET skor_ai = ?, skor_final = ? WHERE id = ?').run(newSkorAi, newSkorFinal, item.rg_id);
          item.skor_final = newSkorFinal;
        }
        hasHealed = true;
      } else if (item.status_penilaian !== 'selesai' && Math.abs(oldMax - curBobot) > 0.001) {
        db.prepare('UPDATE jawaban SET skor_maksimum = ? WHERE id = ?').run(curBobot, item.jawaban_id);
        item.skor_maksimum = curBobot;
        hasHealed = true;
      }
    }

    // Cek konfigurasi jenis ulangan dan bobot campuran (PG + Esai + Koding) serta skor_langsung_ai
    const ulanganInfo = db.prepare(`
      SELECT u.jenis_ulangan, u.bobot_pg, u.bobot_essay, u.bobot_koding, u.skor_langsung_ai
      FROM pengerjaan p 
      JOIN ulangan u ON p.ulangan_id = u.id 
      WHERE p.id = ?
    `).get(pengerjaanId);

    const pgItems = jawabanItems.filter(item => item.jenis === 'pilihan_ganda');
    const kodingItems = jawabanItems.filter(item => item.jenis === 'koding_game');
    const essayItems = jawabanItems.filter(item => item.jenis !== 'pilihan_ganda' && item.jenis !== 'koding_game');

    let totalAiScore = 0;
    let totalFinalScore = 0;
    let skorPg = null;
    let skorKoding = null;
    let skorEssay = null;

    const existingPengerjaan = db.prepare('SELECT skor_pg, skor_koding FROM pengerjaan WHERE id = ?').get(pengerjaanId);
    const recordedSkorPg = (existingPengerjaan && existingPengerjaan.skor_pg !== null && existingPengerjaan.skor_pg !== undefined) ? Number(existingPengerjaan.skor_pg) : null;
    const recordedSkorKoding = (existingPengerjaan && existingPengerjaan.skor_koding !== null && existingPengerjaan.skor_koding !== undefined) ? Number(existingPengerjaan.skor_koding) : null;

    const hasMultiComponents = [
      pgItems.length > 0 || recordedSkorPg !== null,
      kodingItems.length > 0 || recordedSkorKoding !== null,
      essayItems.length > 0
    ].filter(Boolean).length > 1;

    if (ulanganInfo && (ulanganInfo.jenis_ulangan === 'campuran' || hasMultiComponents)) {
      const bPg = Number(ulanganInfo.bobot_pg) || 0;
      const bEs = Number(ulanganInfo.bobot_essay) || 0;
      const bKod = Number(ulanganInfo.bobot_koding) || 0;

      const aiPg = pgItems.length > 0
        ? examService.calculateNormalizedScore(pgItems.map(p => ({ bobot: p.bobot, skor_maksimum: p.skor_maksimum, skor_final: p.skor_rekomendasi ?? 0 })))
        : (recordedSkorPg ?? 0);
      const aiKod = kodingItems.length > 0
        ? examService.calculateNormalizedScore(kodingItems.map(p => ({ bobot: p.bobot, skor_maksimum: p.skor_maksimum, skor_final: p.skor_rekomendasi ?? 0 })))
        : (recordedSkorKoding ?? 0);
      const aiEs = essayItems.length > 0
        ? examService.calculateNormalizedScore(essayItems.map(p => ({ bobot: p.bobot, skor_maksimum: p.skor_maksimum, skor_final: p.skor_rekomendasi ?? 0 })))
        : 0;

      const finPg = pgItems.length > 0
        ? examService.calculateNormalizedScore(pgItems.map(p => ({ bobot: p.bobot, skor_maksimum: p.skor_maksimum, skor_final: p.skor_final ?? p.skor_rekomendasi ?? 0 })))
        : (recordedSkorPg ?? 0);
      const finKod = kodingItems.length > 0
        ? examService.calculateNormalizedScore(kodingItems.map(p => ({ bobot: p.bobot, skor_maksimum: p.skor_maksimum, skor_final: p.skor_final ?? p.skor_rekomendasi ?? 0 })))
        : (recordedSkorKoding ?? 0);
      const finEs = essayItems.length > 0
        ? examService.calculateNormalizedScore(essayItems.map(p => ({ bobot: p.bobot, skor_maksimum: p.skor_maksimum, skor_final: p.skor_final ?? p.skor_rekomendasi ?? 0 })))
        : 0;

      const effBPg = (pgItems.length > 0 || recordedSkorPg !== null) ? bPg : 0;
      const effBKod = (kodingItems.length > 0 || recordedSkorKoding !== null) ? bKod : 0;
      const effBEs = essayItems.length > 0 ? bEs : 0;
      const totalWeight = effBPg + effBKod + effBEs || 100;

      totalAiScore = Math.round((((aiPg * effBPg) + (aiKod * effBKod) + (aiEs * effBEs)) / totalWeight) * 100) / 100;
      totalFinalScore = Math.round((((finPg * effBPg) + (finKod * effBKod) + (finEs * effBEs)) / totalWeight) * 100) / 100;

      skorPg = (pgItems.length > 0 || recordedSkorPg !== null) ? finPg : null;
      skorKoding = (kodingItems.length > 0 || recordedSkorKoding !== null) ? finKod : null;
      skorEssay = essayItems.length > 0 ? finEs : null;
    } else {
      // Hitung total rekomendasi AI standar
      const aiItems = jawabanItems.map(item => ({
        bobot: item.bobot,
        skor_maksimum: item.skor_maksimum,
        skor_final: item.skor_rekomendasi ?? 0
      }));
      totalAiScore = examService.calculateNormalizedScore(aiItems);

      // Hitung total nilai final guru (jika belum direview, gunakan skor AI sebagai default)
      const finalItems = jawabanItems.map(item => ({
        bobot: item.bobot,
        skor_maksimum: item.skor_maksimum,
        skor_final: item.skor_final ?? item.skor_rekomendasi ?? 0
      }));
      totalFinalScore = examService.calculateNormalizedScore(finalItems);

      if (pgItems.length > 0) {
        skorPg = examService.calculateNormalizedScore(pgItems.map(p => ({ bobot: p.bobot, skor_maksimum: p.skor_maksimum, skor_final: p.skor_final ?? p.skor_rekomendasi ?? 0 })));
      }
      if (kodingItems.length > 0) {
        skorKoding = examService.calculateNormalizedScore(kodingItems.map(p => ({ bobot: p.bobot, skor_maksimum: p.skor_maksimum, skor_final: p.skor_final ?? p.skor_rekomendasi ?? 0 })));
      }
      if (essayItems.length > 0) {
        skorEssay = examService.calculateNormalizedScore(essayItems.map(p => ({ bobot: p.bobot, skor_maksimum: p.skor_maksimum, skor_final: p.skor_final ?? p.skor_rekomendasi ?? 0 })));
      }
    }

    const allGraded = jawabanItems.length > 0 && jawabanItems.every(item => item.status_penilaian === 'selesai');
    const shouldAutoRelease = options.checkAutoRelease !== false && Number(ulanganInfo?.skor_langsung_ai) === 1 && allGraded;

    if (shouldAutoRelease) {
      db.prepare(`
        UPDATE pengerjaan 
        SET nilai_ai = ?, nilai_final = ?,
            skor_pg = COALESCE(?, skor_pg),
            skor_koding = COALESCE(?, skor_koding),
            skor_essay = COALESCE(?, skor_essay),
            released_at = COALESCE(released_at, CURRENT_TIMESTAMP)
        WHERE id = ?
      `).run(totalAiScore, totalFinalScore, skorPg, skorKoding, skorEssay, pengerjaanId);
    } else {
      db.prepare(`
        UPDATE pengerjaan 
        SET nilai_ai = ?, nilai_final = ?,
            skor_pg = COALESCE(?, skor_pg),
            skor_koding = COALESCE(?, skor_koding),
            skor_essay = COALESCE(?, skor_essay)
        WHERE id = ?
      `).run(totalAiScore, totalFinalScore, skorPg, skorKoding, skorEssay, pengerjaanId);
    }

    try {
      const pRow = db.prepare('SELECT ulangan_id, peserta_id FROM pengerjaan WHERE id = ?').get(pengerjaanId);
      if (pRow) {
        const ulRow = db.prepare('SELECT kebijakan_nilai FROM ulangan WHERE id = ?').get(pRow.ulangan_id);
        const policy = ulRow?.kebijakan_nilai || 'tertinggi';
        const allAttempts = db.prepare(`
          SELECT nilai_final, nilai_ai FROM pengerjaan 
          WHERE ulangan_id = ? AND peserta_id = ? AND status = 'submitted'
          ORDER BY attempt_ke DESC, id DESC
        `).all(pRow.ulangan_id, pRow.peserta_id);
        let best = null;
        if (policy === 'terakhir') {
          best = allAttempts[0] ? (allAttempts[0].nilai_final ?? allAttempts[0].nilai_ai) : null;
        } else {
          const scores = allAttempts.map(a => Number(a.nilai_final ?? a.nilai_ai ?? 0));
          best = scores.length > 0 ? Math.max(...scores) : null;
        }
        if (best !== null) {
          db.prepare('UPDATE pengerjaan SET nilai_terbaik = ? WHERE ulangan_id = ? AND peserta_id = ?').run(best, pRow.ulangan_id, pRow.peserta_id);
        }
      }
    } catch (eBest) {}

    if ((hasHealed || shouldAutoRelease) && typeof db.syncCloud === 'function') {
      db.syncCloud(true);
    }

    return {
      nilai_ai: totalAiScore,
      nilai_final: totalFinalScore,
      auto_released: shouldAutoRelease
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
      const nowIso = new Date().toISOString();
      if (cleanKelas) {
        db.prepare(`
          UPDATE pengerjaan 
          SET status = 'submitted', submitted_at = COALESCE(submitted_at, ?), auto_submitted = 1
          WHERE ulangan_id = ? AND status = 'mengerjakan'
            AND id IN (SELECT DISTINCT pengerjaan_id FROM jawaban WHERE TRIM(COALESCE(jawaban_siswa, '')) != '')
            AND peserta_id IN (SELECT id FROM peserta WHERE LOWER(kelas) = LOWER(?))
        `).run(nowIso, ulanganId, cleanKelas);

        db.prepare(`
          UPDATE pengerjaan 
          SET released_at = CURRENT_TIMESTAMP 
          WHERE ulangan_id = ? AND status = 'submitted'
            AND peserta_id IN (SELECT id FROM peserta WHERE LOWER(kelas) = LOWER(?))
        `).run(ulanganId, cleanKelas);
      } else {
        db.prepare(`
          UPDATE pengerjaan 
          SET status = 'submitted', submitted_at = COALESCE(submitted_at, ?), auto_submitted = 1
          WHERE ulangan_id = ? AND status = 'mengerjakan'
            AND id IN (SELECT DISTINCT pengerjaan_id FROM jawaban WHERE TRIM(COALESCE(jawaban_siswa, '')) != '')
        `).run(nowIso, ulanganId);

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
        const countJawaban = db.prepare("SELECT COUNT(*) as count FROM jawaban WHERE pengerjaan_id = ? AND TRIM(COALESCE(jawaban_siswa, '')) != ''").get(pengerjaanId)?.count || 0;
        if (countJawaban === 0) {
          throw new Error(`Nilai siswa ${pengerjaan.nama_siswa} belum dapat dirilis karena ujian belum dikumpulkan`);
        }
        const nowIso = new Date().toISOString();
        db.prepare(`
          UPDATE pengerjaan 
          SET status = 'submitted', submitted_at = COALESCE(submitted_at, ?), auto_submitted = 1
          WHERE id = ?
        `).run(nowIso, pengerjaanId);
      }
      db.prepare(`
        UPDATE pengerjaan 
        SET released_at = CURRENT_TIMESTAMP 
        WHERE id = ?
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

  // Laporan Rekapitulasi Nilai per Kelas & per Ulangan untuk Dicetak (Mendukung Multi-Sesi)
  getLaporanNilai(ulanganId, guruId, kelasFilter = null, sesiFilter = null) {
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

    // Ambil semua sesi yang tersedia pada ulangan ini
    let sesiList = [];
    try {
      sesiList = db.prepare(`
        SELECT id, nama_sesi, kode_sesi, kelas, waktu_mulai, waktu_selesai, status
        FROM ulangan_sesi
        WHERE ulangan_id = ?
        ORDER BY waktu_mulai ASC, id ASC
      `).all(ulanganId);
    } catch (e) {}

    // Ambil peserta dan nilai
    let query = `
      SELECT 
        p.id as pengerjaan_id,
        p.sesi_id,
        p.attempt_ke,
        p.nilai_terbaik,
        COALESCE(us.nama_sesi, p.nama_sesi) as nama_sesi,
        us.kode_sesi,
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
      LEFT JOIN ulangan_sesi us ON p.sesi_id = us.id
      LEFT JOIN jawaban j ON p.id = j.pengerjaan_id
      WHERE p.ulangan_id = ?
    `;

    const params = [ulanganId];
    if (kelasFilter && kelasFilter.trim() !== '' && kelasFilter !== 'all') {
      query += ' AND pes.kelas = ?';
      params.push(kelasFilter.trim());
    }

    if (sesiFilter && sesiFilter.trim() !== '' && sesiFilter !== 'all') {
      query += ' AND (p.sesi_id = ? OR us.kode_sesi = ?)';
      params.push(sesiFilter.trim(), sesiFilter.trim());
    }

    query += `
      GROUP BY p.id
      ORDER BY pes.kelas ASC, pes.nama ASC
    `;

    const pesertaList = db.prepare(query).all(...params);

    // Kelompokkan per peserta_id agar siswa yang mengulang tidak dihitung ganda
    const policy = ulangan.kebijakan_nilai || 'tertinggi';
    const studentGroupMap = new Map();

    for (const p of pesertaList) {
      if (!studentGroupMap.has(p.peserta_id)) {
        studentGroupMap.set(p.peserta_id, []);
      }
      studentGroupMap.get(p.peserta_id).push(p);
    }

    const effectivePesertaList = [];
    studentGroupMap.forEach((attempts) => {
      // Urutkan attempts: attempt_ke DESC, id DESC
      attempts.sort((a, b) => (b.attempt_ke || 0) - (a.attempt_ke || 0) || b.pengerjaan_id - a.pengerjaan_id);

      const submitted = attempts.filter(a => a.status === 'submitted');
      let effective = attempts[0]; // fallback ke attempt terbaru jika belum ada yang submit

      if (submitted.length > 0) {
        if (policy === 'terakhir') {
          effective = submitted[0];
        } else {
          // 'tertinggi': ambil pengerjaan submitted dengan nilai tertinggi
          let highestAttempt = submitted[0];
          let highestVal = -1;
          for (const att of submitted) {
            const val = att.nilai_final !== null ? Number(att.nilai_final) : (att.nilai_ai !== null ? Number(att.nilai_ai) : -1);
            if (val > highestVal) {
              highestVal = val;
              highestAttempt = att;
            }
          }
          effective = highestAttempt;
        }
      }

      // Hitung nilai terbaik dari seluruh percobaan submitted
      const allScores = submitted.map(a => Number(a.nilai_final ?? a.nilai_ai ?? 0));
      const bestScore = allScores.length > 0 ? Math.max(...allScores) : null;

      effectivePesertaList.push({
        ...effective,
        total_attempts: attempts.length,
        submitted_attempts: submitted.length,
        attempt_ke: effective.attempt_ke || attempts.length,
        kebijakan_nilai: policy,
        nilai_terbaik: bestScore
      });
    });

    // Nama + kelas ganda bisa muncul sebagai beberapa peserta akibat percobaan
    // lama/import. Untuk laporan dan remedial gunakan satu baris dengan nilai
    // tertinggi agar identitas siswa tidak dihitung ganda.
    const deduplicatedPesertaList = mergeDuplicateStudentRows(effectivePesertaList);
    effectivePesertaList.length = 0;
    effectivePesertaList.push(...deduplicatedPesertaList);

    for (const row of effectivePesertaList) {
      const effectiveScore = row.nilai_laporan ?? scoreOfAttempt(row);
      row.nilai_terbaik = effectiveScore;
      row.is_tuntas = row.status === 'submitted' && effectiveScore !== null
        ? Number(effectiveScore) >= Number(ulangan.kkm || 75)
        : false;
      row.status_ketuntasan = effectiveScore === null
        ? 'belum_dinilai'
        : (row.is_tuntas ? 'tuntas' : 'belum_tuntas');
      row.eligible_remedial = row.status === 'submitted' && effectiveScore !== null && !row.is_tuntas;
    }

    // Urutkan kembali berdasarkan kelas dan nama siswa
    effectivePesertaList.sort((a, b) => {
      const classComp = (a.kelas_siswa || '').localeCompare(b.kelas_siswa || '', 'id', { sensitivity: 'base' });
      if (classComp !== 0) return classComp;
      return (a.nama_siswa || '').localeCompare(b.nama_siswa || '', 'id', { sensitivity: 'base' });
    });

    // Hitung statistik berdasarkan peserta unik
    let totalPeserta = effectivePesertaList.length;
    let submittedCount = 0;
    let scoredSubmittedCount = 0;
    let totalScore = 0;
    let highestScore = null;
    let lowestScore = null;
    const examKkm = ulangan.kkm || 75;
    let tuntasCount = 0;
    let belumTuntasCount = 0;

    // Perhitungan statistik tersegmentasi per sesi
    const sesiStatsMap = new Map();

    effectivePesertaList.forEach(st => {
      const sKey = st.sesi_id || 0;
      const sName = st.nama_sesi || 'Tanpa Sesi / Utama';
      if (!sesiStatsMap.has(sKey)) {
        sesiStatsMap.set(sKey, {
          sesi_id: st.sesi_id || null,
          nama_sesi: sName,
          kode_sesi: st.kode_sesi || '-',
          total_peserta: 0,
          submitted_count: 0,
          scored_count: 0,
          total_score: 0,
          tuntas_count: 0
        });
      }
      const sItem = sesiStatsMap.get(sKey);
      sItem.total_peserta++;

      if (st.status === 'submitted') {
        submittedCount++;
        sItem.submitted_count++;

        const finalScore = st.nilai_laporan ?? scoreOfAttempt(st);
        if (finalScore !== null) {
          scoredSubmittedCount++;
          sItem.scored_count++;
          totalScore += finalScore;
          sItem.total_score += finalScore;

          if (highestScore === null || finalScore > highestScore) highestScore = finalScore;
          if (lowestScore === null || finalScore < lowestScore) lowestScore = finalScore;
          if (finalScore >= examKkm) {
            tuntasCount++;
            sItem.tuntas_count++;
          } else {
            belumTuntasCount++;
          }
        }
      }
    });

    const averageScore = submittedCount > 0 ? Number((totalScore / submittedCount).toFixed(1)) : 0;
    const statistikSesi = Array.from(sesiStatsMap.values()).map(s => ({
      ...s,
      rata_rata: s.scored_count > 0 ? Number((s.total_score / s.scored_count).toFixed(1)) : 0
    }));

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
        maksimal_percobaan: (ulangan.maksimal_percobaan !== undefined && ulangan.maksimal_percobaan !== null) ? Number(ulangan.maksimal_percobaan) : 1,
        kebijakan_nilai: policy,
        created_at: ulangan.created_at,
        nama_guru: ulangan.nama_guru,
        email_guru: ulangan.email_guru
      },
      filter_kelas: kelasFilter || 'all',
      filter_sesi: sesiFilter || 'all',
      available_classes: kelasList,
      available_sesi: sesiList,
      statistik: {
        total_peserta: totalPeserta,
        total_submitted: submittedCount,
        rata_rata: scoredSubmittedCount > 0 ? Number((totalScore / scoredSubmittedCount).toFixed(1)) : 0,
        nilai_tertinggi: highestScore !== null ? highestScore : 0,
        nilai_terendah: lowestScore !== null ? lowestScore : 0,
        kkm: examKkm,
        tuntas_count: tuntasCount,
        belum_tuntas_count: belumTuntasCount
      },
      statistik_sesi: statistikSesi,
      peserta: effectivePesertaList
    };
  },

  getRemedialCandidates(ulanganId, guruId, classes = null, studentIds = null) {
    const laporan = this.getLaporanNilai(ulanganId, guruId);
    const selectedClasses = Array.isArray(classes)
      ? new Set(classes.map(item => String(item || '').trim().toLocaleLowerCase('id-ID')).filter(Boolean))
      : null;
    const selectedStudentIds = normalizeRemedialStudentIds(studentIds);
    const rows = laporan.peserta.filter(row => {
      if (row.status !== 'submitted') return false;
      if (selectedClasses && selectedClasses.size > 0 && !selectedClasses.has(String(row.kelas_siswa || '').trim().toLocaleLowerCase('id-ID'))) return false;
      const score = row.nilai_laporan ?? scoreOfAttempt(row);
      return score !== null;
    }).map(row => ({
      ...row,
      nilai_tertinggi: row.nilai_terbaik ?? scoreOfAttempt(row),
      isTuntas: Number(row.nilai_laporan ?? scoreOfAttempt(row)) >= Number(laporan.ulangan.kkm || 75)
    }));

    const selectedStudentSet = new Set(selectedStudentIds);
    const excluded = rows.filter(row => row.isTuntas || selectedStudentSet.has(Number(row.peserta_id)));
    return {
      ulangan: laporan.ulangan,
      selected_classes: selectedClasses ? Array.from(selectedClasses) : [],
      candidates: rows.filter(row => !row.isTuntas && !selectedStudentSet.has(Number(row.peserta_id))),
      tuntas: rows.filter(row => row.isTuntas),
      excluded,
      selected_student_ids: selectedStudentIds,
      total: rows.length
    };
  },

  createRemedialSession(ulanganId, guruId, options = {}) {
    const requestedClasses = Array.isArray(options.classes)
      ? options.classes.map(item => String(item || '').trim()).filter(Boolean)
      : [];
    const selectedStudentIds = normalizeRemedialStudentIds(options.student_ids || options.peserta_ids);
    const candidateReport = this.getRemedialCandidates(
      ulanganId,
      guruId,
      requestedClasses.length ? requestedClasses : null,
      selectedStudentIds.length ? selectedStudentIds : null
    );
    const selectedRows = candidateReport.candidates;
    const excludedRows = candidateReport.excluded;
    const classes = [];
    const classKeys = new Set();
    const addClass = (value) => {
      const display = String(value || '').trim();
      const key = display.toLocaleLowerCase('id-ID');
      if (display && !classKeys.has(key)) { classKeys.add(key); classes.push(display); }
    };
    if (requestedClasses.length > 0) requestedClasses.forEach(addClass);
    else selectedRows.concat(excludedRows).forEach(row => addClass(row.kelas_siswa));
    if (classes.length === 0) String(candidateReport.ulangan.tingkat_kelas || '').split(/[,;/]+/).forEach(addClass);
    if (classes.length === 0) throw new Error('Kelas remedial wajib dipilih.');
    const normalizedClasses = classes.map(item => item.toLocaleLowerCase('id-ID')).sort().join(',');
    const effectiveStudentIds = normalizeRemedialStudentIds([
      ...selectedStudentIds,
      ...excludedRows.map(row => row.peserta_id)
    ]);
    const normalizedRatios = normalizeRemedialRatios(options.question_ratios || options.remedial_question_ratios);
    const questionCount = options.question_count !== undefined && options.question_count !== null && options.question_count !== ''
      ? Math.max(1, Math.floor(Number(options.question_count))) : null;
    if (options.question_count !== undefined && options.question_count !== null && options.question_count !== '' && !Number.isFinite(Number(options.question_count))) {
      throw new Error('Jumlah soal remedial harus berupa angka.');
    }
    if (options.question_count !== undefined && options.question_count !== null && options.question_count !== '' && Number(options.question_count) <= 0) {
      throw new Error('Jumlah soal remedial minimal 1.');
    }
    const serializedRatios = normalizedRatios ? JSON.stringify(normalizedRatios) : null;
    const serializedStudentIds = effectiveStudentIds.length ? JSON.stringify(effectiveStudentIds) : null;
    const exam = db.prepare('SELECT zona_waktu FROM ulangan WHERE id = ? AND guru_id = ?').get(ulanganId, guruId);
    if (!exam) throw new Error('Ulangan tidak ditemukan atau akses ditolak');
    const normalizedStart = options.waktu_mulai ? examService.parseIndonesianDateTime(options.waktu_mulai, exam.zona_waktu || 'WIB') : null;
    const normalizedEnd = options.waktu_selesai ? examService.parseIndonesianDateTime(options.waktu_selesai, exam.zona_waktu || 'WIB') : null;
    if (options.waktu_mulai && !normalizedStart) throw new Error('Waktu mulai remedial tidak valid.');
    if (options.waktu_selesai && !normalizedEnd) throw new Error('Waktu selesai remedial tidak valid.');
    if (normalizedStart && normalizedEnd && new Date(normalizedStart) > new Date(normalizedEnd)) {
      throw new Error('Waktu mulai remedial tidak boleh melewati waktu selesai.');
    }
    const existing = db.prepare(`
      SELECT id
      FROM ulangan_sesi
      WHERE ulangan_id = ? AND LOWER(nama_sesi) LIKE 'remedial%'
        AND REPLACE(LOWER(COALESCE(kelas, '')), ', ', ',') = ? AND status = 'aktif'
        AND COALESCE(remedial_question_count, -1) = COALESCE(?, -1)
        AND COALESCE(remedial_question_ratios, '') = COALESCE(?, '')
        AND COALESCE(remedial_student_ids, '') = COALESCE(?, '')
        AND COALESCE(waktu_mulai, '') = COALESCE(?, '')
        AND COALESCE(waktu_selesai, '') = COALESCE(?, '')
      ORDER BY id DESC LIMIT 1
    `).get(ulanganId, normalizedClasses, questionCount, serializedRatios, serializedStudentIds, normalizedStart, normalizedEnd);

    let session;
    if (existing) {
      session = examService.getSesiById(existing.id, guruId);
    } else {
      let token = generateShortSessionToken();
      while (db.prepare('SELECT id FROM ulangan_sesi WHERE kode_sesi = ?').get(token)
        || db.prepare('SELECT id FROM ulangan WHERE kode_ujian = ?').get(token)) {
        token = generateShortSessionToken();
      }
      session = examService.createSesi(ulanganId, guruId, {
        nama_sesi: `Remedial - ${classes.join(', ')}`,
        kode_sesi: token,
        kelas: classes.join(', '),
        waktu_mulai: null,
        waktu_selesai: null,
        kuota_peserta: null,
        remedial_question_count: questionCount,
        remedial_question_ratios: normalizedRatios,
        remedial_student_ids: effectiveStudentIds,
        status: 'aktif'
      });
      if (normalizedStart || normalizedEnd) {
        session = examService.updateSesi(session.id, guruId, {
          waktu_mulai: normalizedStart,
          waktu_selesai: normalizedEnd,
          remedial_question_count: questionCount,
          remedial_question_ratios: serializedRatios,
          remedial_student_ids: effectiveStudentIds
        });
      }
    }

    const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    const link = `${baseUrl}/?kode=${encodeURIComponent(session.kode_sesi)}`;
    const geminiService = require('./geminiService');
    const whatsappText = geminiService.formatRemedialSessionWhatsApp({
      ulangan: candidateReport.ulangan,
      session,
      classes,
      candidates: selectedRows,
      excludedStudents: excludedRows,
      link,
      questionCount,
      questionRatios: normalizedRatios,
    });

    return {
      session,
      link,
      candidates: selectedRows,
      tuntas: candidateReport.tuntas,
      excluded: excludedRows,
      selected_student_ids: effectiveStudentIds,
      question_count: questionCount,
      question_ratios: normalizedRatios,
      whatsapp_text: whatsappText
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
