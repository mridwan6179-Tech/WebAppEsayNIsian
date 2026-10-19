const db = require('../config/database');
const packageService = require('./packageService');
const geminiService = require('./geminiService');

const omrService = {
  // Evaluasi dan hitung skor PG berdasarkan kunci jawaban paket
  scoreSubmission({ ulanganId, paket = 'A', answersMap = {} }) {
    const cleanPaket = (paket || 'A').toUpperCase().trim();
    const keyMap = packageService.getAnswerKey(ulanganId, cleanPaket);

    const questionNumbers = Object.keys(keyMap).map(Number).sort((a, b) => a - b);
    const totalSoal = questionNumbers.length;

    let totalBenar = 0;
    let totalSalah = 0;
    let totalKosong = 0;
    const details = [];

    for (const num of questionNumbers) {
      const kunci = (keyMap[String(num)] || '').toUpperCase().trim();
      const rawAns = answersMap[String(num)] || answersMap[num];
      const ans = rawAns ? String(rawAns).toUpperCase().trim() : '';

      let status = 'kosong';
      if (!ans) {
        totalKosong++;
        status = 'kosong';
      } else if (ans === kunci) {
        totalBenar++;
        status = 'benar';
      } else {
        totalSalah++;
        status = 'salah';
      }

      details.push({
        nomor: num,
        jawaban_siswa: ans || '-',
        kunci,
        status
      });
    }

    const skorPg = totalSoal > 0 ? Math.round((totalBenar / totalSoal) * 100 * 10) / 10 : 0;

    return {
      ulangan_id: ulanganId,
      paket: cleanPaket,
      total_soal: totalSoal,
      total_benar: totalBenar,
      total_salah: totalSalah,
      total_kosong: totalKosong,
      skor_pg: skorPg,
      detail_jawaban: details
    };
  },

  // Simpan hasil scan LJK kamera langsung ke rekap nilai peserta & pengerjaan
  saveScannedResult({ ulanganId, namaSiswa, kelas, paket = 'A', answersMap = {}, imageData = null }) {
    if (!namaSiswa || !String(namaSiswa).trim()) {
      throw new Error('Nama siswa wajib diisi');
    }
    const cleanNama = String(namaSiswa).trim();
    const cleanKelas = String(kelas || 'Umum').trim();
    const cleanPaket = (paket || 'A').toUpperCase().trim();

    const ulangan = db.prepare('SELECT * FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');

    // 1. Hitung skor PG
    const scoreResult = this.scoreSubmission({ ulanganId, paket: cleanPaket, answersMap });

    // 2. Cari atau buat record peserta
    let peserta = db.prepare(`
      SELECT id FROM peserta 
      WHERE ulangan_id = ? AND LOWER(nama) = LOWER(?) AND LOWER(kelas) = LOWER(?)
    `).get(ulanganId, cleanNama, cleanKelas);

    if (!peserta) {
      const pInfo = db.prepare(`
        INSERT INTO peserta (ulangan_id, nama, kelas)
        VALUES (?, ?, ?)
      `).run(ulanganId, cleanNama, cleanKelas);
      peserta = { id: pInfo.lastInsertRowid };
    }

    // 3. Cari atau buat record pengerjaan
    let pengerjaan = db.prepare(`
      SELECT id, skor_pg, skor_essay, nilai_final, status FROM pengerjaan
      WHERE ulangan_id = ? AND peserta_id = ?
    `).get(ulanganId, peserta.id);

    // Hitung nilai akhir gabungan (jika ulangan tipe campuran PG + Esai)
    const bobotPg = Number(ulangan.bobot_pg) || (ulangan.jenis_ulangan === 'pg_saja' ? 100 : 60);
    const bobotEssay = Number(ulangan.bobot_essay) || (ulangan.jenis_ulangan === 'pg_saja' ? 0 : 40);

    let nilaiFinal = scoreResult.skor_pg;
    if (ulangan.jenis_ulangan === 'campuran' && pengerjaan && pengerjaan.skor_essay !== null) {
      nilaiFinal = Math.round(((scoreResult.skor_pg * bobotPg / 100) + (pengerjaan.skor_essay * bobotEssay / 100)) * 10) / 10;
    } else if (ulangan.jenis_ulangan === 'campuran') {
      nilaiFinal = Math.round((scoreResult.skor_pg * bobotPg / 100) * 10) / 10;
    }

    let pengerjaanId;
    if (!pengerjaan) {
      const insPengerjaan = db.prepare(`
        INSERT INTO pengerjaan (
          ulangan_id, peserta_id, status, paket_diambil, skor_pg, nilai_final,
          metode_koreksi_pg, submitted_at
        ) VALUES (?, ?, 'submitted', ?, ?, ?, 'kamera_omr', CURRENT_TIMESTAMP)
      `).run(ulanganId, peserta.id, cleanPaket, scoreResult.skor_pg, nilaiFinal);
      pengerjaanId = insPengerjaan.lastInsertRowid;
    } else {
      pengerjaanId = pengerjaan.id;
      db.prepare(`
        UPDATE pengerjaan SET
          paket_diambil = ?,
          skor_pg = ?,
          nilai_final = ?,
          metode_koreksi_pg = 'kamera_omr',
          status = 'submitted',
          submitted_at = COALESCE(submitted_at, CURRENT_TIMESTAMP)
        WHERE id = ?
      `).run(cleanPaket, scoreResult.skor_pg, nilaiFinal, pengerjaanId);
    }

    // 4. Simpan rincian jawaban per butir ke tabel jawaban agar transparan bagi guru
    try {
      const pkg = db.prepare('SELECT urutan_soal_ids FROM paket_soal WHERE ulangan_id = ? AND UPPER(nama_paket) = UPPER(?)').get(ulanganId, cleanPaket);
      if (pkg && pkg.urutan_soal_ids) {
        const ids = JSON.parse(pkg.urutan_soal_ids);
        const upsertJawaban = db.prepare(`
          INSERT INTO jawaban (pengerjaan_id, soal_id, jawaban_siswa, skor_maksimum, skor_rekomendasi, status_jawaban, status_penilaian, alasan_ai)
          VALUES (?, ?, ?, ?, ?, ?, 'selesai', 'Diperiksa otomatis via Scanner Kamera LJK')
          ON CONFLICT(pengerjaan_id, soal_id) DO UPDATE 
          SET jawaban_siswa = excluded.jawaban_siswa,
              skor_maksimum = excluded.skor_maksimum,
              skor_rekomendasi = excluded.skor_rekomendasi,
              status_jawaban = excluded.status_jawaban,
              status_penilaian = 'selesai',
              alasan_ai = excluded.alasan_ai
        `);
        const getBobot = db.prepare('SELECT bobot FROM soal WHERE id = ?');
        for (const d of scoreResult.detail_jawaban) {
          const sId = ids[d.nomor - 1];
          if (sId) {
            const b = getBobot.get(sId)?.bobot || 1;
            const skorRek = d.status === 'benar' ? b : 0;
            upsertJawaban.run(pengerjaanId, sId, d.jawaban_siswa, b, skorRek, d.status);
          }
        }
      }
    } catch (errDet) {
      console.warn('⚠️ Gagal menyimpan rincian butir jawaban OMR:', errDet.message);
    }

    // 5. Catat log pemindaian OMR
    try {
      db.prepare(`
        INSERT INTO omr_scan_log (
          ulangan_id, pengerjaan_id, nama_siswa, kelas, paket, skor_pg,
          total_soal, total_benar, raw_answers, image_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ulanganId,
        pengerjaanId,
        cleanNama,
        cleanKelas,
        cleanPaket,
        scoreResult.skor_pg,
        scoreResult.total_soal,
        scoreResult.total_benar,
        JSON.stringify(answersMap),
        imageData ? String(imageData).slice(0, 1000) : null // simpan cuplikan ringkas/url jika ada
      );
    } catch (e) {
      console.warn('⚠️ Gagal menyimpan log omr:', e.message);
    }

    if (typeof db.syncCloud === 'function') db.syncCloud(true);

    return {
      success: true,
      pengerjaan_id: pengerjaanId,
      nama_siswa: cleanNama,
      kelas: cleanKelas,
      paket: cleanPaket,
      skor_pg: scoreResult.skor_pg,
      nilai_final: nilaiFinal,
      total_soal: scoreResult.total_soal,
      total_benar: scoreResult.total_benar,
      total_salah: scoreResult.total_salah,
      total_kosong: scoreResult.total_kosong,
      detail_jawaban: scoreResult.detail_jawaban
    };
  },

  // Fallback Evaluasi Gambar LJK via Gemini Vision AI jika kamera buram / terlipat (Adaptif Layout LJK)
  async evaluateOmrImageWithAI({ ulanganId, imageBase64, mimeType = 'image/jpeg', paketFallback = 'A', totalSoal = null, opsiCount = null, kolomCount = null }) {
    const ulangan = db.prepare('SELECT * FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');

    // 1. Tentukan paket fallback dan daftar paket yang sah
    const pkgs = db.prepare('SELECT nama_paket, kunci_jawaban_map, urutan_soal_ids FROM paket_soal WHERE ulangan_id = ? ORDER BY nama_paket ASC').all(ulanganId);
    const validPackages = pkgs.length > 0 
      ? pkgs.map(p => p.nama_paket) 
      : ['A', 'B', 'C', 'D'].slice(0, Math.max(1, Math.min(4, Number(ulangan.jumlah_paket) || 1)));

    const activePaket = (paketFallback && validPackages.includes(paketFallback.toUpperCase()))
      ? paketFallback.toUpperCase()
      : validPackages[0] || 'A';

    // 2. Hitung jumlah total butir soal pilihan ganda
    let targetSoalCount = Number(totalSoal) || 0;
    if (!targetSoalCount) {
      const activePkgRow = pkgs.find(p => p.nama_paket === activePaket);
      if (activePkgRow && activePkgRow.kunci_jawaban_map) {
        try {
          const kMap = JSON.parse(activePkgRow.kunci_jawaban_map);
          targetSoalCount = Object.keys(kMap).length;
        } catch (e) {}
      }
    }
    if (!targetSoalCount) {
      const pgCountRow = db.prepare(`
        SELECT COUNT(id) as cnt FROM soal 
        WHERE ulangan_id = ? AND (jenis = 'pilihan_ganda' OR (kunci_pg IS NOT NULL AND TRIM(kunci_pg) != ''))
      `).get(ulanganId);
      targetSoalCount = Number(pgCountRow?.cnt) || Number(ulangan.jumlah_soal) || 20;
    }

    // 3. Tentukan opsi jawaban (A-D untuk 4 opsi, A-E untuk 5 opsi)
    const effectiveOpsiCount = Number(opsiCount) === 5 || Number(ulangan.opsi_pg_count) === 5 ? 5 : 4;
    const allowedLetters = effectiveOpsiCount === 5 ? 'A, B, C, D, atau E' : 'A, B, C, atau D';

    const prompt = `Anda adalah asisten pemeriksa Lembar Jawab Komputer (LJK) pilihan ganda.
Periksa gambar lembar jawaban kertas ujian berikut ini dengan sangat cermat, teliti, dan presisi tinggi.

STRUKTUR & TATA LETAK LEMBAR LJK INI:
- Total Soal di Lembar: TEPAT ${targetSoalCount} BUTIR SOAL (Nomor 1 sampai ${targetSoalCount}).
- Pilihan Huruf per Soal: ${allowedLetters}.
- Pilihan Paket Soal pada Lembar: ${validPackages.join(', ')}.
- Format Grid: Disusun dalam kolom berurutan (misal kolom 1: No. 1 - ..., kolom 2: No. ... - ${targetSoalCount}).

TUGAS PEMERIKSAAN:
1. Baca identitas siswa pada kop LJK:
   - "nama_siswa": Nama siswa yang tertulis (string atau null bila kosong).
   - "kelas": Kelas atau sesi yang tertulis (string atau null bila kosong).
   - "nis": Nomor induk / peserta jika terisi (string atau null bila kosong).
2. Periksa bulatan "PAKET SOAL" di kanan atas:
   - Deteksi bulatan paket mana yang dihitamkan (${validPackages.join(' / ')}).
   - Jika tidak ada bulatan paket yang dihitamkan atau lembar tidak memiliki opsi paket, gunakan default "${activePaket}".
3. Periksa bulatan jawaban siswa secara berurutan DARI NOMOR 1 SAMPAI NOMOR ${targetSoalCount}:
   - Kenali huruf (${allowedLetters}) mana yang dihitamkan / diarsir penuh oleh siswa dengan pensil atau pulpen.
   - HANYA PERIKSA NOMOR 1 SAMPAI ${targetSoalCount}! JANGAN mengarang nomor di atas ${targetSoalCount}.
   - Jika suatu nomor tidak dihitamkan sama sekali oleh siswa (kosong), isi dengan string kosong "".
   - Jika ada dua bulatan dihitamkan pada satu nomor soal yang sama, anggap batal (isi dengan "GANDA").
4. Kembalikan HASIL HANYA dalam format JSON valid berikut tanpa penjelasan atau markdown tambahan:
{
  "nama_siswa": "Nama Terbaca / null",
  "kelas": "Kelas Terbaca / null",
  "nis": "NIS / null",
  "paket": "${activePaket}",
  "answers": {
    "1": "A",
    "2": "B"
  }
}
`;

    const parsed = await geminiService.callVisionJsonPrompt(prompt, imageBase64, mimeType);
    if (!parsed || !parsed.answers) {
      throw new Error('Gagal mengenali bulatan jawaban dari gambar LJK');
    }

    const paket = (parsed.paket || activePaket || 'A').toUpperCase().trim();
    const scored = this.scoreSubmission({
      ulanganId,
      paket,
      answersMap: parsed.answers
    });

    return {
      success: true,
      detected_info: {
        nama_siswa: parsed.nama_siswa || '',
        kelas: parsed.kelas || '',
        nis: parsed.nis || '',
        paket
      },
      answers: parsed.answers,
      jawaban_terdeteksi: parsed.answers,
      paket_terdeteksi: paket,
      scoring: scored
    };
  },

  // Ambil riwayat log scan OMR untuk satu ulangan
  getScanLogs(ulanganId) {
    return db.prepare(`
      SELECT * FROM omr_scan_log
      WHERE ulangan_id = ?
      ORDER BY scanned_at DESC
      LIMIT 100
    `).all(ulanganId);
  }
};

module.exports = omrService;
