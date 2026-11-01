import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {dirname,join} from 'node:path';
import {
  PROJECT_OUTPUT_LARGE_PROFILE as PROFILE,
  validateProjectOutputLargeProfile,
  PROJECT_LARGE_OBSERVATION_TASK_CLASS,
  PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA,
  PROJECT_LARGE_OBSERVATION_CONFIG_SCHEMA,
  PROJECT_LARGE_OBSERVATION_MANIFEST_SCHEMA,
  PROJECT_CODING_OBSERVATION_PROFILE,
  resolveProjectCodingProfile,
  validateProjectCodingObservationProfile,
  validateProjectCodingObservationOutcome
} from '../src/project-coding-profile.mjs';
import {validateLimitedJobRecord,validateLargeProjectJobRecord} from '../src/limited-job-record.mjs';
import {
  parseProjectJson,validateProjectPayloadJson,
  validateLargeProjectPayloadJson
} from '../src/project-task.mjs';
import {hash,canonicalBytes,verifyExactFile} from '../src/bounded-codegen-plan.mjs';
import {
  decodeCodexJsonl,decodeLargeProjectCodexJsonl,
  iterateLargeProjectCodexJsonlFrames
} from '../src/provider-metadata.mjs';
import {
  createCodexProjectStreamCollector,
  createCodexLargeProjectStreamCollector
} from '../src/project-stream-collector.mjs';
import {
  planStaging,writeStage,verifyStage,
  planLargeProjectStaging,writeLargeProjectStage,verifyLargeProjectStage,
  safeMultifileErrorCode
} from '../src/multifile-staging.mjs';
import {
  planExport,writeExport,buildExport,verifyExport,
  planLargeProjectExport,writeLargeProjectExport,buildLargeProjectExport,
  verifyLargeProjectExport
} from '../src/multifile-export.mjs';
import {
  DESKTOP_TARGET,DESKTOP_CODEGEN_PREFIX,DESKTOP_PREFIX_IDENTITY
} from '../src/desktop-profile.mjs';
import {
  admitDesktopCodegenProjectTask,admitDesktopCodingLargeObservationProjectTask,
  runProjectCodexTask,runDesktopCodingLargeObservationProjectTask
} from '../src/project-runner.mjs';
import {
  PROJECT_SOURCE_ROOT,DESKTOP_CODEGEN_SOURCE_FILES,
  validateProjectCodexConfig,validateDesktopCodegenConfig,
  validateDesktopCodingLargeObservationConfig,
  validateDesktopCodingLargeObservationAdmission,
  prepareDesktopCodingLargeObservationTask
} from '../src/project-configuration.mjs';
import {
  buildDesktopCodingLargeObservationInvocation,
  runProjectEntrypointCli,
  desktopCodingLargeObservationEntrypointMode,
  runProjectDesktopCodingLargeObservationWithPorts,
  runProjectDesktopCodingLargeObservationNativeWithReadiness,
  runProjectDesktopCodingLargeObservationWithReadinessWithPorts,
  runProjectDesktopCodingLargeObservationWithFailureDiagnosticsWithPorts,
  runProjectDesktopCodingLargeObservationWithPhaseDiagnosticsWithPorts,
  verifyProjectArtifactChecks,
  verifyProjectArtifactChecksWithPorts
} from '../acceptance/project-entrypoint.mjs';
import {
  createNativeProjectLargeObservationResultReceipt,
  writeNativeProjectLargeObservationResultReceipt,
  createNativeProjectResultReceipt,
  createNativeProjectCodingObservationResultReceipt
} from '../src/project-result-receipt.mjs';
import {
  projectNativeProjectLargeObservationRunSummary,
  projectNativeProjectLargeObservationReceiptBytesSummary,
  projectNativeProjectRunSummary,
  projectNativeProjectCodingObservationRunSummary,
  formatNativeProjectLargeObservationSummaryTerminal,
  formatNativeProjectSummaryTerminal,
  formatNativeProjectCodingObservationSummaryTerminal
} from '../src/project-summary.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {REPORT_MAX_BYTES} from '../src/offline-run-summary.mjs';
import {runOfflineReportCli} from '../bin/squire-report.mjs';
import {publicRetention,retentionResult} from '../src/internal/rejected-capture.mjs';
import {GENERATION_SHUTDOWN} from '../src/bounded-codegen-plan.mjs';
import {CODEX_CHILD_ENV_DELETIONS} from '../src/codex-profile.mjs';

const encoder=new TextEncoder();
const mib=1024*1024;
const source=(path,content='x',encoding='utf-8')=>({
  path,classification:'SOURCE',encoding,content
});
const asset=(path,content='',encoding='utf-8')=>({
  path,classification:'LOCAL_ASSET',encoding,content
});
const doc=(path,content='')=>({
  path,classification:'DOC',encoding:'utf-8',content
});
const envelope=files=>encoder.encode(JSON.stringify({
  schema:'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',files
}));
const reject=(bytes,field,validator=validateLargeProjectPayloadJson)=>
  assert.throws(()=>validator(bytes),error=>error?.field===field);
function padEnvelope(size,files=[source('main.js')]){
  const initial=envelope(files);
  assert.ok(initial.length<=size);
  const bytes=new Uint8Array(size);
  bytes.set(initial);
  bytes.fill(0x20,initial.length);
  return bytes;
}
function uniqueSources(count,content='x'){
  return Array.from({length:count},(_,index)=>source(`src/file-${index}.js`,content));
}

test('large output profile is a fixed closed own-data descriptor',()=>{
  const expected={
    id:'PROJECT_OUTPUT_LARGE_V1',
    max_stdout_bytes:8388608,
    max_stderr_bytes:262144,
    max_envelope_bytes:4194304,
    max_source_file_bytes:524288,
    max_source_total_bytes:2097152,
    max_decoded_project_bytes:4194304,
    max_source_files:25,
    max_all_files:50,
    max_jsonl_frames:65536,
    max_event_depth:64,
    max_event_nodes:65536
  };
  assert.deepEqual(PROFILE,expected);
  assert.equal(Object.isFrozen(PROFILE),true);
  assert.equal(validateProjectOutputLargeProfile({...PROFILE}),PROFILE);
  assert.equal(validateProjectOutputLargeProfile(
    Object.assign(Object.create(null),PROFILE)
  ),PROFILE);
  let invoked=0;
  const getter={...PROFILE};
  Object.defineProperty(getter,'id',{get(){invoked++;return PROFILE.id;}});
  const proxy=new Proxy({...PROFILE},{ownKeys(){invoked++;return Reflect.ownKeys(PROFILE);}});
  for(const value of [null,{},getter,proxy]){
    assert.throws(()=>validateProjectOutputLargeProfile(value));
  }
  for(const key of Object.keys(PROFILE)){
    const missing={...PROFILE};delete missing[key];
    assert.throws(()=>validateProjectOutputLargeProfile(missing));
    assert.throws(()=>validateProjectOutputLargeProfile({...PROFILE,[key]:null}));
  }
  assert.throws(()=>validateProjectOutputLargeProfile({...PROFILE,extra:1}));
  assert.equal(invoked,0);
});

test('legacy observation selection and legacy SOURCE ceiling stay unchanged',()=>{
  assert.equal(validateProjectCodingObservationProfile(
    {...PROJECT_CODING_OBSERVATION_PROFILE}
  ),PROJECT_CODING_OBSERVATION_PROFILE);
  assert.deepEqual(resolveProjectCodingProfile(),{
    generation_wall_ms:120000,
    outer_observation_ms:140000,
    post_generation_closeout_ms:null
  });
  assert.deepEqual(validateProjectCodingObservationOutcome({
    status:'INCOMPLETE',reason:'CANCELED',lifecycle:null,
    generation_invocations:0,has_staging:false,
    post_generation_closeout:{status:'NOT_STARTED',limit_ms:20000}
  }),{status:'NOT_STARTED',limit_ms:20000});
  assert.equal(validateProjectPayloadJson(envelope([
    source('legacy.js','x'.repeat(65536))
  ])).files[0].bytes,65536);
  reject(envelope([source('legacy.js','x'.repeat(65537))]),
    'PROJECT_FILE_SIZE_EXCEEDED',validateProjectPayloadJson);
  assert.equal(validateLargeProjectPayloadJson(envelope([
    source('large.js','x'.repeat(65537))
  ])).files[0].bytes,65537);
});

test('project JSON parser accepts nested primitive tokens after offset zero',()=>{
  const nested=parseProjectJson(encoder.encode(
    '{"label":"frame","number":12,"enabled":true,"missing":null,'+
    '"nested":[0,false,null]}'
  ));
  assert.equal(nested.number,12);
  assert.equal(nested.enabled,true);
  assert.equal(nested.missing,null);
  assert.deepEqual(nested.nested,[0,false,null]);

  const terminal=parseProjectJson(encoder.encode(
    '{"type":"turn.completed","usage":{"input_tokens":0,'+
    '"output_tokens":12,"cached_input_tokens":3,'+
    '"reasoning_output_tokens":2}}'
  ));
  assert.equal(terminal.type,'turn.completed');
  assert.deepEqual([
    terminal.usage.input_tokens,terminal.usage.output_tokens,
    terminal.usage.cached_input_tokens,terminal.usage.reasoning_output_tokens
  ],[0,12,3,2]);

  for(const malformed of ['{"value":x}','{"value":1}junk']){
    assert.throws(()=>parseProjectJson(encoder.encode(malformed)),
      error=>error?.field==='MALFORMED_JSON');
  }
});

test('large SOURCE accepts exactly 512 KiB and rejects one byte more',()=>{
  const exact=validateLargeProjectPayloadJson(envelope([
    source('src/exact.js','x'.repeat(512*mib/1024))
  ]));
  assert.equal(exact.files[0].bytes,PROFILE.max_source_file_bytes);
  assert.equal(exact.files[0].sha256,hash(encoder.encode('x'.repeat(524288))));
  reject(envelope([source('src/over.js','x'.repeat(524289))]),
    'PROJECT_FILE_SIZE_EXCEEDED');
});

test('large SOURCE aggregate accepts 2 MiB and rejects one byte more',()=>{
  const files=uniqueSources(4,'x'.repeat(524288));
  const exact=validateLargeProjectPayloadJson(envelope(files));
  assert.equal(exact.files.reduce((sum,file)=>sum+file.bytes,0),
    PROFILE.max_source_total_bytes);
  const over=[...files,source('src/extra.js')];
  reject(envelope(over),'PROJECT_AGGREGATE_CAPACITY_EXCEEDED');
});

test('source and all-file counts enforce the fixed 25 and 50 boundaries',()=>{
  const sourceLimit=validateLargeProjectPayloadJson(envelope(uniqueSources(25)));
  assert.equal(sourceLimit.files.length,25);
  reject(envelope(uniqueSources(26)),'PROJECT_AGGREGATE_CAPACITY_EXCEEDED');
  const fifty=[
    ...uniqueSources(25),
    ...Array.from({length:20},(_,index)=>asset(`assets/${index}.bin`)),
    ...Array.from({length:5},(_,index)=>doc(`docs/${index}.md`))
  ];
  assert.equal(validateLargeProjectPayloadJson(envelope(fifty)).files.length,
    PROFILE.max_all_files);
  reject(envelope([...fifty,doc('docs/extra.md')]),
    'PROJECT_AGGREGATE_CAPACITY_EXCEEDED');
});

test('unchanged LOCAL_ASSET and DOC per-file, count and aggregate ceilings apply',()=>{
  assert.equal(validateLargeProjectPayloadJson(envelope([
    asset('assets/exact.bin','a'.repeat(524288)),
    ...Array.from({length:19},(_,index)=>asset(`assets/empty-${index}.bin`)),
    ...Array.from({length:5},(_,index)=>doc(`docs/${index}.md`))
  ])).files.length,25);
  reject(envelope([asset('assets/large.bin','a'.repeat(524289))]),
    'PROJECT_FILE_SIZE_EXCEEDED');
  reject(envelope(Array.from({length:21},(_,index)=>
    asset(`assets/${index}.bin`))),
  'PROJECT_AGGREGATE_CAPACITY_EXCEEDED');
  reject(envelope([doc('docs/large.md','a'.repeat(65537))]),
    'PROJECT_FILE_SIZE_EXCEEDED');
  reject(envelope(Array.from({length:6},(_,index)=>doc(`docs/${index}.md`))),
    'PROJECT_AGGREGATE_CAPACITY_EXCEEDED');
});

test('envelope accepts exactly 4 MiB of UTF-8 bytes and rejects one byte more',()=>{
  const exact=padEnvelope(PROFILE.max_envelope_bytes);
  assert.equal(validateLargeProjectPayloadJson(exact).files[0].bytes,1);
  reject(padEnvelope(PROFILE.max_envelope_bytes+1),
    'PROJECT_PAYLOAD_TOO_LARGE');
});

test('decoded project totals remain finite beneath the envelope ceiling',()=>{
  const below=[
    ...uniqueSources(4,'s'.repeat(524288)),
    ...Array.from({length:3},(_,index)=>
      asset(`assets/large-${index}.bin`,'a'.repeat(524288)))
  ];
  const accepted=validateLargeProjectPayloadJson(envelope(below));
  assert.equal(accepted.files.reduce((sum,file)=>sum+file.bytes,0),
    3670016);
  // A 4 MiB decoded payload cannot fit inside the separately fixed 4 MiB JSON
  // envelope: JSON framing and property names consume additional input bytes.
  // This over-limit fixture therefore fails at the earlier envelope boundary.
  const atDecodedCeiling=[
    ...uniqueSources(4,'s'.repeat(524288)),
    ...Array.from({length:4},(_,index)=>
      asset(`assets/${index}.bin`,'a'.repeat(524288)))
  ];
  reject(envelope(atDecodedCeiling),'PROJECT_PAYLOAD_TOO_LARGE');
});

test('UTF-8 byte accounting, canonical base64 and accepted hashes are exact',()=>{
  const multibyte='é'.repeat(262144);
  const base64=Buffer.from(new Uint8Array(524288).fill(0xa5)).toString('base64');
  const result=validateLargeProjectPayloadJson(envelope([
    source('src/multibyte.js',multibyte),
    asset('assets/binary.bin',base64,'base64'),
    doc('README.md','')
  ]));
  assert.deepEqual(result.files.map(file=>file.bytes),[524288,524288,0]);
  assert.deepEqual(result.files.map(file=>file.sha256),[
    hash(encoder.encode(multibyte)),
    hash(new Uint8Array(524288).fill(0xa5)),
    hash(new Uint8Array())
  ]);
  assert.ok(result.files.every(Object.isFrozen));
  reject(envelope([source('src/multibyte-over.js',multibyte+'a')]),
    'PROJECT_FILE_SIZE_EXCEEDED');
  reject(envelope([asset('assets/noncanonical.bin','AB==','base64')]),
    'PROJECT_BASE64_INVALID');
});

test('large envelope rejects malformed, ambiguous and structurally excessive JSON',()=>{
  reject(new Uint8Array([0xff,0xff]),'PROJECT_ENCODING_REJECTED');
  for(const [text,reason] of [
    [
      '{"schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":[{"path":"a.js","classification":"SOURCE","encoding":"utf-8","content":"x"}]}',
      'PROJECT_DUPLICATE_KEY'
    ],
    [
      '{"schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","\\u0073chema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":[{"path":"a.js","classification":"SOURCE","encoding":"utf-8","content":"x"}]}',
      'PROJECT_DUPLICATE_KEY'
    ],
    [
      '{"schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":[{"path":"a.js","\\u0070ath":"b.js","classification":"SOURCE","encoding":"utf-8","content":"x"}]}',
      'PROJECT_DUPLICATE_KEY'
    ],
    [
      '{"schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":[{"path":"a.js","classification":"SOURCE","encoding":"utf-8","content":"\\ud800"}]}',
      'PROJECT_ENCODING_REJECTED'
    ],
    [
      '{"schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":[{"path":"a.js","classification":"SOURCE","encoding":"utf-8","content":"x"}',
      'PROJECT_SCHEMA_MISMATCH'
    ]
  ]){
    reject(encoder.encode(text),reason);
  }
  reject(envelope([source('../escape.js')]),'PROJECT_PATH_TRAVERSAL');
  reject(envelope([source('A.js'),source('a.js')]),'PROJECT_PATH_COLLISION');
  reject(envelope([{
    path:'bad.js',classification:'EVIDENCE_LOG',encoding:'utf-8',content:'x'
  }]),'PROJECT_CLASSIFICATION_INVALID');
  reject(envelope([{
    path:'bad.js',classification:'SOURCE',encoding:'hex',content:'x'
  }]),'PROJECT_ENCODING_INVALID');
  reject(encoder.encode('{"schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":['+
    '['.repeat(9)+'0'+']'.repeat(9)+']}'),'PROJECT_SCHEMA_MISMATCH');
  const manyNodes='{"schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":['+
    Array.from({length:40},()=>`{"path":"a.js","classification":"SOURCE","encoding":"utf-8","content":"x","extra":${JSON.stringify(Array(25).fill(0))}}`).join(',')+
    ']}';
  reject(encoder.encode(manyNodes),'PROJECT_SCHEMA_MISMATCH');
  reject(encoder.encode('{"schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":'),
    'PROJECT_SCHEMA_MISMATCH');
});

const jsonl=(...events)=>encoder.encode(
  events.map(event=>JSON.stringify(event)).join('\n')+'\n'
);
const terminalInput=bytes=>({
  raw_payload_bytes:bytes,
  max_response_bytes:PROFILE.max_stdout_bytes,
  wrapper_exit_code:0,wrapper_signal:null,wrapper_wall_ms:null
});
const responseEvents=response=>[
  {type:'turn.started'},
  {type:'item.completed',item:{type:'agent_message',text:response}},
  {type:'turn.completed'}
];
function feedCollector(collector,bytes,chunkSize=8192){
  for(let offset=0;offset<bytes.length;offset+=chunkSize){
    collector.chunk('stdout',bytes.subarray(offset,Math.min(bytes.length,offset+chunkSize)));
  }
  collector.eof('stdout');
  collector.eof('stderr');
  return collector;
}

test('large metadata decoder is fixed to its profile and keeps output private',()=>{
  const bytes=jsonl(
    {type:'thread.started',private:'synthetic-secret'},
    {type:'turn.completed',usage:{
      input_tokens:0,output_tokens:17,cached_input_tokens:2,
      reasoning_output_tokens:3
    }}
  );
  const result=decodeLargeProjectCodexJsonl(terminalInput(bytes));
  assert.equal(result.parser_status,'OK');
  assert.equal(result.provider_reported_status,'turn.completed');
  assert.deepEqual(result.usage,{
    input:0,output:17,cache_read:2,thinking:null,total:null
  });
  assert.equal(result.extra_metadata.codex_reasoning_output_tokens,3);
  assert.equal(result.extra_metadata.backend_model,'UNKNOWN');
  assert.equal(result.task_outcome_evaluated,false);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'),false);
  assert.equal('raw_payload_bytes'in result,false);
  assert.throws(()=>decodeLargeProjectCodexJsonl({
    ...terminalInput(bytes),max_response_bytes:PROFILE.max_stdout_bytes-1
  }),error=>error.code==='INVALID_WRAPPER_OBSERVATION');

  const legacyBytes=new Uint8Array(1048577);
  const legacy=decodeCodexJsonl({
    raw_payload_bytes:legacyBytes,max_response_bytes:1048576,
    wrapper_exit_code:0,wrapper_signal:null,wrapper_wall_ms:null
  });
  assert.equal(legacy.diagnostic_code,'PAYLOAD_SIZE_EXCEEDED');
  const oversized=decodeLargeProjectCodexJsonl(
    terminalInput(new Uint8Array(PROFILE.max_stdout_bytes+1))
  );
  assert.equal(oversized.parser_status,'PARSE_ERROR');
  assert.equal(oversized.diagnostic_code,'PAYLOAD_SIZE_EXCEEDED');
});

test('large JSONL iterator enforces transport frame and per-frame node and depth ceilings',()=>{
  let frames=0;
  for(const _event of iterateLargeProjectCodexJsonlFrames(
    encoder.encode('{}\n'.repeat(PROFILE.max_jsonl_frames))
  ))frames++;
  assert.equal(frames,PROFILE.max_jsonl_frames);
  assert.throws(()=>{
    for(const _event of iterateLargeProjectCodexJsonlFrames(
      encoder.encode('{}\n'.repeat(PROFILE.max_jsonl_frames+1))
    )){}
  },error=>error.field==='ENVELOPE_PARSE_ERROR');

  const notices=encoder.encode('{"type":"notice"}\n'.repeat(32768));
  const response=new TextDecoder().decode(envelope([source('src/main.js')]));
  const suffix=jsonl(...responseEvents(response));
  const manyFrames=new Uint8Array(notices.length+suffix.length);
  manyFrames.set(notices);
  manyFrames.set(suffix,notices.length);
  const decoded=decodeLargeProjectCodexJsonl(terminalInput(manyFrames));
  assert.equal(decoded.parser_status,'OK');
  const collector=feedCollector(
    createCodexLargeProjectStreamCollector(),manyFrames
  );
  assert.equal(collector.snapshot().io_drained,true);
  const collected=collector.decode({});
  assert.equal(collected.payload.files[0].path,'src/main.js');
  collector.close();

  const exactNodes='{"type":"turn.completed","ignored":['+
    Array(65533).fill('0').join(',')+']}';
  assert.equal(decodeLargeProjectCodexJsonl(
    terminalInput(encoder.encode(exactNodes))
  ).parser_status,'OK');
  const overNodes='{"type":"turn.completed","ignored":['+
    Array(65534).fill('0').join(',')+']}';
  assert.equal(decodeLargeProjectCodexJsonl(
    terminalInput(encoder.encode(overNodes))
  ).diagnostic_code,'ENVELOPE_PARSE_ERROR');

  const atDepth='{"type":"turn.completed","ignored":'+
    '['.repeat(63)+'0'+']'.repeat(63)+'}';
  assert.equal(decodeLargeProjectCodexJsonl(
    terminalInput(encoder.encode(atDepth))
  ).parser_status,'OK');
  const overDepth='{"type":"turn.completed","ignored":'+
    '['.repeat(64)+'0'+']'.repeat(64)+'}';
  assert.equal(decodeLargeProjectCodexJsonl(
    terminalInput(encoder.encode(overDepth))
  ).diagnostic_code,'ENVELOPE_PARSE_ERROR');

  const blankLines='\n'.repeat(100000);
  assert.equal(decodeLargeProjectCodexJsonl(terminalInput(
    encoder.encode(blankLines+'{"type":"turn.completed"}')
  )).parser_status,'OK');
});

