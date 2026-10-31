// Historical fixture adapter only. No production imports, writes, model calls,
// environment lookup or arbitrary caller-supplied filesystem paths.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const SOURCE = new URL('reference/einstein-matchmaker-data/', ROOT);
const COMMIT = '4fb99b3749adf0d10b5977089ff4c73f4f522240';
const LEGACY_CANONICALIZATION = 'python-json-sort-keys-safe-integers-v1';
const JSON_FILES = new Set(['data/researchers.json', 'data/companies.json', 'data/publications.jsonl']);
const CSV_FILES = new Set(['data/researchers.csv', 'data/companies.csv']);
const SOURCE_FILES = new Set([...JSON_FILES, ...CSV_FILES]);
const sha = value => createHash('sha256').update(value).digest('hex');

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const part of Object.values(value)) freeze(part);
    Object.freeze(value);
  }
  return value;
}

function codePointCompare(left, right) {
  const a = Array.from(left, char => char.codePointAt(0));
  const b = Array.from(right, char => char.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Python json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':'))
 * for a deliberately limited subset: well-formed strings and safe integers.
 * Source parsing rejects float/exponent/-0 lexemes BEFORE JSON.parse can erase
 * Python int/float distinctions. This is not node-stable-json-v1 or a general
 * Python floating-point serializer. Never use this adapter for production IDs.
 */
export function canonicalizeLegacyPythonRecord(value) {
  const ancestors = new Set();
  function encode(part) {
    if (part === null) return 'null';
    if (typeof part === 'boolean') return part ? 'true' : 'false';
    if (typeof part === 'string') {
      requireValue(part.isWellFormed(), 'Legacy Python UTF-8 cannot encode unpaired Unicode surrogates.');
      return JSON.stringify(part);
    }
    if (typeof part === 'number') {
      requireValue(Number.isSafeInteger(part) && !Object.is(part, -0), 'Legacy number requires a safe integer without minus zero.');
      return String(part);
    }
    requireValue(part && typeof part === 'object', 'Legacy value must be supported JSON.');
    requireValue(!ancestors.has(part), 'Legacy JSON cannot contain cycles.');
    const array = Array.isArray(part);
    const prototype = Object.getPrototypeOf(part);
    requireValue(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null,
      'Legacy JSON requires plain records and arrays.');
    const descriptors = Object.getOwnPropertyDescriptors(part);
    const keys = Reflect.ownKeys(part);
    requireValue(keys.every(key => typeof key === 'string'), 'Legacy JSON cannot contain Symbol keys.');
    ancestors.add(part);
    try {
      if (array) {
        requireValue(keys.length === part.length + 1, 'Legacy arrays must be dense and have no extra properties.');
        const values = [];
        for (let i = 0; i < part.length; i++) {
          const descriptor = descriptors[i];
          requireValue(descriptor && 'value' in descriptor && descriptor.enumerable, 'Legacy array slot must be a data value.');
          values.push(encode(descriptor.value));
        }
        return `[${values.join(',')}]`;
      }
      const values = keys.sort(codePointCompare).map(key => {
        const descriptor = descriptors[key];
        requireValue('value' in descriptor && descriptor.enumerable, 'Legacy record fields must be data values.');
        return `${encode(key)}:${encode(descriptor.value)}`;
      });
      return `{${values.join(',')}}`;
    } finally {
      ancestors.delete(part);
    }
  }
  return encode(value);
}

/** Retain the legacy Python number-kind boundary instead of guessing after JSON.parse. */
export function parseLegacyJson(text) {
  requireValue(typeof text === 'string', 'Legacy JSON source must be text.');
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '\\') i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '-' || /[0-9]/.test(ch)) {
      const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i))?.[0];
      requireValue(token && !/[.eE]/.test(token) && token !== '-0' && Number.isSafeInteger(Number(token)),
        'Legacy JSON number is outside safe-integer support; use the original Python validator for this source.');
      i += token.length - 1;
    }
  }
  return JSON.parse(text);
}

