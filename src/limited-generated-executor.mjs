import {NODE_RUNTIME,programEnvironment} from './bounded-codegen-plan.mjs';
import {fixtureArgv} from '../fixtures/q218/public-fixtures.mjs';
import {isAbsolute,normalize,dirname} from 'node:path';
import {closed} from './job-spec.mjs';

const retained = new Set();
// Only explicit injected spawn/clock. Importing this module cannot launch a native child.
export function executeGeneratedSummarizer(config,ports){return executeNode(config,ports,false);}
export function executeGeneratedSyntax(config,ports){return executeNode(config,ports,true);}
export function executeSingleJsSyntax(target_path,ports){
  const parent=dirname(target_path);
  return executeNode({summarizer_path:target_path,input_path:parent+'/unused-input',output_path:parent+'/unused-output',manifest_path:parent+'/unused-manifest',window_start:'0',window_end:'0',timeout_ms:5000},ports,true,true);
}
function executeNode(config, ports, syntax, singleJs=false) {
  closed(config,['summarizer_path','input_path','output_path','manifest_path','window_start','window_end','timeout_ms'],['fixture_id','deadline_ms'],'generated_config');
  if(!ports || typeof ports.spawn !== 'function' || typeof ports.clock?.now !== 'function' || typeof ports.clock?.schedule !== 'function') throw Error('INJECTED_EXECUTION_PORTS_REQUIRED');
  config=Object.freeze({...config});
  const paths = ['summarizer_path','input_path','output_path','manifest_path'].map(k=>config[k]);
  if(paths.some(p=>typeof p !== 'string' || !isAbsolute(p) || normalize(p)!==p) || new Set(paths).size!==4 ||
    !config.summarizer_path.endsWith(singleJs?'/workspace/src/task.mjs':'/workspace/src/summarizer.mjs') || (!Number.isSafeInteger(config.timeout_ms)||config.timeout_ms<=0||config.timeout_ms>5000) ||
    ['window_start','window_end'].some(k=>typeof config[k]!=='string' || !/^(0|[1-9][0-9]{0,15})$/.test(config[k]) || !Number.isSafeInteger(Number(config[k]))) ||
    Number(config.window_start)>Number(config.window_end)) throw Error('INVALID_GENERATED_CONFIG');
  if(config.fixture_id !== undefined && (!Number.isSafeInteger(config.fixture_id)||config.fixture_id<1||config.fixture_id>17))throw Error('INVALID_FIXTURE_ID');
  if(config.deadline_ms!==undefined&&(!Number.isSafeInteger(config.deadline_ms)||config.deadline_ms<0))throw Error('INVALID_AGGREGATE_DEADLINE');
  const argv=Object.freeze(syntax?['--check',config.summarizer_path]:[config.summarizer_path,...fixtureArgv(config.fixture_id,config,config.window_start,config.window_end)]);
  const cwd=dirname(dirname(config.summarizer_path));
  let child,begin=null,last=-1,deadline=null,done=false,spawned=false,exited=false,exit_code=null,exit_signal=null,wall=null;
  let status=null,out=0,err=0,outEOF=false,errEOF=false,ioFailed=false;
  const timers=new Map(),attempts=[],late=[];
  let resolve; const result=new Promise(r=>{resolve=r;});
  const now=()=>{const n=ports.clock.now();if(!Number.isSafeInteger(n)||n<0||n<last)throw Error('CLOCK_INVALID');last=n;return n;};
  function cancel(k){const fn=timers.get(k);timers.delete(k);try{fn?.();}catch{status??='INTERNAL_ERROR';}}
  function arm(k,ms,cb){cancel(k);let returned=false,inline=false;
    const fn=ports.clock.schedule(ms,()=>{if(!returned){inline=true;return;}timers.delete(k);if(!done)cb();});returned=true;
    if(typeof fn!=='function')throw Error('SCHEDULER_INVALID');
    if(inline){fn();throw Error('SCHEDULER_INLINE');}
    if(done||exited&&['term','kill','allocation'].includes(k)){fn();return;}timers.set(k,fn);
  }
  function onAbort(){if(done)return;status??='CANCELED';stop();if(exited)finish();}
  function finish(){if(done)return;done=true;ports.abortSignal?.removeEventListener('abort',onAbort);for(const k of [...timers.keys()])cancel(k);
    if(child){child.removeListener('exit',onExit);child.removeListener('spawn',onSpawn);child.removeListener('error',onError);child.on('error',()=>{});
      if(!exited){retained.add(child);child.once('exit',(code,signal)=>{retained.delete(child);late.push(Object.freeze({exit_code:code,exit_signal:signal}));});child.unref?.();}
      for(const stream of [child.stdout,child.stderr]){stream.removeAllListeners('data');stream.removeAllListeners('end');stream.removeAllListeners('close');stream.removeAllListeners('error');stream.on('error',()=>{});try{stream.destroy();}catch{}}
    }
    resolve(Object.freeze({status:status??'OBSERVED_EXIT',observed_exit_code:exit_code,observed_exit_signal:exit_signal,observed_wall_ms:wall,
      observed_termination:exited,io_state:Object.freeze({stdout_bytes_observed:out,stderr_bytes_observed:err,stdout_eof:outEOF,stderr_eof:errEOF,io_drained:outEOF&&errEOF&&!ioFailed}),
      settlement_status:exited?'SETTLED_DIRECT_CHILD_EXIT':spawned?'ABANDONED_UNSETTLED':'UNKNOWN',
      signal_attempts:Object.freeze(attempts.map(x=>Object.freeze({...x}))),deadline_ms:deadline,runtime_admitted:false,descendant_guarantee:'NONE',
      workspace_reuse:'NOT_AUTHORIZED',late_observations:()=>Object.freeze([...late])}));
  }
  function signal(kind){if(!spawned||exited||done)return;const a={signal:kind,accepted:false};attempts.push(a);try{a.accepted=child.kill(kind)===true;}catch{status??='INTERNAL_ERROR';}}
  let stopping=false;
  function stop(){if(stopping||done||exited)return;stopping=true;cancel('budget');
    if(!spawned){try{arm('allocation',2000,finish);}catch{finish();}return;}
    signal('SIGTERM');if(exited||done)return;
    try{arm('term',1000,()=>{signal('SIGKILL');if(exited||done)return;try{arm('kill',1000,finish);}catch{finish();}});}catch{finish();}
  }
  function budget(){try{const n=now();if(n<deadline){arm('budget',deadline-n,budget);return;}status??='TIMEOUT';}catch{status??='INTERNAL_ERROR';}stop();}
  function drained(){if(exited&&outEOF&&errEOF)finish();}
  function onSpawn(){spawned=true;cancel('allocation');if(status){stopping=false;stop();}}
  function onExit(code,signal){if(done||exited)return;exited=true;exit_code=code;exit_signal=signal;
    for(const k of ['term','kill','budget','allocation'])cancel(k);
    try{wall=now()-begin;if(now()>=deadline)status??='TIMEOUT';}catch{status??='INTERNAL_ERROR';}
    if(outEOF&&errEOF){finish();return;}try{arm('drain',500,()=>{ioFailed=true;status??='IO_INCOMPLETE';finish();});}catch{ioFailed=true;status??='INTERNAL_ERROR';finish();}
  }
  function onError(){status??=spawned?'INTERNAL_ERROR':'SPAWN_FAILED';if(!spawned)finish();else stop();}
  function streamError(){if(done)return;ioFailed=true;status??='IO_INCOMPLETE';stop();if(exited)finish();}
  function feed(name,bytes){if(done)return;if(!(bytes instanceof Uint8Array)){streamError();return;}
    if(name==='stdout')out=Math.min(65537,out+bytes.length);else err=Math.min(65537,err+bytes.length);
    if(out>65536||err>65536){ioFailed=true;status??='CAPACITY_EXCEEDED';stop();}try{if(now()>=deadline){status??='TIMEOUT';stop();}}catch{status??='INTERNAL_ERROR';stop();}}
  try{begin=now();deadline=Math.min(begin+config.timeout_ms,config.deadline_ms??Number.MAX_SAFE_INTEGER);if(!Number.isSafeInteger(deadline))throw Error('CLOCK_OVERFLOW');ports.abortSignal?.addEventListener('abort',onAbort,{once:true});
    if(ports.abortSignal?.aborted){status='CANCELED';finish();return result;}
    arm('budget',Math.max(0,deadline-begin),budget);
    if(now()>=deadline){status??='TIMEOUT';finish();return result;}
    if(done||status||ports.abortSignal?.aborted){status??='CANCELED';finish();return result;}
    child=ports.spawn(NODE_RUNTIME.path,argv,{shell:false,detached:false,stdio:['ignore','pipe','pipe'],env:programEnvironment(config.summarizer_path),cwd});
    child.on('spawn',onSpawn);child.on('exit',onExit);child.on('error',onError);
    for(const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]]){
      stream.on('data',b=>feed(name,b));stream.on('end',()=>{if(done)return;if(name==='stdout')outEOF=true;else errEOF=true;drained();});
      stream.on('close',()=>{if(!(name==='stdout'?outEOF:errEOF))streamError();});stream.on('error',streamError);
    }
  }catch{status??='INTERNAL_ERROR';if(child)stop();else finish();}
  return result;
}
