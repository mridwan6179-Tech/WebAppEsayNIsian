# Sistem Ulangan AI — CLAUDE.md
Versi: 0.1 | Tanggal: 10 September 2026 | Status: Draft

## 1. Ringkasan Proyek

Sistem Ulangan AI adalah web untuk guru membuat dan mengelola beberapa ulangan isian singkat dan essay, kemudian membagikannya kepada siswa melalui kode ulangan. Siswa mengisi nama, kelas, dan jawaban tanpa membuat akun, sedangkan guru login untuk membuat ulangan, melihat jawaban, menjalankan penilaian AI secara bertahap, meninjau rekomendasi nilai, dan merilis hasil.

Gemini digunakan sebagai alat bantu penilaian. Kunci jawaban guru menjadi acuan utama tetapi bukan batas mutlak: jawaban siswa yang berbeda dari kunci tetap dapat dinilai benar atau parsial jika secara makna, konsep, dan konteks menjawab soal dengan benar.

## 2. Tech Stack

- Platform: Web responsif (dioptimalkan untuk disematkan pada Google Sites via iframe/embed maupun akses langsung).
- Integrasi Google: Kompatibel dengan iframe Google Sites (header HTTP `frame-ancestors` mengizinkan `https://sites.google.com` dan `https://*.google.com`).
- Hosting: Dukungan hosting gratis ber-HTTPS (Render, Vercel, Railway, atau tunneling Cloudflare/ngrok saat pengujian lokal) untuk memenuhi syarat HTTPS iframe Google Sites.
- Backend/Runtime: Node.js (Express.js) — ringan, cepat, dan integrasi native dengan Google GenAI SDK.
- Database: SQLite (zero-config, portable, file-based) dengan opsi MySQL/MariaDB XAMPP jika diperlukan.
- AI: Google Gemini API melalui mekanisme pemilihan model dinamis dan fallback.
- Autentikasi: Login guru sederhana (berbasis password/kredensial di file `.env` & session/token untuk pemakaian pribadi); siswa tanpa akun permanen.
- Pengaturan: Disimpan di file `.env` (GEMINI_API_KEY, TEACHER_PASSWORD, PORT, dll.).
- Sistem tidak boleh mengunci implementasi pada satu nama model Gemini tertentu.

## 3. Perintah Penting (Commands)

- Run/development: `node server.js` atau `npm run dev`
- Test: `npm test`
- Deploy: Render / Railway / Vercel / Cloudflare Tunnel
- Konfigurasi: `.env` (isi `PORT`, `GEMINI_API_KEY`, `TEACHER_PASSWORD`)

## 4. Struktur Direktori

Struktur final mengikuti stack yang dipilih saat setup.

- `/src` — kode aplikasi utama.
- `/components` — komponen antarmuka yang digunakan ulang.
- `/pages` — halaman aplikasi.
- `/services` — layanan database, autentikasi, penilaian AI, dan proses antrean.
- `/tests` — pengujian.
- `/config` — konfigurasi aplikasi.
- `/docs` — dokumentasi teknis tambahan jika diperlukan.

AI coding HARUS memperbarui §13 ketika struktur nyata berbeda dari struktur awal ini.

## 5. Lingkup

### 5.1 Di Dalam Lingkup

1. Guru login.
2. Guru membuat dan mengelola beberapa ulangan.
3. Setiap ulangan memiliki identitas, mata pelajaran, kelas/tingkat, status, dan kode akses.
4. Guru membuat soal isian singkat dan essay.
5. Setiap soal memiliki bobot.
6. Total nilai ulangan dinormalisasi menjadi maksimum 100.
7. Guru dapat memberikan kunci jawaban.
8. Guru dapat memberikan rubrik jika diperlukan.
9. AI dapat membuat/membantu membentuk kriteria penilaian dari soal jika guru tidak memberikan rubrik lengkap.
10. Kunci jawaban guru menjadi acuan, tetapi AI boleh menerima jawaban valid di luar redaksi kunci.
11. Siswa masuk menggunakan kode ulangan dan mengisi nama serta kelas.
12. Siswa mengerjakan soal dan mengirimkan jawaban.
13. Jawaban siswa disimpan terlebih dahulu tanpa ketergantungan pada proses Gemini.
14. Guru dapat memilih memulai proses review AI setelah jawaban terkumpul.
15. Review AI menggunakan antrean dan memproses jawaban secara bertahap.
16. Sistem memberikan jeda antar-request Gemini.
17. Sistem menggunakan adaptive delay ketika terjadi indikasi rate limit atau error sementara.
18. Hasil AI disimpan sehingga jawaban yang sudah berhasil dinilai tidak dikirim ulang tanpa alasan.
19. Proses review dapat dihentikan dan dilanjutkan.
20. Guru melihat skor rekomendasi AI dan alasan penilaiannya.
21. Guru dapat menerima atau mengubah skor rekomendasi.
22. Nilai final ditentukan guru.
23. Guru dapat merilis hasil kepada siswa.
24. Siswa dapat melihat hasil setelah hasil dirilis.
25. Sistem memilih model Gemini berdasarkan model yang tersedia saat runtime/setup, bukan berdasarkan satu nama model permanen.
26. Sistem dapat memilih kandidat model yang memenuhi kebutuhan dengan prioritas penggunaan resource/quota yang rendah.
27. Sistem memiliki fallback untuk kandidat model lain yang memenuhi persyaratan jika model terpilih gagal digunakan.

