import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NORMALIZATION_VERSION,
  TRANSLITERATION_VERSION,
  latinizeSerbian,
  normalizeText,
  tokenize,
  transliterateSerbian,
} from '../../dist/server/retrieval/normalize.js';

test('normalization has fixed versions and composes before Unicode lowercasing', () => {
  assert.equal(NORMALIZATION_VERSION, 'nfc-lower-unicode-words-v1');
  assert.equal(TRANSLITERATION_VERSION, 'serbian-cyrillic-latin-v1');
  assert.equal(normalizeText(' C\u030cIP  \t\nĐAK—NLP / СРПСКИ; 2026. '),
    'čip đak nlp српски 2026');
  assert.equal(normalizeText('İ E\u0301 Ａ'), 'i\u0307 é ａ');
  assert.equal(normalizeText(''), '');
  assert.equal(normalizeText(' \t— + 😀 \r\n'), '');
});

test('normalization is deterministic and retains morphology, diacritics and original script', () => {
  const raw = '\ufeffKARTICU\r\nC\u030cIP—Љубљана😀';
  const before = Buffer.from(raw, 'utf8');
  const expected = 'karticu čip љубљана';
  assert.equal(normalizeText(raw), expected);
  assert.equal(normalizeText(raw), normalizeText(raw));
  assert.equal(normalizeText(expected), expected);
  assert.deepEqual(Buffer.from(raw, 'utf8'), before);
  assert.notEqual(normalizeText('karticu'), normalizeText('kartica'));
  assert.notEqual(normalizeText('čip'), normalizeText('cip'));
  assert.notEqual(normalizeText('Љубљана'), normalizeText('Ljubljana'));
});

test('tokenization retains order, duplicates, negation and numeric constraints without stemming', () => {
  assert.deepEqual(tokenize('Bez oznaka; no labels, labels. 12.5 EUR; 40s; ２０２６.'),
    ['bez', 'oznaka', 'no', 'labels', 'labels', '12', '5', 'eur', '40s', '２０２６']);
  assert.deepEqual(tokenize('NLP—ČIP/картicu😀中文𝟙e\u0301'),
    ['nlp', 'čip', 'картicu', '中文𝟙é']);
  assert.deepEqual(tokenize(' \n 😀 — '), []);
  assert.deepEqual(tokenize('karticu kartica'), ['karticu', 'kartica']);
});

test('Serbian transliteration covers the alphabet while preserving punctuation and other scripts', () => {
  const cyrillic = 'а б в г д ђ е ж з и ј к л љ м н њ о п р с т ћ у ф х ц ч џ ш';
  const latin = 'a b v g d đ e ž z i j k l lj m n nj o p r s t ć u f h c č dž š';
  assert.equal(transliterateSerbian(cyrillic), latin);
  assert.equal(transliterateSerbian('Љ Њ Џ Ђ Ћ Ч Ш Ж'), 'Lj Nj Dž Đ Ć Č Š Ž');
  assert.equal(transliterateSerbian('Љубљана, Његош и Џез!\r\n中文😀'),
    'Ljubljana, Njegoš i Džez!\r\n中文😀');
  assert.equal(transliterateSerbian('ЉУБЉАНА ЊЕГОШ ЏЕЗ'), 'LJUBLJANA NJEGOŠ DŽEZ');
  assert.equal(transliterateSerbian('e\u0301 English conjugation / русский язык'),
    'é English conjugation / russkiй яzыk');
});

test('canonical Latin representation equates Serbian script variants and digraph case forms', () => {
  for (const variants of [
    ['Љубљана', 'Ljubljana', 'LJUBLJANA', 'ljubljana'],
    ['Његош', 'Njegoš', 'NJEGOŠ', 'njegos\u030c'],
    ['Џез', 'Džez', 'DŽEZ', 'Dz\u030cez'],
    ['Ђак Ћирилица', 'Đak Ćirilica', 'ĐAK ĆIRILICA'],
  ]) {
    const expected = latinizeSerbian(variants[0]);
    for (const variant of variants) assert.equal(latinizeSerbian(variant), expected, variant);
  }
  assert.equal(latinizeSerbian('C\u030cIP / ЧИП'), 'čip čip');
  assert.notEqual(latinizeSerbian('картицу'), latinizeSerbian('kartica'));
  assert.notEqual(latinizeSerbian('Ђорђе'), latinizeSerbian('Djordje'));
  assert.equal(latinizeSerbian('English conjugation'), 'english conjugation');
  assert.equal(latinizeSerbian(latinizeSerbian('Љубљана—ЧИП')), 'ljubljana čip');
});

test('all transforms reject malformed Unicode and non-string input without coercion', () => {
  for (const transform of [normalizeText, tokenize, transliterateSerbian, latinizeSerbian]) {
    for (const invalid of [null, undefined, 42, {}, ['text'], new String('text'),
      '\ud800', '\udfff', 'x\ud800y', '\ud800\ud800', '\udc00\ud800']) {
      assert.throws(() => transform(invalid), TypeError);
    }
  }
});
