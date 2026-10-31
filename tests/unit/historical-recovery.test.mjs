import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHistoricalScanIssue } from '../../scripts/audit-task7r-historical-recovery.mjs';
const root='134378825786040155',old='134378808173647910',later='134378825786040255';
const issue={pid:30656,code:'DESCENDANT_IDENTITY_UNCONFIRMED',stage:'native_identity',parentCreationFileTime:root};
test('worker0 alone never resolves a historical unknown or grants recovery',()=>{
  const r=assessHistoricalScanIssue(issue,{workerCount:0,nativeStatus:'unknown',cimStatus:'absent'});
  assert.equal(r.currentAssociation,'unknown');assert.equal(r.automaticRecoveryAllowed,false);assert.equal(r.historicalCleanupState,'unconfirmed');
});
test('consistent native/CIM older birth excludes current edge while preserving historical proof gap',()=>{
  const r=assessHistoricalScanIssue(issue,{nativeStatus:'present',nativeCreationFileTime:old,cimStatus:'present',cimCreationFileTime:old});
  assert.equal(r.currentAssociation,'excluded_by_consistent_birth');assert.equal(r.originalIdentityMissing,true);assert.equal(r.automaticRecoveryAllowed,false);
});
test('native permission failure plus old CIM remains current-only exclusion with native identity unknown',()=>{
  const r=assessHistoricalScanIssue(issue,{nativeStatus:'unknown',nativeErrorCode:5,cimStatus:'present',cimCreationFileTime:old});
  assert.equal(r.currentAssociation,'excluded_by_cim_birth_current_only');assert.equal(r.nativeIdentityUnknown,true);assert.equal(r.automaticRecoveryAllowed,false);
});
test('birth conflict, close precision and missing time never silently resolve a historical issue',()=>{
  for(const observation of [
    {nativeStatus:'present',nativeCreationFileTime:later,cimStatus:'present',cimCreationFileTime:old},
    {nativeStatus:'unknown',cimStatus:'present',cimCreationFileTime:(BigInt(root)-1n).toString()},
    {nativeStatus:'present',nativeCreationFileTime:null,cimStatus:'present',cimCreationFileTime:null}]){
    const r=assessHistoricalScanIssue(issue,observation);assert.equal(r.currentAssociation,'unknown');assert.equal(r.automaticRecoveryAllowed,false);
  }
});
test('process names cannot exempt unknown identities',()=>{
  for(const name of ['MicrosoftEdgeUpdate.exe','git.exe','node.exe'])assert.equal(assessHistoricalScanIssue(issue,{name,nativeStatus:'unknown',cimStatus:'present'}).currentAssociation,'unknown');
});
test('a recorded at-scan birth is preserved separately and never filled from a later observation',()=>{
  const r=assessHistoricalScanIssue(issue,{nativeStatus:'present',nativeCreationFileTime:old,cimStatus:'present',cimCreationFileTime:old});
  assert.equal(r.recordedAtScanCreationFileTime,null);assert.equal(r.originalIdentityMissing,true);
});