### 5.2 Di Luar Lingkup

1. Siswa tidak memiliki akun permanen pada versi awal.
2. Sistem tidak membuat soal secara otomatis sebagai fitur utama.
3. Sistem tidak menggantikan keputusan akhir guru.
4. Sistem tidak menjadikan kunci jawaban sebagai satu-satunya cara menentukan benar/salah.
5. Sistem tidak memproses seluruh jawaban kelas dalam satu request Gemini.
6. Sistem tidak mengirim ulang jawaban yang sudah berhasil dinilai hanya karena halaman dibuka kembali.
7. Sistem tidak mengunci aplikasi pada satu model Gemini tertentu.
8. Sistem tidak menjamin quota Gemini gratis tanpa batas.
9. Sistem tidak membangun fitur pembayaran.
10. Sistem tidak membangun LMS lengkap.
11. Sistem tidak mencakup ujian pilihan ganda pada versi awal kecuali disetujui kemudian.
12. Sistem tidak mengubah lingkup, stack, atau model data utama tanpa konfirmasi pengguna.

## 6. Model Data & Relasi Database

### Guru

Kolom utama:
- `id` — PK.
- `email` — identitas login.
- `nama` — nama guru.
- `created_at`.
- `updated_at`.

### Ulangan

Kolom utama:
- `id` — PK.
- `guru_id` — FK ke Guru.
- `judul`.
- `mata_pelajaran`.
- `tingkat_kelas`.
- `deskripsi`.
- `kode_ujian` — unik.
- `status` — draft/dibuka/ditutup/selesai.
- `tanggal_mulai` — nullable jika tidak digunakan.
- `tanggal_selesai` — nullable jika tidak digunakan.
- `created_at`.
- `updated_at`.

### Soal

Kolom utama:
- `id` — PK.
- `ulangan_id` — FK ke Ulangan.
- `nomor`.
- `jenis` — isian/essay.
- `pertanyaan`.
- `kunci_jawaban` — dapat kosong jika guru memilih penilaian berbasis soal/rubrik AI.
- `rubrik` — nullable.
- `bobot`.
- `tingkat_kelas`.
- `tingkat_kesulitan`.
- `urutan`.

### Peserta

Kolom utama:
- `id` — PK.
- `ulangan_id` — FK ke Ulangan.
- `nama`.
- `kelas`.
- `created_at`.

Peserta tidak memerlukan akun permanen pada versi awal.

### Pengerjaan

Kolom utama:
- `id` — PK.
- `ulangan_id` — FK ke Ulangan.
- `peserta_id` — FK ke Peserta.
- `status`.
- `started_at`.
- `submitted_at`.
- `nilai_ai`.
- `nilai_final`.
- `released_at`.

### Jawaban

Kolom utama:
- `id` — PK.
- `pengerjaan_id` — FK ke Pengerjaan.
- `soal_id` — FK ke Soal.
- `jawaban_siswa`.
- `status_penilaian` — menunggu/diproses/selesai/gagal.
- `skor_rekomendasi`.
- `skor_maksimum`.
- `status_jawaban` — benar/parsial/salah/perlu_review.
- `alasan_ai`.
- `model_ai`.
- `attempt_count`.
- `last_error`.
- `reviewed_at`.

### Review Guru

Kolom utama:
- `id` — PK.
- `jawaban_id` — FK ke Jawaban.
- `guru_id` — FK ke Guru.
- `skor_ai`.
- `skor_final`.
- `keputusan` — diterima/diubah.
- `catatan_guru`.
- `reviewed_at`.

