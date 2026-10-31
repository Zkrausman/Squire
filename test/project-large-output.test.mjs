import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
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
import {hash} from '../src/bounded-codegen-plan.mjs';
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
  runProjectDesktopCodingLargeObservationWithFailureDiagnosticsWithPorts,
  runProjectDesktopCodingLargeObservationWithPhaseDiagnosticsWithPorts
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