test('large frame parsing rejects malformed UTF-8, duplicates and incomplete JSON',()=>{
  for(const [text,reason] of [
    ['{"type":"turn.completed","ignored":{"a":1,"a":2}}','DUPLICATE_KEY_CONFLICT'],
    ['{"type":"turn.completed","ignored":{"a":1,"\\u0061":2}}','DUPLICATE_KEY_CONFLICT'],
    ['{"type":"turn.completed","ignored":','MALFORMED_JSON']
  ]){
    assert.equal(decodeLargeProjectCodexJsonl(
      terminalInput(encoder.encode(text))
    ).diagnostic_code,reason);
  }
  assert.equal(decodeLargeProjectCodexJsonl(
    terminalInput(new Uint8Array([0xff,0xff]))
  ).diagnostic_code,'MALFORMED_UTF8');
  assert.equal(decodeLargeProjectCodexJsonl(
    terminalInput(encoder.encode('[]'))
  ).diagnostic_code,'INVALID_ROOT_SHAPE');
  const privateMalformed=decodeLargeProjectCodexJsonl(terminalInput(
    encoder.encode('{"type":"turn.completed","ignored":"PRIVATE_CAUGHT_MESSAGE')
  ));
  assert.equal(privateMalformed.diagnostic_code,'MALFORMED_JSON');
  assert.equal(JSON.stringify(privateMalformed).includes('PRIVATE_CAUGHT_MESSAGE'),false);
});

test('large frame iterator return closes an intentionally partial iteration',()=>{
  const iterator=iterateLargeProjectCodexJsonlFrames(
    jsonl({type:'notice',ignored:'PRIVATE_FRAME'},
      {type:'turn.completed'})
  );
  const first=iterator.next();
  assert.equal(first.done,false);
  assert.equal(first.value.type,'notice');
  assert.deepEqual(iterator.return(),{value:undefined,done:true});
  assert.deepEqual(iterator.next(),{value:undefined,done:true});
});

test('large metadata usage rejects rounded, fractional and negative numeric lexemes',()=>{
  for(const lexeme of [
    '-1','-0','1.5','1.0','1e-400','1.00000000000000001',
    '9007199254740992','1e2','1e400'
  ]){
    const bytes=encoder.encode(
      `{"type":"turn.completed","usage":{"output_tokens":${lexeme}}}`
    );
    const result=decodeLargeProjectCodexJsonl(terminalInput(bytes));
    assert.equal(result.parser_status,'OK_WITH_FIELD_DIAGNOSTIC',lexeme);
    assert.equal(result.diagnostic_code,'INVALID_USAGE_COUNTER',lexeme);
    assert.equal(result.usage.output,null,lexeme);
  }
  const zero=decodeLargeProjectCodexJsonl(terminalInput(encoder.encode(
    '{"type":"turn.completed","usage":{"output_tokens":0}}'
  )));
  assert.equal(zero.diagnostic_code,'PARSE_OK');
  assert.equal(zero.usage.output,0);
});

test('large collector accepts fragmented UTF-8 and SOURCE above the legacy file cap',()=>{
  const sourceBytes=encoder.encode('synthetic source\n'.repeat(5000));
  assert.ok(sourceBytes.length>65536);
  const response=new TextDecoder('utf-8',{fatal:true}).decode(envelope([
    source('src/large.js',new TextDecoder().decode(sourceBytes))
  ]));
  const bytes=jsonl(
    {type:'notice',ignored:'fragmented é'},
    ...responseEvents(response)
  );
  const collector=createCodexLargeProjectStreamCollector();
  const split=bytes.findIndex(byte=>byte===0xc3);
  assert.ok(split>=0);
  collector.chunk('stdout',bytes.subarray(0,split+1));
  collector.chunk('stdout',bytes.subarray(split+1));
  collector.eof('stdout');collector.eof('stderr');
  assert.equal(collector.snapshot().io_drained,true);
  const result=collector.decode({});
  assert.equal(result.payload.files[0].bytes,sourceBytes.length);
  assert.equal(result.payload.files[0].sha256,hash(sourceBytes));
  assert.deepEqual(result.payload.files[0].content,sourceBytes);
  assert.equal(JSON.stringify(result.metadata).includes('synthetic source'),false);

  const legacy=createCodexProjectStreamCollector();
  feedCollector(legacy,bytes);
  assert.throws(()=>legacy.decode({}));
  assert.equal(legacy.diagnosticReport().reason,'PROJECT_FILE_SIZE_EXCEEDED');
  collector.close();
  assert.ok(result.payload.files[0].content.every(byte=>byte===0));
});

test('large collector rejects invalid event ordering and terminal histories',()=>{
  const message={type:'item.completed',item:{type:'agent_message',text:'{}'}};
  const started={type:'turn.started'};
  const completed={type:'turn.completed'};
  const failed={type:'turn.failed'};
  const cases=[
    [[message,completed],'ENVELOPE_PARSE_ERROR'],
    [[started,message],'MISSING_TERMINAL'],
    [[started,message,completed,completed],'REPEATED_TERMINAL_REJECTED'],
    [[started,message,completed,failed],'CONFLICTING_TERMINAL_EVENTS'],
    [[started,message,completed,{type:'notice'}],'TRAILING_DATA_AFTER_TERMINAL'],
    [[started,message,message,completed],'AMBIGUOUS_AGENT_MESSAGE'],
    [[started,{type:'error'},message,completed],'PROVIDER_NON_SUCCESS'],
    [[started,message,failed],'TURN_FAILED'],
    [[started,completed],'RESPONSE_STRING_REQUIRED']
  ];
  for(const [events,reason] of cases){
    const collector=feedCollector(
      createCodexLargeProjectStreamCollector(),jsonl(...events)
    );
    assert.throws(()=>collector.decode(),error=>error.field===reason,reason);
    assert.equal(collector.diagnosticReport().reason,reason);
    collector.close();
  }
});

test('large collector retains only bounded legacy-eligible rejected response bytes',()=>{
  const markdown='```'+ 'x'.repeat(70000);
  const small=feedCollector(
    createCodexLargeProjectStreamCollector(),
    jsonl(...responseEvents(markdown))
  );
  assert.throws(()=>small.decode(),error=>error.field==='PROJECT_MARKDOWN_REJECTED');
  const capture=small.diagnosticCapture();
  assert.equal(capture.eligible,true);
  assert.equal(capture.exact_response_bytes,encoder.encode(markdown).length);
  assert.equal(capture.response_bytes.length,65536);
  assert.equal(JSON.stringify(small.diagnosticReport()).includes(markdown),false);
  small.close();
  assert.equal(small.diagnosticCapture(),null);

  const oversized=' '.repeat(PROFILE.max_envelope_bytes+1);
  const large=feedCollector(
    createCodexLargeProjectStreamCollector(),
    jsonl(...responseEvents(oversized))
  );
  assert.throws(()=>large.decode(),error=>error.field==='PROJECT_PAYLOAD_TOO_LARGE');
  const ineligible=large.diagnosticCapture();
  assert.equal(ineligible.eligible,false);
  assert.equal(ineligible.exact_response_bytes,null);
  assert.equal(ineligible.response_bytes,null);
  large.close();
});

test('large collector observes exact stdout and stderr caps and rejects overflow',()=>{
  const exact=createCodexLargeProjectStreamCollector();
  const stdout=new Uint8Array(PROFILE.max_stdout_bytes);
  stdout.fill(0x0a);
  assert.equal(exact.chunk('stdout',stdout),true);
  assert.equal(exact.chunk('stderr',new Uint8Array(PROFILE.max_stderr_bytes)),true);
  exact.eof('stdout');exact.eof('stderr');
  assert.equal(exact.snapshot().stdout_bytes_observed,PROFILE.max_stdout_bytes);
  assert.equal(exact.snapshot().stderr_bytes_observed,PROFILE.max_stderr_bytes);
  assert.equal(exact.snapshot().io_drained,true);
  assert.throws(()=>exact.decode(),error=>error.field==='MISSING_TERMINAL');
  exact.close();

  const stdoutOver=createCodexLargeProjectStreamCollector();
  assert.equal(stdoutOver.chunk(
    'stdout',new Uint8Array(PROFILE.max_stdout_bytes+1)
  ),false);
  stdoutOver.eof('stdout');stdoutOver.eof('stderr');
  assert.equal(stdoutOver.snapshot().stdout_bytes_observed,
    PROFILE.max_stdout_bytes+1);
  assert.equal(stdoutOver.snapshot().io_drained,false);
  assert.throws(()=>stdoutOver.decode(),
    error=>error.field==='COLLECTION_FAILED');
  stdoutOver.close();

  const stderrOver=createCodexLargeProjectStreamCollector();
  assert.equal(stderrOver.chunk(
    'stderr',new Uint8Array(PROFILE.max_stderr_bytes)
  ),true);
  assert.equal(stderrOver.chunk('stderr',new Uint8Array(1)),false);
  stderrOver.eof('stdout');stderrOver.eof('stderr');
  assert.equal(stderrOver.snapshot().stderr_bytes_observed,
    PROFILE.max_stderr_bytes+1);
  stderrOver.close();

  const legacy=createCodexProjectStreamCollector();
  assert.equal(legacy.chunk('stdout',new Uint8Array(1048577)),false);
  const legacyStderr=createCodexProjectStreamCollector();
  assert.equal(legacyStderr.chunk('stderr',new Uint8Array(65537)),false);
});

const stageFile=(path,classification,size,byte=0x61)=>({
  path,classification,content:new Uint8Array(size).fill(byte)
});
const largeStage=(files,id='large-stage')=>planLargeProjectStaging({
  stage_operation_id:id,caller_label:'synthetic',
  output_profile:PROFILE,files
});
const testDirectoryStat=(uid,mode)=>({
  uid,mode,isDirectory:()=>true,isSymbolicLink:()=>false
});
async function largeOwnedFixture(fn){
  const root=await fs.mkdtemp('/tmp/squire-large-project-stage-');
  await fs.chmod(root,0o700);
  const map=path=>{
    assert.ok(path==='/owned'||path.startsWith('/owned/'));
    return join(root,path.slice(6));
  };
  const io={};
  for(const key of ['open','mkdir','lstat','chmod','readdir']){
    io[key]=(path,...args)=>fs[key](map(path),...args);
  }
  io.lstat=(path,...args)=>path==='/'?
    testDirectoryStat(0,0o40755):fs.lstat(map(path),...args);
  try{
    await fn({
      root,map,
      ports:{fs:io,uid:process.getuid()}
    });
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
}
const packageCode=error=>safeMultifileErrorCode(error);

test('large stage plans apply fixed class, project, count and manifest bounds',()=>{
  const exactSource=largeStage([
    stageFile('src/exact.js','SOURCE',PROFILE.max_source_file_bytes)
  ]);
  assert.equal(exactSource.files[0].bytes,PROFILE.max_source_file_bytes);
  assert.equal(exactSource.schema,'SQUIRE4_LARGE_PROJECT_STAGE_PLAN_V1');
  assert.equal(exactSource.manifest.schema_version,
    'squire4.large_project_stage_manifest.v1');
  assert.deepEqual(exactSource.output_profile,PROFILE);
  assert.deepEqual(exactSource.manifest.output_profile,PROFILE);
  assert.equal(exactSource.manifest_sha256,hash(exactSource.manifest_bytes));
  assert.throws(()=>largeStage([
    stageFile('src/over.js','SOURCE',PROFILE.max_source_file_bytes+1)
  ]),error=>packageCode(error)==='CAPACITY_EXCEEDED');

  const sourceExact=Array.from({length:4},(_,index)=>
    stageFile(`src/${index}.js`,'SOURCE',524288));
  const sourcePlan=largeStage(sourceExact);
  assert.equal(sourcePlan.total_bytes,PROFILE.max_source_total_bytes);
  assert.throws(()=>largeStage([
    ...sourceExact,stageFile('src/extra.js','SOURCE',1)
  ]),error=>packageCode(error)==='CAPACITY_EXCEEDED');

  const decodedExact=largeStage([
    ...Array.from({length:4},(_,index)=>
      stageFile(`src/source-${index}.js`,'SOURCE',524288)),
    ...Array.from({length:4},(_,index)=>
      stageFile(`assets/asset-${index}.bin`,'LOCAL_ASSET',524288))
  ]);
  assert.equal(decodedExact.total_bytes,PROFILE.max_decoded_project_bytes);
  assert.throws(()=>largeStage([
    ...Array.from({length:4},(_,index)=>
      stageFile(`src/mix-source-${index}.js`,'SOURCE',524288)),
    ...Array.from({length:4},(_,index)=>
      stageFile(`assets/mix-asset-${index}.bin`,'LOCAL_ASSET',524288)),
    stageFile('docs/one.md','DOC',1)
  ]),error=>packageCode(error)==='CAPACITY_EXCEEDED');

  assert.equal(largeStage(Array.from({length:25},(_,index)=>
    stageFile(`src/count-${index}.js`,'SOURCE',1))).file_count,25);
  assert.throws(()=>largeStage([
    ...Array.from({length:25},(_,index)=>
      stageFile(`src/count-${index}.js`,'SOURCE',1)),
    stageFile('src/count-extra.js','SOURCE',1)
  ]),error=>packageCode(error)==='CAPACITY_EXCEEDED');
  const fifty=[
    ...Array.from({length:25},(_,index)=>
      stageFile(`src/all-${index}.js`,'SOURCE',1)),
    ...Array.from({length:20},(_,index)=>
      stageFile(`assets/all-${index}.bin`,'LOCAL_ASSET',0)),
    ...Array.from({length:5},(_,index)=>
      stageFile(`docs/all-${index}.md`,'DOC',0))
  ];
  assert.equal(largeStage(fifty).file_count,PROFILE.max_all_files);
  assert.throws(()=>largeStage([
    ...fifty,stageFile('docs/all-extra.md','DOC',0)
  ]),error=>packageCode(error)==='CAPACITY_EXCEEDED');

  assert.throws(()=>planStaging({
    stage_operation_id:'legacy-large',caller_label:'synthetic',
    files:[stageFile('src/legacy-over.js','SOURCE',65537)]
  }),error=>packageCode(error)==='CAPACITY_EXCEEDED');
  assert.throws(()=>planLargeProjectStaging({
    stage_operation_id:'missing-profile',caller_label:'synthetic',files:[]
  }));
  assert.throws(()=>planLargeProjectStaging({
    stage_operation_id:'changed-profile',caller_label:'synthetic',
    output_profile:{...PROFILE,max_stdout_bytes:PROFILE.max_stdout_bytes+1},
    files:[]
  }));
});

test('large stage, verify, export, build and verify preserve tagged owned bytes',async()=>{
  await largeOwnedFixture(async fixture=>{
    const sourceBytes=encoder.encode('PUBLIC SYNTHETIC LARGE SOURCE\n'.repeat(3000));
    const plan=largeStage([
      {path:'src/main.js',classification:'SOURCE',content:sourceBytes},
      stageFile('assets/tiny.bin','LOCAL_ASSET',3,0xa5),
      stageFile('docs/readme.md','DOC',0)
    ],'large-owned-stage');
    const ack=await writeLargeProjectStage(plan,'/owned/stage',fixture.ports);
    assert.equal(ack.completion_status,'COMPLETE');
    assert.equal(ack.operation_acknowledgement,'ACKNOWLEDGED');
    assert.deepEqual(ack.output_profile,PROFILE);
    assert.equal(ack.manifest_sha256,hash(plan.manifest_bytes));
    assert.equal(JSON.stringify(ack).includes('/owned'),false);
    const stageDir=fixture.map('/owned/stage');
    assert.equal((await fs.stat(join(stageDir,'src/main.js'))).mode&0o777,0o400);
    assert.equal((await fs.stat(join(stageDir,'src/main.js'))).nlink,1);
    assert.deepEqual(
      new Uint8Array(await fs.readFile(join(stageDir,'src/main.js'))),
      sourceBytes
    );
    const verified=await verifyLargeProjectStage('/owned/stage',fixture.ports);
    assert.equal(verified.status,'VERIFIED');
    assert.equal(verified.original_operation_acknowledgement,'UNKNOWN');
    assert.deepEqual(verified.output_profile,PROFILE);

    const exportPlan=planLargeProjectExport({
      export_operation_id:'large-owned-export',caller_label:'synthetic',
      output_profile:PROFILE,
      stage_binding:{
        stage_operation_id:plan.stage_operation_id,
        stage_manifest_sha256:plan.manifest_sha256
      },
      staged_files:plan.manifest.files,
      evidence_files:[stageFile('run.log','EVIDENCE_LOG',4,0x31)]
    });
    assert.equal(exportPlan.schema,'SQUIRE4_LARGE_PROJECT_EXPORT_PLAN_V1');
    assert.equal(exportPlan.manifest.schema_version,
      'squire4.large_project_export_manifest.v1');
    assert.deepEqual(exportPlan.manifest.output_profile,PROFILE);
    const exportAck=await writeLargeProjectExport(
      exportPlan,'/owned/stage','/owned/export',fixture.ports
    );
    assert.equal(exportAck.operation_acknowledgement,'ACKNOWLEDGED');
    assert.equal(exportAck.stage_binding.stage_manifest_sha256,
      plan.manifest_sha256);
    const exportDir=fixture.map('/owned/export');
    assert.deepEqual(new Uint8Array(await fs.readFile(
      join(exportDir,'project/src/main.js')
    )),sourceBytes);
    assert.deepEqual(new Uint8Array(await fs.readFile(
      join(exportDir,'evidence/run.log')
    )),new Uint8Array(4).fill(0x31));
    for(const path of [
      'project/src/main.js','project/assets/tiny.bin',
      'project/docs/readme.md','evidence/run.log','export-manifest.json'
    ]){
      const stat=await fs.stat(join(exportDir,path));
      assert.equal(stat.mode&0o777,0o400);
      assert.equal(stat.nlink,1);
    }
    assert.equal((await verifyLargeProjectExport(
      '/owned/export',fixture.ports
    )).status,'VERIFIED');

    const buildAck=await buildLargeProjectExport({
      export_operation_id:'large-built-export',caller_label:'synthetic',
      output_profile:PROFILE,stage_dir:'/owned/stage',
      export_dir:'/owned/built-export',
      stage_manifest_sha256:plan.manifest_sha256,
      evidence_files:[stageFile('build.log','EVIDENCE_LOG',2,0x32)]
    },fixture.ports);
    assert.equal(buildAck.completion_status,'COMPLETE');
    assert.equal((await verifyLargeProjectExport(
      '/owned/built-export',fixture.ports
    )).status,'VERIFIED');
    assert.equal(buildAck.provenance_authenticity,'NOT_ESTABLISHED');
    assert.equal(buildAck.crash_durability,'NOT_ESTABLISHED');
  });
});

test('large stage and export families reject legacy and cross-family bindings',async()=>{
  await largeOwnedFixture(async fixture=>{
    const oldPlan=planStaging({
      stage_operation_id:'old-stage',caller_label:'synthetic',
      files:[stageFile('src/old.js','SOURCE',1)]
    });
    const largePlan=largeStage([
      stageFile('src/new.js','SOURCE',1)
    ],'new-stage');
    await writeStage(oldPlan,'/owned/old-stage',fixture.ports);
    await writeLargeProjectStage(
      largePlan,'/owned/new-stage',fixture.ports
    );
    assert.equal((await verifyLargeProjectStage(
      '/owned/old-stage',fixture.ports
    )).status,'CORRUPT_OR_INCOMPLETE');
    assert.equal((await verifyStage(
      '/owned/new-stage',fixture.ports
    )).status,'CORRUPT_OR_INCOMPLETE');

    const oldExport=planExport({
      export_operation_id:'old-export',caller_label:'synthetic',
      stage_binding:{
        stage_operation_id:oldPlan.stage_operation_id,
        stage_manifest_sha256:oldPlan.manifest_sha256
      },
      staged_files:oldPlan.manifest.files
    });
    await writeExport(
      oldExport,'/owned/old-stage','/owned/old-export',fixture.ports
    );
    assert.equal((await verifyLargeProjectExport(
      '/owned/old-export',fixture.ports
    )).status,'CORRUPT_OR_INCOMPLETE');

    const largeExport=planLargeProjectExport({
      export_operation_id:'new-export',caller_label:'synthetic',
      output_profile:PROFILE,
      stage_binding:{
        stage_operation_id:largePlan.stage_operation_id,
        stage_manifest_sha256:largePlan.manifest_sha256
      },
      staged_files:largePlan.manifest.files
    });
    await writeLargeProjectExport(
      largeExport,'/owned/new-stage','/owned/new-export',fixture.ports
    );
    assert.equal((await verifyExport(
      '/owned/new-export',fixture.ports
    )).status,'CORRUPT_OR_INCOMPLETE');

    const wrongBinding=planLargeProjectExport({
      export_operation_id:'wrong-binding',caller_label:'synthetic',
      output_profile:PROFILE,
      stage_binding:{
        stage_operation_id:'foreign-stage',
        stage_manifest_sha256:largePlan.manifest_sha256
      },
      staged_files:largePlan.manifest.files
    });
    await assert.rejects(()=>writeLargeProjectExport(
      wrongBinding,'/owned/new-stage','/owned/wrong-export',fixture.ports
    ),error=>packageCode(error)==='STAGE_BINDING_MISMATCH');
    assert.equal((await verifyLargeProjectStage(
      '/owned/wrong-export',fixture.ports
    )).status,'CORRUPT_OR_INCOMPLETE');
  });
});

test('large write boundaries reject profile and manifest tampering before ACK',async()=>{
  await largeOwnedFixture(async fixture=>{
    const plan=largeStage([stageFile('src/file.js','SOURCE',1)]);
    const wrongProfile={...plan,output_profile:{
      ...PROFILE,max_source_file_bytes:PROFILE.max_source_file_bytes+1
    }};
    await assert.rejects(()=>writeLargeProjectStage(
      wrongProfile,'/owned/profile-rejected',fixture.ports
    ));
    await assert.rejects(()=>fs.stat(fixture.map('/owned/profile-rejected')),
      {code:'ENOENT'});

    const existing=fixture.map('/owned/existing');
    await fs.mkdir(existing,{mode:0o700});
    await fs.writeFile(join(existing,'sentinel'),'PUBLIC SENTINEL');
    await assert.rejects(()=>writeLargeProjectStage(
      plan,'/owned/existing',fixture.ports
    ),error=>packageCode(error)==='DESTINATION_ALREADY_EXISTS');
    assert.equal(await fs.readFile(join(existing,'sentinel'),'utf8'),
      'PUBLIC SENTINEL');

    await writeLargeProjectStage(plan,'/owned/tamper',fixture.ports);
    const manifestPath=join(fixture.map('/owned/tamper'),'stage-manifest.json');
    await fs.chmod(manifestPath,0o600);
    const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
    manifest.output_profile.max_stdout_bytes++;
    await fs.writeFile(manifestPath,JSON.stringify(manifest));
    await fs.chmod(manifestPath,0o400);
    assert.equal((await verifyLargeProjectStage(
      '/owned/tamper',fixture.ports
    )).status,'CORRUPT_OR_INCOMPLETE');
  });
});

test('large export manifests reject extra entry fields and incorrect subpaths',async()=>{
  await largeOwnedFixture(async fixture=>{
    const stage=largeStage([stageFile('src/main.js','SOURCE',1)]);
    await writeLargeProjectStage(stage,'/owned/stage',fixture.ports);
    const plan=planLargeProjectExport({
      export_operation_id:'manifest-check',caller_label:'synthetic',
      output_profile:PROFILE,
      stage_binding:{
        stage_operation_id:stage.stage_operation_id,
        stage_manifest_sha256:stage.manifest_sha256
      },
      staged_files:stage.manifest.files
    });
    const cases=[
      ['extra-entry-field',manifest=>{manifest.files[0].unexpected='value';}],
      ['wrong-export-subpath',manifest=>{
        manifest.files[0].export_subpath='project/src/renamed.js';
      }]
    ];
    for(const [name,mutate] of cases){
      const output=`/owned/${name}`;
      await writeLargeProjectExport(plan,'/owned/stage',output,fixture.ports);
      const manifestPath=join(fixture.map(output),'export-manifest.json');
      await fs.chmod(manifestPath,0o600);
      const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
      mutate(manifest);
      await fs.writeFile(manifestPath,JSON.stringify(manifest));
      await fs.chmod(manifestPath,0o400);
      assert.equal((await verifyLargeProjectExport(
        output,fixture.ports
      )).status,'CORRUPT_OR_INCOMPLETE',name);
    }
  });
});

test('large stage cancellation and IO failures retain partial state without ACK',async()=>{
  await largeOwnedFixture(async fixture=>{
    const plan=largeStage([stageFile('src/file.js','SOURCE',1)]);
    const alreadyAborted=new AbortController();
    alreadyAborted.abort();
    await assert.rejects(()=>writeLargeProjectStage(
      plan,'/owned/not-created',{
        ...fixture.ports,signal:alreadyAborted.signal
      }
    ),error=>packageCode(error)==='PACKAGE_ABORTED');
    await assert.rejects(()=>fs.stat(fixture.map('/owned/not-created')),
      {code:'ENOENT'});

    const controller=new AbortController();
    const abortingFs={
      ...fixture.ports.fs,
      async mkdir(path,...args){
        const result=await fixture.ports.fs.mkdir(path,...args);
        if(path==='/owned/aborted-after-mkdir')controller.abort();
        return result;
      }
    };
    await assert.rejects(()=>writeLargeProjectStage(
      plan,'/owned/aborted-after-mkdir',{
        ...fixture.ports,fs:abortingFs,signal:controller.signal
      }
    ),error=>packageCode(error)==='PACKAGE_ABORTED');
    assert.equal((await fs.stat(
      fixture.map('/owned/aborted-after-mkdir')
    )).isDirectory(),true);

    let failOpen=true;
    const failingFs={
      ...fixture.ports.fs,
      async open(path,...args){
        if(failOpen&&path.endsWith('/src/file.js')){
          failOpen=false;
          throw Error('PRIVATE_SYNTHETIC_IO_FAILURE');
        }
        return fixture.ports.fs.open(path,...args);
      }
    };
    await assert.rejects(()=>writeLargeProjectStage(
      plan,'/owned/io-failure',{...fixture.ports,fs:failingFs}
    ),error=>packageCode(error)==='PACKAGE_IO_ERROR');
    assert.equal((await fs.stat(fixture.map('/owned/io-failure'))).isDirectory(),
      true);
    assert.equal(JSON.stringify(
      await verifyLargeProjectStage('/owned/io-failure',fixture.ports)
    ).includes('PRIVATE_SYNTHETIC_IO_FAILURE'),false);

    await writeLargeProjectStage(plan,'/owned/changed-leaf',fixture.ports);
    const leaf=join(fixture.map('/owned/changed-leaf'),'src/file.js');
    await fs.chmod(leaf,0o600);
    await fs.writeFile(leaf,'changed');
    await fs.chmod(leaf,0o400);
    assert.equal((await verifyLargeProjectStage(
      '/owned/changed-leaf',fixture.ports
    )).status,'CORRUPT_OR_INCOMPLETE');
    const readErrorFs={
      ...fixture.ports.fs,
      async open(path,...args){
        if(path.endsWith('/src/file.js'))throw Error('PRIVATE_READ_FAILURE');
        return fixture.ports.fs.open(path,...args);
      }
    };
    assert.equal((await verifyLargeProjectStage(
      '/owned/changed-leaf',{...fixture.ports,fs:readErrorFs}
    )).status,'CORRUPT_OR_INCOMPLETE');
  });
});

let largeJobNumber=1;
const largeModel='synthetic-large-model',largeEffort='synthetic-large-effort';
const largeAuthorization={
  operator_receipt:'/synthetic/operator-receipt',
  supported_tuples:[{model:largeModel,effort:largeEffort}]
};
const largeDesktopIdentity={
  status:'NOT_QUALIFIED',
  executable:{path:'/synthetic/desktop-gjs',bytes:1,sha256:'a'.repeat(64)},
  typelibs:[{
    namespace:'Gtk',version:'4.0',typelib:'/synthetic/Gtk.typelib',
    bytes:1,sha256:'b'.repeat(64)
  }],
  libraries:[{
    name:'gtk',path:'/synthetic/libgtk.so',bytes:1,sha256:'c'.repeat(64)
  }]
};
function largeRunnerSpec(root,scope=root){
  return {
    job_id:`10000000-0000-4000-8000-${String(largeJobNumber++).padStart(12,'0')}`,
    task_scope:scope,requested_model:largeModel,effort:largeEffort,
    max_wall_clock_sec:null,
    prompt_bytes:encoder.encode(DESKTOP_CODEGEN_PREFIX+'Public synthetic request.'),
    runtime_target:DESKTOP_TARGET,prefix_identity:DESKTOP_PREFIX_IDENTITY,
    desktop_runtime_identity:largeDesktopIdentity,
    execution_profile:PROJECT_CODING_OBSERVATION_PROFILE,
    output_profile:PROFILE
  };
}
function largeRunnerPorts(runtime,extra={}){
  return {
    mode:'DESKTOP_CODEGEN_ONLY',
    operation_intent:'CODEGEN_ONLY_NO_DESKTOP_EXECUTION',
    fs:extra.fs,uid:process.getuid(),spawn:runtime.spawn,
    executable:'/synthetic/codex',environment:{PUBLIC:'synthetic'},
    codex:{
      observed_cli_version:'0.160.0',
      authorization:largeAuthorization,
      permissions:{
        sandbox:'read-only',approval_mode:'never',
        output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'
      }
    },
    ...extra
  };
}
function largeFakeRuntime(response,{mode='immediate',stderrBytes=0,stdoutBytes=null,exitCode=0}={}){
  let time=0;
  const timers=[],calls=[],kills=[],controller=new AbortController();
  const child=new EventEmitter();
  child.pid=321;child.unref=()=>{};child.kill=signal=>{kills.push(signal);return true;};
  for(const key of ['stdout','stderr','stdin']){
    child[key]=new EventEmitter();child[key].destroy=()=>{};
  }
  const output=stdoutBytes??jsonl(
    {type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:response}},
    {type:'turn.completed',usage:{
      input_tokens:11,output_tokens:22,cached_input_tokens:3,
      reasoning_output_tokens:4
    }}
  );
  const finish=()=>{
    child.stdout.emit('data',output);
    child.stdout.emit('end');
    if(stderrBytes)child.stderr.emit(
      'data',new Uint8Array(stderrBytes).fill(0x53)
    );
    child.stderr.emit('end');
    child.emit('exit',exitCode,null);
  };
  child.stdin.write=(_bytes,callback)=>{callback();return true;};
  child.stdin.end=callback=>{
    callback();
    if(mode!=='pending')queueMicrotask(finish);
  };
  const clock={
    now:()=>time,
    schedule(delay,fn){
      const timer={delay,at:time+delay,fn,active:true};
      timers.push(timer);
      return ()=>{timer.active=false;};
    }
  };
  return {
    clock,controller,timers,calls,kills,child,finish,output,
    spawn(...args){
      calls.push(args);
      queueMicrotask(()=>child.emit('spawn'));
      return child;
    },
    advance(value){
      time=value;
      for(const timer of [...timers].sort((a,b)=>a.at-b.at)){
        if(timer.active&&timer.at<=time){timer.active=false;timer.fn();}
      }
    }
  };
}
async function largeRunnerFixture(fn){
  const root=await fs.mkdtemp('/tmp/squire-large-project-runner-');
  await fs.chmod(root,0o700);
  try{await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}
}
function largeResultEnvelope(sourceSize=100000){
  const files=Array.from({length:3},(_,index)=>({
    path:`src/large-${index}.js`,classification:'SOURCE',
    encoding:'utf-8',content:String(index).repeat(sourceSize)
  }));
  return new TextDecoder().decode(envelope(files));
}

