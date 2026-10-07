import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, FixtureRuntime, statusUntil } from './support.mjs';
import { Blocker, digest } from '../src/contracts.mjs';
import { Store } from '../src/store.mjs';
import { CodexRuntime } from '../src/runtime-codex.mjs';
import { readCatalog } from '../src/codex-catalog.mjs';
import { GitWorkspace } from '../src/workspace.mjs';
import { VerificationRunner } from '../src/verification.mjs';
import { GitHubClient } from '../src/delivery.mjs';
import { Controller } from '../src/controller.mjs';
import { runProcess, settleChildBeforeIdentity } from '../src/process.mjs';
import { withProducer } from '../src/producer-context.mjs';

async function setup(t) {
 const f = await fixture(t), release = f.store.lease('controller:fixture');
 f.addCleanup(release);
 const scopeId = f.store.beginProducer('fixture', 'ticket:a', release);
 const marker = path.join(f.root, 'launches');
 const command = { argv: [process.execPath, '-e', 'require("node:fs").appendFileSync(process.argv[1],"launch\\n");console.log("fixture");process.exit(7)', marker], cwd: f.root, directory: path.join(f.root,'evidence'), timeoutSeconds: 5 };
 return { ...f, release, scopeId, marker, command, context: { store:f.store, project:'fixture', scopeId } };
}
async function repeatBlocked(f) {
 f.release();
 const before = f.store.get('fixture').agentCalls;
 for (let i=0;i<2;i++) {
  const store = new Store(f.stateDir);
  try {
   const runtime = new FixtureRuntime();
   const state = await new Controller(store,'fixture',{runtime}).run(undefined,{wait:false});
   assert.equal(state.status,'blocked');
   assert.equal(state.agentCalls,before); assert.equal(runtime.calls.length,0);
   assert.throws(()=>store.resume('fixture',true), {code:'producer_unresolved'});
   assert.equal(store.db.prepare('SELECT closed_at FROM producer_scopes WHERE id=?').get(f.scopeId).closed_at,null);
  } finally { store.close(); }
 }
}
test('settlement cleanup completes before delayed identity evidence is awaited', async () => {
 const order=[];let releaseIdentity,cleanupObserved;
 const identityPending=new Promise(resolve=>{releaseIdentity=resolve;});
 const cleanupReached=new Promise(resolve=>{cleanupObserved=resolve;});
 let deadlineArmed=true,identityCompleted=false;
 const settled=settleChildBeforeIdentity({
  settled:Promise.resolve(7),
  targetIdentity:identityPending.then(evidence=>{identityCompleted=true;order.push('identity');return evidence;}),
  cleanup:()=>{deadlineArmed=false;order.push('cleanup');cleanupObserved();}
 });
 await cleanupReached;
 assert.deepEqual(order,['cleanup']);assert.equal(deadlineArmed,false);assert.equal(identityCompleted,false);
 releaseIdentity({status:'unknown',reason:'fixture'});
 const result=await settled;
 assert.deepEqual(order,['cleanup','identity']);assert.equal(result.exitCode,7);
 assert.deepEqual(result.targetEvidence,{status:'unknown',reason:'fixture'});
});
test('production process entry requires an explicit scope before creating evidence', async t => {
 const f = await fixture(t), directory=path.join(f.root,'absent');
 await assert.rejects(runProcess({argv:[process.execPath,'-e',''],cwd:f.root,directory}),{code:'producer_context_required'});
 await assert.rejects(access(directory));
});
test('nonzero canonical terminal remains fenced until caller outcome, and excludes request secrets',async t=>{
 const f=await setup(t);
 const result=await withProducer(f.context,()=>runProcess({...f.command,input:'private prompt sentinel',env:{FIXTURE_SECRET:'credential sentinel'}}));
 assert.equal(result.exitCode,7); assert.equal(result.stdout.trim(),'fixture');
 const row=f.store.processOperation(result.operationId), terminal=JSON.parse(row.terminal);
 assert.equal(terminal.kind,'terminal');assert.equal(terminal.exitCode,7);
 assert.doesNotMatch(JSON.stringify(row),/private prompt sentinel|credential sentinel/);
 assert.equal(await readFile(f.marker,'utf8'),'launch\n');
 await repeatBlocked(f);
 assert.equal(await readFile(f.marker,'utf8'),'launch\n');
 assert.equal(f.store.processOperation(result.operationId).terminal,row.terminal);
});
test('immutable receipt records launch-bound identity while leaving descendant coverage unknown', async t => {
 const f=await setup(t); let operationId;
 const command={...f.command,argv:[process.execPath,'-e','setTimeout(()=>{console.log("identity fixture");process.exit(7)},150)']};
 const result=await withProducer({...f.context,onRegistered:value=>{operationId=value.id;}},()=>runProcess(command));
 const receipt=JSON.parse(await readFile(path.join(command.directory,`${operationId}.receipt.json`),'utf8'));
 const operation=f.store.processOperation(operationId), evidence=receipt.identityEvidence;
 assert.equal(JSON.parse(operation.terminal).receiptDigest,digest(receipt));
 assert.equal(evidence.version,1);assert.equal(evidence.operationId,operationId);
 assert.equal(evidence.requestDigest,operation.request_digest);
 assert.equal(evidence.supervisor.role,'supervisor');assert.equal(evidence.target.role,'target');
 assert.equal(evidence.target.operationId,operationId);assert.equal(evidence.target.requestDigest,operation.request_digest);
 assert.equal(evidence.descendantCoverage.status,'unknown');
 assert.equal(evidence.descendantCoverage.reason,'no_complete_descendant_inventory');
 if(process.platform==='linux') {
  assert.equal(evidence.supervisor.status,'verified');assert.equal(evidence.supervisor.continuity.status,'verified');
  assert.equal(evidence.target.status,'verified');
  assert.equal(evidence.target.identity.parentPid,evidence.supervisor.identity.pid);
  assert.equal(evidence.target.identity.processGroupId,evidence.target.identity.pid);
  assert.equal(evidence.target.identity.sessionId,evidence.target.identity.pid);
  assert.equal(evidence.directTerminal.status,'verified');
 } else {
  assert.equal(evidence.supervisor.status,'unknown');assert.equal(evidence.target.status,'unknown');
  assert.equal(evidence.directTerminal.status,'unknown');
 }
 assert.equal(result.identityEvidence.directTerminal.status,evidence.directTerminal.status);
 assert.equal(f.store.db.prepare('SELECT closed_at FROM producer_scopes WHERE id=?').get(f.scopeId).closed_at,null);
});
test('registration barrier interruption retains request and debit without any first or second launch',async t=>{
 const f=await setup(t);let operationId,request;
 const runtime=new FixtureRuntime(async()=>runProcess(f.command));
 const controller=new Controller(f.store,'fixture',{runtime});
 await assert.rejects(withProducer({...f.context,onRegistered: value=>{operationId=value.id;request=value.request;throw new Error('fixture registration barrier');}},
  ()=>controller.callAgent('implement',f.root,f.root,'private request')),/registration barrier/);
 assert.equal(f.store.get('fixture').agentCalls,1);
 assert.equal(f.store.processOperation(operationId).phase,'registered');
 assert.equal(f.store.processOperation(operationId).terminal,null);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM producer_calls WHERE scope_id=?').get(f.scopeId).n,1);
 const evidence=await readFile(request,'utf8');
 await assert.rejects(withProducer(f.context,()=>controller.callAgent('implement',f.root,f.root,'second forbidden request')),{code:'producer_unresolved'});
 assert.equal(runtime.calls.length,1);assert.equal(f.store.get('fixture').agentCalls,1);
 await assert.rejects(access(f.marker));await repeatBlocked(f);
 assert.equal(await readFile(request,'utf8'),evidence);await assert.rejects(access(f.marker));
});
test('terminal persistence failure keeps active/request/receipt evidence and cannot relaunch',async t=>{
 const f=await setup(t);let operationId,request;
 f.store.db.exec("CREATE TRIGGER fixture_terminal_failure BEFORE UPDATE OF terminal ON process_operations BEGIN SELECT RAISE(ABORT,'fixture terminal failure'); END");
 await assert.rejects(withProducer({...f.context,onRegistered:value=>{operationId=value.id;request=value.request;}},()=>runProcess(f.command)),{code:'producer_unresolved'});
 await assert.rejects(withProducer(f.context,()=>runProcess(f.command)),{code:'producer_unresolved'});
 assert.equal(await readFile(f.marker,'utf8'),'launch\n');
 const row=f.store.processOperation(operationId);assert.equal(row.terminal,null);assert.equal(row.phase,'target');
 const files=[request,path.join(f.command.directory,`${operationId}.active.json`),path.join(f.command.directory,`${operationId}.receipt.json`)];
 const before=await Promise.all(files.map(file=>readFile(file,'utf8')));
 await repeatBlocked(f);assert.equal(await readFile(f.marker,'utf8'),'launch\n');
 assert.deepEqual(await Promise.all(files.map(file=>readFile(file,'utf8'))),before);
});
for (const failure of ['receipt mismatch', 'missing output']) test(`${failure} after terminal commit fences caught errors, new calls and scope closure`, async t => {
 const f=await setup(t); let request, operationId;
 const original=f.store.processOperation.bind(f.store);
 if(failure==='receipt mismatch') f.store.processOperation=id=>{
  const row=original(id), terminal=JSON.parse(row.terminal);
  return {...row,terminal:JSON.stringify({...terminal,receiptDigest:'0'.repeat(64)})};
 };
 await withProducer({...f.context,onRegistered:value=>{request=value.request;operationId=value.id;},
  onTerminal:failure==='missing output'?async ({result})=>unlink(result.stdoutPath):undefined},async()=>{
  await assert.rejects(runProcess(f.command),failure==='missing output'?{code:'ENOENT'}:{code:'producer_unresolved'});
  f.store.processOperation=original;
  assert.equal(JSON.parse(original(operationId).terminal).exitCode,7);
  await assert.rejects(runProcess(f.command),{code:'producer_unresolved'});
  const runtime=new FixtureRuntime(),controller=new Controller(f.store,'fixture',{runtime});
  await assert.rejects(controller.callAgent('implement',f.root,f.root,'forbidden follow-up'),{code:'producer_unresolved'});
  assert.equal(runtime.calls.length,0);assert.equal(f.store.get('fixture').agentCalls,0);
  assert.throws(()=>f.store.update('fixture',()=>{},'producer.completed',{},f.scopeId),{code:'producer_unresolved'});
 });
 const evidence=await readFile(request,'utf8');
 assert.equal(await readFile(f.marker,'utf8'),'launch\n');
 await repeatBlocked(f);
 assert.equal(await readFile(request,'utf8'),evidence);
 assert.equal(await readFile(f.marker,'utf8'),'launch\n');
});
test('missing executable and invalid outer cwd retain canonical not-started results without clearing scopes',async t=>{
 for (const kind of ['executable','cwd']) await t.test(kind,async t=>{
  const f=await setup(t);let operationId;
  const command={...f.command,...(kind==='executable'?{argv:[path.join(f.root,'missing')]}:{cwd:path.join(f.root,'missing')})};
  const running=withProducer({...f.context,onRegistered:value=>{operationId=value.id;}},()=>runProcess(command));
  if(kind==='cwd')await assert.rejects(running,{code:'ENOENT'});
  else {const result=await running;assert.ok(result.launchError);assert.notEqual(result.exitCode,0);}
  const terminal=JSON.parse(f.store.processOperation(operationId).terminal);assert.equal(terminal.kind,'not_started');
  await repeatBlocked(f);await assert.rejects(access(f.marker));
 });
});
test('duplicate supervisor request cannot overwrite evidence or launch target again',async t=>{
 const f=await setup(t);let payload;
 const result=await withProducer({...f.context,onRegistered:async value=>{payload=await readFile(value.request,'utf8');}},()=>runProcess(f.command));
 const before=await readFile(path.join(f.command.directory,`${result.operationId}.receipt.json`),'utf8');
 const request=path.join(f.root,'duplicate.request.json');await writeFile(request,payload);
 const supervisor=fileURLToPath(new URL('../src/process.mjs',import.meta.url));
 const child=spawn(process.execPath,[supervisor,'--supervise',request],{stdio:['pipe','ignore','pipe']});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdin.on('error',()=>{});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 assert.equal(code,1);assert.match(stderr,/already consumed/);
 assert.equal(await readFile(f.marker,'utf8'),'launch\n');
 assert.equal(await readFile(path.join(f.command.directory,`${result.operationId}.receipt.json`),'utf8'),before);
});
test('outcome persistence barrier rolls back completion event and holds terminal evidence on reopen',async t=>{
 const f=await setup(t);const result=await withProducer(f.context,()=>runProcess(f.command));
 f.store.db.exec("CREATE TRIGGER fixture_outcome_failure BEFORE UPDATE OF closed_at ON producer_scopes BEGIN SELECT RAISE(ABORT,'fixture outcome failure'); END");
 const before=f.store.events('fixture').length;
 assert.throws(()=>f.store.update('fixture',()=>{},'producer.completed',{},f.scopeId),/fixture outcome failure/);
 assert.equal(f.store.events('fixture').length,before);
 const terminal=f.store.processOperation(result.operationId).terminal;
 await repeatBlocked(f);assert.equal(f.store.processOperation(result.operationId).terminal,terminal);
});
test('legacy project authority refuses launch without upgrading or changing spending',async t=>{
 const f=await fixture(t);f.store.update('fixture',state=>{delete state.processProtocol;state.agentCalls=3;});
 for(let i=0;i<2;i++) {
  const runtime=new FixtureRuntime();const result=await new Controller(f.store,'fixture',{runtime}).run(undefined,{wait:false});
  assert.equal(result.blocker.code,'producer_legacy');assert.equal(result.agentCalls,3);assert.equal(runtime.calls.length,0);assert.equal(result.processProtocol,undefined);
 }
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM process_operations').get().n,0);
});

