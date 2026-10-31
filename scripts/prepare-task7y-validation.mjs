// Trusted preparation entry; no attempt, Store.open, worker or model request.
import {prepareTask7yCandidate} from '../dist/server/evaluation/task7y-preparation.js';
prepareTask7yCandidate({checksBatchId:process.argv[2]}).then(r=>{console.log(JSON.stringify(r));if(!r.passed)process.exitCode=1;})
 .catch(()=>{console.error('TASK7Y_PREPARATION_STOPPED_NO_EXECUTION');process.exitCode=1;});
