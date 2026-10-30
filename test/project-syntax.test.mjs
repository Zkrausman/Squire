import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {executeProjectSyntax} from '../src/project-syntax.mjs';
import {
  executeGeneratedSummarizer,executeGeneratedSyntax,executeSingleJsSyntax,
  executePreparedProjectSyntax
} from '../src/limited-generated-executor.mjs';
import {NODE_RUNTIME} from '../src/bounded-codegen-plan.mjs';

const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const spec={project_dir:'/scope/project-root',source_path:'/scope/project-root/src/main.mjs',timeout_ms:5000};
const generated={
  summarizer_path:'/scope/output/run-x/workspace/src/summarizer.mjs',
  input_path:'/scope/input.ndjson',output_path:'/scope/summary.json',
  manifest_path:'/scope/manifest.json',window_start:'0',window_end:'2000000000000',
  timeout_ms:5000
};

// Fake-only counterpart of the existing bounded-codegen test runtime.
// No real process, filesystem, provider, source parser or program is invoked.
function runtime({autoSpawn=true,killAccepted=true}={}){
  let time=0;
  const timers=[],calls=[],kills=[],child=new EventEmitter();
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.unref=()=>{};child.kill=signal=>{kills.push(signal);return killAccepted;};
  for(const stream of [child.stdout,child.stderr])stream.destroy=()=>{};
  const clock={
    now:()=>time,
    schedule(delay,cb){
      const timer={at:time+delay,cb,active:true};timers.push(timer);
      return()=>{timer.active=false;};
    }
  };
  const ports={clock,spawn(exe,argv,opts){
    calls.push({exe,argv,opts});
    if(autoSpawn)queueMicrotask(()=>child.emit('spawn'));
    return child;
  }};
  return {
    child,calls,kills,clock,ports,
    async advance(next){
      time=next;
      for(const timer of [...timers].sort((a,b)=>a.at-b.at)){
        if(timer.active&&timer.at<=time){timer.active=false;timer.cb();}
      }
      await flush();
    },
    eof(){child.stdout.emit('end');child.stderr.emit('end');},
    end(code=0,signal=null){
      this.eof();child.emit('exit',code,signal);
    }
  };
}

test('selected syntax captures exact argv, cwd and minimal environment before clock callbacks',async()=>{
  const input={...spec},f=runtime();
  const clock={...f.clock,now(){
    input.project_dir='/changed';input.source_path='/changed/other.mjs';
    input.timeout_ms=1;return f.clock.now();
  }};
  const p=executeProjectSyntax(input,{...f.ports,clock});
  await flush();f.end();const r=await p;
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].exe,NODE_RUNTIME.path);
  assert.deepEqual(f.calls[0].argv,['--check',spec.source_path]);
  assert.ok(Object.isFrozen(f.calls[0].argv));
  assert.deepEqual(f.calls[0].opts,{
    shell:false,detached:false,stdio:['ignore','pipe','pipe'],
    cwd:spec.project_dir,
    env:{PATH:'/bin:/usr/bin',LANG:'C.UTF-8',TMPDIR:'/scope/.tmp'}
  });
  assert.ok(Object.isFrozen(f.calls[0].opts.env));
  assert.equal(r.status,'OBSERVED_EXIT');
  assert.equal(r.observed_exit_code,0);
  assert.equal(r.observed_termination,true);
  assert.equal(r.io_state.io_drained,true);
  assert.equal(r.runtime_admitted,false);
  assert.equal(r.descendant_guarantee,'NONE');
  assert.equal(r.workspace_reuse,'NOT_AUTHORIZED');
  assert.equal(Object.hasOwn(r,'task_correctness'),false);
  assert.equal(Object.hasOwn(r,'source_sha256'),false);
  assert.ok(Object.isFrozen(r));
});

