// Explicit offline file input only. Imports/default invocation never dispatch a task.
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {REPORT_MAX_BYTES,OFFLINE_REPORT_REJECTION_CODES,parseReceiptJson,projectRunSummary,formatSummaryTerminal,invalidRunSummary} from '../src/offline-run-summary.mjs';
import {projectSingleJsRunSummary,formatSingleJsSummaryTerminal} from '../src/single-js-summary.mjs';
import {
  projectProjectRunSummary,formatProjectSummaryTerminal,
  projectNativeProjectRunSummary,formatNativeProjectSummaryTerminal,
  projectNativeProjectLargeObservationRunSummary,
  projectNativeProjectLargeObservationReceiptBytesSummary,
  formatNativeProjectLargeObservationSummaryTerminal
} from '../src/project-summary.mjs';
import {buildCourierHandoffReport} from '../src/courier-handoff-report.mjs';
import {projectNativeProjectCodingObservationRunSummary,formatNativeProjectCodingObservationSummaryTerminal} from '../src/project-summary.mjs';
import {
  PROJECT_CODING_OBSERVATION_RECEIPT_SCHEMA,
  PROJECT_LARGE_OBSERVATION_RECEIPT_SCHEMA
} from '../src/project-coding-profile.mjs';

export async function readReceiptBytes(path,maxBytes=REPORT_MAX_BYTES) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>REPORT_MAX_BYTES)throw 'READ_FAILED';
  let handle;
  try{
    const before=await fs.lstat(path);
    if(!before.isFile()||before.isSymbolicLink())throw 'SPECIAL_FILE_REJECTED';
    if(before.size>maxBytes)throw 'FILE_TOO_LARGE';
    handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const opened=await handle.stat();if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino)throw 'SPECIAL_FILE_REJECTED';
    if(opened.size>maxBytes)throw 'FILE_TOO_LARGE';
    const bytes=new Uint8Array(maxBytes);let offset=0;
    while(offset<maxBytes){const r=await handle.read(bytes,offset,Math.min(4096,maxBytes-offset),offset);if(r.bytesRead===0)break;offset+=r.bytesRead;}
    const after=await handle.stat();
    if(after.size>maxBytes)throw 'FILE_TOO_LARGE';
    if(after.size!==opened.size||offset!==after.size||opened.mtimeMs!==after.mtimeMs||opened.ctimeMs!==after.ctimeMs)throw 'READ_FAILED';
    return bytes.slice(0,offset);
  }finally{await handle?.close();}
}

const CAPABILITIES_SCHEMA='SQUIRE_OFFLINE_REPORT_CAPABILITIES_V1';
const CAPABILITIES_MAX_BYTES=16*1024;
const CAPABILITIES_INTERNAL_ERROR='CAPABILITIES_INTERNAL_ERROR';
const SCHEMA_MISMATCH_CODE=OFFLINE_REPORT_REJECTION_CODES.find(code=>code==='SCHEMA_MISMATCH');
const COURIER_HANDOFF_INVALID_CODE='INVALID_INPUT';
const typedWriter=formatter=> (route,summary,_detail,stdout,stderr)=>{
  stdout.write(formatter(summary));
  if(summary.readiness==='INVALID_RECEIPT'){stderr.write(route.invalid_stderr_code+'\n');return route.invalid_exit_code;}
  return route.valid_exit_codes[0];
};
const campaignWriter=(route,summary,_detail,stdout,stderr)=>{
  stdout.write(formatSummaryTerminal(summary));
  if(summary.overall_outcome==='INVALID_RECEIPT'){
    const reason=OFFLINE_REPORT_REJECTION_CODES.includes(summary.diagnostic.reason)?summary.diagnostic.reason:SCHEMA_MISMATCH_CODE;
    stderr.write(reason+'\n');return route.invalid_exit_code;
  }
  const code=summary.overall_outcome==='PASS'?0:1;
  return route.valid_exit_codes.includes(code)?code:route.invalid_exit_code;
};
const handoffWriter=(route,_summary,report,stdout,stderr)=>{
  if(!report){stderr.write(route.invalid_stderr_code+'\n');return route.invalid_exit_code;}
  stdout.write(report.terminal_text);return route.valid_exit_codes[0];
};
const makeRoute=route=>{
  const inputSchemas=Object.freeze([...route.input_schemas]);
  const rejectionCodes=Object.freeze([...(route.rejection_codes??(route.invalid_stderr_code?[route.invalid_stderr_code]:[]))]);
  return Object.freeze({
    ...route,
    input_schemas:inputSchemas,
    matches:raw=>inputSchemas.length===0||inputSchemas.includes(raw?.schema),
    ...(route.legacy_shape_names?{legacy_shape_names:Object.freeze([...route.legacy_shape_names])}:{}),
    valid_exit_codes:Object.freeze([...route.valid_exit_codes]),
    rejection_codes:rejectionCodes,
    exit_meanings:Object.freeze({...route.exit_meanings})
  });
};