test('large observation admission is explicit, closed and fixed-profiled before spawn',async()=>{
  await largeRunnerFixture(async root=>{
    const runtime=largeFakeRuntime('{}'),spec=largeRunnerSpec(root);
    const admitted=admitDesktopCodingLargeObservationProjectTask(spec);
    assert.equal(admitted.output_profile,PROFILE);
    assert.equal(admitted.execution_profile,PROJECT_CODING_OBSERVATION_PROFILE);
    assert.throws(()=>admitDesktopCodegenProjectTask(spec));
    assert.throws(()=>validateLargeProjectJobRecord({}));
    for(const invalid of [
      Object.fromEntries(Object.entries(spec).filter(([key])=>key!=='output_profile')),
      {...spec,output_profile:{...PROFILE,max_stdout_bytes:PROFILE.max_stdout_bytes+1}},
      {...spec,execution_profile:{...PROJECT_CODING_OBSERVATION_PROFILE,outer_observation_ms:1}},
      {...spec,runtime_target:'node24-esm'},
      {...spec,max_wall_clock_sec:120},
      {...spec,unexpected:'extra'}
    ]){
      assert.throws(()=>admitDesktopCodingLargeObservationProjectTask(invalid));
    }
    Object.defineProperty(spec,'job_id',{
      value:spec.job_id,enumerable:false,writable:true,configurable:true
    });
    Object.defineProperty(spec,'task_scope',{
      value:spec.task_scope,enumerable:false,writable:true,configurable:true
    });
    const nonenumerableAdmission=admitDesktopCodingLargeObservationProjectTask(spec);
    assert.equal(nonenumerableAdmission.job_id,spec.job_id);
    assert.equal(nonenumerableAdmission.task_scope,root);
    assert.equal(admitDesktopCodingLargeObservationProjectTask(
      nonenumerableAdmission
    ).job_id,spec.job_id);

    const record={
      job_id:spec.job_id,task_class:PROJECT_LARGE_OBSERVATION_TASK_CLASS,
      output_profile:PROFILE,lifecycle_status:'LIMITED_SUCCESS',
      requested_model:largeModel,reported_model:'UNKNOWN',
      process_exit:{
        pid:321,exit_code:0,exit_signal:null,process_wall_ms:12,
        observed_termination:true
      },
      io_state:{
        stdout_bytes_observed:1200000,stderr_bytes_observed:70000,
        stdout_eof:true,stderr_eof:true,io_drained:true
      },
      containment_evidence:{
        containment_level:'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING',
        settlement_status:'SETTLED_DIRECT_CHILD_EXIT',descendant_guarantee:'NONE'
      },
      provider_metadata:{
        codex_reasoning_output_tokens:4,provider_reported_status:'turn.completed',
        duration_seconds:null,
        usage_tokens:{
          input:11,output:22,cache_read:3,thinking:'UNKNOWN',total:'UNKNOWN'
        }
      },
      output_custody:{
        persisted:true,path:'/synthetic/candidate-envelope.json',
        byte_count:1100000,persistence_error:null
      },
      task_outcome_evaluated:false,task_payload_valid:true,
      error_details:{code:null,classification:null,message:null}
    };
    for(const [object,key] of [
      [record,'job_id'],[record.process_exit,'pid'],
      [record.io_state,'stdout_bytes_observed'],
      [record.provider_metadata.usage_tokens,'cache_read']
    ]){
      Object.defineProperty(object,key,{
        value:object[key],enumerable:false,writable:true,configurable:true
      });
    }
    const capturedRecord=validateLargeProjectJobRecord(record);
    assert.equal(capturedRecord.job_id,spec.job_id);
    assert.equal(capturedRecord.process_exit.pid,321);
    assert.equal(capturedRecord.io_state.stdout_bytes_observed,1200000);
    assert.equal(capturedRecord.provider_metadata.usage_tokens.cache_read,3);
    assert.equal(validateLargeProjectJobRecord(capturedRecord).job_id,spec.job_id);

    const ports=largeRunnerPorts(runtime,{fs});
    await assert.rejects(()=>runProjectCodexTask(spec,{
      clock:runtime.clock,shutdown:GENERATION_SHUTDOWN,
      abortSignal:runtime.controller.signal
    },ports));
    assert.equal(runtime.calls.length,0);
  });
});

test('large foreground path accepts large envelope/source/stderr and records actual bounded counts',async()=>{
  await largeRunnerFixture(async root=>{
    const response=largeResultEnvelope(400000);
    const runtime=largeFakeRuntime(response,{stderrBytes:70000});
    const result=await runDesktopCodingLargeObservationProjectTask(
      largeRunnerSpec(root),
      {clock:runtime.clock,shutdown:GENERATION_SHUTDOWN,
       abortSignal:runtime.controller.signal},
      largeRunnerPorts(runtime,{fs})
    );
    assert.equal(result.schema,PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA);
    assert.equal(result.status,'CANDIDATE_STAGED');
    assert.equal(result.output_profile,PROFILE);
    assert.equal(result.execution_profile,PROJECT_CODING_OBSERVATION_PROFILE);
    assert.equal(runtime.calls.length,1);
    assert.ok(result.generation.record.io_state.stdout_bytes_observed>1048576);
    assert.equal(result.generation.record.io_state.stderr_bytes_observed,70000);
    assert.ok(result.generation.record.output_custody.byte_count>1048576);
    assert.equal(result.generation.record.output_profile,PROFILE);
    assert.equal(result.generation.record.task_class,PROJECT_LARGE_OBSERVATION_TASK_CLASS);
    assert.equal(result.generation.record.provider_metadata.usage_tokens.cache_read,3);
    assert.equal(result.generation.record.provider_metadata.codex_reasoning_output_tokens,4);
    assert.throws(()=>validateLimitedJobRecord(result.generation.record));
    assert.equal(validateLargeProjectJobRecord(result.generation.record).output_profile,PROFILE);
    assert.equal(result.generation.record.task_outcome_evaluated,false);
    assert.equal(result.task_correctness,'NOT_EVALUATED');
    assert.equal(JSON.stringify(result).includes('PUBLIC SYNTHETIC LARGE SOURCE'),false);
    const stagePath=join(root,'output','run-'+result.generation.record.job_id,'stage');
    assert.equal((await verifyLargeProjectStage(stagePath,{fs,uid:process.getuid()})).status,'VERIFIED');
    assert.equal((await verifyStage(stagePath,{fs,uid:process.getuid()})).status,'CORRUPT_OR_INCOMPLETE');
  });
});

test('large observation has no elapsed generation cutoff and starts its fixed closeout afterward',async()=>{
  await largeRunnerFixture(async root=>{
    const runtime=largeFakeRuntime(largeResultEnvelope(70000),{mode:'pending'});
    const pending=runDesktopCodingLargeObservationProjectTask(
      largeRunnerSpec(root),
      {clock:runtime.clock,shutdown:GENERATION_SHUTDOWN,
       abortSignal:runtime.controller.signal},
      largeRunnerPorts(runtime,{fs})
    );
    for(let i=0;i<100&&!runtime.calls.length;i++){
      await new Promise(resolve=>setImmediate(resolve));
    }
    assert.equal(runtime.calls.length,1);
    runtime.advance(125000);
    runtime.finish();
    const result=await pending;
    assert.equal(result.status,'CANDIDATE_STAGED');
    assert.equal(result.generation.record.process_exit.process_wall_ms,125000);
    assert.equal(result.post_generation_closeout.limit_ms,20000);
    assert.equal(runtime.timers.some(timer=>timer.delay===120000||timer.delay===140000),false);
  });
});

test('large runner reports stdout and stderr overflow with saturating observed counts',async()=>{
  await largeRunnerFixture(async root=>{
    const cases=[
      {name:'stdout',runtime:largeFakeRuntime(null,{
        stdoutBytes:new Uint8Array(PROFILE.max_stdout_bytes+1)
      }),stdout:PROFILE.max_stdout_bytes+1,stderr:0},
      {name:'stderr',runtime:largeFakeRuntime('{}',{
        stderrBytes:PROFILE.max_stderr_bytes+1
      }),stdout:null,stderr:PROFILE.max_stderr_bytes+1}
    ];
    for(const item of cases){
      const scope=join(root,item.name);
      await fs.mkdir(scope,{mode:0o700});
      const result=await runDesktopCodingLargeObservationProjectTask(
        largeRunnerSpec(root,scope),
        {clock:item.runtime.clock,shutdown:GENERATION_SHUTDOWN,
         abortSignal:item.runtime.controller.signal},
        largeRunnerPorts(item.runtime,{fs})
      );
      assert.equal(result.status,'GENERATION_REJECTED',item.name);
      assert.equal(result.generation.record.lifecycle_status,'LIMITED_CAPACITY_EXCEEDED');
      assert.equal(result.generation.record.io_state.stdout_bytes_observed,
        item.stdout??item.runtime.output.length);
      assert.equal(result.generation.record.io_state.stderr_bytes_observed,item.stderr);
      assert.equal(item.runtime.calls.length,1);
      assert.equal(result.staging,null);
    }
  });
});

test('large envelope above its fixed payload ceiling cannot persist or stage',async()=>{
  await largeRunnerFixture(async root=>{
    const runtime=largeFakeRuntime(' '.repeat(PROFILE.max_envelope_bytes+1));
    const result=await runDesktopCodingLargeObservationProjectTask(
      largeRunnerSpec(root),
      {clock:runtime.clock,shutdown:GENERATION_SHUTDOWN,
       abortSignal:runtime.controller.signal},
      largeRunnerPorts(runtime,{fs})
    );
    assert.equal(result.status,'GENERATION_REJECTED');
    assert.equal(result.generation.record.lifecycle_status,'LIMITED_PARSER_ERROR');
    assert.equal(result.generation.record.output_custody.persisted,false);
    assert.equal(result.staging,null);
    assert.equal(result.generation.record.error_details.code,
      'PAYLOAD:PROJECT_PAYLOAD_TOO_LARGE');
  });
});

test('large generation user abort signals the child and records observed EOF and exit',async()=>{
  await largeRunnerFixture(async root=>{
    const runtime=largeFakeRuntime(largeResultEnvelope(70000),{mode:'pending'});
    const spawned=new Promise(resolve=>{
      runtime.child.once('spawn',resolve);
    });
    const pending=runDesktopCodingLargeObservationProjectTask(
      largeRunnerSpec(root),
      {clock:runtime.clock,shutdown:GENERATION_SHUTDOWN,
       abortSignal:runtime.controller.signal},
      largeRunnerPorts(runtime,{fs})
    );
    let spawnGuard;
    const guardedSpawn=new Promise(resolve=>{
      spawnGuard=setTimeout(()=>resolve(false),55000);
    });
    const boundary=await Promise.race([
      spawned.then(()=>true),
      pending.then(()=>false,()=>false),
      guardedSpawn
    ]);
    clearTimeout(spawnGuard);
    assert.equal(boundary,true,'fake child did not spawn within the bounded guard');
    assert.equal(runtime.calls.length,1);
    runtime.controller.abort();
    assert.ok(runtime.kills.includes('SIGTERM'));
    runtime.finish();
    const result=await pending;
    assert.equal(result.status,'INCOMPLETE');
    assert.equal(result.reason,'CANCELED');
    assert.equal(result.generation.record.lifecycle_status,'LIMITED_USER_ABORT');
    assert.equal(result.generation.record.process_exit.observed_termination,true);
    assert.equal(result.generation.record.io_state.stdout_eof,true);
    assert.equal(result.generation.record.io_state.stderr_eof,true);
    assert.equal(result.staging,null);
    assert.equal(runtime.calls.length,1);
  });
});

