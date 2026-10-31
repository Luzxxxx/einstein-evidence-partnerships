// OFFLINE_FIXTURE: real production worker bootstrap/native loops/tools/parent permits.
// Only HTTPS transport is replaced with a deterministic local Response factory.
import { randomUUID, createHash } from 'node:crypto';
import { access, rename, writeFile } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startWorker } from '../../dist/server/runtime/worker-entry.js';
import { createGatewayRunner } from '../../dist/server/model/gateway-runner.js';
import { PROPOSER_INSTRUCTION } from '../../dist/server/runtime/agents/proposer.js';
import { COUNTER_INSTRUCTION } from '../../dist/server/runtime/agents/counter-evidence.js';
import { CRITIC_INSTRUCTION } from '../../dist/server/runtime/agents/critic.js';

const argument = name => { const slot = process.argv.indexOf(name); return slot < 0 ? undefined : process.argv[slot + 1]; };
const mode = argument('--mode') ?? 'normal';
const pathArgument = argument('--barrier-path');
if (!['normal', 'answer-invalid', 'revise', 'batch', 'batch-tool-wait', 'permit-wait', 'fetch-wait', 'tool-wait', 'artifact-wait', 'outcome-wait', 'fetch-fail', 'fetch-disconnect'].includes(mode)) throw Error('OFFLINE_FIXTURE_MODE_INVALID');
if (!pathArgument) throw Error('OFFLINE_FIXTURE_BARRIER_PATH_REQUIRED');
const barrierPath = resolve(pathArgument);
const batchMode = mode === 'batch' || mode === 'batch-tool-wait';
const hashText = text => createHash('sha256').update(text, 'utf8').digest('hex');
const require = (condition, code) => { if (!condition) throw Error(code); };
let marker;
function mark(stage, fields = {}) {
  // This is a trusted test-control path from the fork arguments, never a model/tool argument.
  marker ??= (async () => {
    const temporary = `${barrierPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ runnerMode: 'offline_fixture', stage, ...fields }) + '\n', { flag: 'wx' });
    await rename(temporary, barrierPath);
  })();
  return marker;
}
let signalMarked = false;
function markSignal(stage, fields = {}) {
  if (signalMarked) return; signalMarked = true;
  // Synchronous tiny atomic receipt survives the worker's immediate disconnect shutdown.
  const temporary = `${barrierPath}.${randomUUID()}.signal.tmp`;
  writeFileSync(temporary, JSON.stringify({ runnerMode: 'offline_fixture', stage, observed: true, ...fields }) + '\n', { flag: 'wx' });
  renameSync(temporary, `${barrierPath}.signal.json`);
}
function withSignal(promise, signal) {
  return new Promise((resolveResult, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(Error('OFFLINE_FIXTURE_ABORTED')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolveResult(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
const waitForAbort = signal => withSignal(new Promise(() => {}), signal);
async function waitForStartupRelease(signal) {
  while (true) {
    try { await access(`${barrierPath}.release`); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await withSignal(new Promise(done => setTimeout(done, 20)), signal);
  }
}

// A regression that accidentally reaches the default transport fails locally.
globalThis.fetch = async () => { throw Error('OFFLINE_FIXTURE_NETWORK_FORBIDDEN'); };

startWorker({
  async configure({ start, signal, permitClient }) {
    if (mode === 'permit-wait') { await mark('startup'); await waitForStartupRelease(signal); }
    const firstRoles = new Set();
    let releaseFirst;
    const bothFirstFetches = new Promise(resolveBoth => { releaseFirst = resolveBoth; });
    const instructionRoles = new Map([[PROPOSER_INSTRUCTION, 'proposer'], [COUNTER_INSTRUCTION, 'counter-evidence'], [CRITIC_INSTRUCTION, 'critic']]);
    const originalBatches = new Map(), actors = new Map(), nativeResults = new Map(), nativeContexts = new Map(), activeCallsByToolName = new Map();
    function observeNative(event, actor) {
      if (!batchMode) return;
      const payload=event.payload;
      if(event.type==='inference.started'){
        actors.set(actor.role,{...actor});
        nativeContexts.set(actor.role,payload.context.getItems().filter(item=>item.type==='function_call'||item.type==='function_call_output')
          .map(item=>item.type==='function_call'?{type:item.type,callId:item.callId,toolName:item.name}
            :{type:item.type,callId:item.callId,outputSha256:hashText(item.output.text)}));
      }else if(event.type==='function_call.started'){
        activeCallsByToolName.set(payload.call.name,{actor:{...actor},callId:payload.call.callId,toolName:payload.call.name});
      }else if(event.type==='function_call.completed'){
        const result=JSON.parse(payload.output.text);
        require(result.ok===true&&result.runId===actor.runId&&result.receiptId,'OFFLINE_FIXTURE_NATIVE_BATCH_RESULT_INVALID');
        nativeResults.set(payload.callId,{callId:payload.callId,receiptId:result.receiptId,runId:result.runId,
          outputSha256:hashText(payload.output.text)});
      }
    }

    async function fakeFetch(url, init) {
      require(String(url) === 'https://offline-fixture.invalid/v1/chat/completions', 'OFFLINE_FIXTURE_URL_INVALID');
      require(init.redirect === 'manual' && init.method === 'POST', 'OFFLINE_FIXTURE_REQUEST_INVALID');
      const request = JSON.parse(init.body);
      require(request.model === 'offline_fixture' && request.stream === false && request.parallel_tool_calls === false, 'OFFLINE_FIXTURE_MODEL_INVALID');
      require(Array.isArray(request.messages) && !request.messages.some(m => m.role === 'developer'), 'OFFLINE_FIXTURE_DEVELOPER_MAPPING_INVALID');
      const systems = request.messages.filter(m => m.role === 'system');
      require(systems.length === 1, 'OFFLINE_FIXTURE_SYSTEM_CONTEXT_INVALID');
      const role = [...instructionRoles].find(([instruction]) => systems[0].content.startsWith(instruction))?.[1];
      require(role, 'OFFLINE_FIXTURE_ROLE_INVALID');
      const payload = request.messages.filter(m => m.role === 'user').map(m => {
        try { return JSON.parse(m.content); } catch { return undefined; }
      }).find(v => v?.input && v?.pool);
      require(payload?.input.runId === start.runId && payload.pool.candidates.length > 0, 'OFFLINE_FIXTURE_TASK_BINDING_INVALID');
      const toolMessages = request.messages.filter(m => m.role === 'tool');
      if (mode === 'fetch-wait') {
        await mark('fetch', { role });
        await waitForAbort(init.signal);
      }
      if (mode === 'fetch-disconnect') {
        init.signal.addEventListener('abort', () => markSignal('disconnect-signal-aborted', { role }), { once: true });
        await mark('channel-disconnect', { role });
        // Intentional real IPC channel loss, not an abrupt parent-death claim.
        if (process.connected) process.disconnect();
        await waitForAbort(init.signal);
      }
      if (mode === 'fetch-fail') {
        firstRoles.add(role); if (firstRoles.size === 2) releaseFirst();
        await withSignal(bothFirstFetches, init.signal);
        if (role === 'proposer') {
          await mark('failure-fence', { bothNativeFetchesEntered: true });
          throw Error('private-offline-provider-error');
        }
        init.signal.addEventListener('abort', () => markSignal('sibling-fetch-aborted', { role }), { once: true });
        await waitForAbort(init.signal);
      }
      let message;
      if (role === 'critic') {
        require(payload.reviewSnapshot?.draft && payload.reviewSnapshot.counter
          && payload.reviewSnapshot.draft.poolHash === payload.pool.poolHash
          && payload.reviewSnapshot.counter.poolHash === payload.pool.poolHash, 'OFFLINE_FIXTURE_CRITIC_INPUT_INVALID');
        const reviewed=payload.reviewSnapshot;
        if(mode==='revise'&&reviewed.draft.version===1){
          const claim=reviewed.draft.claims[0];
          message={role:'assistant',content:JSON.stringify({verdict:'revise',findings:[{
            id:'F_OFFLINE_NATIVE_RECHECK',scope:'claim',claimIds:[claim.id],evidenceIds:[claim.evidenceIds[0]],
            code:'OFFLINE_FIXTURE_PROTOCOL_REVISION',severity:'blocking',
            explanation:'OFFLINE_FIXTURE protocol scenario only: /sections/validation has no explicit recheck condition. Original /notes must stay complete; this scripted finding is not model semantic assessment.',
            recheckQuestion:'Read the same candidate original notes and add an explicit bounded validation condition; preserve all original limits and return changed complete draft content.'
          }]})};
        }else{
          if(mode==='revise')require(reviewed.draft.version===2&&reviewed.draft.sections.validation?.length
            &&reviewed.counter.version===1&&reviewed.counter.hash===payload.previousReview.target.counterReportHash
            &&reviewed.draft.draftHash!==payload.previousReview.target.draftHash,'OFFLINE_FIXTURE_REVISION_SNAPSHOT_INVALID');
          message = { role: 'assistant', content: JSON.stringify({ verdict: 'approve', findings: [] }) };
        }
      } else if (!toolMessages.length) {
        // Both real parent-granted fetch intervals must overlap before either source call is returned.
        firstRoles.add(role); if (firstRoles.size === 2) releaseFirst();
        await withSignal(bothFirstFetches, init.signal);
        const names = batchMode ? (role==='proposer'?['read_candidate_bundle','read_company_challenge']:['read_company_challenge','read_candidate_bundle'])
          : [role === 'proposer' ? 'read_candidate_bundle' : 'read_company_challenge'];
        const calls=names.map((name,index)=>{
          require(request.tools.some(t=>t.function.name===name&&t.function.strict===true),'OFFLINE_FIXTURE_SOURCE_TOOL_MISSING');
          const args=name==='read_candidate_bundle'?{runId:payload.input.runId,researcherId:payload.pool.candidates[0].researcherId}
            :{runId:payload.input.runId,companyId:payload.input.companyId,challengeId:payload.input.challengeId};
          return{id:`fixture_${role.replaceAll('-','_')}_${index}_${randomUUID()}`,type:'function',function:{name,arguments:JSON.stringify(args)}};
        });
        if(batchMode)originalBatches.set(role,structuredClone(calls));
        message = { role: 'assistant', content: null, tool_calls: calls };
      } else {
        require(toolMessages.length === (batchMode?2:1), 'OFFLINE_FIXTURE_TOOL_RESULT_COUNT_INVALID');
        if(batchMode){
          const calls=originalBatches.get(role),assistant=request.messages.filter(m=>m.role==='assistant'&&m.tool_calls?.length);
          require(calls?.length===2&&assistant.length===1&&assistant[0].tool_calls.length===2
            &&JSON.stringify(assistant[0].tool_calls)===JSON.stringify(calls),'OFFLINE_FIXTURE_ORIGINAL_BATCH_CALLS_CHANGED');
          const receipts=calls.map((call,index)=>{
            const output=toolMessages[index],native=nativeResults.get(call.id),result=JSON.parse(output.content);
            require(output.tool_call_id===call.id&&native&&native.outputSha256===hashText(output.content)
              &&native.receiptId===result.receiptId&&result.ok&&result.runId===start.runId,'OFFLINE_FIXTURE_BATCH_OUTPUT_MAPPING_INVALID');
            return native;
          });
          const contextItems=nativeContexts.get(role),actor=actors.get(role);
          require(actor?.runId===start.runId&&contextItems?.length===4,'OFFLINE_FIXTURE_BATCH_NATIVE_CONTEXT_MISSING');
          require(contextItems.every((item,index)=>item.callId===calls[Math.floor(index/2)].id)
            &&contextItems[1].outputSha256===receipts[0].outputSha256&&contextItems[3].outputSha256===receipts[1].outputSha256,
          'OFFLINE_FIXTURE_BATCH_NATIVE_CONTEXT_MAPPING_INVALID');
          await mark('batch-roundtrip',{role,actor,originalCalls:calls,receipts,contextItems,
            wireMessages:[assistant[0],...toolMessages],scope:'offline_fixture actual native tool results, not provider or semantic quality evidence'});
        }
        const toolMessage = toolMessages[0];
        require(request.messages.some(m => m.role === 'assistant'
          && m.tool_calls?.some(c => c.id === toolMessage.tool_call_id)), 'OFFLINE_FIXTURE_NATIVE_CALL_ID_INVALID');
        const result = JSON.parse(toolMessage.content);
        require(result.ok === true && result.runId === payload.input.runId && result.receiptId
          && result.checks.sourceAndStructural === 'verified', 'OFFLINE_FIXTURE_REAL_TOOL_RESULT_INVALID');
        let body;
        if (role === 'proposer') {
          const candidate = payload.pool.candidates[0];
          require(result.data.candidate.researcherId === candidate.researcherId, 'OFFLINE_FIXTURE_CANDIDATE_BINDING_INVALID');
          const notes = result.data.evidence.find(e => e.source.recordId === candidate.researcherId
            && e.source.fieldPointer === '/notes' && !e.source.codePointRange);
          const restriction = result.data.restrictions.find(r => r.fieldPointer === '/notes');
          require(notes && restriction?.value === notes.excerpt, 'OFFLINE_FIXTURE_FULL_ORIGINAL_NOTES_MISSING');
          const claimId = 'claim_offline_fixture_source_notes';
          body = { researcherId: candidate.researcherId, claims: [{ id: claimId, researcherId: candidate.researcherId,
            kind: 'fact', text: notes.excerpt, evidenceIds: [notes.id], sourceBindings: [{ evidenceId: notes.id,
              subjectId: candidate.researcherId, relation: 'profile_field', objectId: candidate.researcherId,
              fieldPointer: notes.source.fieldPointer }], limitations: ['offline_fixture; transport/tool integration only; semantic quality unassessed'] }],
            sections: { summary: [{ text: notes.excerpt, claimIds: [claimId] }] } };
          if(mode==='revise'&&payload.previousDraft){
            require(payload.previousDraft.version===1&&payload.previousReview?.verdict==='revise'
              &&payload.originalSources?.some(source=>source.source.fieldPointer==='/notes'),
            'OFFLINE_FIXTURE_TARGETED_RECHECK_INPUT_INVALID');
            body.claims[0].limitations.push('offline_fixture targeted recheck: original limits retained; validation remains conditional, not a proven collaboration result');
            body.sections.summary[0].text+=' OFFLINE_FIXTURE: the revised draft now records an explicit validation condition.';
            body.sections.validation=[{text:'OFFLINE_FIXTURE protocol validation: confirm the original participation conditions and data permissions before a bounded experiment; no performance or collaboration guarantee is established.',claimIds:[claimId]}];
          }
        } else {
          require(result.data.challenge.id === payload.input.challengeId, 'OFFLINE_FIXTURE_CHALLENGE_BINDING_INVALID');
          body = { checkedFacets: ['offline_fixture original company/challenge source tool'],
            checkedCandidates: payload.pool.candidates.map(c => c.researcherId), findings: [],
            noCounterEvidenceFound: ['OFFLINE_FIXTURE_ONLY_NOT_SEMANTIC_ASSESSMENT'] };
        }
        if (mode === 'answer-invalid' && role === 'proposer') body.claims[0].sourceBindings = 'offline_fixture_wrong_type';
        message = { role: 'assistant', content: JSON.stringify(body) };
      }
      require(!init.signal.aborted, 'OFFLINE_FIXTURE_ABORTED');
      return new Response(JSON.stringify({ choices: [{ message,...(batchMode?{finish_reason:message.tool_calls?'tool_calls':'stop'}:{}) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    return { runnerMode: 'offline_fixture', signal,...(batchMode?{onNative:observeNative}:{}),
      gateway: { baseURL: 'https://offline-fixture.invalid/v1', apiKey: 'offline-fixture-dummy-key', model: 'offline_fixture' },
      runnerFactory: hooks => createGatewayRunner({ baseURL: 'https://offline-fixture.invalid/v1',
        apiKey: 'offline-fixture-dummy-key', model: 'offline_fixture', signal: hooks.signal,
        resolveTask: hooks.resolveTask,...(batchMode?{toolBatchBridge:hooks.toolBatchBridge}:{}),
        requestTimeoutMs: start.limits.requestTimeoutMs, fetchImpl: fakeFetch }, permitClient, hooks.trace),
      ...(mode === 'tool-wait'||mode==='batch-tool-wait' ? { decorateTools: tools => tools.map(tool => ({ ...tool, async invoke(args) {
        const result = await tool.invoke(args);
        require(result?.ok === true && result.receiptId, 'OFFLINE_FIXTURE_REAL_TOOL_INVOKE_FAILED');
        const call=activeCallsByToolName.get(tool.name);
        if(mode==='batch-tool-wait')require(call?.actor.runId===start.runId,'OFFLINE_FIXTURE_BATCH_INVOKE_ACTOR_MISSING');
        await mark(mode==='batch-tool-wait'?'batch-tool-continuation':'tool-continuation', { toolName: tool.name, realInvokeSucceeded: true,
          receiptId: result.receiptId,...(mode==='batch-tool-wait'?{actor:call.actor,callId:call.callId,
            scope:'actual source invoke succeeded but its output is held before SDK completion; no queued second invoke'}:{}) });
        await waitForAbort(signal);
        return result;
      } })) } : {}),
    };
  },
  async beforeSend(message, signal) {
    if (mode === 'artifact-wait' && message.kind === 'artifact') {
      await mark('artifact-queued', { artifactKind: message.typedArtifact.kind });
      await waitForAbort(signal);
    }
    if (mode === 'outcome-wait' && message.kind === 'outcome' && message.typedOutcome.kind === 'reviewed') {
      await mark('outcome-queued', { outcomeKind: message.typedOutcome.kind });
      await waitForAbort(signal);
    }
  },
});
