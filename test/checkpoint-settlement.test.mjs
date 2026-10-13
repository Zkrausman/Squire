import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { withProducer } from '../src/producer-context.mjs';
import { digest } from '../src/contracts.mjs';
import { SQF04_DESIGN_SHA256, settlementContractDigest } from '../src/settlement-contract.mjs';
const h = c => c.repeat(64), sha = c => c.repeat(40);
const nonAdmitting = value => {for(const key of ['admission','settlement','import'])assert.equal(value[key],'not_evaluated');};
function fixture(t, projected = true) {
 const directory=mkdtempSync(path.join(tmpdir(),'squire-checkpoint-binding-'));
 const f={directory,store:new Store(directory),job:randomUUID(),operation:randomUUID(),checkpoint:randomUUID(),requestDigest:h('b')};
 t.after(()=>{f.store.close();rmSync(directory,{recursive:true,force:true});});
 f.config={id:'project',tickets:[{id:'ticket'}]};f.policy=digest(f.config);f.store.initialize(f.config);
 f.lease=f.store.lease('controller:project');f.scope=f.store.beginProducer('project','ticket:ticket',f.lease);
 f.run=fn=>withProducer({store:f.store,project:'project',scopeId:f.scope},fn);
 f.store.update('project',s=>{Object.assign(s.tickets[0],{status:'implementing',workspace:'/offline/project',branch:'squire/offline',generation:1,baseSha:sha('c'),beforeAgentHead:sha('c'),headSha:sha('c'),treeSha:sha('c'),activeJob:f.job});f.store.reserveProducerCall(f.scope,f.job);s.agentCalls++;},'job.started',{jobId:f.job});
 f.grant=f.store.registerProcess(f.scope,f.job,f.operation,directory,f.requestDigest);
 f.store.claimProcess(f.grant,'registered','supervisor',f.requestDigest);f.store.claimProcess(f.grant,'supervisor','target',f.requestDigest);
 f.store.finishProcess(f.grant,'target',{kind:'terminal',exitCode:0,endedAt:105,receiptDigest:h('d')});
 f.input={id:f.checkpoint,projectId:'project',ticketId:'ticket',scopeId:f.scope,purpose:'implementation',workspace:'/offline/project',gitDir:'/offline/project/.git',generation:1,branchRef:'refs/heads/squire/offline',baseSha:sha('c'),parentSha:sha('c'),treeSha:sha('b'),commitSha:sha('a'),policyDigest:f.policy,jobId:f.job,recoveryId:null,files:['src/fixture.mjs'],createdAt:Date.now()};
 // Synthetic SQLite identities: no Git/process/host acceptance is asserted.
 f.run(()=>f.store.prepareCandidateCheckpoint(f.input));
 if(projected)f.run(()=>f.store.update('project',s=>{Object.assign(s.tickets[0],{candidateCheckpointId:f.checkpoint,headSha:sha('a'),treeSha:sha('b'),status:'verifying',activeJob:null,implementation:{jobId:f.job,sessionRef:'fixture'}});},'candidate.projected',{},null,f.checkpoint));
 f.seal=f.run(()=>f.store.sealProcessInventory(f.scope));
 const anchorIdentity={pid:123,startTicks:'456',pidNamespace:'pid:host'};
 f.requirements={version:1,designSha256:SQF04_DESIGN_SHA256,binding:{project:'project',ticket:'ticket',job:f.job,generation:1,candidateSha:sha('a'),policyDigest:f.policy,operationId:f.operation,requestDigest:f.requestDigest},identity:{bootId:'boot',unitName:'squire.service',invocationId:'invocation',controlGroup:'/system.slice/squire.service',cgroupIdentity:'dev:inode',anchorIdentity},deadlines:{startedAtMs:10,execByMs:100,stopByMs:110,observeByMs:120,finalCleanupByMs:130},scope:{sealDigest:f.seal.sealDigest,operations:f.seal.operations}};
 f.receipt=structuredClone({...f.requirements,authority:Object.fromEntries(['managerDigest','migrationDigest','observerDigest','anchorDigest','pidViewDigest','policyDigest','launchBarrierDigest'].map(k=>[k,k==='policyDigest'?f.policy:h('a')])),boundary:{status:'frozen_anchor_only',type:'domain',frozen:1,populated:1,members:[anchorIdentity],subgroups:[],snapshotDigest:h('d'),observedAtMs:115,prunedBeforeSnapshot:false},directTerminal:{status:'terminal',operationId:f.operation,terminalDigest:h('e'),observedAtMs:105},teardown:{status:'terminal',protocol:'teardown_only',anchorIdentity,terminalDigest:h('f'),workloadEmptyDigest:h('d'),observedAtMs:125,prunedBeforeTerminal:false},launchGate:'closed'});
 f.compare=(id=f.checkpoint,projection=null)=>f.store.compareCheckpointSettlement(f.scope,id,f.requirements,f.receipt,projection);
 f.reopen=()=>{f.store.close();f.store=new Store(directory);};
 return f;
}
test('exact explicit projected checkpoint binds durable identities without admission or mutation',t=>{
 const f=fixture(t),before={state:f.store.get('project'),events:f.store.events('project'),checkpoint:f.store.candidateCheckpoint(f.checkpoint),operation:f.store.processOperation(f.operation)};
 const result=f.compare();assert.equal(result.status,'contract_matches');assert.equal(result.checkpoint.checkpointId,f.checkpoint);assert.equal(result.checkpoint.evidence,'durable_metadata_only');assert.match(result.checkpoint.identityDigest,/^[a-f0-9]{64}$/);nonAdmitting(result);
 for(let i=0;i<3;i++){f.reopen();assert.deepEqual(f.compare(),result);assert.deepEqual(f.store.get('project'),before.state);assert.deepEqual(f.store.events('project'),before.events);assert.deepEqual(f.store.candidateCheckpoint(f.checkpoint),before.checkpoint);assert.deepEqual(f.store.processOperation(f.operation),before.operation);}
});
for(const [name,id] of [['missing',null],['malformed','latest'],['nonexistent','f'.repeat(8)+'-ffff-ffff-ffff-'+ 'f'.repeat(12)]])test(`checkpoint ID ${name} stays UNKNOWN, never selects latest`,t=>{
 const f=fixture(t);const result=f.store.compareCheckpointSettlement(f.scope,id,f.requirements,f.receipt);assert.equal(result.status,'unknown');nonAdmitting(result);assert.equal(f.store.db.prepare('SELECT count(*) n FROM candidate_checkpoints').get().n,1);
});
test('unprojected intent is not adopted or projected by comparison',t=>{const f=fixture(t,false);const result=f.compare();assert.equal(result.status,'unknown');nonAdmitting(result);assert.equal(f.store.candidateCheckpoint(f.checkpoint).phase,'intent');});
const ticketChanges=[['checkpoint reference',x=>x.candidateCheckpointId=randomUUID()],['head',x=>x.headSha=sha('f')],['tree',x=>x.treeSha=sha('f')],['base',x=>x.baseSha=sha('f')],['parent',x=>x.beforeAgentHead=sha('f')],['generation',x=>x.generation=2],['branch',x=>x.branch='other'],['workspace',x=>x.workspace='/offline/other'],['implementation job',x=>x.implementation.jobId=randomUUID()],['new active job',x=>x.activeJob=randomUUID()],['missing implementation',x=>delete x.implementation]];
for(const [name,mutate]of ticketChanges)test(`current durable ticket ${name} drift stays UNKNOWN`,t=>{
 const f=fixture(t);f.store.update('project',s=>mutate(s.tickets[0]));const before={state:f.store.get('project'),events:f.store.events('project')};const result=f.compare();assert.equal(result.status,'unknown');nonAdmitting(result);assert.deepEqual(f.store.get('project'),before.state);assert.deepEqual(f.store.events('project'),before.events);
});
for(const field of ['candidateSha','policyDigest','generation'])test(`matching caller/receipt ${field} cannot override durable checkpoint`,t=>{
 const f=fixture(t);f.requirements.binding[field]=field==='generation'?2:field==='candidateSha'?sha('f'):h('f');f.receipt.binding[field]=f.requirements.binding[field];if(field==='policyDigest')f.receipt.authority.policyDigest=h('f');const result=f.compare();assert.equal(result.status,'unknown');nonAdmitting(result);
});
test('changed config hash or durable configuration remains UNKNOWN',t=>{
 const f=fixture(t);f.store.db.prepare('UPDATE project SET config_hash=? WHERE id=?').run(h('a'),'project');assert.equal(f.compare().status,'unknown');f.store.db.prepare('UPDATE project SET config_hash=? WHERE id=?').run(f.policy,'project');f.store.update('project',s=>{s.config.changed=true;});assert.equal(f.compare().status,'unknown');
});
test('duplicate durable ticket IDs are ambiguous',t=>{const f=fixture(t);f.store.update('project',s=>s.tickets.push(structuredClone(s.tickets[0])));assert.equal(f.compare().status,'unknown');});
function alternate(f, overrides) {
 const row=f.store.db.prepare('SELECT * FROM candidate_checkpoints WHERE id=?').get(f.checkpoint),id=randomUUID();
 const value={...row,id,...overrides};const names=Object.keys(value);
 f.store.db.prepare(`INSERT INTO candidate_checkpoints (${names.join(',')}) VALUES (${names.map(()=>'?').join(',')})`).run(...names.map(n=>value[n]));
 f.store.update('project',s=>{s.tickets[0].candidateCheckpointId=id;});return id;
}
for(const [name,change]of [['recovery-only',{purpose:'automatic_recovery'}],['foreign scope',{scope_id:randomUUID()}],['foreign project',{project:'foreign'}],['foreign ticket',{ticket:'foreign'}],['foreign job',{job_id:randomUUID()}],['null physical job',{job_id:null}],['missing projection timestamp',{projected_at:null}],['missing projection digest',{projected_ticket_digest:null}]])test(`explicit ${name} checkpoint is unsupported`,t=>{
 const f=fixture(t),id=alternate(f,change);const result=f.compare(id);assert.equal(result.status,'unknown');nonAdmitting(result);
});
test('checkpoint replacement, update-rekey and UPSERT cannot change or delete existing records',t=>{
 const f=fixture(t),before=f.store.candidateCheckpoint(f.checkpoint);
 assert.throws(()=>f.store.db.prepare('INSERT OR REPLACE INTO candidate_checkpoints SELECT * FROM candidate_checkpoints WHERE id=?').run(f.checkpoint),/immutable/);
 assert.throws(()=>f.store.db.prepare('INSERT INTO candidate_checkpoints SELECT * FROM candidate_checkpoints WHERE id=? ON CONFLICT(id) DO UPDATE SET phase=excluded.phase').run(f.checkpoint),/immutable/);
 const id=alternate(f,{});assert.throws(()=>f.store.db.prepare('UPDATE OR REPLACE candidate_checkpoints SET id=? WHERE id=?').run(f.checkpoint,id),/immutable/);
 assert.throws(()=>f.store.db.prepare('DELETE FROM candidate_checkpoints WHERE id=?').run(f.checkpoint),/immutable/);
 f.reopen();assert.deepEqual(f.store.candidateCheckpoint(f.checkpoint),before);
});
test('same receipt replay still cannot import, close, debit or activate another producer',t=>{
 const f=fixture(t),projection={binding:f.requirements.binding,sealDigest:f.seal.sealDigest,receiptDigest:settlementContractDigest(f.receipt)};
 const before={state:f.store.get('project'),events:f.store.events('project')};
 for(let i=0;i<3;i++){f.reopen();const result=f.compare(f.checkpoint,projection);assert.equal(result.status,'contract_matches');assert.equal(result.replay,'same_receipt');nonAdmitting(result);assert.throws(()=>f.store.update('project',s=>{s.agentCalls++;s.status='completed';},'import.attempt',{},f.scope),{code:'producer_unresolved'});assert.deepEqual(f.store.get('project'),before.state);assert.deepEqual(f.store.events('project'),before.events);assert.throws(()=>f.store.beginProducer('project','ticket:ticket',f.lease),{code:'producer_unresolved'});}
});
test('native evidence remains necessary even with matching checkpoint identity',t=>{
 const f=fixture(t);delete f.receipt.authority.pidViewDigest;const result=f.compare();assert.equal(result.status,'unknown');nonAdmitting(result);assert.equal(result.checkpoint.evidence,'durable_metadata_only');
});

for(const git_dir of ['relative','.','/offline/other/.git','/offline/project'])test(`malformed/outside Git directory ${git_dir} stays UNKNOWN`,t=>{
 const f=fixture(t),id=alternate(f,{git_dir});assert.equal(f.compare(id).status,'unknown');
});