test('large post-generation closeout deadline rejects a held stage without ACK',async()=>{
  await largeRunnerFixture(async root=>{
    const runtime=largeFakeRuntime(largeResultEnvelope(70000));
    const spec=largeRunnerSpec(root);
    const stagePath=join(root,'output',`run-${spec.job_id}`,'stage');
    let releaseStage;
    let enteredStage;
    const stageGate=new Promise(resolve=>{releaseStage=resolve;});
    const stageEntered=new Promise(resolve=>{enteredStage=resolve;});
    let stageEnteredFlag=false;
    let settleStage;
    const stageSettled=new Promise(resolve=>{settleStage=resolve;});
    const heldFs={
      ...fs,
      async mkdir(path,...args){
        if(path===stagePath){
          stageEnteredFlag=true;
          enteredStage();
          try{
            await stageGate;
            return await fs.mkdir(path,...args);
          }finally{settleStage();}
        }
        return fs.mkdir(path,...args);
      }
    };
    const pending=runDesktopCodingLargeObservationProjectTask(
      spec,
      {clock:runtime.clock,shutdown:GENERATION_SHUTDOWN,
       abortSignal:runtime.controller.signal},
      largeRunnerPorts(runtime,{fs:heldFs})
    );
    for(let i=0;i<100&&!stageEnteredFlag;i++){
      await new Promise(resolve=>setImmediate(resolve));
    }
    await stageEntered;
    runtime.advance(20000);
    const result=await pending;
    assert.equal(result.status,'INCOMPLETE');
    assert.equal(result.reason,'POST_GENERATION_CLOSEOUT_DEADLINE');
    assert.deepEqual(result.post_generation_closeout,{
      status:'DEADLINE_EXCEEDED',limit_ms:20000
    });
    assert.equal(result.generation.record.lifecycle_status,'LIMITED_SUCCESS');
    assert.equal(result.staging,null);
    assert.equal(runtime.calls.length,1);
    releaseStage();
    await stageSettled;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(result.staging,null);
  });
});

const largeRequest={
  schema:'SQUIRE2_PROJECT_REQUEST_V1',task_id:'large-preparation-synthetic',
  task_prompt:'Public synthetic desktop project request.',
  runtime_target:DESKTOP_TARGET,stage_target:'multifile-candidate'
};
async function largePreparedFixture(root){
  const files=new Map(),writes=[],verified=[];
  for(const name of DESKTOP_CODEGEN_SOURCE_FILES){
    const path=join(PROJECT_SOURCE_ROOT,name);
    files.set(path,encoder.encode(`PUBLIC SYNTHETIC PIN ${name}`));
  }
  const job=largeRunnerSpec(root).job_id,scope=join(root,`scope-${job}`);
  const preparationRoot=join(root,`prepared-${job}`);
  const inputs={
    job_id:job,scope,
    codex:{path:'/synthetic/codex',version:'0.160.0',bytes:1,sha256:'d'.repeat(64)},
    requested_model:largeModel,effort:largeEffort,
    authorization:largeAuthorization,
    permissions:{
      sandbox:'read-only',approval_mode:'on-request',
      output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'
    },
    desktop_runtime_identity:largeDesktopIdentity
  };
  const ports={
    fs:{
      async readFile(path){
        if(!files.has(path))throw Error('SYNTHETIC_SOURCE_MISSING');
        return new Uint8Array(files.get(path));
      },
      async mkdir(path,options){writes.push(['mkdir',path,options.mode]);},
      async writeFile(path,bytes,options){
        assert.equal(options.flag,'wx');assert.equal(options.mode,0o600);
        assert.equal(files.has(path),false);
        writes.push(['write',path,options.mode]);
        files.set(path,new Uint8Array(bytes));
      }
    },
    async verifyFile(identity){verified.push(identity.path);},
    retention:()=>({prepare:async()=>({capability_status:'READY'})})
  };
  const prepared=await prepareDesktopCodingLargeObservationTask(
    preparationRoot,'e'.repeat(40),largeRequest,inputs,ports
  );
  const configBytes=files.get(join(preparationRoot,'config.json'));
  const manifestBytes=files.get(join(preparationRoot,'operation-manifest.json'));
  const promptBytes=files.get(join(preparationRoot,'prompt.utf8'));
  return {
    files,writes,verified,inputs,scope,preparationRoot,prepared,
    configBytes,config:JSON.parse(new TextDecoder().decode(configBytes)),
    manifest:JSON.parse(new TextDecoder().decode(manifestBytes)),promptBytes
  };
}
function largePreparedAdmission(fixture,bytes=fixture.configBytes){
  return {
    provider_id:'native_codex',
    operator_receipt:fixture.config.authorization.operator_receipt,
    config_sha256:hash(bytes),job_id:fixture.config.job_id,scope:fixture.config.scope,
    desktop_codegen_admitted:true,
    preflight:{evidence_receipt:'/synthetic/large-preflight.json'}
  };
}
function largePreparedPorts(fixture,runtime,proofOverrides={},now=1000){
  const c=fixture.config;
  const proof={
    operation_config_sha256:hash(fixture.configBytes),observed_at_ms:900,
    provider_id:'native_codex',cli_version:c.codex.version,
    executable_sha256:c.codex.sha256,requested_model:c.requested_model,
    effort:c.effort,operator_receipt:c.authorization.operator_receipt,
    subscription:true,allowance_available:true,
    effective_provider:'openai_subscription',no_api_or_paid_fallback:true,
    sandbox:c.permissions.sandbox,approval_mode:c.permissions.approval_mode,
    output_contract:c.permissions.output_contract,installed_flags_verified:true,
    ...proofOverrides
  };
  const proofBytes=encoder.encode(JSON.stringify(proof));
  return {
    fs,uid:process.getuid(),spawn:runtime.spawn,
    readBytes:async path=>{
      if(path==='/synthetic/large-preflight.json')return proofBytes;
      if(path===c.prompt.path)return new Uint8Array(fixture.promptBytes);
      throw Error('SYNTHETIC_READ_REJECTED');
    },
    verifyFile:async()=>{},
    reads:{lstat:fs.lstat,readChunks:async function*(){yield new Uint8Array();}},
    now:()=>now,clock:runtime.clock,
    retention:()=>({
      prepare:async()=>({capability_status:'READY'}),
      retainRejected:async()=>({status:'NOT_RETAINED'})
    }),
    environment:{PUBLIC:'synthetic'}
  };
}

test('large preparation binds its typed config, prompt, source closure and finite manifest limits',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await largePreparedFixture(root);
    const c=validateDesktopCodingLargeObservationConfig(fixture.config);
    assert.equal(c.schema,PROJECT_LARGE_OBSERVATION_CONFIG_SCHEMA);
    assert.equal(c.runtime_admitted,false);
    assert.equal(c.generation_wall_ms,null);
    assert.equal(c.outer_observation_ms,null);
    assert.deepEqual(c.execution_profile,PROJECT_CODING_OBSERVATION_PROFILE);
    assert.deepEqual(c.output_profile,PROFILE);
    assert.equal(fixture.manifest.schema,PROJECT_LARGE_OBSERVATION_MANIFEST_SCHEMA);
    assert.equal(fixture.manifest.config_schema,PROJECT_LARGE_OBSERVATION_CONFIG_SCHEMA);
    assert.deepEqual(fixture.manifest.execution_profile,PROJECT_CODING_OBSERVATION_PROFILE);
    assert.deepEqual(fixture.manifest.output_profile,PROFILE);
    assert.equal(fixture.manifest.generation.wall_ms,null);
    assert.equal(fixture.manifest.limits.outer_observation_ms,null);
    assert.deepEqual(fixture.manifest.output_limits,{
      max_stdout_bytes:PROFILE.max_stdout_bytes,
      max_stderr_bytes:PROFILE.max_stderr_bytes,
      max_envelope_bytes:PROFILE.max_envelope_bytes,
      max_source_file_bytes:PROFILE.max_source_file_bytes,
      max_source_total_bytes:PROFILE.max_source_total_bytes,
      max_decoded_project_bytes:PROFILE.max_decoded_project_bytes,
      max_source_files:PROFILE.max_source_files,
      max_all_files:PROFILE.max_all_files
    });
    assert.equal(fixture.prepared.runtime_admitted,false);
    assert.equal(fixture.prepared.schema,PROJECT_LARGE_OBSERVATION_CONFIG_SCHEMA);
    assert.equal(fixture.writes.length,4);
    assert.deepEqual(fixture.writes.map(item=>item[2]),[0o700,0o600,0o600,0o600]);
    assert.equal(fixture.verified.length,DESKTOP_CODEGEN_SOURCE_FILES.length+2);
    for(const name of DESKTOP_CODEGEN_SOURCE_FILES){
      assert.ok(Object.hasOwn(c.source_pins,join(PROJECT_SOURCE_ROOT,name)));
    }
    assert.throws(()=>validateDesktopCodegenConfig(c));
    assert.throws(()=>validateProjectCodexConfig(c));
    for(const change of [
      {output_profile:{...PROFILE,max_stdout_bytes:PROFILE.max_stdout_bytes+1}},
      {execution_profile:{...PROJECT_CODING_OBSERVATION_PROFILE,outer_observation_ms:1}},
      {runtime_target:'node24-esm'},
      {permissions:{...c.permissions,approval_mode:'never'}},
      {schema:'SQUIRE2_DESKTOP_CODING_OBSERVATION_OPERATION_V1'},
      {unexpected:'extra'}
    ])assert.throws(()=>validateDesktopCodingLargeObservationConfig({...c,...change}));
  });
});

test('large config and admission snapshots preserve validated non-enumerable data',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await largePreparedFixture(root);
    const config={...fixture.config};
    for(const key of ['job_id','scope']){
      const value=config[key];delete config[key];
      Object.defineProperty(config,key,{value,enumerable:false});
    }
    const captured=validateDesktopCodingLargeObservationConfig(config);
    assert.equal(captured.job_id,fixture.config.job_id);
    assert.equal(captured.scope,fixture.config.scope);
    assert.equal(captured.output_profile,PROFILE);
    const bundle=largePreparedAdmission(fixture);
    for(const key of ['job_id','scope','desktop_codegen_admitted']){
      const value=bundle[key];delete bundle[key];
      Object.defineProperty(bundle,key,{value,enumerable:false});
    }
    const preflight=bundle.preflight;
    const evidence=preflight.evidence_receipt;delete preflight.evidence_receipt;
    Object.defineProperty(preflight,'evidence_receipt',{value:evidence,enumerable:false});
    const validated=validateDesktopCodingLargeObservationAdmission(bundle,fixture.configBytes);
    assert.equal(validated.job_id,fixture.config.job_id);
    assert.equal(validated.scope,fixture.config.scope);
    assert.equal(validated.preflight.evidence_receipt,evidence);
    assert.equal(validated.desktop_codegen_admitted,true);
    assert.throws(()=>validateDesktopCodingLargeObservationAdmission({
      ...largePreparedAdmission(fixture),unexpected:true
    },fixture.configBytes));
  });
});

test('large invocation builder copies and binds the exact prompt before native dispatch',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await largePreparedFixture(root);
    const invocation=buildDesktopCodingLargeObservationInvocation(
      fixture.config,fixture.promptBytes
    );
    assert.equal(invocation.specification.max_wall_clock_sec,null);
    assert.equal(invocation.specification.runtime_target,DESKTOP_TARGET);
    assert.equal(invocation.specification.output_profile,PROFILE);
    assert.equal(invocation.specification.execution_profile,PROJECT_CODING_OBSERVATION_PROFILE);
    assert.notEqual(invocation.specification.prompt_bytes,fixture.promptBytes);
    const original=fixture.promptBytes[fixture.promptBytes.length-1];
    fixture.promptBytes[fixture.promptBytes.length-1]^=1;
    assert.equal(invocation.specification.prompt_bytes.at(-1),original);
    assert.throws(()=>buildDesktopCodingLargeObservationInvocation(
      fixture.config,encoder.encode('changed prompt')
    ));
    assert.throws(()=>buildDesktopCodingLargeObservationInvocation(
      fixture.config,new Uint8Array(PROFILE.max_envelope_bytes+1)
    ));
  });
});

test('large native source route verifies fresh evidence and performs one tagged generation and stage',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await largePreparedFixture(root);
    const runtime=largeFakeRuntime(largeResultEnvelope(70000));
    const result=await runProjectDesktopCodingLargeObservationWithPorts(
      fixture.configBytes,largePreparedAdmission(fixture),undefined,
      largePreparedPorts(fixture,runtime)
    );
    assert.equal(result.schema,PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA);
    assert.equal(result.status,'CANDIDATE_STAGED');
    assert.equal(result.output_profile.max_stdout_bytes,PROFILE.max_stdout_bytes);
    assert.equal(result.operator_admitted,true);
    assert.equal(result.direct_child_invocations.generation,1);
    assert.equal(runtime.calls.length,1);
    assert.equal(runtime.calls[0][2].shell,false);
    assert.equal(runtime.calls[0][2].env.OPENAI_API_KEY,undefined);
    assert.equal(result.generation.record.task_class,PROJECT_LARGE_OBSERVATION_TASK_CLASS);
  });
});

test('large source route rejects stale preflight and config binding before any child spawn',async()=>{
  await largeRunnerFixture(async root=>{
    const stale=await largePreparedFixture(root);
    const staleRuntime=largeFakeRuntime('{}');
    await assert.rejects(()=>runProjectDesktopCodingLargeObservationWithPorts(
      stale.configBytes,largePreparedAdmission(stale),undefined,
      largePreparedPorts(stale,staleRuntime,{observed_at_ms:0},300001)
    ));
    assert.equal(staleRuntime.calls.length,0);

    const mismatched=await largePreparedFixture(root);
    const mismatchRuntime=largeFakeRuntime('{}');
    const wrong=largePreparedAdmission(mismatched);
    wrong.config_sha256='0'.repeat(64);
    await assert.rejects(()=>runProjectDesktopCodingLargeObservationWithPorts(
      mismatched.configBytes,wrong,undefined,
      largePreparedPorts(mismatched,mismatchRuntime)
    ));
    assert.equal(mismatchRuntime.calls.length,0);
  });
});

test('large diagnostic wrappers preserve primary rejection values and report phase observer errors',async()=>{
  await largeRunnerFixture(async root=>{
    for(const [kind,thrown] of [['failure',0],['phase',null]]){
      const fixture=await largePreparedFixture(root);
      const runtime=largeFakeRuntime('{}');
      const ports=largePreparedPorts(fixture,runtime);
      ports.verifyFile=()=>{throw thrown;};
      let rejected=false;
      try{
        if(kind==='failure'){
          await runProjectDesktopCodingLargeObservationWithFailureDiagnosticsWithPorts(
            fixture.configBytes,largePreparedAdmission(fixture),undefined,ports
          );
        }else{
          await runProjectDesktopCodingLargeObservationWithPhaseDiagnosticsWithPorts(
            fixture.configBytes,largePreparedAdmission(fixture),undefined,ports
          );
        }
      }catch(error){rejected=true;assert.equal(error,thrown);}
      assert.equal(rejected,true);
      assert.equal(runtime.calls.length,0);
    }

    const fixture=await largePreparedFixture(root);
    const runtime=largeFakeRuntime(largeResultEnvelope(20));
    const originalRemove=runtime.child.stderr.removeListener;
    let removals=0;
    runtime.child.stderr.removeListener=function(event,listener){
      removals++;
      if(removals>4)throw Error('PRIVATE_OBSERVER_CLEANUP');
      return originalRemove.call(this,event,listener);
    };
    const phase=await runProjectDesktopCodingLargeObservationWithPhaseDiagnosticsWithPorts(
      fixture.configBytes,largePreparedAdmission(fixture),undefined,
      largePreparedPorts(fixture,runtime)
    );
    assert.equal(phase.result.status,'CANDIDATE_STAGED');
    assert.equal(runtime.calls.length,1);
    assert.deepEqual(phase.phase_diagnostics,{
      status:'UNAVAILABLE',reason:'OBSERVER_ERROR',sidecar_status:'NOT_REQUESTED'
    });
    assert.equal(JSON.stringify(phase).includes('PRIVATE_OBSERVER_CLEANUP'),false);
  });
});

test('large phase wrapper includes setup time before observer construction',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await largePreparedFixture(root);
    const runtime=largeFakeRuntime(largeResultEnvelope(20));
    queueMicrotask(()=>runtime.advance(5000));
    const pending=runProjectDesktopCodingLargeObservationWithPhaseDiagnosticsWithPorts(
      fixture.configBytes,largePreparedAdmission(fixture),undefined,
      largePreparedPorts(fixture,runtime)
    );
    const phase=await pending;
    assert.equal(phase.result.status,'CANDIDATE_STAGED');
    assert.equal(runtime.calls.length,1);
    assert.equal(phase.phase_diagnostics.status,'OBSERVED');
    assert.equal(phase.phase_diagnostics.evidence.observation.clock.origin,
      'WRAPPER_ENTRY');
    assert.equal(phase.phase_diagnostics.evidence.observation.clock.status,'OK');
    assert.equal(
      phase.phase_diagnostics.evidence.observation.clock.observed_elapsed_ms,
      5000
    );
    const spawnAttempt=
      phase.phase_diagnostics.evidence.observation.milestones
        .spawn_attempt_beforeports_spawn;
    assert.equal(spawnAttempt.observed,true);
    assert.equal(spawnAttempt.elapsed_ms,5000);
  });
});

test('large result receipts and offline summaries preserve large claims without exposing private fields',async()=>{
  await largeRunnerFixture(async root=>{
    const runtime=largeFakeRuntime(largeResultEnvelope(400000),{stderrBytes:70000});
    const live=await runDesktopCodingLargeObservationProjectTask(
      largeRunnerSpec(root),
      {clock:runtime.clock,shutdown:GENERATION_SHUTDOWN,
       abortSignal:runtime.controller.signal},
      largeRunnerPorts(runtime,{fs})
    );
    assert.equal(live.status,'CANDIDATE_STAGED');
    assert.ok(live.generation.record.output_custody.byte_count>1048576);
    assert.ok(live.generation.record.io_state.stderr_bytes_observed>65536);

    const receipt=createNativeProjectLargeObservationResultReceipt(live);
    assert.equal(receipt.schema,
      'SQUIRE3_NATIVE_PROJECT_LARGE_OBSERVATION_RESULT_RECEIPT_V1');
    assert.equal(receipt.result.schema,PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA);
    assert.equal(validateProjectOutputLargeProfile(receipt.result.output_profile),PROFILE);
    assert.equal(receipt.result.generation.record.task_class,
      PROJECT_LARGE_OBSERVATION_TASK_CLASS);
    assert.equal(receipt.result.generation.record.io_state.stderr_bytes_observed,70000);
    assert.equal(Object.hasOwn(receipt.result.generation,'late_observations'),false);
    assert.throws(()=>createNativeProjectResultReceipt(live),
      error=>error.code==='INVALID_INPUT'||error.code==='INVALID_RECEIPT');
    assert.throws(()=>createNativeProjectCodingObservationResultReceipt(live),
      error=>error.code==='INVALID_INPUT'||error.code==='INVALID_RECEIPT');

    const summary=projectNativeProjectLargeObservationRunSummary(receipt);
    assert.equal(summary.readiness,'CANDIDATE_STAGED');
    assert.equal(summary.schema_version,
      'squire3.native_project_large_observation_summary.v1');
    assert.deepEqual(summary.output_profile,PROFILE);
    assert.equal(summary.generation.task_class,PROJECT_LARGE_OBSERVATION_TASK_CLASS);
    assert.equal(summary.generation.io_state.stderr_bytes_observed,70000);
    assert.ok(summary.generation.output_custody.byte_count>1048576);
    const terminal=formatNativeProjectLargeObservationSummaryTerminal(summary);
    assert.match(terminal,/elapsed generation target: NONE/);
    assert.match(terminal,/cost: UNKNOWN/);
    assert.match(terminal,/stderr=262144 bytes/);
    assert.match(terminal,/stderr=70000/);
    assert.doesNotMatch(JSON.stringify(summary)+terminal,
      /synthetic-large-model|synthetic\/operator-receipt|PUBLIC SYNTHETIC LARGE SOURCE|candidate-envelope\.json/);
    assert.equal(projectNativeProjectRunSummary(receipt).readiness,'INVALID_RECEIPT');
    assert.equal(projectNativeProjectCodingObservationRunSummary(receipt).readiness,
      'INVALID_RECEIPT');
    assert.match(formatNativeProjectSummaryTerminal(summary),/INVALID_RECEIPT/);
    assert.match(formatNativeProjectCodingObservationSummaryTerminal(summary),/INVALID_RECEIPT/);

    const acknowledgement=await writeNativeProjectLargeObservationResultReceipt(
      live,{directory:root,filename:'large-result.json'},
      {fs:{lstat:fs.lstat,open:fs.open},uid:process.getuid()}
    );
    assert.equal(acknowledgement.schema,
      'squire3.native_project_large_observation_result_write_receipt.v1');
    assert.equal(acknowledgement.status,'RECORDED');
    assert.equal(acknowledgement.crash_durability,'NOT_ESTABLISHED');
    assert.equal(acknowledgement.source_authenticity,'NOT_ESTABLISHED');
    const bytes=new Uint8Array(await fs.readFile(join(root,'large-result.json')));
    assert.equal(bytes.length,acknowledgement.byte_count);
    assert.equal(hash(bytes),acknowledgement.sha256);
    assert.equal(projectNativeProjectLargeObservationRunSummary(
      parseReceiptJson(bytes)
    ).readiness,'CANDIDATE_STAGED');
    assert.equal((await fs.stat(join(root,'large-result.json'))).mode&0o777,0o600);
  });
});

test('large receipt families reject legacy aliases, altered profiles and forged staging claims',async()=>{
  await largeRunnerFixture(async root=>{
    const runtime=largeFakeRuntime(largeResultEnvelope(70000));
    const live=await runDesktopCodingLargeObservationProjectTask(
      largeRunnerSpec(root),
      {clock:runtime.clock,shutdown:GENERATION_SHUTDOWN,
       abortSignal:runtime.controller.signal},
      largeRunnerPorts(runtime,{fs})
    );
    const receipt=createNativeProjectLargeObservationResultReceipt(live);
    const tamperedProfile={
      ...receipt,result:{
        ...receipt.result,
        output_profile:{...PROFILE,max_stdout_bytes:PROFILE.max_stdout_bytes+1}
      }
    };
    assert.equal(projectNativeProjectLargeObservationRunSummary(
      tamperedProfile
    ).readiness,'INVALID_RECEIPT');
    const wrongStage={
      ...receipt,result:{
        ...receipt.result,
        staging:{
          ...receipt.result.staging,
          schema_version:'squire4.stage_receipt.v1'
        }
      }
    };
    assert.equal(projectNativeProjectLargeObservationRunSummary(wrongStage).readiness,
      'INVALID_RECEIPT');
    assert.throws(()=>createNativeProjectLargeObservationResultReceipt({
      ...live,output_profile:{...PROFILE,max_source_files:PROFILE.max_source_files+1}
    }),error=>error.code==='INVALID_RECEIPT'||error.code==='INVALID_INPUT');

    let hooks=0;
    const accessor={...live};
    Object.defineProperty(accessor,'output_profile',{
      get(){hooks++;throw Error('PRIVATE_ACCESSOR');}
    });
    assert.throws(()=>createNativeProjectLargeObservationResultReceipt(accessor),
      error=>error.code==='INVALID_INPUT');
    const proxy=new Proxy(live,{ownKeys(){hooks++;throw Error('PRIVATE_PROXY');}});
    assert.throws(()=>createNativeProjectLargeObservationResultReceipt(proxy),
      error=>error.code==='INVALID_INPUT');
    assert.equal(hooks,0);
  });
});