### Antrean Review AI

Kolom utama:
- `id` — PK.
- `jawaban_id` — FK ke Jawaban.
- `status` — menunggu/diproses/selesai/gagal.
- `attempt_count`.
- `next_attempt_at`.
- `locked_at`.
- `completed_at`.
- `error_message`.

### Konfigurasi AI

Kolom utama:
- `id` — PK.
- `model_ai`.
- `status`.
- `priority`.
- `last_tested_at`.
- `last_success_at`.
- `last_error`.
- `delay_normal`.
- `delay_rate_limit`.
- `max_retry`.

### Relasi

**Guru—Ulangan**, 1-N.  
Satu guru dapat membuat banyak ulangan. Penghapusan guru harus `restrict` atau mekanisme soft-delete agar data ulangan tidak hilang tanpa konfirmasi.

**Ulangan—Soal**, 1-N.  
Satu ulangan memiliki banyak soal. Penghapusan ulangan dapat menghapus soal terkait melalui `cascade` hanya jika guru mengonfirmasi penghapusan ulangan.

**Ulangan—Peserta**, 1-N.  
Satu ulangan dapat dikerjakan banyak peserta. Peserta terikat pada ulangan tertentu.

**Peserta—Pengerjaan**, 1-N.  
Satu peserta dapat memiliki riwayat pengerjaan sesuai aturan ulangan. Untuk versi awal, satu kode ulangan + satu peserta harus memiliki maksimal satu pengerjaan aktif.

**Pengerjaan—Jawaban**, 1-N.  
Satu pengerjaan memiliki jawaban untuk setiap soal yang dikerjakan.

**Soal—Jawaban**, 1-N.  
Satu soal dapat memiliki jawaban dari banyak peserta.

**Jawaban—Review Guru**, 1-1 atau 1-N sesuai riwayat revisi yang diterapkan. Review guru digunakan untuk mencatat keputusan terhadap rekomendasi AI.

**Jawaban—Antrean Review AI**, 1-1.  
Satu jawaban hanya memiliki satu pekerjaan antrean aktif agar tidak terjadi penilaian ganda.

## 7. Kebutuhan Fungsional

### Modul Guru

**FR-01 — Login Guru**  
Sistem HARUS mengautentikasi guru KETIKA guru membuka fungsi pengelolaan ulangan.

Acceptance criteria:
- Pengguna tanpa autentikasi tidak dapat membuat atau mengubah ulangan.
- Guru yang berhasil login dapat mengakses ulangan miliknya.
- Guru tidak dapat mengakses data ulangan guru lain.

**FR-02 — Banyak Ulangan**  
Sistem HARUS memungkinkan satu guru membuat dan mengelola lebih dari satu ulangan KETIKA guru membutuhkan ulangan berbeda.

Acceptance criteria:
- Setiap ulangan memiliki ID unik.
- Setiap ulangan memiliki kode akses unik.
- Guru dapat melihat daftar ulangan miliknya.

**FR-03 — Membuat Ulangan**  
Sistem HARUS membuat data ulangan KETIKA guru mengisi informasi minimum ulangan.

Acceptance criteria:
- Judul, mata pelajaran, dan tingkat kelas tersimpan.
- Ulangan mendapat ID dan kode akses.
- Ulangan baru berstatus `draft`.

**FR-04 — Membuat Soal**  
Sistem HARUS menyimpan soal isian atau essay KETIKA guru memasukkan pertanyaan, bobot, dan data penilaian.

Acceptance criteria:
- Jenis soal tersimpan.
- Bobot harus lebih besar dari 0.
- Soal memiliki urutan.
- Kunci jawaban dapat disimpan.
- Rubrik dapat disimpan jika guru menggunakannya.

**FR-05 — Normalisasi Nilai**  
Sistem HARUS menghitung nilai akhir dengan maksimum 100 KETIKA total bobot soal tidak sama dengan 100.

Acceptance criteria:
- Sistem menghitung skor berdasarkan bobot.
- Sistem menormalisasi total menjadi 0–100.
- Tidak ada nilai akhir lebih besar dari 100.

### Modul Siswa

**FR-06 — Masuk Ulangan**  
Sistem HARUS memvalidasi kode ulangan KETIKA siswa memasukkan kode akses.

Acceptance criteria:
- Kode valid membuka ulangan yang sedang tersedia.
- Kode tidak valid ditolak.
- Ulangan yang sudah ditutup tidak dapat menerima pengerjaan baru.

