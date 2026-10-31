import './reading.css';

export function ReadingGuide({firstRunId}: {firstRunId?: string}) {
  return <section className="reading-guide" aria-labelledby="reading-guide-heading">
    <div className="reading-guide-heading"><h2 id="reading-guide-heading">Start with a real decision.</h2><p>Three short steps through saved research, its sources and an independent review.</p></div>
    <ol className="reading-steps">
      <li><span className="reading-step-number">1</span><h3>Read the pilot</h3><p>See the company’s problem, a proposed partner and the work they could do together.</p>{firstRunId ? <a href={`#run=${firstRunId}&view=overview`}>Open a reviewed proposal</a> : <span>Proposals will appear when available.</span>}</li>
      <li><span className="reading-step-number">2</span><h3>Check the source</h3><p>Open Claims and sources in a proposal, then choose Evidence to inspect the original field.</p>{firstRunId ? <a href={`#run=${firstRunId}&view=proposal`}>Read claims and citations</a> : null}</li>
      <li><span className="reading-step-number">3</span><h3>Follow a challenge</h3><p>A real Critic requested changes. The revised research Run still ended with insufficient evidence.</p><a href="#run=b738ce31-0d8d-4eba-a01e-f4deac26a632&view=changes">See the review and changes</a></li>
    </ol>
    <p className="reading-guide-note">Saved runs, with their actual outcomes. Opening a page does not start a model request.</p>
  </section>;
}