// This closed set is both the live dispatcher and the capability projection source.
const REPORT_ROUTES=Object.freeze([
  makeRoute({
    route_id:'native_project_large_observation',
    input_schemas:[PROJECT_LARGE_OBSERVATION_RECEIPT_SCHEMA],
    result_kind:'summary',
    terminal_output_kind:'native_project_large_observation_text',
    project:(_raw,bytes)=>projectNativeProjectLargeObservationReceiptBytesSummary(bytes),
    write:typedWriter(formatNativeProjectLargeObservationSummaryTerminal),
    valid_exit_codes:[1],invalid_exit_code:2,invalid_stderr_code:SCHEMA_MISMATCH_CODE,
    exit_meanings:{1:'Typed large-observation summary emitted; this is not a task PASS.',2:'Receipt rejected with the route diagnostic.'}
  }),
  makeRoute({
    route_id:'native_project_coding_observation',
    input_schemas:[PROJECT_CODING_OBSERVATION_RECEIPT_SCHEMA],
    result_kind:'summary',
    terminal_output_kind:'native_project_coding_observation_text',
    project:raw=>projectNativeProjectCodingObservationRunSummary(raw),
    write:typedWriter(formatNativeProjectCodingObservationSummaryTerminal),
    valid_exit_codes:[1],invalid_exit_code:2,invalid_stderr_code:SCHEMA_MISMATCH_CODE,
    exit_meanings:{1:'Typed coding-observation summary emitted; this is not a task PASS.',2:'Receipt rejected with the route diagnostic.'}
  }),
  makeRoute({
    route_id:'native_project',
    input_schemas:['SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1'],
    result_kind:'summary',
    terminal_output_kind:'native_project_text',
    project:raw=>projectNativeProjectRunSummary(raw),
    write:typedWriter(formatNativeProjectSummaryTerminal),
    valid_exit_codes:[1],invalid_exit_code:2,invalid_stderr_code:SCHEMA_MISMATCH_CODE,
    exit_meanings:{1:'Typed native-project summary emitted; this is not a task PASS.',2:'Receipt rejected with the route diagnostic.'}
  }),
  makeRoute({
    route_id:'project',
    input_schemas:['SQUIRE2_PROJECT_RESULT_V1'],
    result_kind:'summary',
    terminal_output_kind:'project_text',
    project:raw=>projectProjectRunSummary(raw),
    write:typedWriter(formatProjectSummaryTerminal),
    valid_exit_codes:[1],invalid_exit_code:2,invalid_stderr_code:SCHEMA_MISMATCH_CODE,
    exit_meanings:{1:'Typed project summary emitted; this is not a task PASS.',2:'Receipt rejected with the route diagnostic.'}
  }),
  makeRoute({
    route_id:'single_js',
    input_schemas:['SQUIRE2_SINGLE_JS_RESULT_V1','SQUIRE2_SINGLE_JS_DRY_RUN_V1'],
    result_kind:'summary',
    terminal_output_kind:'single_js_text',
    project:raw=>projectSingleJsRunSummary(raw),
    write:typedWriter(formatSingleJsSummaryTerminal),
    valid_exit_codes:[1],invalid_exit_code:2,invalid_stderr_code:SCHEMA_MISMATCH_CODE,
    exit_meanings:{1:'Typed single-JavaScript summary emitted; this is not a task PASS.',2:'Receipt rejected with the route diagnostic.'}
  }),
  makeRoute({
    route_id:'courier_handoff',
    input_schemas:['SQUIRE3_COURIER_HANDOFF_REPORT_V1'],
    result_kind:'handoff',
    terminal_output_kind:'courier_handoff_text',
    project:raw=>buildCourierHandoffReport(raw),
    write:handoffWriter,
    valid_exit_codes:[1],invalid_exit_code:2,invalid_stderr_code:COURIER_HANDOFF_INVALID_CODE,
    exit_meanings:{1:'Courier handoff report emitted.',2:'Receipt rejected with INVALID_INPUT.'}
  }),
  makeRoute({
    route_id:'legacy_campaign',input_schemas:[],
    result_kind:'summary',
    legacy_shape_names:['Q218_CAMPAIGN','NATIVE_Q218_CAMPAIGN','NATIVE_DISABLED_DRY_RUN'],
    terminal_output_kind:'legacy_campaign_text',
    project:raw=>projectRunSummary(raw),
    write:campaignWriter,
    valid_exit_codes:[0,1],invalid_exit_code:2,rejection_codes:OFFLINE_REPORT_REJECTION_CODES,
    exit_meanings:{0:'Only a complete legacy campaign PASS.',1:'Legacy campaign FAIL or INCOMPLETE.',2:'Usage, read, parse, or invalid legacy receipt.'}
  })
]);

