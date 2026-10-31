import { z } from 'zod';
import { AnswerIssueFieldSchema, AnswerIssueCodeSchema, AnswerValidationSchema, type AnswerValidation } from '../contracts/events.js';
import { sha256Bytes } from '../evidence/hashing.js';
import type { AnswerRequest } from './answer-diagnostics.js';

const fields = new Set<string>(AnswerIssueFieldSchema.options);
const issueCodes = new Set<string>(AnswerIssueCodeSchema.options);
const expectedTypes = new Set(['string', 'number', 'boolean', 'array', 'object', 'null', 'undefined', 'bigint', 'symbol', 'function', 'date']);
const rules: Record<string, NonNullable<AnswerValidation['issues'][number]['rule']>> = {
  'Facts require evidence and bindings.': 'FACT_EVIDENCE_REQUIRED',
  'Binding points outside the Claim evidence IDs.': 'BINDING_OUTSIDE_EVIDENCE',
  'Every cited Evidence needs a binding.': 'EVIDENCE_BINDING_REQUIRED',
  'Relation subject differs from candidate.': 'RELATION_SUBJECT_MISMATCH',
  'Draft identity mismatch.': 'DRAFT_IDENTITY_MISMATCH',
  'Draft has duplicate or unknown Claim references.': 'DRAFT_CLAIM_REFERENCES',
  'Duplicate finding IDs.': 'DUPLICATE_FINDING_IDS',
  'Duplicate Counter finding IDs.': 'DUPLICATE_FINDING_IDS',
  'Claim findings need Claim IDs.': 'CLAIM_FINDING_REFERENCES',
  'Blocking findings prohibit approve.': 'APPROVAL_WITH_BLOCKERS',
  'Non-approval requires a concrete blocker.': 'NONAPPROVAL_REQUIRES_BLOCKER',
  'Revision blockers require targeted recheck questions.': 'REVISION_REQUIRES_QUESTION',
  'Counter report must record findings or checked absence.': 'COUNTER_CHECKS_REQUIRED',
  'Duplicate IDs.': 'DUPLICATE_REFERENCE_IDS',
  'Duplicate researchers.': 'DUPLICATE_RESEARCHERS',
};
const applicationCodes = new Set(['RUN_MISMATCH', 'PRODUCER_MISMATCH', 'DUPLICATE_COMPLETION', 'CRITIC_PREREQUISITES',
  'CANDIDATE_OUTSIDE_POOL', 'CLAIM_SOURCE_BINDING_FAILED', 'UNCHANGED_REVISION', 'COUNTER_ALREADY_FIXED',
  'COUNTER_COVERAGE_FAILED', 'COUNTER_REFERENCE_FAILED', 'REVIEW_TARGET_CHANGED', 'REVIEW_REFERENCE_FAILED',
  'CONTROLLED_SEED_NOT_PRESERVED']);

export class TaskAnswerValidationError extends Error {
  constructor(readonly code: string, readonly validation: AnswerValidation) { super(code); }
}

/** Only presentation punctuation is optional: a whole JSON fence and trailing
 * commas outside strings. No values, fields or source references are repaired. */
function normalizeAnswerFormatting(text: string): string {
  let source = text.trim();
  const fence = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(source);
  if (fence) source = fence[1]!;
  let output = '', quoted = false, escaped = false, previous = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') { quoted = false; previous = '"'; }
      continue;
    }
    if (char === '"') quoted = true;
    if (char === ',' && previous && !'[{:,'.includes(previous)) {
      let next = i + 1;
      while (next < source.length && /\s/.test(source[next]!)) next++;
      if (source[next] === '}' || source[next] === ']') continue;
    }
    output += char;
    if (!/\s/.test(char)) previous = char;
  }
  return output;
}

/** Observed Counter format: its four fields split across adjacent JSON objects. Assemble only
 * the complete, disjoint Counter envelope; never choose between alternatives,
 * extract from prose, fill a field, or overwrite a duplicate. Domain/source
 * validation still runs on every value. Strict diagnostic mode never uses this. */