test('selected paths preserve relative ASCII limits, reserved components and casing',async()=>{
  const relativePaths=[
    'Main.mjs','src/Library/Value.mjs','src/.hidden.mjs',
    'src/project/main.mjs','src/frames/main.mjs','src/evidence/main.mjs',
    'a'.repeat(60)+'.mjs',
    Array.from({length:6},()=> 'a').join('/')+'/main.mjs',
    ['a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'d'.repeat(57)+'.mjs'].join('/')
  ];
  assert.equal(relativePaths.at(-1).length,256);
  for(const relative of relativePaths){
    const f=runtime(),source_path=spec.project_dir+'/'+relative;
    const p=executeProjectSyntax({...spec,source_path},f.ports);
    await flush();f.end();await p;
    assert.equal(f.calls[0].argv[1],source_path);
  }
  const invalid=[
    '', '../other.mjs','src/../main.mjs','src/./main.mjs','src//main.mjs',
    'src\\main.mjs','src/main.mjs/','src/main.js','src/MAIN.MJS',
    'src/é.mjs','src/a b.mjs','src/a\n.mjs','src/a\0.mjs','--check',
    'CON.mjs','src/prn/main.mjs','src/AUX.txt/main.mjs','src/nul.mjs',
    'src/COM1.mjs','src/lpt9.data/main.mjs',
    'Stage-Manifest.json/main.mjs','src/EXPORT-MANIFEST.JSON/main.mjs',
    'src/package-manifest.json/main.mjs',
    'PROJECT/main.mjs','Evidence/main.mjs','Frames/main.mjs',
    'a'.repeat(61)+'.mjs',
    Array.from({length:7},()=> 'a').join('/')+'/main.mjs',
    ['a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'d'.repeat(58)+'.mjs'].join('/')
  ];
  for(const relative of invalid){
    const f=runtime();
    assert.throws(()=>executeProjectSyntax({...spec,source_path:spec.project_dir+'/'+relative},f.ports));
    assert.deepEqual(f.calls,[]);
  }
});

test('closed data contract rejects unsafe objects without invoking caller code or spawning',()=>{
  let invoked=0;
  const accessor={...spec};
  Object.defineProperty(accessor,'source_path',{enumerable:true,get(){invoked++;return spec.source_path;}});
  const proxy=new Proxy({...spec},{get(){invoked++;throw Error('must not run');}});
  const custom=Object.assign(Object.create({}),spec);
  const serialization={...spec,toJSON(){invoked++;return spec;}};
  const symbol={...spec,[Symbol('extra')]:true};
  const cases=[
    null,[],proxy,accessor,custom,serialization,symbol,
    {...spec,extra:true},{...spec,argv:['--eval','anything']},
    {...spec,project_dir:'/'},{...spec,project_dir:'relative'},
    {...spec,project_dir:'/scope/../scope/project-root'},
    {...spec,project_dir:spec.project_dir+'/'},
    {...spec,source_path:spec.project_dir},
    {...spec,source_path:spec.project_dir+'-other/main.mjs'},
    {...spec,source_path:'src/main.mjs'},
    {...spec,timeout_ms:0},{...spec,timeout_ms:5001},
    {...spec,timeout_ms:1.5},{...spec,timeout_ms:'5000'},
    {...spec,deadline_ms:-1},{...spec,deadline_ms:1.5},
    {...spec,deadline_ms:Number.MAX_SAFE_INTEGER+1}
  ];
  for(const input of cases){
    const f=runtime();
    assert.throws(()=>executeProjectSyntax(input,f.ports));
    assert.deepEqual(f.calls,[]);
  }
  assert.equal(invoked,0);
  const f=runtime();
  assert.throws(()=>executePreparedProjectSyntax({...spec,argv:[]},f.ports));
  assert.deepEqual(f.calls,[]);
  for(const ports of [undefined,{}, {spawn(){},clock:{now(){return 0;}}}]){
    assert.throws(()=>executeProjectSyntax(spec,ports),/INJECTED_EXECUTION_PORTS_REQUIRED/);
  }
});

test('nonenumerable expired deadline prevents spawn and invalid deadlines reject',async()=>{
  const input=Object.defineProperty({...spec},'deadline_ms',{value:0,enumerable:false});
  const f=runtime(),r=await executeProjectSyntax(input,f.ports);
  assert.equal(r.status,'TIMEOUT');
  assert.equal(r.deadline_ms,0);
  assert.equal(r.observed_termination,false);
  assert.deepEqual(f.calls,[]);
  for(const value of [-1,1.5,Number.MAX_SAFE_INTEGER+1]){
    const g=runtime();
    const invalid=Object.defineProperty({...spec},'deadline_ms',{value,enumerable:false});
    assert.throws(()=>executeProjectSyntax(invalid,g.ports),/INVALID_AGGREGATE_DEADLINE/);
    assert.deepEqual(g.calls,[]);
  }
  let invoked=0;
  const accessor=Object.defineProperty({...spec},'deadline_ms',{
    enumerable:false,get(){invoked++;return 0;}
  });
  const g=runtime();
  assert.throws(()=>executeProjectSyntax(accessor,g.ports));
  assert.equal(invoked,0);
  assert.deepEqual(g.calls,[]);
});

test('nonenumerable required fields and optional deadline are captured before callbacks',async()=>{
  for(const [timeout_ms,deadline_ms,effective] of [[25,40,25],[40,25,25]]){
    const input=Object.create(null);
    for(const [key,value] of Object.entries({...spec,timeout_ms,deadline_ms}))
      Object.defineProperty(input,key,{value,enumerable:false,configurable:true});
    assert.deepEqual(Object.keys(input),[]);
    const f=runtime();
    const clock={...f.clock,now(){
      Object.defineProperties(input,{
        project_dir:{value:'/changed'},
        source_path:{value:'/changed/other.mjs'},
        timeout_ms:{value:1},
        deadline_ms:{value:0}
      });
      return f.clock.now();
    }};
    const p=executeProjectSyntax(input,{...f.ports,clock});
    await flush();
    assert.equal(f.calls.length,1);
    assert.deepEqual(f.calls[0].argv,['--check',spec.source_path]);
    assert.equal(f.calls[0].opts.cwd,spec.project_dir);
    await f.advance(effective-1);
    assert.deepEqual(f.kills,[]);
    await f.advance(effective);
    assert.deepEqual(f.kills,['SIGTERM']);
    f.end(null,'SIGTERM');
    const r=await p;
    assert.equal(r.status,'TIMEOUT');
    assert.equal(r.deadline_ms,effective);
    assert.equal(r.observed_termination,true);
  }
});

test('null-prototype closed data is accepted and nonzero syntax exit stays evidence',async()=>{
  const input=Object.assign(Object.create(null),spec),f=runtime();
  const p=executeProjectSyntax(input,f.ports);
  await flush();f.end(1);const r=await p;
  assert.equal(r.status,'OBSERVED_EXIT');
  assert.equal(r.observed_exit_code,1);
  assert.equal(r.settlement_status,'SETTLED_DIRECT_CHILD_EXIT');
  assert.equal(r.runtime_admitted,false);
});

test('already aborted or expired aggregate deadline prevents every spawn',async()=>{
  const controller=new AbortController();controller.abort();
  const f=runtime();
  const canceled=await executeProjectSyntax(spec,{...f.ports,abortSignal:controller.signal});
  assert.equal(canceled.status,'CANCELED');
  assert.equal(canceled.observed_termination,false);
  assert.equal(canceled.settlement_status,'UNKNOWN');
  assert.deepEqual(f.calls,[]);
  const g=runtime();
  const expired=await executeProjectSyntax({...spec,deadline_ms:0},g.ports);
  assert.equal(expired.status,'TIMEOUT');
  assert.equal(expired.deadline_ms,0);
  assert.deepEqual(g.calls,[]);
});

test('exit and EOF are separate observations with the existing 500ms drain bound',async()=>{
  const f=runtime(),p=executeProjectSyntax(spec,f.ports);
  await flush();f.child.emit('exit',0,null);
  let resolved=false;p.then(()=>{resolved=true;});
  await f.advance(499);assert.equal(resolved,false);
  f.eof();const drained=await p;
  assert.equal(drained.status,'OBSERVED_EXIT');
  assert.equal(drained.io_state.io_drained,true);
  const g=runtime(),q=executeProjectSyntax(spec,g.ports);
  await flush();g.child.emit('exit',0,null);
  await g.advance(500);const incomplete=await q;
  assert.equal(incomplete.status,'IO_INCOMPLETE');
  assert.equal(incomplete.observed_exit_code,0);
  assert.equal(incomplete.observed_termination,true);
  assert.equal(incomplete.io_state.io_drained,false);
  g.eof();
  assert.equal(incomplete.io_state.io_drained,false);
});

test('aggregate deadline controls TERM, KILL and bounded late-exit observation',async()=>{
  const f=runtime({killAccepted:false});
  const p=executeProjectSyntax({...spec,deadline_ms:25},f.ports);
  await flush();await f.advance(25);
  assert.deepEqual(f.kills,['SIGTERM']);
  await f.advance(1025);assert.deepEqual(f.kills,['SIGTERM','SIGKILL']);
  await f.advance(2025);const r=await p;
  assert.equal(r.deadline_ms,25);
  assert.equal(r.status,'TIMEOUT');
  assert.equal(r.observed_termination,false);
  assert.equal(r.settlement_status,'ABANDONED_UNSETTLED');
  assert.deepEqual(r.signal_attempts,[
    {signal:'SIGTERM',accepted:false},{signal:'SIGKILL',accepted:false}
  ]);
  assert.deepEqual(r.late_observations(),[]);
  f.child.emit('exit',null,'SIGKILL');
  assert.deepEqual(r.late_observations(),[{exit_code:null,exit_signal:'SIGKILL'}]);
  assert.equal(r.observed_exit_signal,null);
  assert.equal(r.observed_termination,false);
  assert.equal(f.calls.length,1);
});

test('abort records attempts separately from a subsequently observed direct-child exit',async()=>{
  const controller=new AbortController(),f=runtime();
  const p=executeProjectSyntax(spec,{...f.ports,abortSignal:controller.signal});
  await flush();controller.abort();
  assert.deepEqual(f.kills,['SIGTERM']);
  f.end(null,'SIGTERM');const r=await p;
  assert.equal(r.status,'CANCELED');
  assert.equal(r.observed_termination,true);
  assert.equal(r.observed_exit_signal,'SIGTERM');
  assert.equal(r.settlement_status,'SETTLED_DIRECT_CHILD_EXIT');
  assert.equal(r.descendant_guarantee,'NONE');
  assert.equal(f.calls.length,1);
});

test('pre-spawn allocation remains bounded and a late spawn uses existing stop logic',async()=>{
  const f=runtime({autoSpawn:false}),p=executeProjectSyntax({...spec,timeout_ms:10},f.ports);
  await f.advance(10);assert.deepEqual(f.kills,[]);
  await f.advance(2010);const unknown=await p;
  assert.equal(unknown.status,'TIMEOUT');
  assert.equal(unknown.settlement_status,'UNKNOWN');
  assert.equal(unknown.observed_termination,false);
  f.child.emit('exit',0,null);
  assert.equal(unknown.late_observations().length,1);
  const g=runtime({autoSpawn:false}),q=executeProjectSyntax({...spec,timeout_ms:10},g.ports);
  await g.advance(10);g.child.emit('spawn');
  assert.deepEqual(g.kills,['SIGTERM']);
  g.end(null,'SIGTERM');
  assert.equal((await q).status,'TIMEOUT');
});

test('stdout and stderr retain independent exact 65536-byte caps',async()=>{
  const f=runtime(),p=executeProjectSyntax(spec,f.ports);
  await flush();
  f.child.stdout.emit('data',new Uint8Array(65536));
  f.child.stderr.emit('data',new Uint8Array(65536));
  f.end();const atCap=await p;
  assert.equal(atCap.status,'OBSERVED_EXIT');
  assert.equal(atCap.io_state.stdout_bytes_observed,65536);
  assert.equal(atCap.io_state.stderr_bytes_observed,65536);
  for(const stream of ['stdout','stderr']){
    const g=runtime(),q=executeProjectSyntax(spec,g.ports);
    await flush();g.child[stream].emit('data',new Uint8Array(65537));
    assert.deepEqual(g.kills,['SIGTERM']);
    g.end();const exceeded=await q;
    assert.equal(exceeded.status,'CAPACITY_EXCEEDED');
    assert.equal(exceeded.io_state[stream+'_bytes_observed'],65537);
    assert.equal(exceeded.io_state.io_drained,false);
  }
});

test('stream close, error and non-byte chunks withhold drained evidence',async()=>{
  for(const event of ['close','error','data']){
    const f=runtime(),p=executeProjectSyntax(spec,f.ports);
    await flush();f.child.stdout.emit(event,event==='data'?'text':undefined);
    f.end();const r=await p;
    assert.equal(r.status,'IO_INCOMPLETE');
    assert.equal(r.io_state.io_drained,false);
  }
});

test('invalid clocks and cooperative scheduler violations cannot establish success',async()=>{
  for(const clock of [
    {now:()=>NaN,schedule(){throw Error('unused');}},
    {now:()=>Number.MAX_SAFE_INTEGER,schedule(){throw Error('unused');}},
    {now:()=>0,schedule(){return undefined;}},
    {now:()=>0,schedule(ms,cb){cb();return()=>{};}}
  ]){
    const f=runtime(),r=await executeProjectSyntax(spec,{...f.ports,clock});
    assert.equal(r.status,'INTERNAL_ERROR');
    assert.deepEqual(f.calls,[]);
    assert.equal(r.observed_termination,false);
  }
  const f=runtime();let first=true;
  const clock={...f.clock,now(){if(first){first=false;return 1;}return 0;}};
  const r=await executeProjectSyntax(spec,{...f.ports,clock});
  assert.equal(r.status,'INTERNAL_ERROR');assert.deepEqual(f.calls,[]);
  const g=runtime();let broken=false;
  const p=executeProjectSyntax(spec,{...g.ports,clock:{...g.clock,now:()=>broken?NaN:0}});
  await flush();broken=true;g.child.stdout.emit('data',new Uint8Array(1));
  assert.deepEqual(g.kills,['SIGTERM']);
  g.end();assert.equal((await p).status,'INTERNAL_ERROR');
});

test('spawn failures and post-spawn scheduler failure retain honest settlement',async()=>{
  const f=runtime();
  const thrown=await executeProjectSyntax(spec,{...f.ports,spawn(){throw Error('fake');}});
  assert.equal(thrown.status,'INTERNAL_ERROR');
  assert.equal(thrown.settlement_status,'UNKNOWN');
  const g=runtime({autoSpawn:false}),q=executeProjectSyntax(spec,g.ports);
  g.child.emit('error',Error('fake'));
  assert.equal((await q).status,'SPAWN_FAILED');
  const controller=new AbortController(),h=runtime();let scheduled=0;
  const clock={...h.clock,schedule(ms,cb){
    if(++scheduled>1)return undefined;
    return h.clock.schedule(ms,cb);
  }};
  const p=executeProjectSyntax(spec,{...h.ports,clock,abortSignal:controller.signal});
  await flush();controller.abort();const r=await p;
  assert.equal(r.status,'CANCELED');
  assert.equal(r.settlement_status,'ABANDONED_UNSETTLED');
  assert.equal(r.observed_termination,false);
  assert.deepEqual(h.kills,['SIGTERM']);
  h.child.emit('exit',null,'SIGTERM');
  assert.equal(r.late_observations().length,1);
});

test('historical syntax and summarizer profiles preserve their argv, cwd and environment',async()=>{
  const task='/scope/output/run-x/workspace/src/task.mjs';
  const cases=[
    [f=>executeGeneratedSyntax(generated,f.ports),['--check',generated.summarizer_path]],
    [f=>executeSingleJsSyntax(task,f.ports),['--check',task]],
    [f=>executeGeneratedSummarizer(generated,f.ports),[
      generated.summarizer_path,'--input',generated.input_path,
      '--output',generated.output_path,'--manifest',generated.manifest_path,
      '--window-start','0','--window-end','2000000000000'
    ]]
  ];
  for(const [run,argv] of cases){
    const f=runtime(),p=run(f);await flush();f.end();const r=await p;
    assert.equal(f.calls[0].exe,NODE_RUNTIME.path);
    assert.deepEqual(f.calls[0].argv,argv);
    assert.deepEqual(f.calls[0].opts,{
      shell:false,detached:false,stdio:['ignore','pipe','pipe'],
      cwd:'/scope/output/run-x/workspace',
      env:{PATH:'/bin:/usr/bin',LANG:'C.UTF-8',TMPDIR:'/scope/output/run-x/.tmp'}
    });
    assert.equal(r.deadline_ms,5000);
    assert.equal(r.status,'OBSERVED_EXIT');
  }
  const f=runtime();
  assert.throws(()=>executeGeneratedSyntax({...generated,summarizer_path:spec.source_path},f.ports));
  assert.throws(()=>executeGeneratedSummarizer({...generated,summarizer_path:spec.source_path},f.ports));
  assert.throws(()=>executeSingleJsSyntax(spec.source_path,f.ports));
  assert.deepEqual(f.calls,[]);
});

test('historical wrappers keep capacity and timeout behavior through the shared engine',async()=>{
  const f=runtime(),p=executeGeneratedSyntax(generated,f.ports);
  await flush();f.child.stderr.emit('data',new Uint8Array(65537));f.end();
  assert.equal((await p).status,'CAPACITY_EXCEEDED');
  const g=runtime(),q=executeSingleJsSyntax('/scope/output/run-x/workspace/src/task.mjs',g.ports);
  await flush();await g.advance(5000);await g.advance(6000);await g.advance(7000);
  const r=await q;
  assert.equal(r.status,'TIMEOUT');
  assert.deepEqual(g.kills,['SIGTERM','SIGKILL']);
  assert.equal(r.observed_termination,false);
  g.child.emit('exit',null,'SIGKILL');
  assert.equal(r.late_observations().length,1);
});
