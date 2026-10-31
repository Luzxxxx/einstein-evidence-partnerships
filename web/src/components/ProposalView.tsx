import type { ProposalDraft } from '../../../src/contracts/domain.js';
import { sectionNames } from '../state.js';
import { Icon } from './Icons.js';

export function EvidenceLinks({ ids, onEvidence }: { ids: readonly string[]; onEvidence: (id: string) => void }) {
  return <span className="evidence-links">{ids.map((id, i) => <button className="evidence-link" title={id} key={id} onClick={() => onEvidence(id)}><Icon name="source" size={13} /><span>Evidence {ids.length > 1 ? i + 1 : ''}</span><span className="sr-only">{id}</span></button>)}</span>;
}
export function ProposalView({ draft, published, companyName, researcherName, onEvidence }: { draft: ProposalDraft; published: boolean; companyName?: string; researcherName?: string; onEvidence: (id: string) => void }) {
  return <article className="proposal-document" aria-label={`Draft version ${draft.version}`}>
    <header className="document-heading"><div><span className={`badge ${published ? 'success' : 'neutral'}`}>{published ? 'Published proposal' : `Draft v${draft.version}`}</span><h2>{companyName ?? draft.pair.companyId}<span className="pair-divider">/</span>{researcherName ?? draft.pair.researcherId}</h2></div><span className="small muted">{draft.challengeId}</span></header>
    {Object.entries(draft.sections).map(([name, paragraphs]) => paragraphs?.length ? <section className="document-section" key={name}><h3>{sectionNames[name] ?? name}</h3>{paragraphs.map((paragraph, i) => <div key={i} className="document-paragraph"><p>{paragraph.text}</p><div className="claim-refs">{paragraph.claimIds.map(id => <a key={id} href={`#claim-${id}`} onClick={e => { e.preventDefault(); const target = document.getElementById(`claim-${id}`); const details = target?.closest('details'); if (details) details.open = true; target?.scrollIntoView({ behavior: 'instant', block: 'center' }); }}>{id}</a>)}</div></div>)}</section> : null)}
    <details className="document-section source-disclosure"><summary>Claims and sources <span className="count-tag">{draft.claims.length}</span></summary>
      {draft.claims.map(claim => <article className="claim" id={`claim-${claim.id}`} key={claim.id}><header><span className={`claim-kind ${claim.kind}`}>{claim.kind === 'fact' ? 'Fact' : claim.kind === 'inference' ? 'Inference' : 'Proposal'}</span><span className="id-text">{claim.id}</span></header><p>{claim.text}</p>
        {claim.limitations.length ? <div className="claim-limits"><strong>Limits</strong><ul>{claim.limitations.map((text, i) => <li key={i}>{text}</li>)}</ul></div> : null}
        <EvidenceLinks ids={claim.evidenceIds} onEvidence={onEvidence} />
        <details className="technical"><summary>Source relationships</summary>{claim.sourceBindings.map((binding, i) => <dl className="metadata" key={i}><dt>Relationship</dt><dd>{binding.relation}</dd><dt>Subject</dt><dd>{binding.subjectId}</dd><dt>Object</dt><dd>{binding.objectId}</dd><dt>Field</dt><dd>{binding.fieldPointer || '(root)'}</dd><dt>Evidence</dt><dd>{binding.evidenceId}</dd></dl>)}</details>
      </article>)}
    </details>
    <details className="technical document-hashes"><summary>Version and source bindings</summary><dl className="metadata"><dt>Draft version</dt><dd>{draft.version}</dd><dt>Draft SHA-256</dt><dd>{draft.draftHash}</dd><dt>Input SHA-256</dt><dd>{draft.inputHash}</dd><dt>Pool version</dt><dd>{draft.poolVersion}</dd><dt>Pool SHA-256</dt><dd>{draft.poolHash}</dd><dt>Evidence snapshot SHA-256</dt><dd>{draft.evidenceSnapshotHash}</dd></dl></details>
  </article>;
}