test('large CLI flag is exact, emits only the fixed ACK and routes once through large ports',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await largePreparedFixture(root);
    const admission=largePreparedAdmission(fixture);
    const admissionBytes=encoder.encode(JSON.stringify(admission));
    const configPath='/synthetic/large-config.json';
    const admissionPath='/synthetic/large-admission.json';
    const inputs=new Map([
      [configPath,fixture.configBytes],[admissionPath,admissionBytes]
    ]);
    const output=[],errors=[];
    const runtime=largeFakeRuntime(largeResultEnvelope(70000));
    const cliPorts={
      async readBytes(path){
        if(!inputs.has(path))throw Error('SYNTHETIC_PATH_REJECTED');
        return new Uint8Array(inputs.get(path));
      },
      desktopCodingLargeObservationPorts:largePreparedPorts(fixture,runtime),
      stdout:{write:value=>output.push(value)},
      stderr:{write:value=>errors.push(value)}
    };
    const args=[
      '--run-admitted-desktop-coding-large-observation',configPath,admissionPath
    ];
    assert.equal(desktopCodingLargeObservationEntrypointMode(args),
      'EXPLICIT_DESKTOP_CODING_LARGE_OBSERVATION_ADMISSION_REQUIRED');
    assert.equal(await runProjectEntrypointCli(args,cliPorts),1);
    assert.deepEqual(output,[
      '{"schema":"SQUIRE2_DESKTOP_CODING_LARGE_OBSERVATION_ACK_V1","status":"CANDIDATE_STAGED","task_correctness":"NOT_EVALUATED","native_app_status":"NOT_QUALIFIED"}\n'
    ]);
    assert.deepEqual(errors,[]);
    assert.equal(runtime.calls.length,1);
    assert.equal(runtime.calls[0][2].shell,false);

    const wrongArityRuntime=largeFakeRuntime('{}');
    const wrongArityOutput=[],wrongArityErrors=[];
    const wrongArityPorts={
      ...cliPorts,desktopCodingLargeObservationPorts:
        largePreparedPorts(fixture,wrongArityRuntime),
      stdout:{write:value=>wrongArityOutput.push(value)},
      stderr:{write:value=>wrongArityErrors.push(value)}
    };
    assert.equal(desktopCodingLargeObservationEntrypointMode(args.slice(0,2)),
      'DRY_RUN_NATIVE_DISABLED');
    assert.equal(await runProjectEntrypointCli(args.slice(0,2),wrongArityPorts),2);
    assert.equal(wrongArityRuntime.calls.length,0);
    assert.deepEqual(wrongArityOutput,[]);
    assert.deepEqual(wrongArityErrors,[
      'DESKTOP_CODING_LARGE_OBSERVATION_ADMISSION_OR_OPERATION_FAILED\n'
    ]);

    const legacyRuntime=largeFakeRuntime('{}');
    const legacyOutput=[],legacyErrors=[];
    const legacyArgs=['--run-admitted-desktop-codegen',configPath,admissionPath];
    assert.equal(await runProjectEntrypointCli(legacyArgs,{
      ...cliPorts,
      desktopCodegenPorts:largePreparedPorts(fixture,legacyRuntime),
      stdout:{write:value=>legacyOutput.push(value)},
      stderr:{write:value=>legacyErrors.push(value)}
    }),2);
    assert.equal(legacyRuntime.calls.length,0);
    assert.deepEqual(legacyOutput,[]);
    assert.deepEqual(legacyErrors,['DESKTOP_CODEGEN_ADMISSION_OR_OPERATION_FAILED\n']);

    const unknownRuntime=largeFakeRuntime('{}'),unknownOutput=[];
    assert.equal(desktopCodingLargeObservationEntrypointMode(['--unknown']),
      'DRY_RUN_NATIVE_DISABLED');
    assert.equal(await runProjectEntrypointCli(['--unknown'],{
      stdout:{write:value=>unknownOutput.push(value)},stderr:{write(){}}
    }),0);
    assert.equal(unknownRuntime.calls.length,0);
    assert.match(unknownOutput.join(''),/DRY_RUN_NATIVE_DISABLED/);
  });
});

test('offline report selects only the large receipt family and keeps bounded private input',async()=>{
  await largeRunnerFixture(async root=>{
    const runtime=largeFakeRuntime(largeResultEnvelope(400000),{stderrBytes:70000});
    const live=await runDesktopCodingLargeObservationProjectTask(
      largeRunnerSpec(root),
      {clock:runtime.clock,shutdown:GENERATION_SHUTDOWN,
       abortSignal:runtime.controller.signal},
      largeRunnerPorts(runtime,{fs})
    );
    const receipt=createNativeProjectLargeObservationResultReceipt(live);
    const bytes=encoder.encode(`${JSON.stringify(receipt)}\n`);
    assert.ok(bytes.length<REPORT_MAX_BYTES);
    const report=async(input,{size=input.length,symlink=false,readError=null}={})=>{
      let reads=0,stdout='',stderr='';
      const code=await runOfflineReportCli(['/private/large-receipt.json'],{
        stat:async()=>({
          size,isFile:()=>true,isSymbolicLink:()=>symlink
        }),
        readFile:async(_path,options)=>{
          reads++;
          assert.equal(options.maxBytes,REPORT_MAX_BYTES);
          if(readError)throw readError;
          return input;
        },
        stdout:{write:value=>{stdout+=value;}},
        stderr:{write:value=>{stderr+=value;}}
      });
      return {code,reads,stdout,stderr};
    };
    const valid=await report(bytes);
    assert.equal(valid.code,1);
    assert.equal(valid.reads,1);
    assert.match(valid.stdout,/Squire native offline project large observation result: CANDIDATE_STAGED/);
    assert.match(valid.stdout,/stdout=[0-9]+; stderr=70000/);
    assert.match(valid.stdout,/cost: UNKNOWN/);
    assert.equal(valid.stderr,'');
    assert.doesNotMatch(valid.stdout,/synthetic-large-model|synthetic\/operator-receipt|candidate-envelope\.json|PUBLIC SYNTHETIC LARGE SOURCE/);

    const rawText=new TextDecoder().decode(bytes);
    const malformedCounters=[
      '1.00000000000000001','-1e-999','9007199254740992','-0'
    ];
    for(const lexeme of malformedCounters){
      const malformed=encoder.encode(rawText.replace(
        '"output":22',`"output":${lexeme}`
      ));
      assert.equal(projectNativeProjectLargeObservationReceiptBytesSummary(
        malformed
      ).readiness,'INVALID_RECEIPT',lexeme);
    }
    const roundedReport=await report(encoder.encode(rawText.replace(
      '"output":22','"output":1.00000000000000001'
    )));
    assert.equal(roundedReport.code,2);
    assert.equal(roundedReport.stderr,'SCHEMA_MISMATCH\n');

    const zeroText=rawText.replace('"output":22','"output":0');
    const zeroSummary=projectNativeProjectLargeObservationReceiptBytesSummary(
      encoder.encode(zeroText)
    );
    assert.equal(zeroSummary.readiness,'CANDIDATE_STAGED');
    assert.equal(zeroSummary.generation.provider_metadata.usage_tokens.output,0);
    const maxText=rawText.replace(
      '"output":22','"output":9007199254740991'
    ).replace('"usage_tokens"','"usage\\u005ftokens"')
      .replace('"output":9007199254740991','"out\\u0070ut":9007199254740991');
    const maxSummary=projectNativeProjectLargeObservationReceiptBytesSummary(
      encoder.encode(maxText)
    );
    assert.equal(maxSummary.readiness,'CANDIDATE_STAGED');
    assert.equal(maxSummary.generation.provider_metadata.usage_tokens.output,
      Number.MAX_SAFE_INTEGER);
    const quoted=structuredClone(receipt);
    quoted.result.operator_receipt='private text output:1.00000000000000001';
    assert.equal(projectNativeProjectLargeObservationReceiptBytesSummary(
      encoder.encode(`${JSON.stringify(quoted)}\n`)
    ).readiness,'CANDIDATE_STAGED');

    const tampered=structuredClone(receipt);
    tampered.result.output_profile.max_stdout_bytes++;
    const invalid=await report(encoder.encode(`${JSON.stringify(tampered)}\n`));
    assert.equal(invalid.code,2);
    assert.equal(invalid.stderr,'SCHEMA_MISMATCH\n');
    assert.match(invalid.stdout,/INVALID_RECEIPT/);

    const tooLarge=await report(bytes,{size:REPORT_MAX_BYTES+1});
    assert.equal(tooLarge.code,2);
    assert.equal(tooLarge.reads,0);
    assert.equal(tooLarge.stderr,'FILE_TOO_LARGE\n');
    const symlink=await report(bytes,{symlink:true});
    assert.equal(symlink.code,2);
    assert.equal(symlink.reads,0);
    assert.equal(symlink.stderr,'SPECIAL_FILE_REJECTED\n');
    const failedRead=await report(bytes,{readError:'READ_FAILED'});
    assert.equal(failedRead.code,2);
    assert.equal(failedRead.reads,1);
    assert.equal(failedRead.stderr,'READ_FAILED\n');
  });
});

test('large rejected-retention claims enforce capture, publication and truncation relationships',async()=>{
  await largeRunnerFixture(async root=>{
    const runtime=largeFakeRuntime('```');
    const live=await runDesktopCodingLargeObservationProjectTask(
      largeRunnerSpec(root),
      {clock:runtime.clock,shutdown:GENERATION_SHUTDOWN,
       abortSignal:runtime.controller.signal},
      largeRunnerPorts(runtime,{fs})
    );
    assert.equal(live.status,'GENERATION_REJECTED');
    assert.equal(live.generation.record.lifecycle_status,'LIMITED_PARSER_ERROR');
    const baseReceipt=createNativeProjectLargeObservationResultReceipt(live);
    const capture={
      eligible:true,reason:'PROJECT_MARKDOWN_REJECTED',
      exact_response_bytes:1048576,
      response_bytes:new Uint8Array(65536)
    };
    const legitimate=[
      publicRetention(),
      publicRetention('NOT_ELIGIBLE',null),
      publicRetention('NOT_ELIGIBLE',{
        eligible:false,reason:'PROJECT_MARKDOWN_REJECTED',
        exact_response_bytes:null,response_bytes:null
      }),
      publicRetention('FAILED',null,'RETENTION_INVALID_CAPTURE'),
      retentionResult({
        retention_status:'FAILED',retention_error:'RETENTION_IO_FAILED'
      },capture),
      retentionResult({
        retention_status:'UNKNOWN',
        retention_error:'RETENTION_TIMEOUT_OR_ABORTED'
      },capture),
      retentionResult({
        retention_status:'UNKNOWN',retention_error:null
      },capture),
      retentionResult({
        retention_status:'PUBLISHED',retention_error:null
      },capture)
    ];
    for(const retention of legitimate){
      const result=structuredClone(baseReceipt.result);
      result.generation.diagnostic_retention=retention;
      const receipt=createNativeProjectLargeObservationResultReceipt(result);
      assert.equal(projectNativeProjectLargeObservationRunSummary(
        receipt
      ).readiness,'GENERATION_REJECTED');
    }

    const published=retentionResult({
      retention_status:'PUBLISHED',retention_error:null
    },capture);
    const impossible=[
      {...published,exact_response_bytes:2097152,
        retained_bytes_count:2097152,retained_truncated:false},
      {...published,retained_bytes_count:65537},
      {...published,exact_response_bytes:10,retained_bytes_count:11,
        retained_truncated:false},
      {...published,exact_response_bytes:65536,retained_truncated:true},
      {...published,retention_error:'RETENTION_IO_FAILED'},
      {...publicRetention('NOT_ELIGIBLE',{
        eligible:false,reason:'PROJECT_MARKDOWN_REJECTED',
        exact_response_bytes:null,response_bytes:null
      }),retained_bytes_count:1}
    ];
    for(const retention of impossible){
      const result=structuredClone(baseReceipt.result);
      result.generation.diagnostic_retention=retention;
      assert.throws(()=>createNativeProjectLargeObservationResultReceipt(
        result
      ),error=>error.code==='INVALID_RECEIPT');

      const receipt=structuredClone(baseReceipt);
      receipt.result.generation.diagnostic_retention=retention;
      assert.equal(projectNativeProjectLargeObservationRunSummary(
        receipt
      ).readiness,'INVALID_RECEIPT');

      const summary=structuredClone(
        projectNativeProjectLargeObservationRunSummary(baseReceipt)
      );
      summary.generation.diagnostic_retention=retention;
      assert.match(formatNativeProjectLargeObservationSummaryTerminal(
        summary
      ),/INVALID_RECEIPT/);
    }
  });
});

const readinessCompanionPaths=[
  'src/desktop-readiness-evidence.mjs',
  'src/project-artifact-check-evidence.mjs',
  'src/artifact-verifier.mjs',
  'src/job-record.mjs'
];
const readinessClone=value=>structuredClone(value);
const readinessDomain=(domain,value)=>hash(canonicalBytes({domain,value}));
const readinessDeferred=()=>{
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
};
const readinessController=()=>({
  pid:101,start_ticks:'11',
  boot_id:'00000000-0000-0000-0000-000000000001'
});
const readinessServer=()=>({
  pid:102,start_ticks:'12',
  boot_id:'00000000-0000-0000-0000-000000000001'
});
const readinessFixtureProcess=()=>({
  pid:103,start_ticks:'13',
  boot_id:'00000000-0000-0000-0000-000000000001'
});

function readinessRoute(runtimeIdentity,probeRunId='probe-1'){
  return {
    backend:'broadway',backend_gtype:'GdkBroadwayDisplay',
    display_name:'Broadway',
    environment:{
      GDK_BACKEND:'broadway',BROADWAY_DISPLAY:':41',
      XDG_RUNTIME_DIR:'/synthetic/runtime'
    },
    session:{
      probe_run_id:probeRunId,controller:readinessController(),
      server:readinessServer(),host:'127.0.0.1',port:8121,
      socket_path:'/synthetic/runtime/broadway42.socket',
      socket_dev:'0',socket_ino:'44'
    },
    runtime_identity:readinessClone(runtimeIdentity)
  };
}

function readinessSubscriptionBytes(fixture,observedAt){
  const config=fixture.config;
  return encoder.encode(JSON.stringify({
    operation_config_sha256:hash(fixture.configBytes),
    observed_at_ms:observedAt,
    provider_id:'native_codex',cli_version:config.codex.version,
    executable_sha256:config.codex.sha256,
    requested_model:config.requested_model,effort:config.effort,
    operator_receipt:config.authorization.operator_receipt,
    subscription:true,allowance_available:true,
    effective_provider:'openai_subscription',no_api_or_paid_fallback:true,
    sandbox:config.permissions.sandbox,
    approval_mode:config.permissions.approval_mode,
    output_contract:config.permissions.output_contract,
    installed_flags_verified:true
  }));
}

function refreshReadinessFixture(fixture,{operationHash=true}={}){
  const requirements=fixture.context.requirements;
  if(operationHash){
    requirements.operation_config_sha256=hash(fixture.configBytes);
  }
  fixture.proof.route=readinessClone(requirements.route);
  fixture.terminal.probe_run_id=requirements.route.session.probe_run_id;
  fixture.terminal.requirements_sha256=readinessDomain(
    'squire.desktop-readiness.requirements.v2',requirements
  );
  fixture.terminal.route_sha256=readinessDomain(
    'squire.desktop-readiness.route.v2',requirements.route
  );
  fixture.terminalBytes=encoder.encode(JSON.stringify(fixture.terminal));
  fixture.context.observer_terminal_pin={
    ...fixture.context.observer_terminal_pin,
    bytes:fixture.terminalBytes.length,sha256:hash(fixture.terminalBytes)
  };
  fixture.proof.requirements_sha256=readinessDomain(
    'squire.desktop-readiness.requirements.v2',requirements
  );
  fixture.proof.terminal_receipt_sha256=hash(fixture.terminalBytes);
  fixture.proof.capabilities.find(
    item=>item.name==='direct_owned_cleanup'
  ).detail.terminal_sha256=hash(fixture.terminalBytes);
  fixture.proofBytes=encoder.encode(JSON.stringify(fixture.proof));
  fixture.context.proof_pin={
    ...fixture.context.proof_pin,
    bytes:fixture.proofBytes.length,sha256:hash(fixture.proofBytes)
  };
  fixture.readinessContextBytes=encoder.encode(
    JSON.stringify(fixture.context)
  );
  fixture.selectedRouteBytes=encoder.encode(
    JSON.stringify(fixture.context.requirements.route)
  );
  fixture.files.set(fixture.context.proof_pin.path,fixture.proofBytes);
  fixture.files.set(
    fixture.context.observer_terminal_pin.path,fixture.terminalBytes
  );
  fixture.subscriptionBytes=readinessSubscriptionBytes(
    fixture,fixture.subscriptionObservedAt
  );
  fixture.files.set('/synthetic/large-preflight.json',
    fixture.subscriptionBytes);
  return fixture;
}

function readinessRuntimeDescriptor(files){
  const descriptor=readinessClone(largeDesktopIdentity);
  const bind=(pin,path,label)=>{
    const bytes=encoder.encode(label);
    pin.bytes=bytes.length;
    pin.sha256=hash(bytes);
    files.set(path,bytes);
  };
  bind(descriptor.executable,descriptor.executable.path,
    'synthetic runtime executable');
  for(const entry of descriptor.typelibs){
    bind(entry,entry.typelib,`synthetic typelib ${entry.namespace}`);
  }
  for(const entry of descriptor.libraries){
    bind(entry,entry.path,`synthetic library ${entry.name}`);
  }
  return descriptor;
}

async function makeReadinessIntegrationFixture(root,{
  jobId=null,scope=null,needsInput=true
}={}){
  const prepared=await largePreparedFixture(root);
  const config=readinessClone(prepared.config);
  if(jobId)config.job_id=jobId;
  if(scope)config.scope=scope;
  const files=prepared.files;
  const descriptor=readinessRuntimeDescriptor(files);
  config.desktop_runtime_identity=descriptor;
  const configBytes=encoder.encode(JSON.stringify(config));
  files.set(config.prompt.path,new Uint8Array(prepared.promptBytes));
  const route=readinessRoute(descriptor);
  const fixtureProcess=readinessFixtureProcess();
  const fixtureDefinitionBytes=encoder.encode('fixture definition bytes');
  const observerDefinitionBytes=encoder.encode('observer definition bytes');
  const probeBytes=encoder.encode('PNGbytes');
  const witness={
    'captures/window.png':{
      byte_count:probeBytes.length,sha256:hash(probeBytes)
    }
  };
  const companionFiles=new Map();
  const companion_source_pins=Object.create(null);
  for(const relative of readinessCompanionPaths){
    const bytes=encoder.encode(`synthetic pinned companion ${relative}`);
    const path=join(PROJECT_SOURCE_ROOT,relative);
    companionFiles.set(path,bytes);
    files.set(path,bytes);
    companion_source_pins[relative]={
      bytes:bytes.length,sha256:hash(bytes)
    };
  }
  const requirements={
    schema:'squire.desktop_readiness_requirements.v2',
    operation_config_sha256:hash(configBytes),job_id:config.job_id,
    scope:config.scope,source_commit:config.source_commit,
    prompt_sha256:config.prompt.sha256,
    desktop_descriptor_sha256:readinessDomain(
      'squire.desktop-runtime-descriptor.v2',descriptor
    ),
    route:readinessClone(route),
    observer_policy_sha256:'3'.repeat(64),needs_input:needsInput,
    required_capabilities:needsInput
      ?['api_shape','own_widget_render_readback','artifact_return',
        'own_window_active','direct_owned_cleanup']
      :['api_shape','own_widget_render_readback','artifact_return',
        'direct_owned_cleanup'],
    max_age_ms:300000,
    fixture_definition_sha256:hash(fixtureDefinitionBytes),
    observer_definition_sha256:hash(observerDefinitionBytes)
  };
  const terminal={
    schema:'squire.desktop_readiness_terminal.v2',
    probe_run_id:route.session.probe_run_id,
    requirements_sha256:readinessDomain(
      'squire.desktop-readiness.requirements.v2',requirements
    ),
    route_sha256:readinessDomain(
      'squire.desktop-readiness.route.v2',route
    ),
    fixture_definition_sha256:requirements.fixture_definition_sha256,
    observer_definition_sha256:requirements.observer_definition_sha256,
    terminal:{
      process:readinessFixtureProcess(),started_at_ms:900,ended_at_ms:1100,
      direct_child_exit_observed:true,exit_kind:'natural',exit_code:0,
      signal:null,stdout_eof:true,stderr_eof:true,stop_codes:[],
      cleanup_codes:[],descendant_guarantee:'NOT_ESTABLISHED'
    }
  };
  const terminalBytes=encoder.encode(JSON.stringify(terminal));
  const capabilities=[
    {
      name:'api_shape',status:'passed',evidence_kind:'API_CONTRACT',
      detail:{
        activity_property_kind:'boolean',
        backend_gtype:'GdkBroadwayDisplay',display_name:'Broadway'
      }
    },
    {
      name:'own_widget_render_readback',status:'passed',
      evidence_kind:'NATIVE_RENDER',
      detail:{
        mapped:true,width:640,height:480,decoded_width:640,
        decoded_height:480,png_relative:'captures/window.png'
      }
    },
    {
      name:'artifact_return',status:'passed',
      evidence_kind:'ARTIFACT_READBACK',
      detail:{
        witness_sha256:readinessDomain(
          'squire.desktop-readiness.artifact-witness.v2',witness
        )
      }
    },
    ...(needsInput?[{
      name:'own_window_active',status:'passed',
      evidence_kind:'NATIVE_ACTIVE',
      detail:{
        active:true,target:'OWN_FIXTURE',
        process:readinessFixtureProcess()
      }
    }]:[]),
    {
      name:'direct_owned_cleanup',status:'passed',
      evidence_kind:'DIRECT_PROCESS_CLEANUP',
      detail:{terminal_sha256:hash(terminalBytes)}
    }
  ];
  const proof={
    schema:'squire.desktop_readiness_observation.v2',
    requirements_sha256:readinessDomain(
      'squire.desktop-readiness.requirements.v2',requirements
    ),
    observed_at_ms:1000,route:readinessClone(route),
    fixture_definition_sha256:requirements.fixture_definition_sha256,
    observer_definition_sha256:requirements.observer_definition_sha256,
    observer_policy_sha256:requirements.observer_policy_sha256,
    capabilities,
    terminal_receipt_sha256:hash(terminalBytes),
    artifact_witness_sha256:readinessDomain(
      'squire.desktop-readiness.artifact-witness.v2',witness
    )
  };
  const proofBytes=encoder.encode(JSON.stringify(proof));
  const context={
    schema:'squire.desktop_readiness_context.v2',requirements,
    proof_pin:{
      path:'/synthetic/evidence/proof.json',
      bytes:proofBytes.length,sha256:hash(proofBytes)
    },
    observer_definition_pin:{
      path:'/synthetic/evidence/observer.py',
      bytes:observerDefinitionBytes.length,
      sha256:hash(observerDefinitionBytes)
    },
    fixture_definition_pin:{
      path:'/synthetic/evidence/fixture.py',
      bytes:fixtureDefinitionBytes.length,
      sha256:hash(fixtureDefinitionBytes)
    },
    observer_terminal_pin:{
      path:'/synthetic/evidence/terminal.json',
      bytes:terminalBytes.length,sha256:hash(terminalBytes)
    },
    probe_artifacts:{root:'/synthetic/probe',witness},
    companion_source_pins
  };
  const readinessContextBytes=encoder.encode(JSON.stringify(context));
  const fixture={
    ...prepared,files,config,configBytes,
    admission:null,route,context,proof,terminal,proofBytes,terminalBytes,
    readinessContextBytes,
    selectedRouteBytes:encoder.encode(JSON.stringify(route)),
    fixtureDefinitionBytes,observerDefinitionBytes,probeBytes,
    companionFiles,now:1200,subscriptionObservedAt:1100
  };
  fixture.admission=largePreparedAdmission(fixture,configBytes);
  files.set(context.proof_pin.path,proofBytes);
  files.set(context.observer_terminal_pin.path,terminalBytes);
  files.set(context.fixture_definition_pin.path,fixtureDefinitionBytes);
  files.set(context.observer_definition_pin.path,observerDefinitionBytes);
  files.set('/synthetic/probe/captures/window.png',probeBytes);
  fixture.subscriptionBytes=readinessSubscriptionBytes(
    fixture,fixture.subscriptionObservedAt
  );
  files.set('/synthetic/large-preflight.json',fixture.subscriptionBytes);
  return fixture;
}

