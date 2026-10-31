import { useMemo, useState } from 'react';
import type { Catalog } from '../types.js';
import { Icon } from './Icons.js';

export function ChallengePicker({ catalog, companyId, challengeId, onCompany, onChallenge, onCreate, creating }: {
  catalog: Catalog; companyId: string; challengeId: string; onCompany: (id: string) => void;
  onChallenge: (id: string) => void; onCreate: () => void; creating: boolean;
}) {
  const [filter, setFilter] = useState('');
  const company = catalog.companies.find(c => c.id === companyId);
  const choices = useMemo(() => catalog.companies.filter(c => `${c.id} ${c.name}`.toLowerCase().includes(filter.toLowerCase())), [catalog, filter]);
  return <section className="challenge-picker" aria-labelledby="picker-heading">
    <div className="sidebar-heading"><Icon name="search" /><h2 id="picker-heading">Choose a challenge</h2></div>
    <label htmlFor="company-search">Find a company</label>
    <input id="company-search" type="search" placeholder="Company name or ID" value={filter} onChange={e => setFilter(e.target.value)} disabled={creating} />
    <label htmlFor="company-select">Company</label>
    <select id="company-select" value={companyId} onChange={e => onCompany(e.target.value)} disabled={creating}>
      {company && !choices.some(c => c.id === companyId) ? <option value={company.id}>{company.name} ({company.id})</option> : null}
      {choices.map(c => <option value={c.id} key={c.id}>{c.name} ({c.id})</option>)}
    </select>
    {choices.length === 0 ? <p className="muted small" role="status">No companies match your search.</p> : null}
    <fieldset disabled={creating}><legend>Technical challenge</legend>
      {company?.challenges.map((challenge, i) => <label className={`challenge-option ${challenge.id === challengeId ? 'selected' : ''}`} key={challenge.id}>
        <span className="challenge-radio"><input type="radio" name="challenge" value={challenge.id} checked={challenge.id === challengeId} onChange={() => onChallenge(challenge.id)} /><span>Challenge {i + 1}</span><span className="id-text">{challenge.id}</span></span>
        <span className="challenge-text">{challenge.text}</span>
      </label>)}
    </fieldset>
    <button className="button primary start-button" onClick={onCreate} disabled={!challengeId || creating || !catalog.newRunsAvailable}>
      <Icon name="spark" size={18} />{creating ? 'Starting analysis…' : 'Start analysis'}
    </button>
    {!catalog.newRunsAvailable ? <p className="small muted">New analyses are unavailable. You can still open recorded runs.</p> : <p className="small muted">Uses the official synthetic dataset.</p>}
  </section>;
}