**FR-07 — Identitas Siswa**  
Sistem HARUS meminta nama dan kelas KETIKA siswa memulai pengerjaan.

Acceptance criteria:
- Nama wajib diisi.
- Kelas wajib diisi.
- Data tersimpan bersama pengerjaan.

**FR-08 — Submit Jawaban**  
Sistem HARUS menyimpan seluruh jawaban siswa KETIKA siswa menekan submit.

Acceptance criteria:
- Jawaban tersimpan sebelum proses AI dimulai.
- Submit tidak memerlukan respons Gemini.
- Pengerjaan mendapat status `submitted`.
- Waktu submit tersimpan.

### Modul Penilaian AI

**FR-09 — Antrean Penilaian**  
Sistem HARUS memasukkan jawaban yang belum dinilai ke antrean KETIKA guru mengaktifkan review AI.

Acceptance criteria:
- Satu jawaban memiliki maksimal satu pekerjaan antrean aktif.
- Jawaban yang sudah `selesai` tidak dimasukkan kembali.
- Antrean mencatat status setiap jawaban.

**FR-10 — Penilaian Bertahap**  
Sistem HARUS memproses maksimal satu pekerjaan AI aktif pada satu waktu untuk satu antrean review KETIKA review AI berjalan.

Acceptance criteria:
- Sistem tidak mengirim seluruh jawaban kelas dalam satu request.
- Setiap jawaban diproses secara individual.
- Status jawaban berubah dari `menunggu` → `diproses` → `selesai` atau `gagal`.

**FR-11 — Jeda Request**  
Sistem HARUS memberikan jeda antar-request Gemini KETIKA satu jawaban selesai diproses.

Acceptance criteria:
- Request berikutnya tidak dikirim sebelum delay selesai.
- Durasi delay dapat dikonfigurasi.
- Delay tidak menyebabkan jawaban yang telah selesai diproses ulang.

**FR-12 — Adaptive Delay**  
Sistem HARUS memperpanjang jeda KETIKA Gemini memberikan indikasi rate limit atau error sementara.

Acceptance criteria:
- Sistem mencatat error.
- Sistem menjadwalkan percobaan berikutnya.
- Delay rate-limit lebih besar daripada delay normal.
- Sistem tidak melakukan retry tanpa batas.

**FR-13 — Resume Review**  
Sistem HARUS melanjutkan review dari jawaban yang belum selesai KETIKA proses sebelumnya berhenti.

Acceptance criteria:
- Jawaban berstatus `selesai` tidak diproses ulang.
- Jawaban `menunggu` dapat dilanjutkan.
- Jawaban `gagal` dapat dijadwalkan retry sesuai batas.
- Guru dapat melihat jumlah selesai dan tersisa.

**FR-14 — Penilaian Berdasarkan Makna**  
Sistem HARUS mengevaluasi kesesuaian makna jawaban siswa terhadap tuntutan soal KETIKA AI menilai jawaban.

Acceptance criteria:
- Perbedaan redaksi tidak otomatis dianggap salah.
- Typo yang tidak mengubah makna tidak otomatis mengurangi skor.
- Sinonim yang sesuai konteks dapat dianggap benar.
- Jawaban yang benar secara konsep tetapi tidak terdapat secara literal dalam kunci dapat memperoleh skor.
- Jawaban yang bertentangan dengan konsep yang diminta tidak boleh diberi skor benar hanya karena mengandung kata yang sama dengan kunci.

**FR-15 — Kunci Jawaban Sebagai Acuan**  
Sistem HARUS memberikan kunci jawaban guru sebagai konteks penilaian KETIKA guru menyediakan kunci.

Acceptance criteria:
- AI menerima soal dan kunci sebagai konteks.
- AI tidak dipaksa melakukan exact string matching.
- AI dapat merekomendasikan jawaban di luar kunci sebagai benar jika alasan semantiknya memenuhi tuntutan soal.

**FR-16 — Penilaian Parsial**  
Sistem HARUS memberikan skor parsial KETIKA jawaban hanya memenuhi sebagian kriteria.

Acceptance criteria:
- Skor tidak boleh kurang dari 0.
- Skor tidak boleh melebihi bobot soal.
- AI memberikan alasan singkat.
- Guru dapat mengubah skor.

**FR-17 — Tingkat Pendidikan**  
Sistem HARUS memberikan tingkat kelas dan tingkat kesulitan sebagai konteks penilaian KETIKA data tersebut tersedia.