function readinessProbeStat(kind,size=0,ino=10n){
  return {
    dev:1n,ino,size:BigInt(size),mtimeNs:2n,ctimeNs:3n,
    mode:kind==='file'?0o100600n:0o040700n,
    uid:process.getuid(),nlink:1,
    isFile:()=>kind==='file',
    isDirectory:()=>kind==='directory',
    isSymbolicLink:()=>false
  };
}

function makeReadinessIntegrationPorts(fixture,runtime,hooks={}){
  const files=fixture.files;
  const probeRoot='/synthetic/probe';
  const probeDirs=new Set([probeRoot,join(probeRoot,'captures')]);
  const probeFiles=new Set(['/synthetic/probe/captures/window.png']);
  const calls={
    verify:[],readBytes:[],lstat:[],readChunks:[],realpath:[],
    probeOpen:[],probeRead:[],probeClose:[],mkdir:[],retention:[],
    events:[],now:[]
  };
  const retentionGate=hooks.retentionGate?readinessDeferred():null;
  const releaseRetention=retentionGate?.resolve??null;
  const enteredRetention=hooks.retentionEntered??(()=>{});
  const probeStat=path=>probeDirs.has(path)
    ?readinessProbeStat('directory',1,10n)
    :probeFiles.has(path)
      ?readinessProbeStat('file',files.get(path)?.length??0,20n)
      :null;
  const fsPort={
    async lstat(path,...args){
      calls.lstat.push(path);
      const fake=probeStat(path);
      if(fake)return fake;
      return fs.lstat(path,...args);
    },
    async realpath(path,...args){
      calls.realpath.push(path);
      if(path.startsWith('/synthetic/'))return path;
      return fs.realpath(path,...args);
    },
    async open(path,...args){
      if(probeFiles.has(path)){
        calls.probeOpen.push(path);
        if(hooks.beforeProbeOpen)await hooks.beforeProbeOpen(calls);
        const bytes=files.get(path);
        let closed=false;
        return {
          async stat(){return readinessProbeStat('file',bytes.length,20n);},
          async read(buffer,offset,length,position){
            calls.probeRead.push({path,position,length});
            const count=Math.min(length,Math.max(0,bytes.length-position));
            if(count)buffer.set(bytes.subarray(position,position+count),offset);
            return {bytesRead:count};
          },
          async close(){
            if(closed)throw Error('DOUBLE_PROBE_CLOSE');
            closed=true;calls.probeClose.push(path);
          }
        };
      }
      return fs.open(path,...args);
    },
    async mkdir(path,...args){
      calls.mkdir.push(path);
      const value=await fs.mkdir(path,...args);
      if(hooks.afterMkdir)await hooks.afterMkdir(path,calls);
      return value;
    },
    chmod:(...args)=>fs.chmod(...args),
    readdir:(...args)=>fs.readdir(...args)
  };
  const reads={
    async lstat(path){
      calls.events.push(`pin-lstat:${path}`);
      calls.lstat.push(path);
      if(hooks.pinLstat)await hooks.pinLstat(path,calls);
      const bytes=files.get(path);
      if(!bytes)throw Object.assign(new Error('missing'),{code:'ENOENT'});
      return {size:bytes.length,isFile:()=>true,isSymbolicLink:()=>false};
    },
    readChunks(path){
      calls.readChunks.push(path);
      const bytes=files.get(path);
      if(!bytes)throw Object.assign(new Error('missing'),{code:'ENOENT'});
      return (async function*(){
        for(let offset=0;offset<bytes.length;offset+=7){
          if(hooks.afterDefinitionChunk)await hooks.afterDefinitionChunk(path);
          yield bytes.subarray(offset,Math.min(offset+7,bytes.length));
        }
      })();
    }
  };
  const port={
    fs:fsPort,uid:process.getuid(),spawn:runtime.spawn,
    async readBytes(path,maxBytes){
      calls.readBytes.push({path,maxBytes});
      calls.events.push(`read-bytes:${path}`);
      if(hooks.beforeReadBytes)await hooks.beforeReadBytes(path,calls);
      const bytes=files.get(path);
      if(!bytes)throw Object.assign(new Error('missing'),{code:'ENOENT'});
      if(bytes.length>maxBytes)throw Error('SYNTHETIC_READ_LIMIT');
      const result=new Uint8Array(bytes);
      if(hooks.afterReadBytes)await hooks.afterReadBytes(path,calls);
      return result;
    },
    async verifyFile(identity,suppliedReads){
      calls.verify.push(identity.path);
      calls.events.push(`verify:${identity.path}`);
      if(hooks.beforeVerify)await hooks.beforeVerify(identity,calls);
      if(identity.path===fixture.config.node.path||
         identity.path===fixture.config.codex.path){
        if(hooks.verifyFile)await hooks.verifyFile(identity,calls);
        return Object.freeze({...identity});
      }
      const companion=fixture.companionFiles.get(identity.path);
      if(companion&&!files.has(identity.path)){
        throw Error('SYNTHETIC_COMPANION_MISSING');
      }
      const result=await verifyExactFile(identity,suppliedReads);
      if(hooks.verifyFile)await hooks.verifyFile(identity,calls);
      return result;
    },
    reads,now(){
      calls.now.push(fixture.now);
      return hooks.now?hooks.now(calls,fixture):fixture.now;
    },
    clock:runtime.clock,
    retention(jobId){
      calls.retention.push(jobId);
      return {
        async prepare(){
          if(retentionGate)enteredRetention();
          if(retentionGate)await retentionGate.promise;
          if(hooks.retentionPrepare)await hooks.retentionPrepare();
          return {capability_status:'READY'};
        },
        async retainRejected(){return {status:'NOT_RETAINED'};}
      };
    },
    environment:{PUBLIC:'synthetic'}
  };
  return {port,calls,files,releaseRetention};
}

// Harness construction has no dispatch. Every test starts and awaits one
// explicit API operation, including abort and corrected-retry cases.
function dispatchReadiness(fixture,harness,abortSignal=undefined){
  return runProjectDesktopCodingLargeObservationWithReadinessWithPorts(
    fixture.configBytes,fixture.admission,fixture.readinessContextBytes,
    fixture.selectedRouteBytes,abortSignal,harness.port
  );
}

async function expectReadinessCode(code,operation){
  await assert.rejects(operation,error=>
    error?.code===code||error?.message===code
  );
}

test('readiness opt-in verifies fixed source closure, accepted evidence and probe bytes before generation',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await makeReadinessIntegrationFixture(root);
    const runtime=largeFakeRuntime(largeResultEnvelope(20));
    const harness=makeReadinessIntegrationPorts(fixture,runtime);
    const result=await dispatchReadiness(fixture,harness);
    assert.equal(result.schema,PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA);
    assert.equal(result.status,'CANDIDATE_STAGED');
    assert.equal(result.task_correctness,'NOT_EVALUATED');
    assert.equal(result.task_outcome_evaluated,false);
    assert.equal(result.runtime_admitted,false);
    assert.equal(result.operator_admitted,true);
    assert.equal(result.direct_child_invocations.generation,1);
    assert.equal(runtime.calls.length,1);
    assert.equal(harness.calls.probeOpen.length,1);
    assert.deepEqual(harness.calls.probeClose,harness.calls.probeOpen);
    assert.ok(harness.calls.probeRead.some(read=>read.length===1));
    assert.ok(harness.calls.readChunks.includes(
      fixture.context.fixture_definition_pin.path
    ));
    assert.ok(harness.calls.readChunks.includes(
      fixture.context.observer_definition_pin.path
    ));
    const basePaths=[
      fixture.config.node.path,fixture.config.codex.path,
      fixture.config.prompt.path,...Object.keys(fixture.config.source_pins)
    ];
    const baseEnd=Math.max(...basePaths.map(path=>
      harness.calls.events.indexOf(`verify:${path}`)
    ));
    const companions=readinessCompanionPaths.map(relative=>
      harness.calls.events.indexOf(
        `verify:${join(PROJECT_SOURCE_ROOT,relative)}`
      )
    );
    assert.ok(companions.every(index=>index>baseEnd));
    const firstEvidenceRead=harness.calls.events.indexOf(
      `read-bytes:${fixture.context.proof_pin.path}`
    );
    assert.ok(firstEvidenceRead>Math.max(...companions));
    assert.equal(harness.calls.readBytes.every(
      item=>item.maxBytes<=65536
    ),true);
    assert.equal(harness.calls.retention.length,1);
    assert.ok(harness.calls.mkdir.includes(fixture.config.scope));
    assert.equal(fixture.config.desktop_runtime_identity.status,'NOT_QUALIFIED');
    assert.equal(Object.hasOwn(result,'native_app_status'),false);
  });
});

test('all four mandatory companion pins fail closed and corrected same-identity retries proceed',async()=>{
  await largeRunnerFixture(async root=>{
    for(const relative of readinessCompanionPaths){
      for(const failure of ['expected-hash','backing-missing','backing-changed']){
        const fixture=await makeReadinessIntegrationFixture(root);
        const expectedContext=new Uint8Array(fixture.readinessContextBytes);
        const originalBacking=new Uint8Array(
          fixture.companionFiles.get(join(PROJECT_SOURCE_ROOT,relative))
        );
        if(failure==='expected-hash'){
          fixture.context.companion_source_pins[relative].sha256='0'.repeat(64);
          fixture.readinessContextBytes=encoder.encode(
            JSON.stringify(fixture.context)
          );
        }else if(failure==='backing-missing'){
          fixture.files.delete(join(PROJECT_SOURCE_ROOT,relative));
        }else{
          fixture.files.set(join(PROJECT_SOURCE_ROOT,relative),
            new Uint8Array([...originalBacking,0x21]));
        }
        const failedRuntime=largeFakeRuntime(largeResultEnvelope(20));
        const failedHarness=makeReadinessIntegrationPorts(
          fixture,failedRuntime
        );
        await expectReadinessCode(
          failure==='expected-hash'
            ?'READINESS_EVIDENCE_BLOCKED'
            :'READINESS_EVIDENCE_BLOCKED',
          dispatchReadiness(fixture,failedHarness)
        );
        assert.equal(failedRuntime.calls.length,0);
        assert.equal(failedHarness.calls.retention.length,0);

        fixture.readinessContextBytes=expectedContext;
        fixture.files.set(join(PROJECT_SOURCE_ROOT,relative),originalBacking);
        const retryRuntime=largeFakeRuntime(largeResultEnvelope(20));
        const retryHarness=makeReadinessIntegrationPorts(fixture,retryRuntime);
        assert.equal((await dispatchReadiness(fixture,retryHarness)).status,
          'CANDIDATE_STAGED');
        assert.equal(retryRuntime.calls.length,1);
        assert.equal(readinessCompanionPaths.every(path=>
          retryHarness.calls.verify.includes(join(PROJECT_SOURCE_ROOT,path))
        ),true);
      }
    }

    const malformed=[
      context=>{delete context.companion_source_pins[readinessCompanionPaths[0]];},
      context=>{
        const pin=context.companion_source_pins[readinessCompanionPaths[0]];
        delete context.companion_source_pins[readinessCompanionPaths[0]];
        context.companion_source_pins['src/wrong.mjs']=pin;
      },
      context=>{context.companion_source_pins.unexpected={bytes:1,sha256:'0'.repeat(64)};},
      context=>{context.companion_source_pins[readinessCompanionPaths[0]].bytes=Number.MAX_SAFE_INTEGER;},
      context=>{context.companion_source_pins[readinessCompanionPaths[0]].bytes=1048577;},
      context=>{context.companion_source_pins[readinessCompanionPaths[0]].sha256='unsafe';}
    ];
    const fixture=await makeReadinessIntegrationFixture(root);
    const original=new Uint8Array(fixture.readinessContextBytes);
    for(const mutate of malformed){
      const changed=readinessClone(fixture.context);
      mutate(changed);
      fixture.readinessContextBytes=encoder.encode(JSON.stringify(changed));
      const runtime=largeFakeRuntime(largeResultEnvelope(20));
      const harness=makeReadinessIntegrationPorts(fixture,runtime);
      await expectReadinessCode(
        'INVALID_READINESS_CONTEXT',dispatchReadiness(fixture,harness)
      );
      assert.equal(runtime.calls.length,0);
      assert.equal(harness.calls.retention.length,0);
    }
    fixture.readinessContextBytes=original;
    const retryRuntime=largeFakeRuntime(largeResultEnvelope(20));
    const retryHarness=makeReadinessIntegrationPorts(fixture,retryRuntime);
    assert.equal((await dispatchReadiness(fixture,retryHarness)).status,
      'CANDIDATE_STAGED');
  });
});

test('base source verification failure is fail-closed and leaves the operation available',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await makeReadinessIntegrationFixture(root);
    let failOnce=true;
    const hooks={
      verifyFile(identity){
        if(failOnce&&identity.path===fixture.config.node.path){
          failOnce=false;
          throw Error('PRIVATE_SOURCE_FAILURE');
        }
      }
    };
    const failedRuntime=largeFakeRuntime(largeResultEnvelope(20));
    const failedHarness=makeReadinessIntegrationPorts(
      fixture,failedRuntime,hooks
    );
    await expectReadinessCode(
      'READINESS_EVIDENCE_BLOCKED',
      dispatchReadiness(fixture,failedHarness)
    );
    assert.equal(failedRuntime.calls.length,0);
    assert.equal(failedHarness.calls.retention.length,0);
    const retryRuntime=largeFakeRuntime(largeResultEnvelope(20));
    const retryHarness=makeReadinessIntegrationPorts(
      fixture,retryRuntime,hooks
    );
    assert.equal((await dispatchReadiness(fixture,retryHarness)).status,
      'CANDIDATE_STAGED');
    assert.equal(retryRuntime.calls.length,1);
  });
});

test('operation, job, source, prompt and selected-route mismatches reach their bound comparisons',async()=>{
  await largeRunnerFixture(async root=>{
    for(const mode of [
      'operation-config','job-id','source-commit','prompt-hash','route-session'
    ]){
      const fixture=await makeReadinessIntegrationFixture(root);
      const originalOperationHash=
        fixture.context.requirements.operation_config_sha256;
      if(mode==='operation-config'){
        fixture.config.scope=join(root,`scope-B-${fixture.config.job_id}`);
      }else if(mode==='job-id'){
        fixture.config.job_id='20000000-0000-4000-8000-000000000001';
      }else if(mode==='source-commit'){
        fixture.config.source_commit='f'.repeat(40);
      }else if(mode==='prompt-hash'){
        fixture.promptBytes=encoder.encode(
          `${new TextDecoder().decode(fixture.promptBytes)} `
        );
        fixture.config.prompt.bytes=fixture.promptBytes.length;
        fixture.config.prompt.sha256=hash(fixture.promptBytes);
        fixture.files.set(fixture.config.prompt.path,fixture.promptBytes);
      }else{
        const selected=readinessRoute(
          fixture.config.desktop_runtime_identity,'probe-session-B'
        );
        fixture.selectedRouteBytes=encoder.encode(JSON.stringify(selected));
      }
      if(mode!=='route-session'){
        fixture.configBytes=encoder.encode(JSON.stringify(fixture.config));
        fixture.admission=largePreparedAdmission(
          fixture,fixture.configBytes
        );
        fixture.subscriptionObservedAt=fixture.now-100;
        refreshReadinessFixture(fixture);
        if(mode==='operation-config'){
          fixture.context.requirements.operation_config_sha256=
            originalOperationHash;
          refreshReadinessFixture(fixture,{operationHash:false});
        }
      }
      const runtime=largeFakeRuntime(largeResultEnvelope(20));
      const harness=makeReadinessIntegrationPorts(fixture,runtime);
      await expectReadinessCode(
        'READINESS_EVIDENCE_BLOCKED',
        dispatchReadiness(fixture,harness)
      );
      assert.equal(runtime.calls.length,0,mode);
      assert.equal(harness.calls.retention.length,0,mode);
      assert.equal(harness.calls.readBytes.some(item=>
        item.path===fixture.context.proof_pin.path
      ),false,mode);
    }
  });
});

test('caller buffers and admission are captured before a held source verification',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await makeReadinessIntegrationFixture(root);
    const gate=readinessDeferred(),entered=readinessDeferred();
    const runtime=largeFakeRuntime(largeResultEnvelope(20));
    const configBytes=fixture.configBytes;
    const contextBytes=fixture.readinessContextBytes;
    const routeBytes=fixture.selectedRouteBytes;
    const admission=fixture.admission;
    const harness=makeReadinessIntegrationPorts(fixture,runtime,{
      async beforeVerify(identity){
        if(identity.path===fixture.config.node.path){
          entered.resolve();
          await gate.promise;
        }
      }
    });
    const operation=dispatchReadiness(fixture,harness);
    await entered.promise;
    configBytes.fill(0);
    contextBytes.fill(0);
    routeBytes.fill(0);
    admission.job_id='30000000-0000-4000-8000-000000000001';
    gate.resolve();
    const result=await operation;
    assert.equal(result.status,'CANDIDATE_STAGED');
    assert.equal(result.operator_receipt,
      fixture.config.authorization.operator_receipt);
    assert.equal(runtime.calls.length,1);
  });
});

