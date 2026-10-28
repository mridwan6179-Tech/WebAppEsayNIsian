const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('kolom kode pemulihan tertutup sampai siswa membukanya', () => {
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.match(html, /<details[^>]+id="recovery-token-panel"/i);
  assert.match(html, /<summary[^>]*>[^<]*kode pemulihan/i);
  assert.match(html, /<input[^>]+id="input-recovery-token"/i);
  assert.doesNotMatch(html, /id="input-recovery-token"[^>]+required/i);
});