/** RFC4180-style quoting, with both CRLF and LF row endings; cell newlines stay exact. */
export function parseLegacyCSV(text) {
  requireValue(typeof text === 'string', 'CSV source must be text.');
  if (text.startsWith('\ufeff')) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false, closedQuote = false;
  const pushField = () => { row.push(field); field = ''; closedQuote = false; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; closedQuote = true; }
      else field += ch;
    } else if (ch === ',') pushField();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r') { requireValue(text[i + 1] === '\n', 'CSV has an isolated CR row ending.'); i++; }
      pushRow();
    } else if (ch === '"') {
      requireValue(field.length === 0 && !closedQuote, 'CSV quote must start a field.');
      inQuotes = true;
    } else {
      requireValue(!closedQuote, 'CSV has content after a closing quote.');
      field += ch;
    }
  }
  requireValue(!inQuotes, 'CSV has an unterminated quoted field.');
  if (field.length || row.length || closedQuote) pushRow();
  const columns = rows.shift();
  requireValue(columns?.length && columns.every(Boolean) && new Set(columns).size === columns.length,
    'CSV requires nonempty unique headers.');
  const records = rows.map(values => {
    requireValue(values.length === columns.length, 'CSV row has an inconsistent column count.');
    return Object.fromEntries(columns.map((key, index) => [key, values[index]]));
  });
  return { columns, records };
}

function pointer(value, path) {
  requireValue(typeof path === 'string' && (path === '' || path.startsWith('/')), 'Invalid legacy pointer.');
  if (path === '') return value;
  for (let token of path.slice(1).split('/')) {
    requireValue(!/~(?:[^01]|$)/.test(token), 'Invalid legacy pointer escape.');
    token = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(value)) {
      requireValue(/^(?:0|[1-9][0-9]*)$/.test(token), 'Invalid legacy array index.');
      const index = Number(token);
      requireValue(Number.isSafeInteger(index) && index < value.length, 'Legacy array index out of bounds.');
      value = value[index];
    } else {
      requireValue(value && typeof value === 'object' && Object.hasOwn(value, token), 'Legacy pointer field does not exist.');
      value = value[token];
    }
  }
  return value;
}

function sourceBytes(file) {
  requireValue(SOURCE_FILES.has(file), `Unknown legacy source file: ${file}`);
  return readFileSync(new URL(file, SOURCE));
}

function loadSources() {
  const sources = new Map();
  for (const file of SOURCE_FILES) {
    const bytes = sourceBytes(file);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    let data;
    if (CSV_FILES.has(file)) data = parseLegacyCSV(text);
    else if (file.endsWith('.jsonl')) {
      const lines = text.split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      requireValue(lines.every(line => line.trim()), 'Legacy JSONL has a blank record.');
      data = lines.map(parseLegacyJson);
    } else data = parseLegacyJson(text);
    sources.set(file, { bytes, data });
  }
  return sources;
}

export function loadEvidenceCasebook() {
  // Tracked byte-for-byte historical fixture; preparation/ is not a checkout dependency.
  return freeze(parseLegacyJson(readFileSync(new URL('./evidence-cases.json', import.meta.url), 'utf8')));
}

/** Only the 73 JSON/JSONL entries map to production SourceRef. CSV is historical diagnostic input. */
export function casebookSources(item) {
  requireValue(Array.isArray(item?.evidence), 'Case must contain an evidence array.');
  return freeze(item.evidence.flatMap(evidence => {
    requireValue(SOURCE_FILES.has(evidence.source_file), `Unknown casebook source file: ${evidence.source_file}`);
    if (CSV_FILES.has(evidence.source_file)) return [];
    requireValue(['verbatim-string', 'json-null-token'].includes(evidence.value_encoding), 'Unsupported legacy value encoding.');
    return [{ file: evidence.source_file, recordId: evidence.record_id,
      locator: evidence.source_file.endsWith('.jsonl')
        ? { format: 'jsonl', line1Based: evidence.jsonl_line_1based }
        : { format: 'json', jsonPointer: evidence.record_pointer },
      fieldPointer: evidence.field_pointer, derivedRecordId: false,
      ...(evidence.value_encoding === 'verbatim-string' ? { codePointRange: [...evidence.character_range] } : {}),
    }];
  }));
}

function locate(sources, evidence) {
  requireValue(SOURCE_FILES.has(evidence.source_file), `Unknown casebook source file: ${evidence.source_file}`);
  const { data } = sources.get(evidence.source_file);
  let record;
  if (CSV_FILES.has(evidence.source_file)) {
    const index = evidence.csv_data_row_1based;
    requireValue(Number.isSafeInteger(index) && index >= 1 && index <= data.records.length, 'Invalid legacy CSV logical row.');
    record = data.records[index - 1];
  } else if (evidence.source_file.endsWith('.jsonl')) {
    const index = evidence.jsonl_line_1based;
    requireValue(Number.isSafeInteger(index) && index >= 1 && index <= data.length, 'Invalid legacy JSONL line.');
    record = data[index - 1];
  } else record = pointer(data, evidence.record_pointer);
  requireValue(record?.id === evidence.record_id, `Legacy record ID does not match locator: ${evidence.evidence_id}`);
  return { record, field: pointer(record, evidence.field_pointer) };
}

