// Optional local answer recorder for a natural research diagnostic. Business
// execution still uses the production worker/engine, original tools and API.
import { appendFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { startWorker } from '../dist/server/runtime/worker-entry.js';
import { captureAnswerText } from '../dist/server/runtime/answer-diagnostics.js';

const index = process.argv.indexOf('--capture-folder');
const folder = index >= 0 ? process.argv[index + 1] : undefined;
if (!folder || !isAbsolute(folder)) throw Error('RESEARCH_CAPTURE_FOLDER_REQUIRED');
startWorker({ configure: async ({ start }) => {
  const gateway = { baseURL: process.env.EINSTEIN_GATEWAY_BASE_URL ?? '',
    apiKey: process.env.EINSTEIN_GATEWAY_API_KEY ?? '', model: process.env.EINSTEIN_GATEWAY_MODEL ?? '' };
  const file = join(folder, 'answers.jsonl');
  writeFileSync(file, JSON.stringify({ kind: 'header', runId: start.runId, runnerMode: 'live', controlledSeed: false }) + '\n', { flag: 'wx' });
  return { runnerMode: 'live', gateway,
    onNative(event, actor) {
      if (event.type !== 'model.answer') return;
      const saved = captureAnswerText(event.payload.answer?.content?.text, gateway.apiKey, 262144);
      appendFileSync(file, JSON.stringify({ kind: 'answer', actor, ...saved }) + '\n');
    } };
} });
