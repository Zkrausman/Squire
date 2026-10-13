import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { digest } from '../src/contracts.mjs';
import { withProducer } from '../src/producer-context.mjs';
import { SQF04_DESIGN_SHA256, settlementContractDigest } from '../src/settlement-contract.mjs';
const h = c => c.repeat(64);
const blocked = fn => assert.throws(fn, { code: 'producer_unresolved' });
function fixture(t, terminal = true) {
 const directory = mkdtempSync(path.join(tmpdir(), 'squire-sealed-inventory-'));
 const f = { directory, store: new Store(directory), requestDigest: h('b') };
 t.after(() => { f.store.close(); rmSync(directory, {recursive:true,force:true}); });
 f.store.initialize({id:'project',tickets:[]});f.lease=f.store.lease('controller:project');
 f.scope=f.store.beginProducer('project','ticket:ticket',f.lease);
 f.run=fn=>withProducer({store:f.store,scopeId:f.scope,project:'project'},fn);
 f.store.update('project',s=>{f.store.reserveProducerCall(f.scope,'job');s.agentCalls++;},'job.started',{jobId:'job'});
 f.grant=f.store.registerProcess(f.scope,'job','worker',directory,f.requestDigest);
 if(terminal){f.store.claimProcess(f.grant,'registered','supervisor',f.requestDigest);f.store.claimProcess(f.grant,'supervisor','target',f.requestDigest);f.store.finishProcess(f.grant,'target',{kind:'terminal',exitCode:0,endedAt:105,receiptDigest:h('d')});}
 f.seal=()=>f.run(()=>f.store.sealProcessInventory(f.scope));
 f.reopen=()=>{f.store.close();f.store=new Store(directory);};
 f.complete=()=>f.store.update('project',s=>{s.status='completed';},'producer.done',{},f.scope);
 return f;
}
function supplied(f, seal) {
 const anchorIdentity={pid:123,startTicks:'456',pidNamespace:'pid:host'};
 const requirements={version:1,designSha256:SQF04_DESIGN_SHA256,binding:{project:'project',ticket:'ticket',job:'job',generation:1,candidateSha:'a'.repeat(40),policyDigest:h('a'),operationId:'worker',requestDigest:f.requestDigest},
 identity:{bootId:'boot',unitName:'squire.service',invocationId:'invocation',controlGroup:'/system.slice/squire.service',cgroupIdentity:'dev:inode',anchorIdentity},
 deadlines:{startedAtMs:10,execByMs:100,stopByMs:110,observeByMs:120,finalCleanupByMs:130},scope:{sealDigest:seal.sealDigest,operations:seal.operations}};
 const receipt=structuredClone({...requirements,authority:Object.fromEntries(['managerDigest','migrationDigest','observerDigest','anchorDigest','pidViewDigest','policyDigest','launchBarrierDigest'].map(k=>[k,h('a')])),
 boundary:{status:'frozen_anchor_only',type:'domain',frozen:1,populated:1,members:[anchorIdentity],subgroups:[],snapshotDigest:h('d'),observedAtMs:115,prunedBeforeSnapshot:false},
 directTerminal:{status:'terminal',operationId:'worker',terminalDigest:h('e'),observedAtMs:105},
 teardown:{status:'terminal',protocol:'teardown_only',anchorIdentity,terminalDigest:h('f'),workloadEmptyDigest:h('d'),observedAtMs:125,prunedBeforeTerminal:false},launchGate:'closed'});
 return {requirements,receipt};
}
const nonAdmitting = result => {for(const key of ['admission','settlement','import'])assert.equal(result[key],'not_evaluated');};
test('seal freezes durable inventory without changing accounting, state or events; replay survives reopen',t=>{
 const f=fixture(t),before={state:f.store.get('project'),events:f.store.events('project'),op:f.store.processOperation('worker')};
 const seal=f.seal();nonAdmitting(seal);assert.equal(seal.launchGate,'closed');
 for(let i=0;i<3;i++){f.reopen();assert.deepEqual(f.seal(),seal);assert.deepEqual(f.store.get('project'),before.state);assert.deepEqual(f.store.events('project'),before.events);assert.deepEqual(f.store.processOperation('worker'),before.op);}
});
test('matching metadata and exact replay cannot close/import, reset counters or open a replacement producer',t=>{
 const f=fixture(t),seal=f.seal(),{requirements,receipt}=supplied(f,seal);
 const projection={binding:requirements.binding,sealDigest:seal.sealDigest,receiptDigest:settlementContractDigest(receipt)};
 const before={state:f.store.get('project'),events:f.store.events('project')};
 for(let i=0;i<3;i++){f.reopen();const result=f.store.compareSealedProcessInventory(f.scope,requirements,receipt,projection);assert.equal(result.status,'contract_matches');assert.equal(result.replay,'same_receipt');nonAdmitting(result);blocked(f.complete);blocked(()=>f.store.beginProducer('project','ticket:ticket',f.lease));assert.deepEqual(f.store.get('project'),before.state);assert.deepEqual(f.store.events('project'),before.events);}
});
test('sealed reservation/register/claim APIs refuse, and database guards cover direct insert/update/delete',t=>{
 const f=fixture(t);f.seal();
 blocked(()=>f.store.reserveProducerCall(f.scope,'new-job'));blocked(()=>f.store.registerProcess(f.scope,'job','sibling',f.directory,f.requestDigest));blocked(()=>f.store.claimProcess(f.grant,'supervisor','target',f.requestDigest));
 for(const [sql,args] of [
 ['INSERT INTO producer_calls VALUES (?,?)',['new-job',f.scope]],['UPDATE producer_calls SET job_id=? WHERE scope_id=?',['other',f.scope]],['DELETE FROM producer_calls WHERE scope_id=?',[f.scope]],
 ['INSERT INTO process_operations VALUES (?,?,?,?,?,?,?,NULL)',['sibling',f.scope,null,'token',f.directory,f.requestDigest,'registered']],['DELETE FROM process_operations WHERE scope_id=?',[f.scope]],
 ['UPDATE producer_scopes SET closed_at=123 WHERE id=?',[f.scope]],['DELETE FROM producer_scopes WHERE id=?',[f.scope]],
 ['UPDATE process_inventory_seals SET seal_digest=? WHERE scope_id=?',[h('a'),f.scope]],['DELETE FROM process_inventory_seals WHERE scope_id=?',[f.scope]]
 ])assert.throws(()=>f.store.db.prepare(sql).run(...args),/sealed|immutable/);
 assert.equal(f.store.get('project').agentCalls,1);
});
test('seal creation requires healthy current context and unchanged lease',t=>{
 const f=fixture(t);blocked(()=>f.store.sealProcessInventory(f.scope));
 blocked(()=>withProducer({store:f.store,scopeId:f.scope,project:'project',lifecycle:{persistenceFailed:true}},()=>f.store.sealProcessInventory(f.scope)));
 blocked(()=>withProducer({store:f.store,scopeId:'foreign',project:'project'},()=>f.store.sealProcessInventory(f.scope)));
 f.lease();f.store.lease('controller:project');blocked(f.seal);
});
test('unresolved/empty/uncovered reservation inventories cannot be sealed',t=>{
 const f=fixture(t,false);blocked(f.seal);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM process_inventory_seals').get().n,0);
 const empty=f.store.beginProducer('project','independent',f.lease);blocked(()=>withProducer({store:f.store,scopeId:empty,project:'project'},()=>f.store.sealProcessInventory(empty)));
});
test('orphan reservation prevents sealing even when another operation is terminal',t=>{
 const f=fixture(t);f.store.reserveProducerCall(f.scope,'orphan');blocked(f.seal);
 assert.equal(f.store.get('project').agentCalls,1);
});
test('seal persistence failure rolls back and reopening permits only the same reference capture',t=>{
 const f=fixture(t),before={state:f.store.get('project'),events:f.store.events('project')};
 f.store.db.exec("CREATE TRIGGER fail_seal BEFORE INSERT ON process_inventory_seals BEGIN SELECT RAISE(ABORT,'injected seal failure'); END");
 assert.throws(f.seal,/injected seal failure/);f.reopen();assert.equal(f.store.db.prepare('SELECT count(*) n FROM process_inventory_seals').get().n,0);
 assert.deepEqual(f.store.get('project'),before.state);assert.deepEqual(f.store.events('project'),before.events);
 f.store.db.exec('DROP TRIGGER fail_seal');assert.equal(f.seal().launchGate,'closed');
});
test('comparison detects missing seal, changed store inventory, foreign job and caller seal',t=>{
 const f=fixture(t);let pair=supplied(f,{sealDigest:h('a'),operations:[]});
 assert.deepEqual(f.store.compareSealedProcessInventory(f.scope,pair.requirements,pair.receipt).blockers,['durable_inventory_seal_missing']);
 const seal=f.seal();pair=supplied(f,seal);pair.requirements.binding.job='foreign';assert.notEqual(f.store.compareSealedProcessInventory(f.scope,pair.requirements,pair.receipt).status,'contract_matches');
 pair=supplied(f,seal);pair.requirements.scope.sealDigest=h('a');assert.deepEqual(f.store.compareSealedProcessInventory(f.scope,pair.requirements,pair.receipt).blockers,['expected_inventory_seal_changed']);
 pair=supplied(f,seal);f.store.db.exec('DROP TRIGGER sealed_operation_delete');f.store.db.prepare('DELETE FROM process_operations WHERE id=?').run('worker');
 assert.equal(f.store.compareSealedProcessInventory(f.scope,pair.requirements,pair.receipt).status,'unknown');blocked(f.seal);
});
test('altered seal is unknown and cannot be replayed as valid',t=>{
 const f=fixture(t),seal=f.seal(),pair=supplied(f,seal);
 f.store.db.exec('DROP TRIGGER immutable_inventory_seal_update');f.store.db.prepare('UPDATE process_inventory_seals SET seal_digest=? WHERE scope_id=?').run(h('a'),f.scope);
 assert.deepEqual(f.store.compareSealedProcessInventory(f.scope,pair.requirements,pair.receipt).blockers,['durable_inventory_changed']);blocked(f.seal);
});
test('partial host metadata stays unknown behind seal and conflicting projection remains non-admitting',t=>{
 const f=fixture(t),seal=f.seal(),pair=supplied(f,seal);
 delete pair.receipt.authority.pidViewDigest;const partial=f.store.compareSealedProcessInventory(f.scope,pair.requirements,pair.receipt);assert.equal(partial.status,'unknown');nonAdmitting(partial);
 const other=supplied(f,seal),projection={binding:other.requirements.binding,sealDigest:seal.sealDigest,receiptDigest:h('a')};
 const conflict=f.store.compareSealedProcessInventory(f.scope,other.requirements,other.receipt,projection);assert.equal(conflict.replay,'conflicting_receipt');nonAdmitting(conflict);blocked(f.complete);
});
test('a sealed lane does not block an independent unsealed lane or change legacy closure',t=>{
 const f=fixture(t);f.seal();const second=f.store.beginProducer('project','independent',f.lease);
 const grant=f.store.registerProcess(second,null,'independent-op',f.directory,f.requestDigest);f.store.finishProcess(grant,'registered',{kind:'not_started',exitCode:null,endedAt:123,receiptDigest:h('a')});
 f.store.update('project',()=>{},'independent.done',{},second);assert.notEqual(f.store.db.prepare('SELECT closed_at FROM producer_scopes WHERE id=?').get(second).closed_at,null);blocked(f.complete);
});

