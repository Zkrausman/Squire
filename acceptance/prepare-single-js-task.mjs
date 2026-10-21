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
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await runSingleJsPreparationCli(process.argv.slice(2))));}
  catch{console.error('SINGLE_JS_PREPARATION_FAILED');process.exitCode=2;}
}
