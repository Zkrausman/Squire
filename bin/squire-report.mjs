// Explicit offline file input only. Imports/default invocation never dispatch a task.
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {REPORT_MAX_BYTES,parseReceiptJson,projectRunSummary,formatSummaryTerminal,invalidRunSummary} from '../src/offline-run-summary.mjs';
import {projectSingleJsRunSummary,formatSingleJsSummaryTerminal} from '../src/single-js-summary.mjs';
import {projectProjectRunSummary,formatProjectSummaryTerminal,projectNativeProjectRunSummary,formatNativeProjectSummaryTerminal} from '../src/project-summary.mjs';
import {buildCourierHandoffReport} from '../src/courier-handoff-report.mjs';

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
export async function runOfflineReportCli(argv,ports={}) {
  const stdout=ports.stdout??process.stdout,stderr=ports.stderr??process.stderr;
  if(!Array.isArray(argv)||argv.length!==1||typeof argv[0]!=='string'||!argv[0]||argv[0].includes('\0')){stderr.write('Usage: node bin/squire-report.mjs <receipt-path>\n');return 2;}
  let summary,kind='campaign',handoffReport;
  try{
    let bytes;
    if(ports.readFile){
      if(typeof ports.stat!=='function')throw 'READ_FAILED';const st=await ports.stat(argv[0]);
      if(!st.isFile()||st.isSymbolicLink?.())throw 'SPECIAL_FILE_REJECTED';if(st.size>REPORT_MAX_BYTES)throw 'FILE_TOO_LARGE';
      bytes=await ports.readFile(argv[0],{maxBytes:REPORT_MAX_BYTES});
    }else bytes=await readReceiptBytes(argv[0]);
    const raw=parseReceiptJson(bytes);
    if(raw?.schema==='SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1'){kind='native-project';summary=projectNativeProjectRunSummary(raw);}
    else if(raw?.schema==='SQUIRE2_PROJECT_RESULT_V1'){kind='project';summary=projectProjectRunSummary(raw);}
    else if(raw?.schema==='SQUIRE2_SINGLE_JS_RESULT_V1'||raw?.schema==='SQUIRE2_SINGLE_JS_DRY_RUN_V1'){kind='single';summary=projectSingleJsRunSummary(raw);}
    else if(raw?.schema==='SQUIRE3_COURIER_HANDOFF_REPORT_V1'){kind='handoff';handoffReport=buildCourierHandoffReport(raw);}
    else summary=projectRunSummary(raw);
  }catch(error){
    let code='READ_FAILED';
    if(typeof error==='string')code=error;
    else try{if(error?.code==='ENOENT')code='FILE_NOT_FOUND';else if(error?.code==='ELOOP')code='SPECIAL_FILE_REJECTED';}catch{}
    summary=invalidRunSummary(code);
  }
  if(kind==='handoff'){
    if(!handoffReport){stderr.write('INVALID_INPUT\n');return 2;}
    stdout.write(handoffReport.terminal_text);return 1;
  }
  if(kind==='native-project'){
    stdout.write(formatNativeProjectSummaryTerminal(summary));
    if(summary.readiness==='INVALID_RECEIPT'){stderr.write('SCHEMA_MISMATCH\n');return 2;}
    return 1;
  }
  if(kind==='project'){stdout.write(formatProjectSummaryTerminal(summary));if(summary.readiness==='INVALID_RECEIPT'){stderr.write('SCHEMA_MISMATCH\n');return 2;}return 1;}
  if(kind==='single'){stdout.write(formatSingleJsSummaryTerminal(summary));if(summary.readiness==='INVALID_RECEIPT'){stderr.write('SCHEMA_MISMATCH\n');return 2;}return 1;}
  stdout.write(formatSummaryTerminal(summary));
  if(summary.overall_outcome==='INVALID_RECEIPT'){stderr.write(summary.diagnostic.reason+'\n');return 2;}
  return summary.overall_outcome==='PASS'?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runOfflineReportCli(process.argv.slice(2));