test('abort, stale, future and regressing readiness clocks reject before consumption and allow retry',async()=>{
  await largeRunnerFixture(async root=>{
    const abortStages=['source','reader','probe','subscription','prompt'];
    for(const stage of abortStages){
      const fixture=await makeReadinessIntegrationFixture(root);
      const controller=new AbortController();
      const gate=readinessDeferred(),entered=readinessDeferred();
      const runtime=largeFakeRuntime(largeResultEnvelope(20));
      const hooks={};
      const hold=async()=>{
        entered.resolve();
        await gate.promise;
        controller.abort();
      };
      if(stage==='source'){
        hooks.beforeVerify=async identity=>{
          if(identity.path===fixture.config.node.path)await hold();
        };
      }else if(stage==='reader'){
        hooks.beforeReadBytes=async path=>{
          if(path===fixture.context.proof_pin.path)await hold();
        };
      }else if(stage==='probe'){
        hooks.beforeProbeOpen=hold;
      }else if(stage==='subscription'){
        hooks.beforeReadBytes=async path=>{
          if(path==='/synthetic/large-preflight.json')await hold();
        };
      }else{
        hooks.beforeReadBytes=async path=>{
          if(path===fixture.config.prompt.path)await hold();
        };
      }
      const harness=makeReadinessIntegrationPorts(fixture,runtime,hooks);
      const operation=dispatchReadiness(fixture,harness,controller.signal);
      await entered.promise;
      gate.resolve();
      await assert.rejects(operation,error=>
        ['OPERATION_ABORTED','READINESS_EVIDENCE_BLOCKED'].includes(
          error?.code??error?.message
        )
      );
      assert.equal(runtime.calls.length,0,stage);
      assert.equal(harness.calls.retention.length,0,stage);
      const retryRuntime=largeFakeRuntime(largeResultEnvelope(20));
      const retryHarness=makeReadinessIntegrationPorts(fixture,retryRuntime);
      assert.equal((await dispatchReadiness(fixture,retryHarness)).status,
        'CANDIDATE_STAGED',stage);
    }

    const stale=await makeReadinessIntegrationFixture(root);
    stale.now=301001;
    stale.subscriptionObservedAt=300901;
    stale.subscriptionBytes=readinessSubscriptionBytes(
      stale,stale.subscriptionObservedAt
    );
    stale.files.set('/synthetic/large-preflight.json',stale.subscriptionBytes);
    const staleRuntime=largeFakeRuntime(largeResultEnvelope(20));
    const staleHarness=makeReadinessIntegrationPorts(stale,staleRuntime);
    await expectReadinessCode(
      'READINESS_EVIDENCE_BLOCKED',
      dispatchReadiness(stale,staleHarness)
    );
    assert.ok(staleHarness.calls.readBytes.some(item=>
      item.path===stale.config.prompt.path
    ));
    assert.equal(staleRuntime.calls.length,0);
    stale.now=1200;
    stale.subscriptionObservedAt=1100;
    stale.subscriptionBytes=readinessSubscriptionBytes(stale,1100);
    stale.files.set('/synthetic/large-preflight.json',stale.subscriptionBytes);
    const staleRetryRuntime=largeFakeRuntime(largeResultEnvelope(20));
    const staleRetryHarness=makeReadinessIntegrationPorts(
      stale,staleRetryRuntime
    );
    assert.equal((await dispatchReadiness(stale,staleRetryHarness)).status,
      'CANDIDATE_STAGED');

    const future=await makeReadinessIntegrationFixture(root);
    future.now=999;
    future.subscriptionObservedAt=899;
    future.subscriptionBytes=readinessSubscriptionBytes(future,899);
    future.files.set('/synthetic/large-preflight.json',future.subscriptionBytes);
    const futureRuntime=largeFakeRuntime(largeResultEnvelope(20));
    const futureHarness=makeReadinessIntegrationPorts(future,futureRuntime);
    await expectReadinessCode(
      'READINESS_EVIDENCE_BLOCKED',
      dispatchReadiness(future,futureHarness)
    );
    assert.ok(futureHarness.calls.readBytes.some(item=>
      item.path===future.config.prompt.path
    ));
    assert.equal(futureRuntime.calls.length,0);
    future.now=1200;
    future.subscriptionObservedAt=1100;
    future.files.set('/synthetic/large-preflight.json',
      readinessSubscriptionBytes(future,1100));
    assert.equal((await dispatchReadiness(
      future,makeReadinessIntegrationPorts(
        future,largeFakeRuntime(largeResultEnvelope(20))
      )
    )).status,'CANDIDATE_STAGED');

    const regressing=await makeReadinessIntegrationFixture(root);
    let sample=0;
    const regressionRuntime=largeFakeRuntime(largeResultEnvelope(20));
    const regressionHarness=makeReadinessIntegrationPorts(
      regressing,regressionRuntime,{
        now(){
          sample++;
          return sample===1?1200:sample===2?1201:1200;
        }
      }
    );
    await expectReadinessCode(
      'READINESS_EVIDENCE_BLOCKED',
      dispatchReadiness(regressing,regressionHarness)
    );
    assert.equal(regressionRuntime.calls.length,0);
    assert.equal(regressionHarness.calls.retention.length,0);
    assert.equal((await dispatchReadiness(
      regressing,makeReadinessIntegrationPorts(
        regressing,largeFakeRuntime(largeResultEnvelope(20))
      )
    )).status,'CANDIDATE_STAGED');
  });
});

test('concurrent new readiness calls share both existing job and scope fences',async()=>{
  await largeRunnerFixture(async root=>{
    for(const relation of ['same-job','same-scope']){
      const sharedJob=`40000000-0000-4000-8000-00000000000${
        relation==='same-job'?'1':'2'
      }`;
      const sharedScope=join(root,`shared-readiness-${relation}`);
      const first=await makeReadinessIntegrationFixture(root,{
        jobId:relation==='same-job'?sharedJob:null,
        scope:relation==='same-scope'?sharedScope:join(root,'readiness-A')
      });
      const second=await makeReadinessIntegrationFixture(root,{
        jobId:relation==='same-job'?sharedJob:null,
        scope:relation==='same-scope'?sharedScope:join(root,'readiness-B')
      });
      const gate=readinessDeferred(),entered=readinessDeferred();
      let arrivals=0;
      const beforeVerify=async()=>{
        if(++arrivals===2)entered.resolve();
        await gate.promise;
      };
      const runtimeA=largeFakeRuntime(largeResultEnvelope(20));
      const runtimeB=largeFakeRuntime(largeResultEnvelope(20));
      const harnessA=makeReadinessIntegrationPorts(first,runtimeA,{beforeVerify});
      const harnessB=makeReadinessIntegrationPorts(second,runtimeB,{beforeVerify});
      const operationA=dispatchReadiness(first,harnessA);
      const operationB=dispatchReadiness(second,harnessB);
      await entered.promise;
      gate.resolve();
      const settled=await Promise.allSettled([operationA,operationB]);
      assert.equal(settled.filter(item=>item.status==='fulfilled').length,1);
      assert.equal(settled.filter(item=>item.status==='rejected').length,1);
      assert.equal(runtimeA.calls.length+runtimeB.calls.length,1);
      assert.equal(
        harnessA.calls.retention.length+harnessB.calls.retention.length,1
      );
    }
  });
});

test('new and legacy routes contend in both winner orders for shared job and scope fences',async()=>{
  await largeRunnerFixture(async root=>{
    for(const relation of ['same-job','same-scope']){
      for(const winner of ['new-first','legacy-first']){
        const suffix=`${relation}-${winner}`;
        const sharedJob=`50000000-0000-4000-8000-00000000000${
          winner==='new-first'?'1':'2'
        }`;
        const sharedScope=join(root,`shared-${suffix}`);
        const readiness=await makeReadinessIntegrationFixture(root,{
          jobId:relation==='same-job'?sharedJob:null,
          scope:relation==='same-scope'?sharedScope:join(root,`new-${suffix}`)
        });
        const legacy=await makeReadinessIntegrationFixture(root,{
          jobId:relation==='same-job'?sharedJob:null,
          scope:relation==='same-scope'?sharedScope:join(root,`legacy-${suffix}`)
        });
        const newRuntime=largeFakeRuntime(largeResultEnvelope(20));
        const legacyRuntime=largeFakeRuntime(largeResultEnvelope(20));

        if(winner==='new-first'){
          const entered=readinessDeferred();
          const newHarness=makeReadinessIntegrationPorts(
            readiness,newRuntime,{
              retentionGate:true,retentionEntered:()=>entered.resolve()
            }
          );
          const newOperation=dispatchReadiness(readiness,newHarness);
          await entered.promise;
          const legacyHarness=makeReadinessIntegrationPorts(
            legacy,legacyRuntime
          );
          await expectReadinessCode(
            'NATIVE_OPERATION_ALREADY_CONSUMED',
            runProjectDesktopCodingLargeObservationWithPorts(
              legacy.configBytes,legacy.admission,undefined,legacyHarness.port
            )
          );
          assert.equal(legacyRuntime.calls.length,0);
          assert.equal(legacyHarness.calls.retention.length,0);
          newHarness.releaseRetention();
          assert.equal((await newOperation).status,'CANDIDATE_STAGED');
          assert.equal(newRuntime.calls.length,1);
        }else{
          const gate=readinessDeferred(),entered=readinessDeferred();
          const legacyHarness=makeReadinessIntegrationPorts(
            legacy,legacyRuntime,{
              async beforeVerify(identity){
                if(identity.path===legacy.config.node.path){
                  entered.resolve();
                  await gate.promise;
                }
              }
            }
          );
          const legacyOperation=
            runProjectDesktopCodingLargeObservationWithPorts(
              legacy.configBytes,legacy.admission,undefined,legacyHarness.port
            );
          await entered.promise;
          const newHarness=makeReadinessIntegrationPorts(
            readiness,newRuntime
          );
          await expectReadinessCode(
            'NATIVE_OPERATION_ALREADY_CONSUMED',
            dispatchReadiness(readiness,newHarness)
          );
          assert.equal(newRuntime.calls.length,0);
          assert.equal(newHarness.calls.retention.length,0);
          gate.resolve();
          assert.equal((await legacyOperation).status,'CANDIDATE_STAGED');
          assert.equal(legacyRuntime.calls.length,1);
        }
      }
    }
  });
});

test('late expiry blocks physical spawn after both attempts and backend throws remain unknown-child attempts',async()=>{
  await largeRunnerFixture(async root=>{
    const expired=await makeReadinessIntegrationFixture(root);
    const expiredRuntime=largeFakeRuntime(largeResultEnvelope(20));
    const expiredHarness=makeReadinessIntegrationPorts(
      expired,expiredRuntime,{
        async afterMkdir(path){
          if(path===expired.config.scope)expired.now=301001;
        }
      }
    );
    const result=await dispatchReadiness(expired,expiredHarness);
    assert.equal(result.status,'GENERATION_REJECTED');
    assert.equal(result.generation.record.lifecycle_status,'LIMITED_SPAWN_FAILED');
    assert.equal(result.direct_child_invocations.generation,1);
    assert.equal(expiredRuntime.calls.length,0);
    assert.equal(expiredHarness.calls.retention.length,1);
    const retryRuntime=largeFakeRuntime(largeResultEnvelope(20));
    await expectReadinessCode('NATIVE_OPERATION_ALREADY_CONSUMED',
      dispatchReadiness(expired,makeReadinessIntegrationPorts(
        expired,retryRuntime
      ))
    );
    assert.equal(retryRuntime.calls.length,0);

    const thrown=await makeReadinessIntegrationFixture(root);
    const backendCalls=[];
    const throwingRuntime=largeFakeRuntime(largeResultEnvelope(20));
    const throwingHarness=makeReadinessIntegrationPorts(
      thrown,throwingRuntime
    );
    throwingHarness.port.spawn=(...args)=>{
      backendCalls.push(args);
      throw Error('SYNTHETIC_BACKEND_THROW');
    };
    const failed=await dispatchReadiness(thrown,throwingHarness);
    assert.equal(failed.status,'GENERATION_REJECTED');
    assert.equal(failed.generation.record.lifecycle_status,'LIMITED_SPAWN_FAILED');
    assert.equal(failed.direct_child_invocations.generation,1);
    assert.equal(backendCalls.length,1);
    assert.equal(failed.generation.record.process_exit.pid,null);
    assert.equal(
      failed.generation.record.containment_evidence.settlement_status,
      'UNKNOWN'
    );
  });
});

test('native readiness projects its environment and honors an early preflight abort',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await makeReadinessIntegrationFixture(root);
    const controller=new AbortController();
    controller.abort();
    await assert.rejects(
      ()=>runProjectDesktopCodingLargeObservationNativeWithReadiness(
        fixture.configBytes,fixture.admission,fixture.readinessContextBytes,
        fixture.selectedRouteBytes,controller.signal
      ),
      error=>{
        const descriptor=Object.getOwnPropertyDescriptor(error,'code');
        return Boolean(descriptor&&Object.hasOwn(descriptor,'value')&&
          descriptor.value==='OPERATION_ABORTED');
      }
    );
  });
});

test('injected readiness environments stay descriptor-safe and bounded',async()=>{
  await largeRunnerFixture(async root=>{
    let getterCalls=0,proxyTraps=0;
    const accessorEnvironment={};
    Object.defineProperty(accessorEnvironment,'SYNTHETIC_ACCESSOR',{
      enumerable:true,
      get(){getterCalls++;return 'synthetic-value';}
    });
    const proxyTarget={PUBLIC:'synthetic-value'};
    const proxyEnvironment=new Proxy(proxyTarget,{
      ownKeys(target){proxyTraps++;return Reflect.ownKeys(target);},
      getOwnPropertyDescriptor(target,key){
        proxyTraps++;return Reflect.getOwnPropertyDescriptor(target,key);
      },
      getPrototypeOf(target){
        proxyTraps++;return Reflect.getPrototypeOf(target);
      },
      get(target,key,receiver){
        proxyTraps++;return Reflect.get(target,key,receiver);
      }
    });
    const customPrototype=Object.create({syntheticMarker:'synthetic-value'});
    customPrototype.PUBLIC='synthetic-value';
    const oversizedEnvironment={};
    for(let index=0;index<80;index++){
      oversizedEnvironment[`SYNTHETIC_ENV_${index}`]='x'.repeat(4096);
    }
    const scenarios=[
      {
        name:'ordinary',
        environment:{PUBLIC:'synthetic-value'},
        expected:'OPERATION_ABORTED'
      },
      {
        name:'accessor',
        environment:accessorEnvironment,
        expected:'INVALID_READINESS_CONTEXT'
      },
      {
        name:'proxy',
        environment:proxyEnvironment,
        expected:'INVALID_READINESS_CONTEXT'
      },
      {
        name:'custom-prototype',
        environment:customPrototype,
        expected:'INVALID_READINESS_CONTEXT'
      },
      {
        name:'oversized',
        environment:oversizedEnvironment,
        expected:'INVALID_READINESS_CONTEXT'
      }
    ];
    for(const scenario of scenarios){
      const fixture=await makeReadinessIntegrationFixture(root);
      const runtime=largeFakeRuntime(largeResultEnvelope(20));
      const harness=makeReadinessIntegrationPorts(fixture,runtime);
      harness.port.environment=scenario.environment;
      const controller=new AbortController();
      controller.abort();
      await expectReadinessCode(
        scenario.expected,
        dispatchReadiness(fixture,harness,controller.signal)
      );
      assert.equal(harness.calls.verify.length,0,scenario.name);
      assert.equal(harness.calls.readBytes.length,0,scenario.name);
      assert.equal(harness.calls.readChunks.length,0,scenario.name);
      assert.equal(harness.calls.realpath.length,0,scenario.name);
      assert.equal(harness.calls.probeOpen.length,0,scenario.name);
      assert.equal(harness.calls.retention.length,0,scenario.name);
      assert.equal(runtime.calls.length,0,scenario.name);
    }
    assert.equal(getterCalls,0);
    assert.equal(proxyTraps,0);
  });
});

test('readiness generation preserves synthetic environment policy at the fake backend',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await makeReadinessIntegrationFixture(root);
    const runtime=largeFakeRuntime(largeResultEnvelope(20));
    const harness=makeReadinessIntegrationPorts(fixture,runtime);
    const environment={
      PUBLIC:'synthetic-public',
      PATH:'/synthetic/bin',
      TMPDIR:'/synthetic/ambient-tmp'
    };
    for(const key of CODEX_CHILD_ENV_DELETIONS){
      environment[key]='synthetic-deleted-value';
    }
    harness.port.environment=environment;
    const result=await dispatchReadiness(fixture,harness);
    assert.equal(result.status,'CANDIDATE_STAGED');
    assert.equal(runtime.calls.length,1);
    const childEnvironment=runtime.calls[0][2].env;
    assert.equal(childEnvironment.PUBLIC,'synthetic-public');
    assert.equal(childEnvironment.PATH,'/synthetic/bin');
    assert.equal(childEnvironment.TMPDIR,`${fixture.config.scope}/.tmp`);
    for(const key of CODEX_CHILD_ENV_DELETIONS){
      assert.equal(Object.hasOwn(childEnvironment,key),false);
    }
  });
});

const artifactWrapperCompanions=[
  'src/desktop-readiness-evidence.mjs',
  'src/project-artifact-check-evidence.mjs',
  'src/artifact-verifier.mjs',
  'src/job-record.mjs'
];
const artifactWrapperUid=71;
function artifactWrapperTerminal({exit_code=0}={}){
  return {
    process:{
      pid:503,start_ticks:'53',
      boot_id:'00000000-0000-0000-0000-000000000001'
    },
    started_at_ms:100,ended_at_ms:101,
    direct_child_exit_observed:true,exit_kind:'natural',exit_code,
    signal:null,stdout_eof:true,stderr_eof:true,stop_codes:[],
    cleanup_codes:[],descendant_guarantee:'NOT_ESTABLISHED'
  };
}
const artifactWrapperSubset=(fixture,check)=>{
  const artifacts=check.artifact_ids.map(id=>{
    const item=fixture.context.artifacts.find(value=>value.artifact_id===id);
    return {
      artifact_id:item.artifact_id,role:item.role,
      relative_path:item.relative_path,byte_count:item.byte_count,
      sha256:item.sha256,staged_artifact_id:item.staged_artifact_id
    };
  }).sort((left,right)=>left.artifact_id<right.artifact_id?-1:1);
  return hash(canonicalBytes({
    domain:'squire.project-artifact-check.subset.v2',
    value:{
      job_id:fixture.config.job_id,
      operation_config_sha256:hash(fixture.configBytes),
      stage_manifest_sha256:fixture.stagePlan.manifest_sha256,
      artifacts
    }
  }));
};

async function makeArtifactWrapperFixture(root,options={}){
  const prepared=await largePreparedFixture(root);
  const config=readinessClone(prepared.config);
  const files=prepared.files;
  const configBytes=encoder.encode(JSON.stringify(config));
  const stageRoot=join(
    config.scope,'output',`run-${config.job_id}`,'stage'
  );
  const sourceBytes=encoder.encode('synthetic artifact wrapper application');
  const stagePlan=planLargeProjectStaging({
    stage_operation_id:`stage-${config.job_id}`,
    caller_label:'artifact-wrapper-stage',
    output_profile:PROFILE,
    files:[{
      path:'src/app.js',classification:'SOURCE',content:sourceBytes
    }]
  });
  const stageMember=stagePlan.files[0];
  const deliveryRoot=join(root,'artifact-wrapper-delivery');
  const artifacts=[
    {
      artifact_id:'main-app',role:'staged',root:stageRoot,
      relative_path:stageMember.path,byte_count:stageMember.bytes,
      sha256:stageMember.sha256,staged_artifact_id:null
    },
    {
      artifact_id:'copy-app',role:'delivered_copy',root:deliveryRoot,
      relative_path:'app.js',byte_count:stageMember.bytes,
      sha256:stageMember.sha256,staged_artifact_id:'main-app'
    }
  ];
  files.set(join(stageRoot,stageMember.path),new Uint8Array(sourceBytes));
  files.set(join(stageRoot,'stage-manifest.json'),
    new Uint8Array(stagePlan.manifest_bytes));
  files.set(join(deliveryRoot,'app.js'),new Uint8Array(sourceBytes));

  const companion_source_pins=Object.create(null);
  for(const relative of artifactWrapperCompanions){
    const path=join(PROJECT_SOURCE_ROOT,relative);
    let bytes=files.get(path);
    if(!bytes){
      bytes=encoder.encode(`synthetic pinned source ${relative}`);
      files.set(path,bytes);
    }
    companion_source_pins[relative]={
      bytes:bytes.length,sha256:hash(bytes)
    };
  }
  const checkIds=options.checkIds??['first-check','later-check'];
  const definitions=checkIds.map(id=>
    encoder.encode(`synthetic definition ${id}`)
  );
  const checks=checkIds.map((check_id,index)=>({
    check_id,
    definition_pin:{
      path:join(root,'artifact-wrapper-evidence',`${check_id}.definition`),
      bytes:definitions[index].length,sha256:hash(definitions[index])
    },
    receipt_pin:{
      path:join(root,'artifact-wrapper-evidence',`${check_id}.receipt`),
      bytes:1,sha256:'0'.repeat(64)
    },
    observer_role:'trusted_owner_fixture',
    artifact_ids:['copy-app','main-app']
  }));
  const context={
    schema:'squire.project_artifact_check_context.v2',
    operation_config_sha256:hash(configBytes),job_id:config.job_id,
    candidate:{
      source_commit:config.source_commit,stage_root:stageRoot,
      stage_operation_id:`stage-${config.job_id}`,
      stage_manifest_sha256:stagePlan.manifest_sha256
    },
    artifacts,required_checks:checks,
    observer_policy_sha256:'c'.repeat(64),companion_source_pins
  };
  const receipts=options.receipts??checkIds.map(()=>({}));
  for(let index=0;index<checks.length;index++){
    const check=checks[index];
    const receipt={
      schema:'squire.project_artifact_check_receipt.v2',
      check_id:check.check_id,definition_sha256:check.definition_pin.sha256,
      job_id:config.job_id,operation_config_sha256:hash(configBytes),
      stage_manifest_sha256:stagePlan.manifest_sha256,
      artifact_subset_sha256:artifactWrapperSubset(
        {config,configBytes,stagePlan,context},check
      ),
      observer_policy_sha256:context.observer_policy_sha256,
      observer_role:'trusted_owner_fixture',
      status:'passed',reason:'NONE',
      terminal:artifactWrapperTerminal(),limitations:[],
      ...readinessClone(receipts[index])
    };
    const receiptBytes=encoder.encode(JSON.stringify(receipt));
    check.receipt_pin={
      path:check.receipt_pin.path,
      bytes:receiptBytes.length,sha256:hash(receiptBytes)
    };
    files.set(check.definition_pin.path,new Uint8Array(definitions[index]));
    files.set(check.receipt_pin.path,receiptBytes);
  }
  const artifactContextBytes=encoder.encode(JSON.stringify(context));
  return {
    ...prepared,config,configBytes,context,artifactContextBytes,
    stageRoot,stagePlan,files
  };
}