export function legacyCSVRecords(book = loadEvidenceCasebook()) {
  const sources = loadSources();
  return freeze(book.cases.flatMap(item => item.evidence).filter(e => CSV_FILES.has(e.source_file)).map(evidence => {
    const { record } = locate(sources, evidence);
    const { bytes, data } = sources.get(evidence.source_file);
    return { evidenceId: evidence.evidence_id, sourceFile: evidence.source_file, recordId: evidence.record_id,
      csvDataRow1Based: evidence.csv_data_row_1based, columns: [...data.columns], row: record,
      utf8Bom: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), sourceFileSha256: sha(bytes) };
  }));
}

/** Validate the historical Python-format fixture, not production author/Claim semantics. */
export function verifyLegacyCasebook(book = loadEvidenceCasebook()) {
  requireValue(book.dataset_commit === COMMIT && book.semantic_gold === false, 'Wrong casebook baseline or semantic-gold declaration.');
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', fileURLToPath(SOURCE), ...args],
    { encoding: 'utf8', windowsHide: true }).trim();
  requireValue(git('rev-parse', 'HEAD') === COMMIT, 'Local data commit is not the historical baseline.');
  requireValue(git('status', '--porcelain', '--untracked-files=all') === '', 'Historical source data is not clean.');
  requireValue(Object.keys(book.source_files).length === SOURCE_FILES.size
    && Object.keys(book.source_files).every(file => SOURCE_FILES.has(file)), 'Wrong historical source-file manifest.');
  const sources = loadSources();
  for (const [file, { bytes }] of sources) {
    const manifest = book.source_files[file];
    requireValue(bytes.length === manifest.bytes && sha(bytes) === manifest.sha256, `Source-file bytes/hash mismatch: ${file}`);
    requireValue(manifest.utf8_bom === bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `Source BOM mismatch: ${file}`);
  }
  const evidence = book.cases.flatMap(item => item.evidence);
  requireValue(book.cases.length === 13 && new Set(book.cases.map(item => item.case_id)).size === 13,
    'Historical casebook must preserve all 13 case identities.');
  requireValue(evidence.length === 75 && new Set(evidence.map(item => item.evidence_id)).size === 75,
    'Historical casebook must preserve all 75 evidence identities.');
  let nullExcerpts = 0, stringExcerpts = 0;
  for (const item of evidence) {
    const { record, field } = locate(sources, item);
    let excerpt;
    if (item.value_encoding === 'json-null-token') {
      requireValue(field === null && !Object.hasOwn(item, 'character_range'), 'Legacy null must remain null without a string range.');
      excerpt = 'null'; nullExcerpts++;
    } else {
      requireValue(item.value_encoding === 'verbatim-string' && typeof field === 'string', 'Legacy excerpt must retain its original field type.');
      const [start, end] = item.character_range;
      const points = Array.from(field);
      requireValue(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < end && end <= points.length,
        'Invalid legacy code-point range.');
      excerpt = points.slice(start, end).join(''); stringExcerpts++;
    }
    requireValue(excerpt === item.excerpt, `Legacy excerpt mismatch: ${item.evidence_id}`);
    requireValue(sha(Buffer.from(excerpt, 'utf8')) === item.excerpt_sha256, `Legacy excerpt hash mismatch: ${item.evidence_id}`);
    requireValue(sha(Buffer.from(canonicalizeLegacyPythonRecord(record), 'utf8')) === item.record_canonical_sha256,
      `Legacy Python record hash mismatch: ${item.evidence_id}`);
  }
  return freeze({ datasetCommit: COMMIT, caseCount: book.cases.length, evidenceCount: evidence.length,
    sourceFileCount: sources.size, productionSourceCount: book.cases.flatMap(casebookSources).length,
    legacyCSVCount: evidence.filter(item => CSV_FILES.has(item.source_file)).length,
    stringExcerpts, nullExcerpts, excerptHashesChecked: evidence.length,
    pythonRecordHashesChecked: evidence.length, sourceFileHashesChecked: sources.size,
    legacyCanonicalization: LEGACY_CANONICALIZATION });
}