test('failed job.finished persistence cannot become a closable failure or admit a second call', async t => {
 const f = await fixture(t), marker = path.join(f.root,'failed-job-launches');
 const runtime = new FixtureRuntime(async job => {
  const receipt = await runProcess({ argv:[process.execPath,'-e','require("node:fs").appendFileSync(process.argv[1],"launch\\n");process.exit(7)',marker], cwd:job.workspace, directory:job.directory, timeoutSeconds:5 });
  throw new Blocker('runtime_failed','Synthetic terminal failure',{receipt});
 });
 const controller = new Controller(f.store,'fixture',{runtime});
 await statusUntil(f.store,controller,'prepared');
 let failures=0;
 f.store.db.function('fail_finished_once',()=>++failures===1?1:0);
 f.store.db.exec("CREATE TRIGGER fixture_finished_failure BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.type')='job.finished' AND fail_finished_once()=1 BEGIN SELECT RAISE(ABORT,'fixture job outcome failure'); END");
 await assert.rejects(controller.step('a'),error=>error.storeTransactionFailed===true && /fixture job outcome failure/.test(error.message));
 assert.equal(f.store.get('fixture').agentCalls,1);assert.equal(runtime.calls.length,1);
 assert.equal(f.store.get('fixture').tickets[0].status,'implementing');
 assert.equal(f.store.events('fixture').filter(event=>event.type==='job.finished').length,0);
 const scope=f.store.db.prepare('SELECT id FROM producer_scopes WHERE closed_at IS NULL').get();assert.ok(scope);
 const evidence=f.store.db.prepare('SELECT * FROM process_operations WHERE scope_id=?').all(scope.id);
 assert.ok(evidence.some(row=>JSON.parse(row.terminal)?.exitCode===7));
 for(let i=0;i<2;i++) {
  const store=new Store(f.stateDir);
  try {
   await assert.rejects(new Controller(store,'fixture',{runtime}).step('a'),{code:'producer_unresolved'});
   assert.throws(()=>store.resume('fixture',true),{code:'producer_unresolved'});
   assert.equal(store.get('fixture').agentCalls,1);
   assert.deepEqual(store.db.prepare('SELECT * FROM process_operations WHERE scope_id=?').all(scope.id),evidence);
  } finally {store.close();}
 }
 assert.equal(runtime.calls.length,1);assert.equal(await readFile(marker,'utf8'),'launch\n');
});

