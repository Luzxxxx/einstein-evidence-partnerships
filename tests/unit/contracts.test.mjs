import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../../dist/server/contracts/domain.js';
import { LimitsSchema, DEFAULT_LIMITS } from '../../dist/server/contracts/config.js';
import { transitionRun, validateReviewBinding } from '../../dist/server/contracts/state.js';
import { input, target, evidence, claim, finding, review, draft, counter, pool, record,
  expectation, actor, ids, h } from '../fixtures/contracts.mjs';

const invalid = (schema, value) => assert.equal(schema.safeParse(value).success, false);
const copy = value => structuredClone(value);

test('RunRequest only accepts client selection, not authority or model configuration', () => {
  assert.deepEqual(c.RunRequestSchema.parse({ companyId: 'C001', challengeId: 'C001-CH1' }),
    { companyId: 'C001', challengeId: 'C001-CH1' });
  for (const [key, value] of Object.entries({ runId: ids.run, mode: 'research', runnerMode: 'live',
    approved: true, apiKey: 'test', model: 'other', seq: 1 }))
    invalid(c.RunRequestSchema, { companyId: 'C001', challengeId: 'C001-CH1', [key]: value });
  invalid(c.RunRequestSchema, { companyId: 'C002', challengeId: 'C001-CH1' });
});

test('trusted inputs remain strict and pinned without conflating valid shape with source existence', () => {
  c.RunInputSchema.parse(input());
  for (const change of [{ companyId: 'C000' }, { challengeId: 'C001-CH0' }, { runId: 'run' },
    { datasetCommit: 'a'.repeat(40) }, { mode: 'fixture' }, { approved: true }])
    invalid(c.RunInputSchema, { ...input(), ...change });
});

