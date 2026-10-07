import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Controller } from '../src/controller.mjs';
import { Store } from '../src/store.mjs';
import { runProcess } from '../src/process.mjs';
import { fixture, ticket, FixtureRuntime } from './support.mjs';

const headSha = 'a'.repeat(40);
const heldScopes = store => store.db.prepare('SELECT * FROM producer_scopes WHERE closed_at IS NULL').all();
const operations = store => store.db.prepare('SELECT * FROM process_operations ORDER BY id').all();
const reopen = f => {
  const store = new Store(f.stateDir);
  f.addCleanup(() => store.close());
  return store;
};
function oneShotBarrier(store, predicate, message) {
  let calls = 0;
  store.db.function('fail_once', () => ++calls === 1 ? 1 : 0);
  store.db.exec(`CREATE TRIGGER injected_failure BEFORE ${predicate} AND fail_once()=1 BEGIN SELECT RAISE(ABORT,'${message}'); END`);
  return () => calls;
}
async function fakeProcess(f, label = 'target') {
  const marker = path.join(f.root, `${label}.calls`);
  const executable = path.join(f.root, `${label}.mjs`);
  await writeFile(executable, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'launch\\n');`);
  return { marker, run: () => runProcess({ argv: [process.execPath, executable], cwd: f.root, directory: path.join(f.root, `${label}-evidence`), timeoutSeconds: 10 }) };
}

for (const lane of ['project:plan', 'project:doctor', 'project:configure-runtime', 'project:acceptance']) {
  test(`unresolved ${lane} fences all project producers and ticket dispatch after reopen`, async t => {
    const f = await fixture(t, [ticket('a'), ticket('b')]);
    const lease = f.store.lease(`controller:${f.config.id}`);
    const scope = f.store.beginProducer(f.config.id, lane, lease);
    lease();
    const before = f.store.get(f.config.id);
    let dispatches = 0;
    for (let i = 0; i < 3; i++) {
      const store = reopen(f), controller = new Controller(store, f.config.id, { runtime: new FixtureRuntime() });
      controller.produceStep = async () => { dispatches++; };
      for (const next of ['project:plan', 'project:doctor', 'project:configure-runtime', 'project:acceptance', 'project:preflight']) {
        await assert.rejects(controller.producer(next, async () => { dispatches++; }), { code: 'producer_unresolved' });
      }
      await assert.rejects(controller.step('b'), { code: 'producer_unresolved' });
      assert.deepEqual(store.get(f.config.id), before);
      assert.equal(heldScopes(store)[0].id, scope);
    }
    assert.equal(dispatches, 0);
  });
}

test('an unresolved ticket lane fences project work while another ticket can durably finish', async t => {
  const f = await fixture(t, [ticket('a'), ticket('b')]);
  const lease = f.store.lease(`controller:${f.config.id}`);
  const scopeA = f.store.beginProducer(f.config.id, 'ticket:a', lease);
  lease();
  let dispatches = 0;
  const controller = new Controller(f.store, f.config.id, { runtime: new FixtureRuntime() });
  controller.produceStep = async id => {
    dispatches++;
    controller.transition(id, 'prepared');
  };
  await controller.step('b');
  assert.equal(dispatches, 1);
  assert.equal(controller.current('b').status, 'prepared');
  assert.equal(heldScopes(f.store)[0].id, scopeA);
  assert.equal(heldScopes(f.store).length, 1);
  await assert.rejects(controller.step('a'), { code: 'producer_unresolved' });
  await assert.rejects(controller.producer('project:plan', async () => { dispatches++; }), { code: 'producer_unresolved' });
  assert.equal(dispatches, 1);
  assert.equal(f.store.get(f.config.id).agentCalls, 0);
});

test('one-shot transition persistence failure after terminal evidence escapes produceStep and never releases its scope', async t => {
  const f = await fixture(t), fake = await fakeProcess(f);
  const runtime = new FixtureRuntime();
  const providers = {
    runtime,
    delivery: () => ({ preflight: async () => {} }),
    workspace: { prepare: async () => {
      const result = await fake.run(); assert.equal(result.exitCode, 0);
      return { baseSha: headSha };
    } },
    verifier: { setup: async () => {} }
  };
  const controller = new Controller(f.store, f.config.id, providers);
  const failures = oneShotBarrier(f.store,
    "INSERT ON events WHEN json_extract(NEW.data,'$.type')='ticket.transition' AND json_extract(NEW.data,'$.status')='prepared'",
    'injected transition outcome failure');
  await assert.rejects(controller.step('a'), error => error.storeTransactionFailed === true && /injected transition outcome failure/.test(error.message));
  assert.equal(failures(), 1);
  assert.equal(controller.current('a').status, 'preparing');
  assert.equal(heldScopes(f.store).length, 1);
  const evidence = operations(f.store);
  assert.equal(evidence.length, 1);
  assert.equal(JSON.parse(evidence[0].terminal).exitCode, 0);
  const before = f.store.get(f.config.id);
  for (let i = 0; i < 3; i++) {
    const store = reopen(f);
    const next = new Controller(store, f.config.id, providers);
    await assert.rejects(next.step('a'), { code: 'producer_unresolved' });
    assert.deepEqual(store.get(f.config.id), before);
    assert.deepEqual(operations(store), evidence);
    assert.equal(heldScopes(store).length, 1);
  }
  assert.equal(await readFile(fake.marker, 'utf8'), 'launch\n');
  assert.equal(runtime.calls.length, 0);
  assert.equal(before.agentCalls, 0);
  assert.equal(f.store.events(f.config.id).filter(e => e.type === 'producer.completed').length, 0);
});

test('acceptance completion and scope close commit atomically; a failed close stays fenced across reopen', async t => {
  const f = await fixture(t), fake = await fakeProcess(f, 'acceptance');
  const providers = {
    runtime: new FixtureRuntime(),
    workspace: {
      remoteHead: async () => headSha,
      mergeWorkspace: async () => {},
      identity: async () => ({ headSha, dirty: false })
    },
    verifier: {
      setup: async () => {},
      run: async () => {
        const receipt = await fake.run();
        return { passed: receipt.exitCode === 0, results: [{ name: 'fake', exitCode: receipt.exitCode }] };
      }
    }
  };
  f.store.update(f.config.id, s => { s.status = 'running'; s.tickets[0].status = 'shipped'; });
  const failures = oneShotBarrier(f.store, "UPDATE OF outcome ON producer_scopes WHEN NEW.lane='project:acceptance'", 'injected acceptance close failure');
  const controller = new Controller(f.store, f.config.id, providers);
  await assert.rejects(controller.acceptance(), error => error.storeTransactionFailed === true && /injected acceptance close failure/.test(error.message));
  assert.equal(failures(), 1);
  const before = f.store.get(f.config.id), evidence = operations(f.store);
  assert.equal(before.status, 'running');
  assert.equal(before.completedAt, undefined);
  assert.equal(before.acceptance.app.status, 'passed');
  assert.equal(evidence.length, 1);
  assert.equal(heldScopes(f.store).length, 1);
  assert.equal(f.store.events(f.config.id).filter(e => e.type === 'project.completed').length, 0);
  for (let i = 0; i < 3; i++) {
    const store = reopen(f), next = new Controller(store, f.config.id, providers);
    assert.throws(() => next.acceptance(), { code: 'producer_unresolved' });
    assert.deepEqual(store.get(f.config.id), before);
    assert.deepEqual(operations(store), evidence);
  }
  assert.equal(await readFile(fake.marker, 'utf8'), 'launch\n');
});

for (const command of ['doctor', 'configure-runtime']) {
  test(`CLI ${command} registers a fake auth process and fences repeated failed preflight without new launches`, async t => {
    const f = await fixture(t, [ticket('a')], async ({ root }) => {
      const fake = path.join(root, 'fake-auth.mjs'), marker = path.join(root, 'auth.calls');
      await writeFile(fake, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'auth\\n'); console.error('offline fixture rejects authentication'); process.exitCode=9;`);
      return { runtime: { kind: 'codex', authentication: 'subscription', command: [process.execPath, fake] } };
    });
    if (command === 'configure-runtime') f.store.pause(f.config.id);
    const configFile = path.join(f.root, 'project.json'), overrides = path.join(f.root, 'routing.json');
    await writeFile(configFile, JSON.stringify(f.config));
    await writeFile(overrides, JSON.stringify({ model: 'offline-fixture-model' }));
    const args = [fileURLToPath(new URL('../bin/squire.mjs', import.meta.url)), command, configFile, ...(command === 'configure-runtime' ? [overrides] : [])];
    const invoke = () => spawnSync(process.execPath, args, { cwd: f.root, encoding: 'utf8', timeout: 15000, windowsHide: true });
    const first = invoke();
    assert.equal(first.error, undefined);
    assert.notEqual(first.status, 0, first.stdout);
    assert.match(first.stdout + first.stderr, /authentication|ChatGPT subscription/i);
    const evidence = operations(f.store), scopes = heldScopes(f.store);
    assert.equal(evidence.length, 1);
    assert.equal(JSON.parse(evidence[0].terminal).exitCode, 9);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].lane, `project:${command}`);
    for (let i = 0; i < 2; i++) {
      const result = invoke();
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /unresolved|replacement work refused/i);
      assert.deepEqual(operations(f.store), evidence);
      assert.equal(f.store.get(f.config.id).agentCalls, 0);
    }
    assert.equal(await readFile(path.join(f.root, 'auth.calls'), 'utf8'), 'auth\n');
  });
}