test('built-in adapter entries fail closed without a producer capability',async t=>{
 const f=await fixture(t),runtime=new CodexRuntime({command:[process.execPath,'fake-only.mjs']},f.root);
 const work=[()=>new GitWorkspace(f.root).git(f.root,['status']),
  ()=>new VerificationRunner(f.root).run(f.root,[{name:'fake',argv:[process.execPath,'fake-only.mjs']}],'fixture'),
  ()=>new GitHubClient(f.root).api('repos/offline/fixture'),()=>runtime.preflight(),()=>readCatalog([process.execPath,'fake-only.mjs'],f.root)];
 for(const invoke of work)await assert.rejects(invoke(),{code:'producer_context_required'});
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM process_operations').get().n,0);
});
test('fake Codex auth, catalog and agent launches share durable reservation and compatible receipts',async t=>{
 const f=await fixture(t),cli=path.join(f.root,'fake-codex.mjs');
 await writeFile(cli,`import {writeFile} from 'node:fs/promises';
 const args=process.argv.slice(2);
 if(['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','GH_TOKEN','GITHUB_TOKEN'].some(key=>process.env[key]))throw new Error('Unexpected credential');
 if(args.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
 if(args.includes('app-server')){
  const {createInterface}=await import('node:readline');
  for await(const line of createInterface({input:process.stdin})){
   const request=JSON.parse(line);if(request.id===undefined)continue;
   const result=request.method==='account/read'?{account:{type:'chatgpt'}}:request.method==='model/list'?{data:[{model:'offline-fixture',isDefault:true}],nextCursor:null}:{};
   console.log(JSON.stringify({id:request.id,result}));
  }process.exit(0);
 }
 for await(const chunk of process.stdin){}
 await writeFile(args[args.indexOf('-o')+1],'Fixture complete');
 console.log(JSON.stringify({type:'thread.started',thread_id:'offline-session'}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}));`);
 const controller=new Controller(f.store,'fixture');
 controller.runtime=new CodexRuntime({kind:'codex',model:'offline-fixture',command:[process.execPath,cli]},controller.root);
 await mkdir(controller.root,{recursive:true});
 const result=await controller.callAgent('implement',f.seed,path.join(controller.root,'job'),'private prompt sentinel');
 assert.equal(result.outcome,'completed');assert.equal(result.receipt.exitCode,0);assert.ok(result.receipt.argv.includes('exec'));
 const rows=f.store.db.prepare('SELECT * FROM process_operations').all();assert.equal(rows.length,3);
 assert.ok(rows.every(row=>row.job_id===result.jobId && JSON.parse(row.terminal).kind==='terminal'));
 assert.doesNotMatch(JSON.stringify(rows),/private prompt sentinel/);
 assert.equal(f.store.get('fixture').agentCalls,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM producer_calls').get().n,1);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM producer_scopes WHERE closed_at IS NULL').get().n,0);
});