function routeRecords(routes){
  return routes.map(route=>({
    route_id:route.route_id,
    input_schemas:[...route.input_schemas],
    ...(route.legacy_shape_names?{legacy_shape_names:[...route.legacy_shape_names]}:{}),
    terminal_output_kind:route.terminal_output_kind,
    valid_exit_codes:[...route.valid_exit_codes],
    invalid_exit_code:route.invalid_exit_code
  }));
}
function rejectionRecords(routes){
  const byCode=new Map();
  for(const route of routes)for(const code of route.rejection_codes){
    if(!byCode.has(code))byCode.set(code,[]);
    byCode.get(code).push(route.route_id);
  }
  byCode.set(CAPABILITIES_INTERNAL_ERROR,['capabilities']);
  return [...byCode].map(([code,route_ids])=>({code,route_ids,stability:'V1_DISCOVERY_CONTRACT'}));
}
function exitRecords(routes){
  const byCode=new Map([[0,[]],[1,[]],[2,[{route_id:'usage',meaning:'Invalid argument shape uses the existing usage response.'}]]]);
  for(const route of routes){
    for(const code of route.valid_exit_codes)byCode.get(code).push({route_id:route.route_id,meaning:route.exit_meanings[code]});
    byCode.get(route.invalid_exit_code).push({route_id:route.route_id,meaning:route.exit_meanings[route.invalid_exit_code]});
  }
  return [...byCode].map(([exit_code,route_meanings])=>({exit_code,route_meanings}));
}
export function serializeOfflineReportCapabilities(routes=REPORT_ROUTES){
  try{
    if(!Array.isArray(routes)||routes.length>7)throw 0;
    for(const route of routes){
      if(typeof route?.route_id!=='string'||route.route_id.length>64||
         !Array.isArray(route.input_schemas)||route.input_schemas.length>2||
         route.input_schemas.some(value=>typeof value!=='string'||value.length>96)||
         route.legacy_shape_names!==undefined&&(!Array.isArray(route.legacy_shape_names)||route.legacy_shape_names.length>3)||
         typeof route.terminal_output_kind!=='string'||route.terminal_output_kind.length>64||
         !Array.isArray(route.valid_exit_codes)||route.valid_exit_codes.length>3||
         route.valid_exit_codes.some(value=>![0,1,2].includes(value))||
         !Number.isInteger(route.invalid_exit_code)||route.invalid_exit_code<0||route.invalid_exit_code>2||
         !Array.isArray(route.rejection_codes)||route.rejection_codes.length>OFFLINE_REPORT_REJECTION_CODES.length+1||
         route.rejection_codes.some(value=>typeof value!=='string'||value.length>64)||
         !route.exit_meanings||typeof route.exit_meanings!=='object'||Array.isArray(route.exit_meanings)||
         Object.keys(route.exit_meanings).some(code=>!['0','1','2'].includes(code))||
         Object.values(route.exit_meanings).some(value=>typeof value!=='string'||value.length>1024)||
         route.legacy_shape_names?.some(value=>typeof value!=='string'||value.length>64))throw 0;
    }
    const manifest={
      schema:CAPABILITIES_SCHEMA,
      interface:'squire-report',
      invocation:['--capabilities','--json'],
      receipt_input_max_bytes:REPORT_MAX_BYTES,
      routes:routeRecords(routes),
      rejection_codes:rejectionRecords(routes),
      exit_meanings:exitRecords(routes)
    };
    const output=JSON.stringify(manifest)+'\n';
    if(new TextEncoder().encode(output).length>CAPABILITIES_MAX_BYTES)throw 0;
    return output;
  }catch{throw CAPABILITIES_INTERNAL_ERROR;}
}
export function writeOfflineReportCapabilities(stdout,stderr,routes=REPORT_ROUTES){
  try{const output=serializeOfflineReportCapabilities(routes);stdout.write(output);return 0;}
  catch{try{stderr.write(CAPABILITIES_INTERNAL_ERROR+'\n');}catch{}return 2;}
}