function assembleCounterEnvelope(text: string): unknown {
  const allowed = new Set(['checkedFacets', 'checkedCandidates', 'findings', 'noCounterEvidenceFound']);
  const result: Record<string, unknown> = {};
  let cursor = 0, count = 0;
  while (cursor < text.length) {
    while (cursor < text.length && /[ \t\r\n]/.test(text[cursor]!)) cursor++;
    if (cursor === text.length) break;
    if (text[cursor] !== '{' || count >= 4) throw Error('COUNTER_ENVELOPE');
    const start = cursor;
    let depth = 0, quoted = false, escaped = false, rootCommas = 0;
    for (; cursor < text.length; cursor++) {
      const char = text[cursor]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') depth--;
      // Count members before JSON.parse can collapse duplicate root keys.
      else if (char === ',' && depth === 1) rootCommas++;
      if (depth === 0) { cursor++; break; }
    }
    if (quoted || depth !== 0) throw Error('COUNTER_ENVELOPE');
    const fragment: unknown = JSON.parse(text.slice(start, cursor));
    if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) throw Error('COUNTER_ENVELOPE');
    const entries = Object.entries(fragment);
    if (!entries.length || entries.length !== rootCommas + 1) throw Error('COUNTER_ENVELOPE');
    for (const [key, value] of entries) {
      if (!allowed.has(key) || Object.hasOwn(result, key)) throw Error('COUNTER_ENVELOPE');
      result[key] = value;
    }
    count++;
  }
  if (count < 2 || Object.keys(result).length !== 4) throw Error('COUNTER_ENVELOPE');
  return result;
}

/** Diagnostics hash the original answer and contain no text, unknown
 * property names, source values, provider envelope or arbitrary exception text. */
export function parseTaskAnswer(text: unknown, request: AnswerRequest | null, parse: (value: unknown) => unknown, allowFormatting = false): unknown {
  const base = { ...(request ?? {}), ...(typeof text === 'string'
    ? { answerHash: sha256Bytes(Buffer.from(text, 'utf8')), answerBytes: Buffer.byteLength(text) } : {}) };
  const fail = (code: string, stage: AnswerValidation['stage'], issues: unknown[] = []): never => {
    throw new TaskAnswerValidationError(code, AnswerValidationSchema.parse({ ...base, stage, issues }));
  };
  if (typeof text !== 'string') return fail('ANSWER_CAPTURE_INVALID', 'answer_capture');
  if (Buffer.byteLength(text) > 262144) return fail('ANSWER_CAPTURE_LIMIT', 'answer_capture');
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    if (!allowFormatting) return fail('ANSWER_JSON_PARSE_FAILED', 'json_parse');
    const normalized = normalizeAnswerFormatting(text);
    try { value = JSON.parse(normalized); }
    catch { try { value = assembleCounterEnvelope(normalized); } catch { return fail('ANSWER_JSON_PARSE_FAILED', 'json_parse'); } }
  }
  try { return parse(value); }
  catch (error) {
    if (error instanceof TaskAnswerValidationError)
      throw new TaskAnswerValidationError(error.code, AnswerValidationSchema.parse({ ...base, ...error.validation }));
    if (error instanceof z.ZodError) {
      const issues = error.issues.slice(0, 24).map(issue => ({
        path: issue.path.slice(0, 16).map(part => typeof part === 'number' && Number.isSafeInteger(part) && part >= 0
          ? part : typeof part === 'string' && fields.has(part) ? part : '$unknown'),
        code: issueCodes.has(issue.code) ? issue.code : 'custom',
        ...('expected' in issue && typeof issue.expected === 'string' && expectedTypes.has(issue.expected) ? { expected: issue.expected } : {}),
        ...(Object.hasOwn(rules, issue.message) ? { rule: rules[issue.message] } : {}),
      }));
      return fail('ANSWER_SCHEMA_INVALID', 'schema_validation', issues);
    }
    return fail(error instanceof Error && applicationCodes.has(error.message) ? error.message : 'ANSWER_VALIDATION_FAILED', 'application_validation');
  }
}
