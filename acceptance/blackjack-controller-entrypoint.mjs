// No native launch mode exists in this source-only delivery.
import {fileURLToPath} from 'node:url';
export const blackjackControllerDryRun=()=>Object.freeze({schema:'SQUIRE_BLACKJACK_CONTROLLER_DRY_RUN_V1',status:'DRY_RUN_NATIVE_DISABLED',runtime_admitted:false,operator_admitted:false,direct_child_invocations:0,task_correctness:'NOT_EVALUATED'});
export const blackjackControllerEntrypointMode=()=> 'DRY_RUN_NATIVE_DISABLED';
if(process.argv[1]===fileURLToPath(import.meta.url))process.stdout.write(JSON.stringify(blackjackControllerDryRun())+'\n');
