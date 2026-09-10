const path = require('path');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const fileParserService = {
  /**
   * Ekstrak teks materi dari file PDF, DOCX, XLSX/XLS/CSV, atau TXT
   * @param {string|Buffer} input - Buffer file atau string Base64 (bisa berupa data URI)
   * @param {string} filename - Nama file lengkap beserta ekstensinya (misal: "materi.pdf")
   * @returns {Promise<{success: boolean, text: string, filename: string, charCount: number}>}
   */
  async parseFile(input, filename = 'document.txt') {
    if (!input) {
      throw new Error('Data file tidak boleh kosong');
    }

    let buffer;
    if (Buffer.isBuffer(input)) {
      buffer = input;
    } else if (typeof input === 'string') {
      // Hilangkan header data URI jika ada (misal: "data:application/pdf;base64,")
      const base64Data = input.replace(/^data:[^;]+;base64,/, '').trim();
      buffer = Buffer.from(base64Data, 'base64');
    } else {
      throw new Error('Format data file tidak didukung');
    }

    if (!buffer || buffer.length === 0) {
      throw new Error('Ukuran file kosong (0 bytes)');
    }

    const ext = path.extname(filename || '').toLowerCase();
    let extractedText = '';
    let fileType = 'text';

    const allowedExts = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.md', '.json', ''];
    if (!allowedExts.includes(ext)) {
      throw new Error(`Format berkas '${ext}' tidak didukung. Harap unggah berkas PDF, Word (DOCX/DOC), Excel/Spreadsheet (XLSX/CSV), atau Teks.`);
    }

    try {
      if (ext === '.pdf') {
        fileType = 'pdf';
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(buffer);
        extractedText = data.text || '';
      } else if (ext === '.docx' || ext === '.doc') {
        fileType = 'word';
        const result = await mammoth.extractRawText({ buffer });
        extractedText = result.value || '';
      } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
        fileType = 'excel';
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheetsText = [];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(sheet);
          if (csv && csv.trim()) {
            sheetsText.push(`[Sheet: ${sheetName}]\n${csv.trim()}`);
          }
        }
        extractedText = sheetsText.join('\n\n');
      } else {
        fileType = 'text';
        extractedText = buffer.toString('utf-8');
      }
    } catch (err) {
      console.error(`[FILE-PARSER] Gagal mengekstrak berkas ${filename}:`, err.message);
      throw new Error(`Gagal membaca isi file (${filename}): ${err.message}`);
    }

    // Bersihkan karakter kontrol aneh dan rapikan spasi berlebih
    let sanitized = extractedText
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!sanitized) {
      throw new Error(`File ${filename} berhasil dibaca tetapi tidak memuat teks atau materi yang dapat diekstrak.`);
    }

    // Batasi maksimal 25.000 karakter agar tidak melebihi konteks prompt Gemini
    const MAX_CHARS = 25000;
    if (sanitized.length > MAX_CHARS) {
      sanitized = sanitized.substring(0, MAX_CHARS) + '\n\n[... Catatan: Sebagian teks dipotong karena melebihi batas 25.000 karakter ...]';
    }

    return {
      success: true,
      text: sanitized,
      filename,
      charCount: sanitized.length,
      fileType
    };
  }
};

module.exports = fileParserService;
