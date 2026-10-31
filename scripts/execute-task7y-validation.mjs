// Explicit trusted entry. Every candidate shares the one fixed Task7y attempt.
import {runV4LiveValidation} from '../dist/server/evaluation/v4-bounded-validation.js';
const candidateId=process.argv[2],rawFreezeFileSha256=process.argv[3];
if(process.argv.length!==4||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(candidateId??'')||!/^[a-f0-9]{64}$/.test(rawFreezeFileSha256??'')){
 console.error('TASK7Y_EXACT_CANDIDATE_REQUIRED');process.exitCode=1;
}else await runV4LiveValidation({preparedFreezeFile:'docs/implementation/task-7y-live/candidates/'+candidateId+'/freeze.json',preparedFreezeFileSha256:rawFreezeFileSha256})
 .then(result=>{console.log(JSON.stringify({passed:result.passed,errorCode:result.errorCode,totalGranted:result.execution?.totalGranted??null,L05Executed:false}));if(!result.passed)process.exitCode=1;})
 .catch(()=>{console.error('TASK7Y_EXECUTION_STOPPED_NO_RETRY');process.exitCode=1;});
