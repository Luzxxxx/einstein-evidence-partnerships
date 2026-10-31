import {ProposalDraftSchema} from '../contracts/domain.js';
import {renderApprovedDraft} from '../publishing/render.js';
export const escapeHtml=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
/** Text-only projection of the complete reviewed draft. Never an LLM rewrite. */
export function proposalPresentation(value:unknown){
 const draft=ProposalDraftSchema.parse(JSON.parse(renderApprovedDraft(value)));
 const sections=Object.entries(draft.sections).map(([name,paragraphs])=>({name,paragraphs:paragraphs!}));
 const html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(draft.pair.companyId+':'+draft.pair.researcherId)}</title><body><main><h1>${escapeHtml(draft.pair.companyId+' / '+draft.pair.researcherId)}</h1><p>Challenge ${escapeHtml(draft.challengeId)} · approved draft version ${draft.version}</p>${sections.map(s=>`<section><h2>${escapeHtml(s.name)}</h2>${s.paragraphs.map(p=>`<p>${escapeHtml(p.text)}</p><p>Claims: ${p.claimIds.map(id=>`<a href="#${escapeHtml(id)}">${escapeHtml(id)}</a>`).join(', ')}</p>`).join('')}</section>`).join('')}<section><h2>Claims, evidence and limitations</h2>${draft.claims.map(c=>`<article id="${escapeHtml(c.id)}"><h3>${escapeHtml(c.id)} (${c.kind})</h3><p>${escapeHtml(c.text)}</p><ul>${c.limitations.map(l=>`<li>${escapeHtml(l)}</li>`).join('')}</ul><p>Evidence: ${c.evidenceIds.map(escapeHtml).join(', ')}</p><pre>${escapeHtml(JSON.stringify(c.sourceBindings,null,2))}</pre></article>`).join('')}</section></main></body></html>\n`;
 return {format:'deterministic-approved-view-v1' as const,draft,sections,html};
}