test('Evidence requires a distinct lowercase raw-file hash and code-point range', () => {
  c.EvidenceSchema.parse(evidence());
  for (const value of [undefined, null, '', 'A'.repeat(64), 'f'.repeat(63), 'not-a-hash']) {
    const e = evidence(); if (value === undefined) delete e.sourceFileSha256; else e.sourceFileSha256 = value;
    invalid(c.EvidenceSchema, e);
  }
  const e = evidence(); e.source.codePointRange = [0, 3]; invalid(c.EvidenceSchema, e);
  for (const range of [[-1, 1], [3, 2], [0.5, 2], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    const e = evidence(); e.source.codePointRange = range; invalid(c.EvidenceSchema, e);
  }
});

test('SourceRef locator/file combinations are exclusive and traversal is invalid', () => {
  for (const mutation of [
    { file: '../secret.jsonl' }, { fieldPointer: '/authors/-1' }, { fieldPointer: '/a~2b' },
    { locator: { format: 'jsonl', line1Based: 0 } },
    { locator: { format: 'jsonl', line1Based: 1, jsonPointer: '/extra' } },
    { file: 'data/researchers.json' }, { file: 'data/unknown.jsonl' },
  ]) invalid(c.EvidenceSchema, { ...evidence(), source: { ...evidence().source, ...mutation } });
});

test('Claims bind declared evidence and constrain relation shapes', () => {
  c.ClaimSchema.parse(claim());
  invalid(c.ClaimSchema, { ...claim(), evidenceIds: [] });
  invalid(c.ClaimSchema, { ...claim(), sourceBindings: [] });
  const wrong = claim(); wrong.sourceBindings[0].evidenceId = 'e-other'; invalid(c.ClaimSchema, wrong);
  const badRelation = claim(); badRelation.sourceBindings[0].relation = 'author_of'; invalid(c.ClaimSchema, badRelation);
  invalid(c.ClaimSchema, { ...claim(), evidenceIds: ['e-1', 'e-1'] });
  invalid(c.ClaimSchema, { ...claim(), approved: true });
});

test('draft, pool and counter reject incoherent identities, references and counts', () => {
  c.ProposalDraftSchema.parse(draft()); c.CandidatePoolSchema.parse(pool()); c.CounterReportSchema.parse(counter());
  invalid(c.ProposalDraftSchema, { ...draft(), challengeId: 'C002-CH1' });
  invalid(c.ProposalDraftSchema, { ...draft(), pair: { companyId: 'C001', researcherId: 'R0001' } });
  invalid(c.ProposalDraftSchema, { ...draft(), claims: [claim(), claim()] });
  invalid(c.ProposalDraftSchema, { ...draft(), sections: { summary: [{ text: 'unknown', claimIds: ['not-here'] }] } });
  const p = pool(); p.candidates.push(copy(p.candidates[0])); invalid(c.CandidatePoolSchema, p);
  invalid(c.CandidatePoolSchema, { ...pool(), mergedCandidateCount: 0 });
  invalid(c.CounterReportSchema, { ...counter(), checkedCandidates: [] });
});

test('model Critic output cannot set captured target, identity, version or approval', () => {
  c.CriticOutputSchema.parse({ verdict: 'approve', findings: [] });
  for (const fields of [{ target: target() }, { hash: h(1) }, { agentId: ids.agent },
    { runId: ids.run }, { approved: true }]) invalid(c.CriticOutputSchema, { verdict: 'approve', findings: [], ...fields });
  invalid(c.CriticOutputSchema, { verdict: 'approve', findings: [finding()] });
  invalid(c.CriticOutputSchema, { verdict: 'revise', findings: [] });
  const f = finding(); delete f.recheckQuestion; invalid(c.CriticOutputSchema, { verdict: 'revise', findings: [f] });
  invalid(c.ReviewFindingSchema, { ...finding(), claimIds: [] });
});

test('review binding checks every captured field and requires complete current target', () => {
  assert.deepEqual(validateReviewBinding(review(), expectation(), ids.run), []);
  for (const field of Object.keys(target())) {
    const r = review(); r.target[field] = typeof r.target[field] === 'number' ? 2 : h(0);
    assert.ok(validateReviewBinding(r, expectation(), ids.run).length > 0, field);
    const missing = review(); delete missing.target[field]; invalid(c.CriticReviewSchema, missing);
  }
  assert.ok(validateReviewBinding({ ...review(), version: 2 }, expectation(), ids.run).length > 0);
  assert.ok(validateReviewBinding({ ...review(), runId: ids.otherRun }, expectation(), ids.run).length > 0);
});

test('a bare approved record or worker outcome is never a valid release', () => {
  c.RunRecordSchema.parse(record());
  invalid(c.RunRecordSchema, { ...record(), status: 'approved' });
  invalid(c.RunOutcomeSchema, { runId: ids.run, kind: 'approved', approved: true });
  invalid(c.RunOutcomeSchema, { runId: ids.run, kind: 'reviewed', reasonCodes: [] });
  c.RunOutcomeSchema.parse({ runId: ids.run, kind: 'reviewed', draft: draft(), review: review(), counter: counter(), reasonCodes: [] });
  invalid(c.RunOutcomeSchema, { runId: ids.otherRun, kind: 'reviewed', draft: draft(), review: review(), counter: counter(), reasonCodes: [] });
});

test('hard limits and raw usage do not invent token or monetary budgets', () => {
  assert.equal(DEFAULT_LIMITS.maxModelRequests, 16); LimitsSchema.parse(DEFAULT_LIMITS);
  invalid(LimitsSchema, { ...DEFAULT_LIMITS, maxActiveRuns: 0 });
  // Approved design: 2 is an explicit trusted test/config override, never the default.
  LimitsSchema.parse({ ...DEFAULT_LIMITS, maxActiveRuns: 2 });
  invalid(LimitsSchema, { ...DEFAULT_LIMITS, maxActiveRuns: 3 });
  invalid(LimitsSchema, { ...DEFAULT_LIMITS, tokenBudget: 999 });
  const u = c.RawUsageSchema.parse({ source: 'gateway_reported', requestId: ids.task });
  assert.equal(u.promptTokens, undefined);
  invalid(c.RawUsageSchema, { ...u, totalTokens: -1 });
});

test('pointers reject malformed Unicode and Counter findings have unique IDs', () => {
  invalid(c.SourceRefSchema, { ...evidence().source, fieldPointer: '/\ud800' });
  invalid(c.SourceRefSchema, { ...evidence().source, file: 'data/researchers.json',
    locator: { format: 'json', jsonPointer: '/\udfff' } });
  invalid(c.CounterReportSchema, { ...counter(), findings: [finding(), finding()] });
});

test('derived page record IDs have the same alphabet in sources and generic bindings', () => {
  const source = { ...evidence().source, file: 'data/company-pages.jsonl', recordId: 'company-page:1', derivedRecordId: true };
  c.SourceRefSchema.parse(source);
  c.SourceBindingSchema.parse({ ...claim().sourceBindings[0], subjectId: source.recordId });
});

test('Run records cannot smuggle approval or skip captured review rounds', () => {
  for (const change of [ { publishedDraftHash: h(4) }, { acceptedReview: review(), reviewExpectation: expectation() },
    { status: 'reviewing' }, { status: 'revising', revisionCount: 0 },
    { status: 'researching', reviewExpectation: expectation() } ])
    invalid(c.RunRecordSchema, { ...record(), ...change });
  const v = { ...record(), status: 'reviewing', cleanupState: 'pending', reviewExpectation: expectation() };
  c.RunRecordSchema.parse(v);
  invalid(c.RunRecordSchema, { ...v, revisionCount: 1 });
  const e = expectation(); e.actor.attempt = 2;
  invalid(c.RunRecordSchema, { ...v, reviewExpectation: e });
  invalid(c.RunRecordSchema, { ...v, publishedDraftHash: h(4) });
});

test('reviewed worker outcomes bind all available artifact hashes and versions', () => {
  const value = { runId: ids.run, kind: 'reviewed', draft: draft(), review: review(), counter: counter(), reasonCodes: [] };
  for (const mutate of [
    v => { v.review.target.draftHash = h(0); }, v => { v.review.target.draftVersion = 2; },
    v => { v.review.target.inputHash = h(0); }, v => { v.review.target.poolVersion = 2; },
    v => { v.review.target.poolHash = h(0); }, v => { v.review.target.counterReportHash = h(0); },
    v => { v.review.target.evidenceSnapshotHash = h(0); }, v => { v.counter.poolHash = h(0); },
    v => { v.counter.inputHash = h(0); }, v => { v.review.version = 2; },
  ]) { const v = copy(value); mutate(v); invalid(c.RunOutcomeSchema, v); }
});

test('terminal records preserve possible history, never impossible review rounds', () => {
  for (const status of ['failed', 'cancelled', 'insufficient']) {
    invalid(c.RunRecordSchema, { ...record(), status, revisionCount: 1 });
    const later = expectation(); later.reviewVersion = 2; later.actor.attempt = 2; later.target.draftVersion = 2;
    invalid(c.RunRecordSchema, { ...record(), status, reviewExpectation: later });
    c.RunRecordSchema.parse({ ...record(), status, revisionCount: 1, reviewExpectation: expectation() });
  }
});

test('a reassembled draft round can retain an unchanged counter report version', () => {
  const d = { ...draft(), version: 2, draftHash: h(0) };
  const r = { ...review(), version: 2, target: { ...target(), draftVersion: 2, draftHash: h(0) } };
  c.RunOutcomeSchema.parse({ runId: ids.run, kind: 'reviewed', draft: d, review: r, counter: counter(), reasonCodes: [] });
  invalid(c.RunOutcomeSchema, { runId: ids.run, kind: 'reviewed', draft: d, review: r,
    counter: { ...counter(), hash: h(0) }, reasonCodes: [] });
});

function event(seq, action, payload = {}) { return { runId: ids.run, seq, action, ...payload }; }
function researching() { return transitionRun(record(), event(1, 'start')).state; }
function reviewing() { return transitionRun(researching(), event(2, 'begin_review', { expectation: expectation() })).state; }
function reviewEvent(seq, value = review()) { return event(seq, 'review_result', { actor: actor(), review: value }); }

test('approve remains reviewing until matching publication acknowledgement and cleanup', () => {
  const accepted = transitionRun(reviewing(), reviewEvent(3));
  assert.equal(accepted.state.status, 'reviewing');
  assert.ok(accepted.state.acceptedReview);
  assert.equal(transitionRun(accepted.state, event(4, 'publication_committed', {
    reviewId: 'review-1', reviewHash: h(9), draftHash: h(4) })).kind, 'ignored');
  const cleaned = transitionRun(accepted.state, event(4, 'cleanup_confirmed')).state;
  const result = transitionRun(cleaned, event(5, 'publication_committed', {
    reviewId: 'review-1', reviewHash: h(9), draftHash: h(4) }));
  assert.equal(result.state.status, 'approved'); c.RunRecordSchema.parse(result.state);
});

test('publication acknowledgement binds all references; approved is irreversible', () => {
  const accepted = transitionRun(reviewing(), reviewEvent(3)).state;
  const cleaned = transitionRun(accepted, event(4, 'cleanup_confirmed')).state;
  const publication = { reviewId: 'review-1', reviewHash: h(9), draftHash: h(4) };
  for (const patch of [{ reviewId: 'other' }, { reviewHash: h(0) }, { draftHash: h(0) }])
    assert.equal(transitionRun(cleaned, event(5, 'publication_committed', { ...publication, ...patch })).kind, 'ignored');
  const approved = transitionRun(cleaned, event(5, 'publication_committed', publication)).state;
  for (const e of [event(6, 'cancel'), event(7, 'fail', { reason: 'late' }),
    event(8, 'start'), reviewEvent(9), event(10, 'begin_review', { expectation: expectation() })]) {
    const result = transitionRun(approved, e);
    assert.equal(result.kind, 'ignored'); assert.equal(result.state.status, 'approved');
    assert.equal(result.state.publishedDraftHash, h(4));
  }
});

test('stale targets, wrong actors and duplicate/out-of-order sequence do not accept review', () => {
  const state = reviewing();
  const r = review(); r.target.poolHash = h(0);
  assert.equal(transitionRun(state, reviewEvent(3, r)).kind, 'ignored');
  assert.equal(transitionRun(state, { ...reviewEvent(3), actor: { ...actor(), role: 'proposer' } }).kind, 'ignored');
  const got = transitionRun(state, reviewEvent(3)).state;
  assert.equal(transitionRun(got, reviewEvent(3)).kind, 'ignored');
  assert.equal(transitionRun(got, reviewEvent(2)).kind, 'ignored');
});

test('cancellation and other terminal states cannot be reopened, while cleanup can finish', () => {
  const cancelled = transitionRun(reviewing(), event(3, 'cancel')).state;
  assert.equal(cancelled.status, 'cancelled');
  const before = copy(cancelled);
  assert.equal(transitionRun(cancelled, reviewEvent(4)).kind, 'ignored');
  assert.deepEqual(cancelled, before, 'Pure rules must not mutate the input');
  const cleaned = transitionRun(cancelled, event(5, 'cleanup_confirmed')).state;
  assert.equal(cleaned.status, 'cancelled'); assert.equal(cleaned.cleanupState, 'confirmed');
  for (const status of ['failed', 'insufficient']) {
    const finished = transitionRun(reviewing(), event(3, status === 'failed' ? 'fail' : 'insufficient', { reason: 'fixture' })).state;
    assert.equal(finished.status, status);
    assert.equal(transitionRun(finished, event(4, 'start')).kind, 'ignored');
  }
});

test('one revise changes round; stale binding or a second revise cannot create a third round', () => {
  const r = { ...review(), verdict: 'revise', findings: [finding()] };
  const revised = transitionRun(reviewing(), reviewEvent(3, r)).state;
  assert.equal(revised.status, 'revising'); assert.equal(revised.revisionCount, 1);
  assert.equal(transitionRun(revised, event(4, 'begin_review', { expectation: expectation() })).kind, 'ignored');
  const next = expectation(); next.reviewVersion = 2; next.actor.attempt = 2;
  next.actor.taskId = ids.otherRun; next.actor.contextId = ids.task;
  next.target.draftVersion = 2; next.target.draftHash = h(0); next.target.counterReportHash = h(6);
  const second = transitionRun(revised, event(5, 'begin_review', { expectation: next })).state;
  const again = { ...r, version: 2, target: next.target };
  const ended = transitionRun(second, event(6, 'review_result', { actor: next.actor, review: again })).state;
  assert.equal(ended.status, 'insufficient'); assert.equal(ended.revisionCount, 1);
});