test('inventory insertion at the persistence boundary rolls back seal and inserted sibling',t=>{
 const f=fixture(t);
 f.store.db.exec(`CREATE TRIGGER inject_sibling BEFORE INSERT ON process_inventory_seals BEGIN
 INSERT INTO process_operations VALUES ('sibling',NEW.scope_id,NULL,'token','/offline','${h('a')}','registered','{"kind":"not_started","exitCode":null,"endedAt":123,"receiptDigest":"${h('b')}"}'); END`);
 assert.throws(f.seal,/inventory or scope changed during seal persistence/);f.reopen();
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM process_inventory_seals').get().n,0);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM process_operations WHERE id='sibling'").get().n,0);
 assert.equal(f.store.get('project').agentCalls,1);
});
test('canonical malformed terminal shape is not stripped into a valid seal',t=>{
 const f=fixture(t,false);
 f.store.db.prepare('UPDATE process_operations SET terminal=? WHERE id=?').run(JSON.stringify({kind:'not_started',exitCode:null,endedAt:123,receiptDigest:h('a'),futureEvidence:true}),'worker');blocked(f.seal);
});
test('inventory count limit rejects before capturing an oversized seal',t=>{
 const f=fixture(t);for(let i=0;i<100;i++){const grant=f.store.registerProcess(f.scope,null,`helper-${i}`,f.directory,f.requestDigest);f.store.finishProcess(grant,'registered',{kind:'not_started',exitCode:null,endedAt:123,receiptDigest:h('a')});}blocked(f.seal);
});

