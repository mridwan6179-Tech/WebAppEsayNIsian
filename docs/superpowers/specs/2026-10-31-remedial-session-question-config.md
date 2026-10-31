# Konfigurasi Link Ulangan Ulang

## Tujuan

Guru dapat membuat link ulangan ulang dari laporan nilai dengan memilih kelas dan, bila diperlukan, daftar siswa tertentu. Link tersebut memiliki aturan sendiri untuk jumlah soal, komposisi persentase tipe soal, dan jadwal buka/tutup. Ulangan utama, nilai lama, auth, dan isolasi sesi tidak berubah.

## Aturan

- Default laporan remedial tetap menampilkan semua siswa yang sudah mengumpulkan dan nilai terbaiknya di bawah KKM.
- Guru dapat mengirim `student_ids` sebagai daftar pengecualian: nama yang dipilih adalah siswa yang tidak perlu mengulang. Siswa lain dari kelas terpilih tetap boleh masuk, termasuk siswa yang belum mengikuti ulangan utama.
- Nama dan kelas yang sama tetap digabung menjadi satu peserta dengan nilai tertinggi sebelum kandidat dibentuk.
- `question_count` adalah jumlah soal target. Bila kosong, semua soal bank dipakai.
- `question_ratios` berisi persentase per kategori: `pg_biasa`, `pg_kompleks`, `isian`, `essay`, `koding_game`. Persentase harus bilangan 0 sampai 100 dan totalnya tidak boleh melebihi 100 bila dikirim. Jika totalnya kurang dari 100, sisa dibagikan otomatis ke kategori lain yang tersedia. Jika bank suatu tipe tidak mencukupi, kekurangannya diisi dari tipe lain tanpa duplikasi agar jumlah target tetap tercapai selama total bank mencukupi.
- Alokasi soal menggunakan largest remainder agar jumlah akhir tepat. Soal dipilih acak dengan seed sesi, lalu disimpan di `pengerjaan.soal_ids` saat siswa mulai. Refresh/rejoin tidak memilih ulang.
- Penilaian tetap memakai bobot setiap soal dan fungsi penilaian yang ada, sehingga nilai dinormalisasi ke skala 100 seperti ulangan utama.
- `waktu_mulai` dan `waktu_selesai` memakai parser zona waktu ulangan induk dan divalidasi mulai tidak melewati selesai.
- Sesi remedial membatasi kelas dan jadwal. Nama pada daftar pengecualian ditolak dengan pesan bahwa siswa tersebut tidak perlu mengulang; peserta baru dibuat bila identitas yang diketik belum ada.

## Antarmuka

`reviewService.createRemedialSession(ulanganId, guruId, options)` menerima:

```js
{
  classes: string[],
  student_ids: number[],
  question_count: number|string|null,
  question_ratios: object|null,
  waktu_mulai: string|null,
  waktu_selesai: string|null,
  baseUrl: string
}
```

Konfigurasi disimpan pada kolom nullable `ulangan_sesi.remedial_question_count`, `ulangan_sesi.remedial_question_ratios`, dan `ulangan_sesi.remedial_student_ids`.

## Non-goals

- Tidak mengubah tabel `ulangan` utama atau aturan jumlah soal ulangan utama.
- Tidak mengubah endpoint auth, token siswa, antrean, atau penilaian AI.
- Tidak menghapus sesi remedial aktif lama; permintaan dengan konfigurasi berbeda membuat sesi remedial baru.
