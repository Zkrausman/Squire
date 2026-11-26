import {readFileSync} from 'node:fs';

export const mixedTransport=readFileSync(new URL('./mixed.jsonl',import.meta.url));
const [startRecord,messageRecord,completedRecord]=mixedTransport.toString('utf8').trimEnd().split('\n');
export const mixedEnvelope=String.raw`{"schema": "SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":[{"path":"src/mix.js","classification":"SOURCE","encoding":"utf-8","content":"café\n\"\\Ω"},{"path":"assets/mix.bin","classification":"LOCAL_ASSET","encoding":"base64","content":"AP+AQQ=="}]}`;

// Keep the byte oracle separate from the transport and its JSON/base64 decoders.
export const mixedFiles=[
  {path:'src/mix.js',classification:'SOURCE',bytes:10,
    content:Uint8Array.of(0x63,0x61,0x66,0xc3,0xa9,0x0a,0x22,0x5c,0xce,0xa9)},
  {path:'assets/mix.bin',classification:'LOCAL_ASSET',bytes:4,
    content:Uint8Array.of(0x00,0xff,0x80,0x41)}
];
const repeatedMessage=Buffer.from([startRecord,messageRecord,messageRecord,completedRecord,''].join('\n'));
const conflictingTerminal=Buffer.concat([mixedTransport,Buffer.from('{"type":"turn.failed"}\n')]);

export const rejections=[
  ['missing stderr EOF',mixedTransport,436,false,'COLLECTION','COLLECTION_FAILED'],
  ['repeated message',repeatedMessage,794,true,'RESPONSE','AMBIGUOUS_AGENT_MESSAGE'],
  ['conflicting terminal',conflictingTerminal,459,true,'ENVELOPE','CONFLICTING_TERMINAL_EVENTS']
];
