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

  // Fallback Evaluasi Gambar LJK via Gemini Vision AI jika kamera buram / terlipat
  async evaluateOmrImageWithAI({ ulanganId, imageBase64, mimeType = 'image/jpeg' }) {
    const ulangan = db.prepare('SELECT * FROM ulangan WHERE id = ?').get(ulanganId);
    if (!ulangan) throw new Error('Ulangan tidak ditemukan');

    const prompt = `Anda adalah asisten pemeriksa Lembar Jawab Komputer (LJK) pilihan ganda.
Periksa gambar lembar jawaban kertas ujian berikut ini dengan sangat cermat.

TUGAS ANDA:
1. Baca identitas siswa pada lembar:
   - Nama Siswa (bila tertulis)
   - Kelas (bila tertulis)
2. Periksa pilihan bulatan "PAKET SOAL" yang dihitamkan (biasanya opsi A, B, C, atau D). Jika tidak terlihat jelas, default ke "A".
3. Periksa nomor 1 sampai selesai pada grid bulatan jawaban:
   - Kenali huruf (A, B, C, D, atau E) mana yang dihitamkan/dilingkari oleh siswa.
   - Jika suatu nomor tidak dihitamkan sama sekali, abaikan atau beri nilai null.
   - Jika ada dua bulatan dihitamkan pada nomor yang sama, anggap batal/ganda (beri nilai "GANDA").
4. Kembalikan HASIL HANYA dalam format JSON valid berikut tanpa teks lain:
{
  "nama_siswa": "Nama Terbaca / null",
  "kelas": "Kelas Terbaca / null",
  "paket": "A",
  "answers": {
    "1": "A",
    "2": "C",
    "3": "B"
  }
}
`;

    const parsed = await geminiService.callVisionJsonPrompt(prompt, imageBase64, mimeType);
    if (!parsed || !parsed.answers) {
      throw new Error('Gagal mengenali bulatan jawaban dari gambar LJK');
    }

    const paket = (parsed.paket || 'A').toUpperCase().trim();
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
        paket
      },
      answers: parsed.answers,
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