test('startup fences a shipped-but-unclosed predecessor before scheduling, while an independent repository lane advances', async t => {
 const f = await fixture(t, [ticket('a'),ticket('b',['a']),ticket('c',[],'other')], ({source,check}) => ({ services: {
  app: {source,branch:'main',delivery:{kind:'local'},checks:[{name:'check',argv:[process.execPath,check],timeoutSeconds:5}]},
  other: {source,branch:'independent',delivery:{kind:'local'},checks:[{name:'check',argv:[process.execPath,check],timeoutSeconds:5}]}
 }}));
 f.store.update('fixture',s=>{s.tickets[0].status='shipped';s.tickets[0].shippedAt=123;s.agentCalls=4;});
 const lease=f.store.lease('controller:fixture');const scopeId=f.store.beginProducer('fixture','ticket:a',lease);lease();
 const calls=[];
 for(let attempt=0;attempt<2;attempt++) {
  const store=reopen(f),controller=new Controller(store,'fixture',{runtime:new FixtureRuntime()});
  controller.produceStep=async id=>{calls.push(id);controller.transition(id,'shipped');};
  const state=await controller.run(undefined,{wait:false});
  assert.equal(state.status,'blocked');assert.equal(state.agentCalls,4);
  assert.equal(state.tickets[0].status,'blocked');assert.equal(state.tickets[0].shippedAt,123);
  assert.equal(state.tickets[0].producerHold.status,'shipped');assert.equal(state.tickets[0].producerHold.scopeId,scopeId);
  assert.equal(state.tickets[1].status,'dependency_blocked');assert.equal(state.tickets[2].status,'shipped');
 }
 assert.deepEqual(calls,['c']);
});


