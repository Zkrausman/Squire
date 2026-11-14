import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
// Fixed trusted executable fixtures only; never run a generated candidate.
export async function artifactCliChild(url,args,{before='',closed=null}={}){
 const hold="await new Promise(resolve=>{process.stdin.on('end',resolve);process.stdin.resume();});";
 const preload='data:text/javascript,'+encodeURIComponent(hold+before);
 const cp=spawn(process.execPath,['--import',preload,fileURLToPath(url),...args],{stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='',stdoutEof=false,stderrEof=false,timedOut=false,overflow=false;
 cp.stdin.on('error',()=>{}); // Terminal child status below remains authoritative.
 cp.stdout.on('end',()=>stdoutEof=true);cp.stderr.on('end',()=>stderrEof=true);
 const collect=key=>b=>{if(key==='stdout')stdout+=b;else stderr+=b;
  if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>65536){overflow=true;cp.kill('SIGKILL');}};
 cp.stdout.on('data',collect('stdout'));cp.stderr.on('data',collect('stderr'));
 const done=new Promise((resolve,reject)=>{cp.once('error',()=>reject(Error('ARTIFACT_FIXTURE_LAUNCH_FAILED')));
  cp.once('close',(code,signal)=>resolve({code,signal,stdout,stderr,stdoutEof,stderrEof,timedOut,overflow}));});
 const timer=setTimeout(()=>{timedOut=true;cp.kill('SIGKILL');},10000);
 try{
  if(closed){await new Promise(resolve=>{cp[closed].once('close',resolve);cp[closed].destroy();});}
  // Release only after the selected parent's read endpoint has actually closed.
  cp.stdin.end();const result=await done;
  assert.equal(result.timedOut,false);assert.equal(result.overflow,false);return result;
 }finally{clearTimeout(timer);}
}