Acceptance criteria:
- Tingkat kelas tersimpan pada soal/ulangan.
- Tingkat kesulitan tersimpan pada soal.
- Informasi tersebut dikirim sebagai konteks penilaian AI.

**FR-18 — Model Gemini Dinamis**  
Sistem HARUS menentukan kandidat model dari model Gemini yang tersedia KETIKA aplikasi membutuhkan model AI.

Acceptance criteria:
- Sistem tidak bergantung pada satu nama model permanen.
- Model kandidat disaring berdasarkan kemampuan yang dibutuhkan.
- Model yang gagal digunakan dapat diganti kandidat lain.
- Sistem mencatat model yang digunakan untuk setiap penilaian.

**FR-19 — Efisiensi Context AI**  
Sistem HARUS mengirim hanya konteks yang diperlukan untuk satu penilaian KETIKA memproses satu jawaban.

Acceptance criteria:
- Request tidak mengirim seluruh database.
- Request minimal memuat soal, tipe soal, bobot, tingkat, kunci/rubrik jika tersedia, dan jawaban siswa.
- Hasil AI disimpan sehingga penilaian berhasil tidak perlu diulang.

### Modul Review Guru

**FR-20 — Review Rekomendasi**  
Sistem HARUS menampilkan skor rekomendasi AI dan alasan KETIKA guru membuka hasil review.

Acceptance criteria:
- Guru dapat melihat jawaban siswa.
- Guru dapat melihat skor AI.
- Guru dapat melihat alasan AI.
- Guru dapat menerima atau mengubah skor.

**FR-21 — Nilai Final**  
Sistem HARUS menetapkan nilai final KETIKA guru menerima atau mengubah rekomendasi AI.

Acceptance criteria:
- Nilai final berbeda dari skor AI jika guru mengubahnya.
- Nilai final tidak melebihi bobot soal.
- Sistem menyimpan keputusan guru.

**FR-22 — Rilis Nilai**  
Sistem HARUS menyembunyikan nilai siswa KETIKA guru belum merilis hasil.

Acceptance criteria:
- Siswa tidak dapat melihat nilai sebelum status rilis.
- Setelah dirilis, siswa dapat melihat nilai miliknya.
- Siswa tidak dapat melihat nilai siswa lain.

### Modul Hasil

**FR-23 — Nilai Ulangan**  
Sistem HARUS menghitung nilai total siswa KETIKA seluruh jawaban yang relevan memiliki nilai final.

Acceptance criteria:
- Nilai maksimum 100.
- Perhitungan menggunakan bobot soal.
- Nilai dapat dibedakan antara rekomendasi AI dan nilai final.

## 8. Kebutuhan Non-Fungsional

**NFR-01 — Ketahanan Submit**  
Sistem HARUS menyimpan jawaban siswa tanpa menunggu proses Gemini selesai.

**NFR-02 — Antrean AI**  
Sistem HARUS memproses maksimal satu request AI aktif per antrean review kelas pada versi awal.

**NFR-03 — Delay AI**  
Sistem HARUS memberikan delay acak 5–13 detik antar-request secara adaptif untuk menjaga batas quota Gemini free-tier. Nilai rentang dapat dikonfigurasi melalui `.env` atau konstanta setting.

**NFR-04 — Retry**  
Sistem HARUS membatasi retry error sementara dengan jumlah maksimum yang dapat dikonfigurasi.

**NFR-05 — Rate Limit**  
Sistem HARUS memperpanjang interval retry ketika menerima indikasi rate limit dari provider.

**NFR-06 — Idempotensi**  
Sistem HARUS mencegah jawaban dengan status `selesai` diproses ulang oleh antrean normal.

**NFR-07 — Audit Penilaian**  
Sistem HARUS menyimpan model AI, waktu penilaian, skor AI, alasan AI, jumlah percobaan, dan keputusan guru untuk setiap jawaban yang dinilai.

**NFR-08 — Nilai**  
Sistem HARUS membatasi skor soal pada rentang 0 sampai bobot soal.

**NFR-09 — Privasi**  
Sistem HARUS membatasi akses data pengerjaan kepada guru pemilik ulangan dan siswa hanya kepada pengerjaannya sendiri.

**NFR-10 — Skala MVP**  
Sistem HARUS mendukung sekurang-kurangnya 20 peserta dalam satu ulangan tanpa mengirim seluruh jawaban peserta dalam satu request AI.

**NFR-11 — Recovery**  
Sistem HARUS dapat melanjutkan antrean setelah proses berhenti tanpa mengulang jawaban yang sudah berstatus `selesai`.

