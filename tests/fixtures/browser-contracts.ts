// Test-only browser entry: retain every contract export, without adding business UI.
export * as domain from '../../src/contracts/domain.js';
export * as events from '../../src/contracts/events.js';
export * as ipc from '../../src/contracts/ipc.js';
export * as config from '../../src/contracts/config.js';
export * as canonical from '../../src/contracts/canonical.js';
export * as state from '../../src/contracts/state.js';

import type { Evidence, RunOutcome } from '../../src/contracts/domain.js';
import type { WorkerToParentMessage } from '../../src/contracts/ipc.js';
// Compile-time regression probes: a weakened any/unknown output makes these fail.
function checkTypes(evidence: Evidence, outcome: RunOutcome, message: WorkerToParentMessage) {
const hash: string = evidence.sourceFileSha256;
void hash;
if (outcome.kind === 'reviewed') outcome.draft.claims[0]!.evidenceIds;
// @ts-expect-error worker outcomes do not have an approved variant
const approved: RunOutcome['kind'] = 'approved';
void approved;
if (message.kind === 'artifact') {
  // @ts-expect-error typed artifacts cannot carry arbitrary unknown kinds
  const bad: typeof message.typedArtifact.kind = 'untyped_blob';
  void bad;
}
}
void checkTypes;
