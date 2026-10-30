// Explicit source/config preparation only. No child or provider execution.
import {pathToFileURL} from 'node:url';
import {readReceiptBytes} from '../bin/squire-report.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {parseProjectRequest} from '../src/project-task.mjs';
import {prepareProjectCodexTask,prepareDesktopCodegenTask,prepareDesktopCodingObservationTask} from '../src/project-configuration.mjs';
export {prepareProjectCodexTask,prepareDesktopCodegenTask,prepareDesktopCodingObservationTask};
export async function runProjectPreparationCli(args){
  if(args.length!==5||!['--prepare-codex','--prepare-desktop-codegen','--prepare-desktop-coding-observation'].includes(args[0]))throw Error('EXACT_PREPARATION_ARGS_REQUIRED');
  const request=parseProjectRequest(await readReceiptBytes(args[3],65536)),inputs=parseReceiptJson(await readReceiptBytes(args[4],65536));
  const prepare=args[0]==='--prepare-desktop-coding-observation'?prepareDesktopCodingObservationTask:
    args[0]==='--prepare-desktop-codegen'?prepareDesktopCodegenTask:prepareProjectCodexTask;
  return prepare(args[1],args[2],request,inputs);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await runProjectPreparationCli(process.argv.slice(2))));}
  catch{console.error('PROJECT_PREPARATION_FAILED');process.exitCode=2;}
}
