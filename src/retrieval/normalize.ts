/** Derived retrieval text only. Never replace evidence text or identity keys with these values. */
export const NORMALIZATION_VERSION = 'nfc-lower-unicode-words-v1';
export const TRANSLITERATION_VERSION = 'serbian-cyrillic-latin-v1';

const serbianLetters: Readonly<Record<string, string>> = Object.freeze({
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'đ', е: 'e', ж: 'ž', з: 'z', и: 'i',
  ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', ћ: 'ć', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'č', џ: 'dž', ш: 'š',
});

function assertText(text: string): void {
  if (typeof text !== 'string') throw new TypeError('Retrieval text must be a string.');
  // In Unicode mode valid surrogate pairs are one scalar and do not match this range.
  if (/[\ud800-\udfff]/u.test(text)) throw new TypeError('Retrieval text must be well-formed Unicode.');
}

/** NFC, Unicode lowercase, then letter/mark/number tokens separated by one space.
 * This is deliberately not compatibility normalization, accent folding, or stemming.
 */
export function normalizeText(text: string): string {
  assertText(text);
  return text.normalize('NFC').toLowerCase().normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

/** Preserve token order, repetitions, word forms and negation; no stopwords are removed. */
export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(' ') : [];
}

/** Mechanical Serbian Cyrillic-to-Latin table, preserving other characters and punctuation.
 * Uppercase words retain uppercase digraphs; an isolated capital uses Lj/Nj/Dž.
 * This does not detect a language or safely reverse arbitrary Latin digraphs.
 */
export function transliterateSerbian(text: string): string {
  assertText(text);
  return text.normalize('NFC').replace(/[\p{L}\p{M}]+/gu, word => {
    const uppercaseWord = [...word].length > 1 && word === word.toUpperCase();
    return [...word].map(letter => {
      const lower = letter.toLowerCase();
      const latin = serbianLetters[lower];
      if (latin === undefined) return letter;
      if (letter === lower) return latin;
      return uppercaseWord ? latin.toUpperCase() : latin[0].toUpperCase() + latin.slice(1);
    }).join('');
  });
}

/** Canonical Latin retrieval representation: љ/lj, њ/nj and џ/dž share tokens.
 * Use only in the controlled Serbian retrieval lane, never to merge people by name.
 * Word forms remain distinct and Latin dj is not treated as đ.
 */
export function latinizeSerbian(text: string): string {
  return normalizeText(transliterateSerbian(text));
}
