// Explicit source/config preparation only. No child or provider execution.
import {pathToFileURL} from 'node:url';
import {readReceiptBytes} from '../bin/squire-report.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {parseSingleJsRequest} from '../src/single-js-task.mjs';
import {prepareSingleJsCodexTask} from '../src/single-js-configuration.mjs';
export {prepareSingleJsCodexTask};
export async function runSingleJsPreparationCli(args){
  if(args.length!==5||args[0]!=='--prepare-codex')throw Error('EXACT_PREPARATION_ARGS_REQUIRED');
  const request=parseSingleJsRequest(await readReceiptBytes(args[3],65536)),inputs=parseReceiptJson(await readReceiptBytes(args[4],65536));
  return prepareSingleJsCodexTask(args[1],args[2],request,inputs);
}
function writePreparationOutput(stream,text){
  return new Promise((resolve,reject)=>{
    stream.write(text,error=>{if(error)reject(error);else resolve();});
  });
}

export async function runSingleJsPreparationExecutable(args,{prepare=runSingleJsPreparationCli,stdout,stderr}){
  let output;
  try{
    output=JSON.stringify(await prepare(args))+'\n';
  }catch{
    try{await writePreparationOutput(stderr,'SINGLE_JS_PREPARATION_FAILED\n');}catch{}
    return 2;
  }
  try{await writePreparationOutput(stdout,output);return 0;}
  catch{return 2;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let outputFailed=false;
  const outputError=()=>{outputFailed=true;process.exitCode=2;};
  process.stdout.on('error',outputError);
  process.stderr.on('error',outputError);
  const code=await runSingleJsPreparationExecutable(process.argv.slice(2),{stdout:process.stdout,stderr:process.stderr});
  process.exitCode=outputFailed?2:code;
}
