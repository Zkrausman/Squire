// Owned fixture materialization only. No subprocess/model/generated source execution.
import * as fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {publicFixtures,fixtureArgv} from './public-fixtures.mjs';
import {oracle,sha256,canonicalBytes} from './reference-summarizer.mjs';
import {freezeBytes} from './freeze.mjs';
export async function materializePublicFreeze(root){
  if(typeof root!=='string'||resolve(root)!==root||root==='/')throw Error('FREEZE_ROOT_INVALID');
  await fs.mkdir(root,{mode:0o700}); // EEXIST fences: no replacement, repair or retry
  const pins=[];
  const write=async(path,bytes)=>{await fs.writeFile(join(root,path),bytes,{flag:'wx',mode:0o600});const read=await fs.readFile(join(root,path));if(sha256(read)!==sha256(bytes))throw Error('FREEZE_READBACK_MISMATCH');pins.push({path,bytes:bytes.length,sha256:sha256(read)});};
  for(const f of publicFixtures()){
    const dir=`fixture-${String(f.id).padStart(2,'0')}`;await fs.mkdir(join(root,dir),{mode:0o700});
    if(f.input_bytes)await write(dir+'/input.ndjson',f.input_bytes);
    const argv=fixtureArgv(f.id,{input_path:'/f/input.ndjson',output_path:'/f/summary.json',manifest_path:'/f/manifest.json'},f.window_start,f.window_end);
    const r=oracle({...f,argv});if(r.summary)await write(dir+'/expected-summary.json',r.summary);
  }
  await write('fixtures-freeze-manifest.json',freezeBytes());
  const source_pins=[];
  for(const name of ['public-fixtures.mjs','reference-summarizer.mjs','freeze.mjs','build-public-freeze.mjs']){
    const bytes=await fs.readFile(new URL(name,import.meta.url));source_pins.push({path:'fixtures/q218/'+name,bytes:bytes.length,sha256:sha256(bytes)});
  }
  const receipt=canonicalBytes({schema:'Q218_PHYSICAL_PUBLIC_FREEZE_V1',runtime_admitted:false,source_pins,artifacts:pins,
    reference_evaluation:'OWNED_PURE_BYTE_ORACLE_NO_CHILD_PROCESS',generated_program_executions:0,model_calls:0});
  await fs.writeFile(join(root,'physical-freeze-receipt.json'),receipt,{flag:'wx',mode:0o600});
  if(sha256(await fs.readFile(join(root,'physical-freeze-receipt.json')))!==sha256(receipt))throw Error('FREEZE_RECEIPT_MISMATCH');
  return {path:join(root,'physical-freeze-receipt.json'),bytes:receipt.length,sha256:sha256(receipt),artifacts:pins.length};
}