// Synchronous sink failures withhold success, without retrying output or
// exposing the thrown value. Already emitted bytes cannot be retracted.
export async function runOfflineReportCli(argv,ports={}) {
  try{return await runOfflineReportCliInternal(argv,ports);}
  catch{return 2;}
}
async function runOfflineReportCliInternal(argv,ports) {
  const stdout=ports.stdout??process.stdout,stderr=ports.stderr??process.stderr;
  if(Array.isArray(argv)&&argv.length===2&&argv[0]==='--capabilities'&&argv[1]==='--json'){
    return writeOfflineReportCapabilities(stdout,stderr);
  }
  if(!Array.isArray(argv)||argv.length!==1||typeof argv[0]!=='string'||!argv[0]||argv[0].includes('\0')){stderr.write('Usage: node bin/squire-report.mjs <receipt-path>\n');return 2;}
  let summary,handoffReport;
  let route=REPORT_ROUTES.at(-1);
  try{
    let bytes;
    if(ports.readFile){
      if(typeof ports.stat!=='function')throw 'READ_FAILED';const st=await ports.stat(argv[0]);
      if(!st.isFile()||st.isSymbolicLink?.())throw 'SPECIAL_FILE_REJECTED';if(st.size>REPORT_MAX_BYTES)throw 'FILE_TOO_LARGE';
      bytes=await ports.readFile(argv[0],{maxBytes:REPORT_MAX_BYTES});
    }else bytes=await readReceiptBytes(argv[0]);
    const raw=parseReceiptJson(bytes);
    route=REPORT_ROUTES.find(candidate=>candidate.matches(raw))??REPORT_ROUTES.at(-1);
    const projected=route.project(raw,bytes);
    if(route.result_kind==='handoff')handoffReport=projected;else summary=projected;
  }catch(error){
    let code='READ_FAILED';
    if(typeof error==='string')code=error;
    else try{if(error?.code==='ENOENT')code='FILE_NOT_FOUND';else if(error?.code==='ELOOP')code='SPECIAL_FILE_REJECTED';}catch{}
    summary=invalidRunSummary(code);
  }
  return route.write(route,summary,handoffReport,stdout,stderr);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runOfflineReportCli(process.argv.slice(2));
