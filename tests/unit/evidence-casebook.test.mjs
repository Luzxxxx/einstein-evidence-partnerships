import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  loadEvidenceCasebook, casebookSources, legacyCSVRecords, verifyLegacyCasebook,
  parseLegacyCSV, parseLegacyJson, canonicalizeLegacyPythonRecord,
} from '../fixtures/evidence-cases.mjs';

test('original casebook stays complete and deeply immutable', () => {
  const book = loadEvidenceCasebook();
  assert.equal(book.dataset_commit, '4fb99b3749adf0d10b5977089ff4c73f4f522240');
  assert.equal(book.semantic_gold, false);
  assert.equal(book.cases.length, 13);
  assert.equal(book.cases.flatMap(item => item.evidence).length, 75);
  assert.ok(Object.isFrozen(book.cases[0].evidence[0]));
  assert.throws(() => { book.cases[0].evidence[0].excerpt = 'changed'; }, TypeError);
});

test('all 75 historical excerpts, source-file bytes and legacy Python hashes are actually checked', () => {
  const report = verifyLegacyCasebook();
  assert.deepEqual(report, {
    datasetCommit: '4fb99b3749adf0d10b5977089ff4c73f4f522240',
    caseCount: 13, evidenceCount: 75, sourceFileCount: 5,
    productionSourceCount: 73, legacyCSVCount: 2,
    stringExcerpts: 74, nullExcerpts: 1,
    excerptHashesChecked: 75, pythonRecordHashesChecked: 75,
    sourceFileHashesChecked: 5,
    legacyCanonicalization: 'python-json-sort-keys-safe-integers-v1',
  });
});

test('73 production source references preserve field/record locators and exclude exactly two CSV records', () => {
  const book = loadEvidenceCasebook();
  const refs = book.cases.flatMap(casebookSources);
  assert.equal(refs.length, 73);
  assert.ok(refs.every(ref => !ref.file.endsWith('.csv') && ref.derivedRecordId === false));
  const aliasCase = book.cases.find(item => item.case_id === 'EC-A01');
  assert.deepEqual(casebookSources(aliasCase)[0], {
    file: 'data/researchers.json', recordId: 'R0139',
    locator: { format: 'json', jsonPointer: '/researchers/138' },
    fieldPointer: '/name', derivedRecordId: false, codePointRange: [0, 15],
  });
  const nullCase = book.cases.find(item => item.case_id === 'EC-U01');
  const nullRef = casebookSources(nullCase).find(ref => ref.fieldPointer === '/authors/1/researcher_id');
  assert.deepEqual(nullRef, {
    file: 'data/publications.jsonl', recordId: 'SYN-PUB-00001',
    locator: { format: 'jsonl', line1Based: 1 }, fieldPointer: '/authors/1/researcher_id', derivedRecordId: false,
  });
});

test('legacy CSV rows retain BOM-aware id and correctly disclose missing institution/detail projection', () => {
  const rows = legacyCSVRecords();
  assert.equal(rows.length, 2);
  const researcher = rows.find(row => row.sourceFile === 'data/researchers.csv');
  const company = rows.find(row => row.sourceFile === 'data/companies.csv');
  assert.equal(researcher.evidenceId, 'EC-F01-E01');
  assert.equal(researcher.recordId, 'R0001');
  assert.equal(company.evidenceId, 'EC-F01-E03');
  assert.equal(company.recordId, 'C001');
  for (const row of rows) {
    assert.equal(row.utf8Bom, true);
    assert.equal(row.csvDataRow1Based, 1);
    assert.equal(row.columns[0], 'id');
    assert.match(row.sourceFileSha256, /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(row.row));
    assert.ok(!Object.keys(row.row).includes('\ufeffid'));
  }
  assert.ok(!researcher.columns.includes('institution'));
  assert.ok(!Object.hasOwn(researcher.row, 'institution'));
  assert.match(company.row.challenges, /^C001-CH1: /);
  assert.ok(!Object.hasOwn(company.row, 'detail'));
  assert.match(company.row.about, /\n\n/); // Real quoted multiline CSV content survives.
});

test('RFC4180 parsing handles BOM, quoted commas/quotes, embedded CRLF and trailing empty cells', () => {
  const text = '\ufeffid,note,empty\r\nR0001,"first, \"\"quoted\"\"\r\nsecond",\r\nR0002,plain,\r\n';
  assert.deepEqual(parseLegacyCSV(text), {
    columns: ['id', 'note', 'empty'],
    records: [{ id: 'R0001', note: 'first, "quoted"\r\nsecond', empty: '' },
      { id: 'R0002', note: 'plain', empty: '' }],
  });
});

test('CSV parser rejects malformed quoting, duplicate headers and uneven columns', () => {
  for (const text of ['id,note\r\nR0001,"unterminated', 'id,note\r\nR0001,bad"quote\r\n',
    'id,note\r\nR0001,"ok"junk\r\n', 'id,id\r\nR0001,x\r\n', 'id,note\r\nR0001\r\n']) {
    assert.throws(() => parseLegacyCSV(text));
  }
});

test('legacy Python canonicalization uses code-point key order, not JavaScript UTF-16 order', () => {
  const value = { '\u{1f600}': 'astral', '\ue000': 'bmp', nested: [true, null, 2026] };
  const expected = '{"nested":[true,null,2026],"\ue000":"bmp","😀":"astral"}';
  assert.equal(canonicalizeLegacyPythonRecord(value), expected);
  assert.notEqual(JSON.stringify(Object.fromEntries(Object.entries(value).sort())), expected);
  assert.equal(createHash('sha256').update(expected, 'utf8').digest('hex'),
    createHash('sha256').update(canonicalizeLegacyPythonRecord(value), 'utf8').digest('hex'));
});

test('legacy numeric support is explicit: floating/exponent/minus-zero/unsafe lexemes are rejected', () => {
  for (const number of ['1.0', '1e0', '-0', '9007199254740993']) {
    assert.throws(() => parseLegacyJson(`{"n":${number}}`), /legacy|integer|number/i);
  }
  for (const value of [1.5, -0, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.throws(() => canonicalizeLegacyPythonRecord({ n: value }), /integer|number/i);
  }
  assert.deepEqual(parseLegacyJson('{"year":2026,"text":"1.0 and 1e6 inside strings stay text"}'),
    { year: 2026, text: '1.0 and 1e6 inside strings stay text' });
});

test('tampered excerpts, legacy hashes and source-file declarations are rejected in memory', () => {
  for (const mutation of ['excerpt', 'legacyRecordHash', 'sourceHash']) {
    const book = structuredClone(loadEvidenceCasebook());
    if (mutation === 'excerpt') book.cases[0].evidence[0].excerpt = 'TAMPERED';
    if (mutation === 'legacyRecordHash') book.cases[0].evidence[0].record_canonical_sha256 = '0'.repeat(64);
    if (mutation === 'sourceHash') book.source_files['data/researchers.json'].sha256 = '0'.repeat(64);
    assert.throws(() => verifyLegacyCasebook(book), undefined, mutation);
  }
});

test('source helper refuses unknown files and historical pointers cannot use Python/JS negative indexing', () => {
  const entry = structuredClone(loadEvidenceCasebook().cases[0]);
  entry.evidence[0].source_file = '../../.env.local';
  assert.throws(() => casebookSources(entry), /source|file/i);
  const book = structuredClone(loadEvidenceCasebook());
  book.cases[0].evidence[0].record_pointer = '/researchers/-909';
  assert.throws(() => verifyLegacyCasebook(book), /pointer|index/i);
});
