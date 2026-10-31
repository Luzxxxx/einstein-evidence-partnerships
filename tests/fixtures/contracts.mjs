export const ids = {
  run: '11111111-1111-4111-8111-111111111111',
  otherRun: '22222222-2222-4222-8222-222222222222',
  agent: '33333333-3333-4333-8333-333333333333',
  task: '44444444-4444-4444-8444-444444444444',
  context: '55555555-5555-4555-8555-555555555555',
};
export const h = (n) => String(n).repeat(64);
export const input = () => ({ runId: ids.run, companyId: 'C001', challengeId: 'C001-CH1',
  datasetCommit: '4fb99b3749adf0d10b5977089ff4c73f4f522240', promptVersion: 'prompt-v1',
  configVersion: 'config-v1', mode: 'research' });
export const target = () => ({ inputHash: h(1), poolVersion: 1, poolHash: h(2),
  counterReportHash: h(3), draftVersion: 1, draftHash: h(4), evidenceSnapshotHash: h(5) });
export const actor = () => ({ role: 'critic', agentId: ids.agent, taskId: ids.task,
  contextId: ids.context, attempt: 1 });
export const expectation = () => ({ actor: actor(), reviewVersion: 1, target: target() });
export const evidence = () => ({ id: 'e-1', datasetCommit: input().datasetCommit,
  source: { file: 'data/publications.jsonl', recordId: 'SYN-PUB-00492',
    locator: { format: 'jsonl', line1Based: 492 }, fieldPointer: '/abstract', derivedRecordId: false,
    codePointRange: [0, 2] }, excerpt: 'A😀', excerptSha256: h(6), recordSha256: h(7),
  sourceFileSha256: h(8), canonicalizationVersion: 'node-stable-json-v1' });
export const claim = () => ({ id: 'cl-1', researcherId: 'R1008', kind: 'fact', text: 'Fixture claim.',
  evidenceIds: ['e-1'], sourceBindings: [{ evidenceId: 'e-1', subjectId: 'SYN-PUB-00492',
    relation: 'source_field', objectId: 'R1008', fieldPointer: '/abstract' }], limitations: [] });
export const finding = () => ({ id: 'f-1', scope: 'claim', claimIds: ['cl-1'], evidenceIds: ['e-1'],
  code: 'unsupported_inference', severity: 'blocking', explanation: 'The source does not establish this claim.',
  recheckQuestion: 'Which original field supports this inference?' });
export const review = () => ({ id: 'review-1', runId: ids.run, version: 1, hash: h(9),
  verdict: 'approve', target: target(), findings: [] });
export const draft = () => ({ runId: ids.run, inputHash: h(1), pair: { companyId: 'C001', researcherId: 'R1008' },
  challengeId: 'C001-CH1', version: 1, poolVersion: 1, poolHash: h(2), claims: [claim()],
  sections: { summary: [{ text: 'Fixture claim.', claimIds: ['cl-1'] }] },
  evidenceSnapshotHash: h(5), draftHash: h(4) });
export const counter = () => ({ id: 'counter-1', runId: ids.run, inputHash: h(1), version: 1, hash: h(3),
  poolVersion: 1, poolHash: h(2), checkedFacets: ['method'], checkedCandidates: ['R1008'],
  findings: [], noCounterEvidenceFound: ['No additional counter-evidence found in checked fields.'] });
export const pool = () => ({ poolVersion: 1, poolHash: h(2), datasetCommit: input().datasetCommit,
  query: 'fixture', expandedTerms: [], mergedCandidateCount: 1,
  candidates: [{ researcherId: 'R1008', rank: 1, channels: ['L0'],
    matchedFields: [{ sourceRef: evidence().source, terms: ['fixture'], score: 1 }],
    evidenceIds: ['e-1'], identityFlags: [], restrictionRefs: [] }],
  diagnostics: { corpusCounts: { researchers: 1047 }, channelStatus: { L0: 'available', L1: 'empty', L2: 'empty' },
    facets: ['method'], mergedCount: 1, selectedCount: 1, truncated: false, lowRecallReasons: [], judgedCapture: null } });
export const record = () => ({ runId: ids.run, input: input(), inputHash: h(1), runnerMode: 'live',
  status: 'queued', createdAt: '2026-10-30T10:00:00.000Z', revisionCount: 0,
  cleanupState: 'not_started', lastSeq: 0 });