for(const boundary of ['registered','terminal']) test(`same-store repository hold fences another project after ${boundary} boundary and turnover`,async t=>{
 const f=await fixture(t),fake=await fakeProcess(f,'cross-project');
 const first=new Controller(f.store,'fixture',{runtime:new FixtureRuntime()});
 if(boundary==='registered') {
  const lease=f.store.lease('controller:fixture');
  const scopeId=f.store.beginProducer('fixture','ticket:a',lease,first.producerResources('ticket:a'));
  f.store.registerProcess(scopeId,null,'pending-operation',path.join(f.root,'pending'),'a'.repeat(64));lease();
 } else await assert.rejects(first.producer('ticket:a',async()=>{await fake.run();throw new Error('fixture projection barrier');}),/projection barrier/);
 const evidence=operations(f.store);
 const secondConfig={...structuredClone(f.config),id:'second-project'};f.store.initialize(secondConfig);
 const before=f.store.get('fixture');
 for(let i=0;i<2;i++) {
  const store=reopen(f),runtime=new FixtureRuntime(),second=new Controller(store,secondConfig.id,{runtime});
  const result=await second.run(undefined,{wait:false});
  assert.equal(result.status,'blocked');assert.equal(result.tickets[0].blocker.code,'producer_unresolved');
  assert.equal(result.agentCalls,0);assert.equal(runtime.calls.length,0);
  assert.deepEqual(operations(store),evidence);assert.deepEqual(store.get('fixture'),before);
 }
 const independentConfig={...structuredClone(f.config),id:'independent-project'};
 independentConfig.services.app.branch='independent';f.store.initialize(independentConfig);
 const independent=new Controller(f.store,independentConfig.id,{runtime:new FixtureRuntime()});
 let advanced=false;await independent.producer('ticket:a',async()=>{advanced=true;});assert.equal(advanced,true);
 assert.equal(heldScopes(f.store).filter(scope=>scope.project==='fixture').length,1);
});
