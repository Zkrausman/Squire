// Explicit source/config preparation only. No child or provider execution.
import {pathToFileURL} from 'node:url';
import {readReceiptBytes} from '../bin/squire-report.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {parseProjectRequest} from '../src/project-task.mjs';
import {prepareProjectCodexTask,prepareDesktopCodegenTask,prepareDesktopCodingObservationTask,prepareDesktopCodingLargeObservationTask} from '../src/project-configuration.mjs';
export {prepareProjectCodexTask,prepareDesktopCodegenTask,prepareDesktopCodingObservationTask,prepareDesktopCodingLargeObservationTask};
export async function runProjectPreparationCli(args){
  if(args.length!==5||!['--prepare-codex','--prepare-desktop-codegen','--prepare-desktop-coding-observation','--prepare-desktop-coding-large-observation'].includes(args[0]))throw Error('EXACT_PREPARATION_ARGS_REQUIRED');
  const request=parseProjectRequest(await readReceiptBytes(args[3],65536)),inputs=parseReceiptJson(await readReceiptBytes(args[4],65536));
  const prepare=args[0]==='--prepare-desktop-coding-large-observation'?prepareDesktopCodingLargeObservationTask:
    args[0]==='--prepare-desktop-coding-observation'?prepareDesktopCodingObservationTask:
    args[0]==='--prepare-desktop-codegen'?prepareDesktopCodegenTask:prepareProjectCodexTask;
  return prepare(args[1],args[2],request,inputs);
}
function writePreparationOutput(stream,text){
  return new Promise((resolve,reject)=>{
    stream.write(text,error=>{if(error)reject(error);else resolve();});
  });
}

export async function runProjectPreparationExecutable(args,{prepare=runProjectPreparationCli,stdout,stderr}){
  let output;
  try{
    output=JSON.stringify(await prepare(args))+'\n';
  }catch{
    try{await writePreparationOutput(stderr,'PROJECT_PREPARATION_FAILED\n');}catch{}
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
  const code=await runProjectPreparationExecutable(process.argv.slice(2),{stdout:process.stdout,stderr:process.stderr});
  process.exitCode=outputFailed?2:code;
}