test('REPLACE cannot bypass immutable seals or move sealed identities to an unsealed scope',t=>{
 const f=fixture(t),seal=f.seal(),other=f.store.beginProducer('project','independent',f.lease);
 for(const [sql,args] of [
 ['INSERT OR REPLACE INTO process_inventory_seals VALUES (?,?,?,?)',[f.scope,'{}',h('a'),123]],
 ['INSERT OR REPLACE INTO producer_calls VALUES (?,?)',['job',other]],
 ['INSERT OR REPLACE INTO process_operations VALUES (?,?,?,?,?,?,?,NULL)',['worker',other,null,'new-token',f.directory,h('a'),'registered']],
 ['INSERT OR REPLACE INTO producer_scopes(id,project,lane,lease_resource,lease_owner,created_at) VALUES (?,?,?,?,?,?)',[f.scope,'project','independent','controller:project',f.lease.owner,123]]
 ])assert.throws(()=>f.store.db.prepare(sql).run(...args),/sealed|immutable/);
 f.reopen();assert.deepEqual(f.seal(),seal);assert.equal(f.store.processOperation('worker').scope_id,f.scope);assert.equal(f.store.db.prepare('SELECT scope_id FROM producer_calls WHERE job_id=?').get('job').scope_id,f.scope);
});