function makeArtifactWrapperPorts(fixture,hooks={}){
  const nodes=new Map();
  const calls={verify:[],readBytes:[],lstat:[],realpath:[],open:[],
    read:[],close:[],readdir:[],mkdir:[],chmod:[],events:[]};
  let nextInode=10;
  const directory=path=>{
    if(nodes.has(path))return nodes.get(path);
    if(path!=='/')directory(dirname(path));
    const node={kind:'directory',ino:nextInode++};
    nodes.set(path,node);
    return node;
  };
  for(const [path,bytes] of fixture.files){
    directory(dirname(path));
    nodes.set(path,{
      kind:'file',ino:nextInode++,bytes:new Uint8Array(bytes)
    });
  }
  const stat=(node,bigint=false)=>{
    const number=value=>bigint?BigInt(value):value;
    return {
      dev:number(1),ino:number(node.ino),
      size:number(node.kind==='file'?node.bytes.length:1),
      mtimeNs:number(2),ctimeNs:number(3),
      mtimeMs:2,ctimeMs:3,
      mode:number(node.kind==='file'?0o100400:0o040700),
      uid:number(artifactWrapperUid),nlink:number(1),
      isFile:()=>node.kind==='file',
      isDirectory:()=>node.kind==='directory',
      isSymbolicLink:()=>false
    };
  };
  const missing=()=>Object.assign(new Error('synthetic missing'),{
    code:'ENOENT'
  });
  const fsPort={
    async lstat(path,options){
      calls.lstat.push(path);
      if(hooks.beforeLstat)await hooks.beforeLstat(path,calls);
      const node=nodes.get(path);
      if(!node)throw missing();
      return stat(node,options?.bigint===true);
    },
    async realpath(path){
      calls.realpath.push(path);
      if(hooks.realpath)return hooks.realpath(path,calls);
      return path;
    },
    async open(path){
      calls.open.push(path);
      const node=nodes.get(path);
      if(!node||node.kind!=='file')throw missing();
      let closedHandle=false;
      return {
        async stat(options){return stat(node,options?.bigint===true);},
        async read(buffer,offset,length,position){
          calls.read.push({path,position,length});
          if(hooks.read)await hooks.read(path,position,calls);
          const count=Math.min(length,Math.max(0,node.bytes.length-position));
          if(count)Uint8Array.prototype.set.call(
            buffer,node.bytes.subarray(position,position+count),offset
          );
          return {bytesRead:count};
        },
        async close(){
          if(closedHandle)throw new Error('DOUBLE_SYNTHETIC_CLOSE');
          closedHandle=true;
          calls.close.push(path);
        }
      };
    },
    async readdir(path){
      calls.readdir.push(path);
      const entries=[...nodes.keys()].filter(candidate=>
        candidate!==path&&dirname(candidate)===path
      ).map(candidate=>candidate.slice(path.length+1));
      if(hooks.afterReaddir)await hooks.afterReaddir(path,calls);
      return entries;
    },
    async mkdir(path){calls.mkdir.push(path);throw new Error('WRITE_FORBIDDEN');},
    async chmod(path){calls.chmod.push(path);throw new Error('WRITE_FORBIDDEN');}
  };
  const reads={
    async lstat(path){
      calls.events.push(`pin-lstat:${path}`);
      const node=nodes.get(path);
      if(!node)throw missing();
      return stat(node,false);
    },
    readChunks(path){
      calls.readChunks??=[];
      calls.readChunks.push(path);
      const node=nodes.get(path);
      if(!node||node.kind!=='file')throw missing();
      return (async function*(){
        for(let offset=0;offset<node.bytes.length;offset+=7){
          yield new Uint8Array(node.bytes.subarray(
            offset,Math.min(offset+7,node.bytes.length)
          ));
        }
      })();
    }
  };
  const port={
    fs:fsPort,uid:artifactWrapperUid,reads,
    async readBytes(path,maxBytes){
      calls.readBytes.push({path,maxBytes});
      calls.events.push(`read-bytes:${path}`);
      if(hooks.beforeReadBytes)await hooks.beforeReadBytes(path,calls);
      const node=nodes.get(path);
      if(!node||node.kind!=='file')throw missing();
      if(node.bytes.length>maxBytes)throw new Error('SYNTHETIC_READ_LIMIT');
      return new Uint8Array(node.bytes);
    },
    async verifyFile(identity,suppliedReads){
      calls.verify.push(identity.path);
      calls.events.push(`verify:${identity.path}`);
      if(hooks.beforeVerify)await hooks.beforeVerify(identity,calls);
      return verifyExactFile(identity,suppliedReads);
    }
  };
  return {port,calls,nodes};
}

async function expectArtifactWrapperCode(code,operation){
  await assert.rejects(operation,error=>
    error?.code===code&&error?.message===code
  );
}

async function settleArtifactWrapperGate(
  operation,entered,release,beforeRelease=()=>{}
){
  const outcome=Promise.resolve(operation).then(
    value=>({state:'fulfilled',value}),
    error=>({state:'rejected',error})
  );
  let boundary,failure,failureObserved=false;
  try{
    boundary=await Promise.race([
      entered.promise.then(()=>({state:'entered'})),
      outcome.then(result=>({state:'settled',result}))
    ]);
    assert.equal(
      boundary.state,'entered',
      boundary.state==='settled'
        ?`artifact wrapper settled ${boundary.result.state} before its hold`
        :'artifact wrapper did not enter its hold'
    );
    await beforeRelease();
  }catch(error){
    failure=error;
    failureObserved=true;
  }finally{
    release.resolve();
  }
  const settled=await outcome;
  if(failureObserved)throw failure;
  if(settled.state==='rejected')throw settled.error;
  return settled.value;
}

test('public artifact wrappers reject malformed envelopes, ports and abort brands before IO',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await makeArtifactWrapperFixture(root);
    const harness=makeArtifactWrapperPorts(fixture);
    await expectArtifactWrapperCode('INVALID_ARTIFACT_CONTEXT',
      verifyProjectArtifactChecksWithPorts(
        encoder.encode('{}'),fixture.artifactContextBytes,undefined,
        harness.port
      )
    );
    await expectArtifactWrapperCode('INVALID_ARTIFACT_CONTEXT',
      verifyProjectArtifactChecksWithPorts(
        fixture.configBytes,encoder.encode('{}'),undefined,harness.port
      )
    );
    let getterCalls=0,proxyTraps=0;
    const accessor={...harness.port};
    Object.defineProperty(accessor,'readBytes',{
      enumerable:true,get(){getterCalls++;return harness.port.readBytes;}
    });
    await expectArtifactWrapperCode('INVALID_ARTIFACT_CONTEXT',
      verifyProjectArtifactChecksWithPorts(
        fixture.configBytes,fixture.artifactContextBytes,undefined,accessor
      )
    );
    const proxy=new Proxy(harness.port,{
      ownKeys(){proxyTraps++;throw new Error('PRIVATE_PORT_PROXY');}
    });
    await expectArtifactWrapperCode('INVALID_ARTIFACT_CONTEXT',
      verifyProjectArtifactChecksWithPorts(
        fixture.configBytes,fixture.artifactContextBytes,undefined,proxy
      )
    );
    const forged=Object.create(AbortSignal.prototype);
    await expectArtifactWrapperCode('INVALID_ARTIFACT_CONTEXT',
      verifyProjectArtifactChecksWithPorts(
        fixture.configBytes,fixture.artifactContextBytes,forged,harness.port
      )
    );
    await expectArtifactWrapperCode('INVALID_ARTIFACT_CONTEXT',
      verifyProjectArtifactChecksWithPorts(
        fixture.configBytes,fixture.artifactContextBytes,
        new Proxy(new AbortController().signal,{}),harness.port
      )
    );
    await expectArtifactWrapperCode('INVALID_ARTIFACT_CONTEXT',
      verifyProjectArtifactChecks(
        new Uint8Array([0x7b]),new Uint8Array(),undefined
      )
    );
    assert.equal(getterCalls,0);
    assert.equal(proxyTraps,0);
    assert.deepEqual(harness.calls.verify,[]);
    assert.deepEqual(harness.calls.readBytes,[]);
    assert.deepEqual(harness.calls.open,[]);
  });
});

test('public wrapper verifies every source pin on warm calls before actual resolver IO',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await makeArtifactWrapperFixture(root);
    const harness=makeArtifactWrapperPorts(fixture);
    const expected=[
      ...Object.keys(fixture.config.source_pins).sort(),
      ...artifactWrapperCompanions.map(relative=>
        join(PROJECT_SOURCE_ROOT,relative)
      )
    ];
    const first=await verifyProjectArtifactChecksWithPorts(
      fixture.configBytes,fixture.artifactContextBytes,undefined,harness.port
    );
    assert.equal(first.sidecar.coverage,'DECLARED_CHECKS_PASSED');
    assert.equal(first.sidecar.reason,'NONE');
    assert.deepEqual(
      first.sidecar.check_results.map(item=>item.check_id),
      ['first-check','later-check']
    );
    assert.ok(first.sidecar.check_results.every(item=>
      item.status==='passed'&&item.evidence_binding==='verified'
    ));
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.sidecar));
    assert.deepEqual([...first.bytes],[...canonicalBytes(first.sidecar)]);
    assert.deepEqual(harness.calls.verify.slice(0,expected.length),expected);
    assert.deepEqual(harness.calls.verify.slice(expected.length),[
      fixture.context.required_checks[0].definition_pin.path,
      fixture.context.required_checks[1].definition_pin.path
    ]);
    assert.ok(harness.calls.readBytes.every(call=>call.maxBytes<=65536));
    assert.deepEqual(harness.calls.mkdir,[]);
    assert.deepEqual(harness.calls.chmod,[]);
    const before=harness.calls.verify.length;
    const warm=await verifyProjectArtifactChecksWithPorts(
      fixture.configBytes,fixture.artifactContextBytes,undefined,harness.port
    );
    assert.equal(warm.sidecar.coverage,'DECLARED_CHECKS_PASSED');
    assert.deepEqual(
      harness.calls.verify.slice(before,before+expected.length),expected
    );
  });
});

test('public wrapper preserves verified negatives and returns blocked evidence with every check ID',async()=>{
  await largeRunnerFixture(async root=>{
    const failed=await makeArtifactWrapperFixture(root,{
      receipts:[{
        status:'failed',reason:'CHECK_FAILED',
        terminal:artifactWrapperTerminal({exit_code:1})
      },{}]
    });
    const failedResult=await verifyProjectArtifactChecksWithPorts(
      failed.configBytes,failed.artifactContextBytes,undefined,
      makeArtifactWrapperPorts(failed).port
    );
    assert.equal(failedResult.sidecar.coverage,'DECLARED_CHECKS_FAILED');
    assert.deepEqual(
      failedResult.sidecar.check_results.map(item=>item.evidence_binding),
      ['verified','verified']
    );
    assert.equal(failedResult.sidecar.check_results[0].status,'failed');
    assert.equal(failedResult.sidecar.reason,'CHECK_FAILED');

    const missing=await makeArtifactWrapperFixture(root);
    missing.files.delete(
      missing.context.required_checks[0].receipt_pin.path
    );
    const blockedResult=await verifyProjectArtifactChecksWithPorts(
      missing.configBytes,missing.artifactContextBytes,undefined,
      makeArtifactWrapperPorts(missing).port
    );
    assert.equal(blockedResult.sidecar.coverage,'BLOCKED');
    assert.equal(blockedResult.sidecar.reason,'MISSING_EVIDENCE');
    assert.deepEqual(
      blockedResult.sidecar.check_results.map(item=>item.check_id),
      ['first-check','later-check']
    );
    assert.equal(blockedResult.sidecar.check_results[0].evidence_binding,
      'unresolved');
    assert.equal(blockedResult.sidecar.check_results[1].status,'passed');
    assert.equal(blockedResult.sidecar.check_results[1].evidence_binding,
      'verified');
  });
});

test('each companion and a base config pin failure stop before resolver reads',async()=>{
  await largeRunnerFixture(async root=>{
    for(const relative of artifactWrapperCompanions){
      const fixture=await makeArtifactWrapperFixture(root);
      fixture.context.companion_source_pins[relative].sha256='0'.repeat(64);
      fixture.artifactContextBytes=encoder.encode(
        JSON.stringify(fixture.context)
      );
      const harness=makeArtifactWrapperPorts(fixture);
      await expectArtifactWrapperCode('INVALID_ARTIFACT_CONTEXT',
        verifyProjectArtifactChecksWithPorts(
          fixture.configBytes,fixture.artifactContextBytes,undefined,
          harness.port
        )
      );
      assert.deepEqual(harness.calls.readBytes,[]);
      assert.equal(harness.calls.verify.includes(
        join(PROJECT_SOURCE_ROOT,relative)
      ),true);
    }

    const base=await makeArtifactWrapperFixture(root);
    const basePath=Object.keys(base.config.source_pins).sort()[0];
    base.config.source_pins[basePath].sha256='0'.repeat(64);
    base.configBytes=encoder.encode(JSON.stringify(base.config));
    base.context.operation_config_sha256=hash(base.configBytes);
    base.artifactContextBytes=encoder.encode(JSON.stringify(base.context));
    const harness=makeArtifactWrapperPorts(base);
    await expectArtifactWrapperCode('INVALID_ARTIFACT_CONTEXT',
      verifyProjectArtifactChecksWithPorts(
        base.configBytes,base.artifactContextBytes,undefined,harness.port
      )
    );
    assert.equal(harness.calls.verify.includes(basePath),true);
    assert.deepEqual(harness.calls.readBytes,[]);
  });
});

test('read-only artifact calls leave both generation admission fences available',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await makeArtifactWrapperFixture(root);
    const artifactHarness=makeArtifactWrapperPorts(fixture);
    const sidecar=await verifyProjectArtifactChecksWithPorts(
      fixture.configBytes,fixture.artifactContextBytes,undefined,
      artifactHarness.port
    );
    assert.equal(sidecar.sidecar.coverage,'DECLARED_CHECKS_PASSED');

    const runtime=largeFakeRuntime(largeResultEnvelope(20));
    const ports=largePreparedPorts(fixture,runtime);
    const verificationAttempts=[];
    let proofReads=0;
    const originalReadBytes=ports.readBytes;
    ports.readBytes=async function(...args){
      proofReads++;
      return Reflect.apply(originalReadBytes,this,args);
    };
    const earlyStop=new Error('SYNTHETIC_STOP_AFTER_ADMISSION');
    ports.verifyFile=async identity=>{
      verificationAttempts.push(identity.path);
      throw earlyStop;
    };

    let observed;
    try{
      await runProjectDesktopCodingLargeObservationWithPorts(
        fixture.configBytes,largePreparedAdmission(fixture),undefined,ports
      );
    }catch(error){observed=error;}
    assert.equal(observed,earlyStop);
    assert.deepEqual(verificationAttempts,[fixture.config.node.path]);
    assert.equal(proofReads,0);
    assert.equal(runtime.calls.length,0);
  });
});

test('falsy and private source-pin failures stay fixed and stop before resolver IO',async()=>{
  let getterCalls=0,proxyTraps=0;
  const privateError={};
  Object.defineProperty(privateError,'code',{
    get(){getterCalls++;throw Error('PRIVATE_CODE_GETTER');}
  });
  Object.defineProperty(privateError,'message',{
    get(){getterCalls++;throw Error('PRIVATE_MESSAGE_GETTER');}
  });
  const privateProxy=new Proxy({},{
    get(){proxyTraps++;throw Error('PRIVATE_PROXY_GET');},
    ownKeys(){proxyTraps++;throw Error('PRIVATE_PROXY_KEYS');},
    getOwnPropertyDescriptor(){
      proxyTraps++;throw Error('PRIVATE_PROXY_DESCRIPTOR');
    },
    getPrototypeOf(){
      proxyTraps++;throw Error('PRIVATE_PROXY_PROTOTYPE');
    }
  });
  const scenarios=[
    {name:'zero',kind:'base',thrown:0},
    {name:'null',kind:'base',thrown:null},
    {name:'undefined',kind:'companion',thrown:undefined},
    {name:'private-accessors',kind:'companion',thrown:privateError},
    {name:'private-proxy',kind:'companion',thrown:privateProxy}
  ];
  await largeRunnerFixture(async root=>{
    for(const scenario of scenarios){
      const fixture=await makeArtifactWrapperFixture(root);
      const basePaths=Object.keys(fixture.config.source_pins).sort();
      const failingPath=scenario.kind==='base'
        ?basePaths[0]
        :join(PROJECT_SOURCE_ROOT,artifactWrapperCompanions[0]);
      let failedHookCalls=0;
      const harness=makeArtifactWrapperPorts(fixture,{
        beforeVerify(identity){
          if(identity.path===failingPath){
            failedHookCalls++;
            throw scenario.thrown;
          }
        }
      });

      let exposed;
      try{
        await verifyProjectArtifactChecksWithPorts(
          fixture.configBytes,fixture.artifactContextBytes,undefined,
          harness.port
        );
      }catch(error){exposed=error;}
      assert.equal(failedHookCalls,1,scenario.name);
      assert.ok(exposed instanceof Error,scenario.name);
      const code=Object.getOwnPropertyDescriptor(exposed,'code');
      const message=Object.getOwnPropertyDescriptor(exposed,'message');
      assert.equal(code?.value,'INVALID_ARTIFACT_CONTEXT',scenario.name);
      assert.equal(message?.value,'INVALID_ARTIFACT_CONTEXT',scenario.name);
      assert.doesNotMatch(
        `${message.value}\n${code.value}\n${JSON.stringify(exposed)}`,
        /PRIVATE_(?:CODE|MESSAGE|PROXY)/
      );

      const expectedVerifications=scenario.kind==='base'
        ?[basePaths[0]]
        :[
          ...basePaths,
          join(PROJECT_SOURCE_ROOT,artifactWrapperCompanions[0])
        ];
      assert.deepEqual(
        harness.calls.verify,expectedVerifications,scenario.name
      );
      assert.deepEqual(harness.calls.readBytes,[],scenario.name);
      assert.deepEqual(harness.calls.open,[],scenario.name);
      assert.deepEqual(harness.calls.lstat,[],scenario.name);
      assert.deepEqual(harness.calls.realpath,[],scenario.name);
      assert.deepEqual(harness.calls.readdir,[],scenario.name);
      assert.deepEqual(harness.calls.mkdir,[],scenario.name);
      assert.deepEqual(harness.calls.chmod,[],scenario.name);
    }
  });
  assert.equal(getterCalls,0);
  assert.equal(proxyTraps,0);
});

test('public wrapper snapshots caller bytes, method receivers and ports before suspension',async()=>{
  await largeRunnerFixture(async root=>{
    const fixture=await makeArtifactWrapperFixture(root);
    const configBytes=fixture.configBytes;
    const contextBytes=fixture.artifactContextBytes;
    const harness=makeArtifactWrapperPorts(fixture);
    const port=harness.port;
    let getterCalls=0,receiverMismatch=false;
    const decorate=(owner,key)=>{
      const original=owner[key];
      const wrapped=function(...args){
        if(this!==owner)receiverMismatch=true;
        return Reflect.apply(original,this,args);
      };
      for(const property of ['name','length']){
        Object.defineProperty(wrapped,property,{
          configurable:true,get(){getterCalls++;throw new Error('PRIVATE_METADATA');}
        });
      }
      owner[key]=wrapped;
    };
    for(const key of ['open','mkdir','lstat','chmod','readdir','realpath']){
      decorate(port.fs,key);
    }
    for(const key of ['lstat','readChunks'])decorate(port.reads,key);
    decorate(port,'readBytes');
    const originalVerify=port.verifyFile;
    const entered=readinessDeferred(),release=readinessDeferred();
    let held=false;
    port.verifyFile=async function(identity,suppliedReads){
      if(this!==port)receiverMismatch=true;
      if(!held){
        held=true;entered.resolve();await release.promise;
      }
      return Reflect.apply(originalVerify,this,[identity,suppliedReads]);
    };
    const operation=verifyProjectArtifactChecksWithPorts(
      configBytes,contextBytes,undefined,port
    );
    const result=await settleArtifactWrapperGate(
      operation,entered,release,()=>{
        configBytes.fill(0);contextBytes.fill(0);
        port.verifyFile=async()=>{throw new Error('MUTATED_PORT_USED');};
        port.fs.lstat=async()=>{throw new Error('MUTATED_FS_USED');};
        port.reads.lstat=async()=>{throw new Error('MUTATED_READS_USED');};
      }
    );
    assert.equal(result.sidecar.coverage,'DECLARED_CHECKS_PASSED');
    assert.equal(getterCalls,0);
    assert.equal(receiverMismatch,false);
  });
});

test('pre-import abort stops bootstrap while post-bootstrap abort remains a BLOCKED sidecar',async()=>{
  await largeRunnerFixture(async root=>{
    const pre=await makeArtifactWrapperFixture(root);
    const preHarness=makeArtifactWrapperPorts(pre);
    const controller=new AbortController();
    controller.abort();
    await expectArtifactWrapperCode('OPERATION_ABORTED',
      verifyProjectArtifactChecksWithPorts(
        pre.configBytes,pre.artifactContextBytes,controller.signal,
        preHarness.port
      )
    );
    assert.deepEqual(preHarness.calls.verify,[]);
    assert.deepEqual(preHarness.calls.readBytes,[]);

    const held=await makeArtifactWrapperFixture(root);
    const heldHarness=makeArtifactWrapperPorts(held);
    const heldController=new AbortController();
    const entered=readinessDeferred(),release=readinessDeferred();
    let paused=false;
    const originalVerify=heldHarness.port.verifyFile;
    heldHarness.port.verifyFile=async function(identity,reads){
      if(!paused){
        paused=true;entered.resolve();await release.promise;
      }
      return Reflect.apply(originalVerify,this,[identity,reads]);
    };
    const pending=verifyProjectArtifactChecksWithPorts(
      held.configBytes,held.artifactContextBytes,heldController.signal,
      heldHarness.port
    );
    await expectArtifactWrapperCode('OPERATION_ABORTED',()=>(
      settleArtifactWrapperGate(
        pending,entered,release,()=>heldController.abort()
      )
    ));
    assert.deepEqual(heldHarness.calls.readBytes,[]);

    const post=await makeArtifactWrapperFixture(root);
    const postController=new AbortController();
    let aborted=false;
    const postHarness=makeArtifactWrapperPorts(post,{
      async afterReaddir(path){
        if(path===post.stageRoot&&!aborted){
          aborted=true;postController.abort();
        }
      }
    });
    const result=await verifyProjectArtifactChecksWithPorts(
      post.configBytes,post.artifactContextBytes,postController.signal,
      postHarness.port
    );
    assert.equal(result.sidecar.coverage,'BLOCKED');
    assert.equal(result.sidecar.reason,'ABORTED');
    assert.ok(result.sidecar.io_failures.includes('ABORTED'));
    assert.ok(result.sidecar.check_results.every(item=>
      item.evidence_binding==='unresolved'
    ));
    assert.equal(postHarness.calls.mkdir.length,0);
  });
});

// Public wrapper additions: 8 integration test bodies; previous 57 retained.
// Proposed integration total: 65. No tests were run for this proposal.
