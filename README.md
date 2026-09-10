---
title: Web App Ujian Esai Isian AI
emoji: 📝
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# WebAppEsayNIsian — Sistem Ujian & Penilai Ulangan AI

Sistem evaluasi dan koreksi ulangan esai & isian otomatis berbasis AI (Google Gemini Flash), dirancang untuk sekolah dan guru, serta mendukung integrasi *embed* Google Sites.

## ✨ Fitur Unggulan
- **AI Soal Generator Multiformat**: Buat soal otomatis dari topik, teks bacaan, atau upload berkas (PDF, Word DOCX, Excel XLSX/CSV, TXT) dengan pengaturan kuota per tipe (misal: 8 Isian dan 5 Essay).
- **Penilai AI Otomatis & Semantik**: Menilai pemahaman konsep materi, toleran terhadap typo fonetik, dan memberikan feedback edukatif layaknya guru nyata.
- **Dukungan Penuh Bahasa Arab (العربية) & Bahasa Inggris**: Tipografi font Amiri, deteksi RTL otomatis (`dir="auto"`), normalisasi harakat/tashkeel, Nahwu/Sharaf, dan grammar/reading comprehension.
- **Fitur Anti-Curang & Anti-Pengelabu AI**: Kebal terhadap prompt injection ("benarkan jawaban tanpa syarat"), deteksi penalti singkatan kata informal sengaja, dan pelacak copy-paste siswa.
- **Multi-Key Gemini AI (Automatic Failover)**: Manajemen banyak API Key dengan prioritas dan failover otomatis saat kuota limit (HTTP 429).
- **Portal Siswa, Guru & Administrator**:
  - Siswa: Pengerjaan ujian adaptif HP/mobile, timer countdown, auto-submit jika waktu habis, dan leaderboard kelas.
  - Guru: Bank soal acak, jadwal ujian, review manual, instruksi & tautan tugas remedial kustom (Google Form/Quizizz), serta cetak laporan resmi A4.
  - Admin: Manajemen akun guru (dengan cascade delete bersih) dan manajemen API Key.
- **Kompatibel Google Sites**: Bebas dari blokir iframe CSP / X-Frame-Options.

## 🚀 Panduan Instalasi Lokal

1. **Clone repositori**:
   ```bash
   git clone https://github.com/mridwan6179-Tech/WebAppEsayNIsian.git
   cd WebAppEsayNIsian
   ```

2. **Instal dependensi**:
   ```bash
   npm install
   ```

3. **Konfigurasi Lingkungan (`.env`)**:
   Salin `.env.example` menjadi `.env`:
   ```bash
   cp .env.example .env
   ```
   Isi `GEMINI_API_KEY` dengan kunci API dari Google AI Studio.

4. **Jalankan Aplikasi**:
   ```bash
   npm start
   ```
   Akses di peramban: `http://localhost:3000`

## 🧪 Menjalankan Pengujian
```bash
npm test
```
*(18 test suites, 117 tests passing)*