for(const [name,effect] of [
 ['project',"UPDATE producer_scopes SET project='foreign' WHERE id=NEW.scope_id;"],
 ['lane',"UPDATE producer_scopes SET lane='foreign' WHERE id=NEW.scope_id;"],
 ['closed scope',"UPDATE producer_scopes SET closed_at=123 WHERE id=NEW.scope_id;"],
 ['lease owner',"UPDATE leases SET owner='foreign' WHERE resource='controller:project';"]
])test(`scope/lease ${name} mutation at seal persistence rolls back`,t=>{
 const f=fixture(t),before=f.store.db.prepare('SELECT * FROM producer_scopes WHERE id=?').get(f.scope);
 f.store.db.exec(`CREATE TRIGGER inject_scope BEFORE INSERT ON process_inventory_seals BEGIN ${effect} END`);
 blocked(f.seal);f.reopen();assert.equal(f.store.db.prepare('SELECT count(*) n FROM process_inventory_seals').get().n,0);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM producer_scopes WHERE id=?').get(f.scope),before);
 assert.equal(f.store.db.prepare('SELECT owner FROM leases WHERE resource=?').get('controller:project').owner,f.lease.owner);
 assert.equal(f.store.get('project').agentCalls,1);
});

test('UPDATE OR REPLACE cannot rekey unsealed operations/calls onto sealed identities',t=>{
 const f=fixture(t),seal=f.seal(),other=f.store.beginProducer('project','independent',f.lease);
 f.store.reserveProducerCall(other,'other-job');f.store.registerProcess(other,null,'unsealed-op',f.directory,f.requestDigest);
 assert.throws(()=>f.store.db.prepare("UPDATE OR REPLACE process_operations SET id='worker' WHERE id='unsealed-op'").run(),/sealed/);
 assert.throws(()=>f.store.db.prepare("UPDATE OR REPLACE producer_calls SET job_id='job' WHERE job_id='other-job'").run(),/sealed/);
 f.reopen();assert.deepEqual(f.seal(),seal);assert.equal(f.store.processOperation('worker').scope_id,f.scope);assert.equal(f.store.processOperation('unsealed-op').scope_id,other);
 assert.equal(f.store.db.prepare('SELECT scope_id FROM producer_calls WHERE job_id=?').get('job').scope_id,f.scope);assert.equal(f.store.db.prepare('SELECT scope_id FROM producer_calls WHERE job_id=?').get('other-job').scope_id,other);
});