**NFR-12 — Provider AI**  
Sistem HARUS menghindari ketergantungan permanen pada nama model Gemini tertentu karena daftar model dan kebijakan quota dapat berubah.

**NFR-13 — Kompatibilitas**  
Web harus dapat digunakan pada browser modern desktop dan mobile yang mendukung JavaScript standar `[daftar versi minimum perlu konfirmasi]`.

**NFR-14 — Hosting**  
Versi MVP harus dapat dijalankan menggunakan layanan hosting gratis yang dipilih pada tahap setup, selama quota layanan tersebut memenuhi kebutuhan MVP.

## 9. Konvensi & Guardrails

### 9.1 Boleh Dilakukan AI tanpa konfirmasi

- Memperbaiki bug yang menyebabkan acceptance criteria gagal.
- Membuat test untuk requirement yang sudah disetujui.
- Melakukan refactor tanpa mengubah perilaku yang disetujui.
- Menambah logging yang tidak menyimpan data sensitif.
- Mengoptimalkan request AI selama hasil penilaian dan acceptance criteria tetap sama.
- Mengubah implementasi antrean selama prinsip satu-per-satu, delay, retry terbatas, dan resume tetap terpenuhi.
- Mengganti kandidat model Gemini ketika model yang tersedia berubah, selama memenuhi FR-18.
- Menambahkan validasi input yang mencegah data tidak valid tanpa mengubah alur bisnis.

### 9.2 Tidak Boleh Tanpa Konfirmasi

- Mengubah tujuan utama aplikasi.
- Menambahkan jenis ujian utama di luar lingkup.
- Mengubah guru menjadi pengguna yang tidak wajib login.
- Membuat akun permanen siswa.
- Menghilangkan review guru.
- Menjadikan skor AI otomatis sebagai nilai final.
- Menghapus kunci/rubrik sebagai konteks penilaian.
- Mengubah prinsip bahwa jawaban valid di luar redaksi kunci dapat memperoleh nilai.
- Menghapus antrean atau delay AI.
- Mengubah model data utama.
- Mengganti database utama.
- Mengganti tech stack.
- Menambahkan layanan berbayar.
- Menghapus NFR.
- Menonaktifkan pencatatan hasil AI.
- Mengirim seluruh jawaban kelas dalam satu request Gemini.

### 9.3 Aturan Saat Ragu

**Bertanya ke pengguna, DILARANG menebak diam-diam.**

## 10. Wajib Uji Internal Tiap Modul/CRUD

Setelah satu modul/CRUD selesai ditulis, AI coding WAJIB, SEBELUM lanjut modul berikutnya:

- Jalankan uji create/read/update/delete atau alur utama jika bukan CRUD.
- Verifikasi setiap acceptance criteria FR terkait lolos.
- Uji kasus gagal dan edge case dasar.
- Untuk modul AI, uji jawaban benar, typo, sinonim, jawaban parsial, jawaban berbeda dari kunci tetapi benar secara konsep, dan jawaban salah.
- Uji bahwa submit siswa tetap berhasil ketika Gemini tidak tersedia.
- Uji bahwa proses AI berjalan satu per satu.
- Uji bahwa delay diterapkan.
- Uji retry ketika terjadi rate limit/error sementara.
- Uji penghentian dan pelanjutan antrean.
- Uji bahwa jawaban selesai tidak diproses ulang.
- Uji normalisasi nilai menjadi maksimum 100.
- Modul dianggap selesai HANYA jika lolos uji — bukan hanya kode ditulis.
- Catat hasil uji (lolos/gagal + ringkasan) di §12 sebelum lanjut.

## 11. Rencana Tugas (Tasks)

Tugas harus kecil dan dapat selesai dalam satu sesi.

| ID | Terkait FR | Dependensi | File yang disentuh | Kriteria Selesai |
|---|---|---|---|---|
| T-01 | FR-01 | Tech stack | Rujuk §13 | Login guru berjalan dan lulus §10 |
| T-02 | FR-02–FR-05 | T-01 | Rujuk §13 | CRUD ulangan dan soal berjalan dan lulus §10 |
| T-03 | FR-06–FR-08 | T-02 | Rujuk §13 | Alur siswa masuk sampai submit berjalan dan lulus §10 |
| T-04 | FR-09–FR-13 | T-03 | Rujuk §13 | Antrean, delay, retry, resume lulus §10 |
| T-05 | FR-14–FR-19 | T-04 | Rujuk §13 | Penilaian Gemini dan resolver model lulus §10 |
| T-06 | FR-20–FR-21 | T-05 | Rujuk §13 | Review dan perubahan nilai guru lulus §10 |
| T-07 | FR-22–FR-23 | T-06 | Rujuk §13 | Rilis dan tampilan nilai siswa lulus §10 |
| T-08 | NFR-01–NFR-14 | T-07 | Rujuk §13 | Pengujian NFR lulus §10 |
| T-09 | Semua FR/NFR | T-08 | Rujuk §13 | Regression test dan DoD proyek terpenuhi |

## 12. Log Progres

WAJIB dibaca AI coding PALING AWAL setiap sesi baru.

| Task ID | Status | Tanggal | Hasil Uji | Ringkasan Kerja | Langkah Lanjut |
|---|---|---|---|---|---|
| T-01 | Selesai | 10 Sep 2026 | Lolos (5/5 tests di `tests/auth.test.js`) | Setup package.json, skema SQLite lengkap sesuai §6, authService session & proteksi guru | Lanjut T-02 |
| T-02 | Selesai | 10 Sep 2026 | Lolos (7/7 tests di `tests/exam.test.js`) | Implementasi examService: CRUD ulangan, kode ujian unik, CRUD soal isian/essay, formula normalisasi nilai skala 100 | Lanjut T-03 |
| T-03 | Selesai | 10 Sep 2026 | Lolos (6/6 tests di `tests/student.test.js`) | Implementasi studentService: validasi kode ulangan, proteksi kunci jawaban tidak bocor, registrasi peserta, submit instan tanpa nunggu AI (NFR-01) | Lanjut T-04 |
| T-04 | Selesai | 10 Sep 2026 | Lolos (6/6 tests di `tests/queue.test.js`) | Implementasi queueService: pemrosesan bertahap 1-demi-1, jeda acak 5–13s, adaptive delay rate-limit, pause/resume, dan idempotensi (NFR-06) | Lanjut T-05 |
| T-05 | Selesai | 10 Sep 2026 | Lolos (5/5 tests di `tests/gemini.test.js`) | Implementasi geminiService: pemilihan model dinamis, fallback berjenjang, prompt evaluasi semantik (makna/konsep, toleransi typo & sinonim, skor parsial) | Lanjut T-06 |
| T-06 | Selesai | 10 Sep 2026 | Lolos (5/5 tests di `tests/review.test.js`) | Implementasi reviewService: daftar pengerjaan, detail butir jawaban & alasan AI, override skor guru, normalisasi nilai total max 100, toggle rilis hasil | Lanjut T-07 |
| T-07 | Selesai | 10 Sep 2026 | Lolos (8/8 tests di `tests/api.test.js`) | Implementasi server.js Express, header CSP Google Sites (`frame-ancestors`), UI responsif `public/index.html` dan `public/guru.html` | Lanjut T-08 |
| T-08 | Selesai | 10 Sep 2026 | Lolos (4/4 tests di `tests/nfr.test.js`) | Pengujian NFR: Skala MVP 20 peserta (40 jawaban) bertahap, audit trail lengkap, clamping skor | Lanjut T-09 |
| T-09 | Selesai | 10 Sep 2026 | Lolos 100% (46/46 tests di seluruh suite) | Regression testing, validasi DoD, seluruh requirement PRD terpenuhi | Selesai (Siap Produksi/Digunakan) |
| T-10 | Selesai | 10 Sep 2026 | Lolos 100% (4/4 tests di `tests/generator.test.js` & live) | Implementasi AI Soal Generator (Mode Topik & Mode Teks Materi), kunci jawaban, rubrik konsep, dan bobot otomatis | Selesai |

Jika sesi terhenti di tengah tugas, catat fungsi/baris terakhir yang dikerjakan pada `Langkah Lanjut`.

## 13. Peta Keterkaitan File

WAJIB diperbarui AI coding setiap kali file/modul baru dibuat atau hubungan antar-file berubah.

| File/Modul | Fungsi | File Terkait/Bergantung |
|---|---|---|
| `package.json` | Konfigurasi dependensi Node.js & scripts | Express, SQLite, GenAI SDK |
| `.env` / `.env.example` | Konfigurasi runtime (port, password guru, gemini api key, delay) | `authService.js`, `database.js`, `server.js` |
| `src/config/database.js` | Koneksi SQLite dan inisialisasi tabel (§6) | Semua service database |
| `src/services/authService.js` | Autentikasi guru, verifikasi token & middleware | `database.js`, `routes` |
| `src/services/examService.js` | CRUD ulangan & soal, generator kode unik, normalisasi nilai | `database.js` |
| `src/services/studentService.js` | Akses siswa, pengerjaan, submit instan jawaban | `database.js`, `examService.js` |
| `src/services/queueService.js` | Antrean penilaian AI 1-per-1, delay acak 5-13s, resume | `database.js`, `geminiService.js` |
| `src/services/geminiService.js` | Evaluasi semantik AI, resolver model dinamis & fallback | `queueService.js` |
| `src/services/reviewService.js` | Review skor AI, override guru, rilis nilai, normalisasi | `database.js`, `examService.js` |
| `server.js` | Server Express, header CSP Google Sites, API endpoints | Semua service & public static |
| `public/index.html` | Antarmuka web portal siswa (pengerjaan & hasil nilai) | `server.js` |
| `public/guru.html` | Antarmuka dashboard guru (manajemen ujian, review, AI) | `server.js` |
| `tests/auth.test.js` | Pengujian unit T-01 (FR-01) | `authService.js` |
| `tests/exam.test.js` | Pengujian unit T-02 (FR-02–FR-05) | `examService.js` |
| `tests/student.test.js` | Pengujian unit T-03 (FR-06–FR-08, NFR-01) | `studentService.js` |
| `tests/queue.test.js` | Pengujian unit T-04 (FR-09–FR-13, NFR-02–NFR-06) | `queueService.js` |
| `tests/gemini.test.js` | Pengujian unit T-05 (FR-14–FR-19, NFR-12) | `geminiService.js` |
| `tests/review.test.js` | Pengujian unit T-06 (FR-20–FR-23) | `reviewService.js` |
| `tests/api.test.js` | Pengujian integrasi T-07 (API & CSP Google Sites) | `server.js` |
| `tests/nfr.test.js` | Pengujian NFR T-08 (Skala MVP 20 siswa, clamping, audit) | `queueService.js`, `examService.js` |
| `tests/generator.test.js` | Pengujian AI Soal Generator T-10 | `geminiService.js`, `server.js` |
| `tests/random_soal.test.js` | Pengujian Bank Soal & Pengacakan Paket Soal T-11 | `studentService.js`, `examService.js` |
| `tests/anti_cheat.test.js` | Pengujian Anti-Pengelabu AI, Prompt Injection Defense, Toleransi Typo/Singkatan, & Copy-Paste T-12 | `geminiService.js`, `studentService.js` |

Peta ini harus cukup untuk menentukan file relevan sebelum AI membuka source code.

## 14. Definisi Selesai (DoD) Proyek

- [x] Guru dapat login.
- [x] Guru dapat membuat beberapa ulangan.
- [x] Guru dapat membuat soal isian dan essay.
- [x] Guru dapat memberikan bobot dan kunci jawaban.
- [x] Guru dapat mengatur tingkat kelas dan kesulitan.
- [x] Siswa dapat masuk menggunakan kode.
- [x] Siswa wajib mengisi nama dan kelas.
- [x] Siswa dapat mengirim jawaban tanpa menunggu Gemini.
- [x] Jawaban tersimpan dengan benar.
- [x] Guru dapat memulai review AI secara manual.
- [x] Review berjalan satu per satu.
- [x] Terdapat delay antar-request.
- [x] Adaptive delay berjalan ketika diperlukan.
- [x] Retry dibatasi.
- [x] Review dapat dihentikan dan dilanjutkan.
- [x] Jawaban yang sudah selesai tidak diproses ulang.
- [x] AI dapat menilai berdasarkan makna, bukan exact matching.
- [x] Jawaban valid di luar kunci dapat memperoleh nilai.
- [x] Jawaban parsial dapat memperoleh nilai parsial.
- [x] Skor AI hanya rekomendasi.
- [x] Guru dapat mengubah skor AI.
- [x] Nilai final maksimum 100.
- [x] Guru dapat merilis hasil.
- [x] Siswa hanya dapat melihat hasilnya sendiri setelah dirilis.
- [x] Model Gemini dipilih secara dinamis berdasarkan model yang tersedia.
- [x] Tidak ada ketergantungan permanen pada satu nama model Gemini.
- [x] Semua FR lulus uji §10.
- [x] Semua NFR terpenuhi.
- [x] Log Progres §12 lengkap.
- [x] Peta File §13 lengkap.
- [x] Tidak ada task berstatus belum selesai.