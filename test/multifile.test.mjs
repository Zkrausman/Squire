import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {planStaging,writeStage,verifyStage,safeMultifileErrorCode} from '../src/multifile-staging.mjs';
import {planExport,writeExport,buildExport,verifyExport} from '../src/multifile-export.mjs';
const enc=new TextEncoder(),hash=b=>createHash('sha256').update(b).digest('hex');
const content=enc.encode('// PUBLIC SYNTHETIC BYTES ONLY\n'),file=(path='src/app.mjs',classification='SOURCE',b=content)=>({path,classification,content:b});
const stage=(files=[file()])=>planStaging({stage_operation_id:'stage-1',caller_label:'synthetic',files});
const eplan=(p,extra=[])=>planExport({export_operation_id:'export-1',caller_label:'synthetic',stage_binding:{stage_operation_id:p.stage_operation_id,stage_manifest_sha256:p.manifest_sha256},staged_files:p.manifest.files,evidence_files:extra});
// Explicit fake filesystem namespace backed by owned temporary files. It is not
// a host isolation/ownership qualification: /owned maps only to this test's root.
const directoryStat=(uid,mode)=>({uid,mode,isDirectory:()=>true,isSymbolicLink:()=>false});
async function fixture(fn){const root=await fs.mkdtemp(join(process.cwd(),'multifile-fixture-'));await fs.chmod(root,0o700);const map=p=>{assert.ok(p==='/owned'||p.startsWith('/owned/'));return join(root,p.slice(6));};const io={};for(const k of ['open','mkdir','lstat','chmod','readdir'])io[k]=(p,...args)=>fs[k](map(p),...args);io.lstat=(p,...args)=>p==='/'?directoryStat(0,0o40755):fs.lstat(map(p),...args);try{await fn({root,map,ports:{fs:io,uid:process.getuid()}});}finally{await fs.rm(root,{recursive:true,force:true});}}
const rejects=(fn,code)=>assert.throws(fn,e=>safeMultifileErrorCode(e)===code);
test('multifile pure stage canonical metadata, exact bytes, no self hash and defensive ownership',()=>{
 const original=new Uint8Array([0,255,10]),p=stage([file('Z.bin','LOCAL_ASSET',original),file('a.mjs')]);original[0]=99;
 assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.files));assert.equal(p.files[0].path,'Z.bin');assert.deepEqual(p.files[0].content,new Uint8Array([0,255,10]));assert.equal(p.file_count,2);assert.equal(p.total_bytes,content.length+3);assert.equal(p.manifest_sha256,hash(p.manifest_bytes));assert.equal(p.manifest.files.length,2);assert.equal(new TextDecoder().decode(p.manifest_bytes).includes('\n'),false);assert.equal(p.manifest_bytes[0],123);
});
test('portable paths reject traversal, device and reserved names, excessive segments/length',()=>{
 for(const p of ['../a','/a','a/./b','a//b','a/','a\\b','a\0b','a:b','é','CON','aux.txt','a/COM9.js','project/a','Evidence/a','frames/a','stage-manifest.json','a/export-manifest.json','package-manifest.json','a/b/c/d/e/f/g/h','x'.repeat(65)])rejects(()=>stage([file(p)]),'PATH_TRAVERSAL_REJECTED');
 assert.equal(stage([file('a/b/c/d/e/f/g')]).file_count,1);
});
test('exact/casefold/prefix/directory casing collisions reject without renaming',()=>{
 for(const paths of [['a','a'],['A','a'],['src/a','src/a/b'],['a','a-b','a/x'],['SRC/a','src/A/b'],['Src/a','src/b']])rejects(()=>stage(paths.map(p=>file(p))),'PATH_COLLISION_REJECTED');
});
test('per-class counts, single-file and aggregate byte ceilings are finite',()=>{
 rejects(()=>stage(Array.from({length:26},(_,i)=>file('f'+i))),'CAPACITY_EXCEEDED');rejects(()=>stage([file('a','SOURCE',new Uint8Array(65537))]),'CAPACITY_EXCEEDED');
 rejects(()=>stage(Array.from({length:9},(_,i)=>file('f'+i,'SOURCE',new Uint8Array(65536)))),'CAPACITY_EXCEEDED');
 assert.equal(stage(Array.from({length:8},(_,i)=>file('f'+i,'SOURCE',new Uint8Array(65536)))).total_bytes,524288);
 for(const [kind,count,size,totalCount]of [['LOCAL_ASSET',21,524289,5],['DOC',6,65537,3]]){
  rejects(()=>stage(Array.from({length:count},(_,i)=>file('f'+i,kind))),'CAPACITY_EXCEEDED');rejects(()=>stage([file('a',kind,new Uint8Array(size))]),'CAPACITY_EXCEEDED');rejects(()=>stage(Array.from({length:totalCount},(_,i)=>file('f'+i,kind,new Uint8Array(size-1)))),'CAPACITY_EXCEEDED');}
 const p=stage();rejects(()=>eplan(p,Array.from({length:11},(_,i)=>file('e'+i,'EVIDENCE_LOG'))),'CAPACITY_EXCEEDED');rejects(()=>eplan(p,[file('frame','FRAME_CAPTURE',new Uint8Array(1048577))]),'CAPACITY_EXCEEDED');rejects(()=>eplan(p,Array.from({length:6},(_,i)=>file('f'+i,'FRAME_CAPTURE',new Uint8Array(1048576)))),'CAPACITY_EXCEEDED');
});
test('plain typed arrays, closed records and arrays reject proxies/accessors/custom prototypes without callbacks',()=>{
 let calls=0;const proxy=new Proxy({}, {ownKeys(){calls++;throw Error('private');}});rejects(()=>planStaging(proxy),'INVALID_STAGE_SPEC');
 const getter={stage_operation_id:'x',caller_label:'y',get files(){calls++;return [];}};rejects(()=>planStaging(getter),'INVALID_STAGE_SPEC');
 for(const b of [new Proxy(new Uint8Array(1),{}),new Uint16Array(1),new DataView(new ArrayBuffer(1)),new ArrayBuffer(1),Buffer.from('a')])rejects(()=>stage([file('a','SOURCE',b)]),'INVALID_STAGE_SPEC');
 const a=[];Object.defineProperty(a,'0',{get(){calls++;return file();}});rejects(()=>stage(a),'INVALID_STAGE_SPEC');assert.equal(calls,0);
 rejects(()=>stage([{...file(),unexpected:true}]),'INVALID_STAGE_SPEC');rejects(()=>stage([file('a','EVIDENCE_LOG')]),'INVALID_STAGE_SPEC');
});
test('owned-file stage and export partition exact copied bytes, modes, receipts and independent verifier',async()=>fixture(async f=>{
 const p=stage([file(),file('assets/x.bin','LOCAL_ASSET',new Uint8Array([255,0])),file('README.md','DOC',new Uint8Array())]);const ack=await writeStage(p,'/owned/stage',f.ports);assert.equal(ack.operation_acknowledgement,'ACKNOWLEDGED');assert.equal(JSON.stringify(ack).includes('/owned'),false);
 const v=await verifyStage('/owned/stage',f.ports);assert.equal(v.status,'VERIFIED');assert.equal(v.original_operation_acknowledgement,'UNKNOWN');
 const ep=eplan(p,[file('run.log','EVIDENCE_LOG'),file('image.bin','FRAME_CAPTURE',new Uint8Array([1,2,3]))]);const ex=await writeExport(ep,'/owned/stage','/owned/export',f.ports);assert.equal(ex.operation_acknowledgement,'ACKNOWLEDGED');assert.equal((await verifyExport('/owned/export',f.ports)).status,'VERIFIED');
 assert.deepEqual((await fs.readdir(f.map('/owned/export'))).sort(),['evidence','export-manifest.json','frames','project']);
 assert.deepEqual(await fs.readFile(f.map('/owned/export/project/src/app.mjs')),Buffer.from(content));assert.notEqual((await fs.stat(f.map('/owned/stage/src/app.mjs'))).ino,(await fs.stat(f.map('/owned/export/project/src/app.mjs'))).ino);
 for(const path of ['project/src/app.mjs','evidence/run.log','frames/image.bin','export-manifest.json'])assert.equal((await fs.stat(f.map('/owned/export/'+path))).mode&0o777,0o400);
 assert.equal(ex.provenance_authenticity,'NOT_ESTABLISHED');assert.equal(ex.crash_durability,'NOT_ESTABLISHED');assert.equal('task_correctness'in ex,false);
}));
test('exclusive destination stops before input reads and preserves existing file/directory/symlink',async()=>fixture(async f=>{
 for(const kind of ['dir','file','link']){const target='/owned/'+kind;if(kind==='dir')await fs.mkdir(f.map(target));else if(kind==='file')await fs.writeFile(f.map(target),'sentinel');else await fs.symlink('file',f.map(target));let opens=0;const ports={...f.ports,fs:{...f.ports.fs,open(){opens++;throw Error('must not read');}}};
 await assert.rejects(()=>buildExport({export_operation_id:'e',caller_label:'c',stage_dir:'/owned/missing',export_dir:target,stage_manifest_sha256:'a'.repeat(64)},ports),e=>e.code==='DESTINATION_ALREADY_EXISTS');assert.equal(opens,0);}
 assert.equal(await fs.readFile(f.map('/owned/file'),'utf8'),'sentinel');
}));
test('write-boundary forged/mutated plans fail before destination creation',async()=>fixture(async f=>{
 const p=stage();p.files[0].content[0]^=1;await assert.rejects(()=>writeStage(p,'/owned/bad',f.ports));await assert.rejects(()=>fs.stat(f.map('/owned/bad')),{code:'ENOENT'});
 const good=stage(),forged={...good,total_bytes:0};await assert.rejects(()=>writeStage(forged,'/owned/forged',f.ports));
 const ep=eplan(good,[file('e','EVIDENCE_LOG')]);ep.files.find(f=>!f.is_staged).content[0]^=1;await assert.rejects(()=>writeExport(ep,'/owned/stage','/owned/export',f.ports));
}));
test('foreign stage binding, subset omission and changed content are never exported as acknowledged',async()=>fixture(async f=>{
 const p=stage([file(),file('b')]);await writeStage(p,'/owned/stage',f.ports);
 for(const [i,ep]of [eplan(p),planExport({export_operation_id:'e',caller_label:'c',stage_binding:{stage_operation_id:'foreign',stage_manifest_sha256:p.manifest_sha256},staged_files:p.manifest.files}),planExport({export_operation_id:'e',caller_label:'c',stage_binding:{stage_operation_id:p.stage_operation_id,stage_manifest_sha256:p.manifest_sha256},staged_files:p.manifest.files.slice(0,1)})].entries()){
  if(i===0)continue;await assert.rejects(()=>writeExport(ep,'/owned/stage','/owned/out'+i,f.ports),e=>e.code==='STAGE_BINDING_MISMATCH');}
 await fs.chmod(f.map('/owned/stage/b'),0o600);await fs.writeFile(f.map('/owned/stage/b'),'changed');await fs.chmod(f.map('/owned/stage/b'),0o400);await assert.rejects(()=>writeExport(eplan(p),'/owned/stage','/owned/changed',f.ports));assert.equal((await verifyStage('/owned/stage',f.ports)).status,'CORRUPT_OR_INCOMPLETE');
}));
test('buildExport binds exact manifest and rechecks the complete source stage',async()=>fixture(async f=>{
 const p=stage();await writeStage(p,'/owned/stage',f.ports);const spec={export_operation_id:'e',caller_label:'c',stage_dir:'/owned/stage',export_dir:'/owned/export',stage_manifest_sha256:p.manifest_sha256};assert.equal((await buildExport(spec,f.ports)).completion_status,'COMPLETE');
 await assert.rejects(()=>buildExport({...spec,export_dir:'/owned/foreign',stage_manifest_sha256:'0'.repeat(64)},f.ports),e=>e.code==='STAGE_BINDING_MISMATCH');
}));
test('verification rejects extras, missing files, hardlinks, symlinks, executable modes and malformed manifests',async()=>fixture(async f=>{
 for(const [i,alter]of [async r=>fs.writeFile(join(r,'extra'),'x'),async r=>fs.unlink(join(r,'src/app.mjs')),async r=>{await fs.unlink(join(r,'src/app.mjs'));await fs.symlink('../stage-manifest.json',join(r,'src/app.mjs'));},async r=>fs.chmod(join(r,'src/app.mjs'),0o500),async r=>fs.link(join(r,'src/app.mjs'),join(r,'link')),async r=>{await fs.chmod(join(r,'stage-manifest.json'),0o600);await fs.writeFile(join(r,'stage-manifest.json'),'{}');await fs.chmod(join(r,'stage-manifest.json'),0o400);}].entries()){
  const dest='/owned/s'+i;await writeStage(stage(),dest,f.ports);await alter(f.map(dest));assert.equal((await verifyStage(dest,f.ports)).status,'CORRUPT_OR_INCOMPLETE');}
}));
test('all writes, handle closes, readbacks and chmod failures retain partial outputs and suppress ACK',async()=>fixture(async f=>{
 for(const [i,point]of ['write','close','read','chmod'].entries()){
  let fired=false;const io={...f.ports.fs,async open(...args){const h=await f.ports.fs.open(...args);return new Proxy(h,{get(t,k){if(['writeFile','close','read'].includes(k))return async(...a)=>{if(!fired&&k===({write:'writeFile',close:'close',read:'read'}[point])){fired=true;if(k==='close')await t.close();throw Error('/PRIVATE/path');}return t[k](...a);};const v=t[k];return typeof v==='function'?v.bind(t):v;}});},async chmod(...a){if(point==='chmod'&&!fired){fired=true;throw Error('/PRIVATE/path');}return f.ports.fs.chmod(...a);}};
  await assert.rejects(()=>writeStage(stage(),'/owned/f'+i,{...f.ports,fs:io}),e=>{assert.equal(e.message.includes('PRIVATE'),false);return true;});assert.ok(fired);assert.ok((await fs.stat(f.map('/owned/f'+i))).isDirectory());assert.equal((await verifyStage('/owned/f'+i,f.ports)).status,'CORRUPT_OR_INCOMPLETE');}
}));
test('late abort during final read close suppresses ACK and verification never reconstructs original ACK',async()=>fixture(async f=>{
 const c=new AbortController();let manifestReads=0;const io={...f.ports.fs,async open(path,...args){const h=await f.ports.fs.open(path,...args);if(path.endsWith('stage-manifest.json')&&typeof args[0]==='number'&&(args[0]&3)===0){manifestReads++;if(manifestReads===2)return new Proxy(h,{get(t,k){if(k==='close')return async()=>{await t.close();c.abort();};const v=t[k];return typeof v==='function'?v.bind(t):v;}});}return h;}};
 await assert.rejects(()=>writeStage(stage(),'/owned/late',{...f.ports,fs:io,signal:c.signal}),e=>e.code==='PACKAGE_ABORTED');const v=await verifyStage('/owned/late',f.ports);assert.equal(v.status,'VERIFIED');assert.equal(v.original_operation_acknowledgement,'UNKNOWN');
 assert.equal((await verifyStage('/owned/late',{...f.ports,signal:c.signal})).status,'CORRUPT_OR_INCOMPLETE');
}));
test('already aborted operation performs no creation; unsafe root and oversized metadata fail closed',async()=>fixture(async f=>{
 const c=new AbortController();c.abort();await assert.rejects(()=>writeStage(stage(),'/owned/no',{...f.ports,signal:c.signal}),e=>e.code==='PACKAGE_ABORTED');await assert.rejects(()=>fs.stat(f.map('/owned/no')),{code:'ENOENT'});
 await fs.symlink('.',f.map('/owned/link'));await assert.rejects(()=>writeStage(stage(),'/owned/link/no',f.ports),e=>e.code==='SPECIAL_FILE_REJECTED');
}));
test('safe errors never evaluate hostile error getters or proxy traps',async()=>fixture(async f=>{
 let called=0;const e=new Proxy({}, {get(){called++;throw Error('secret');},getOwnPropertyDescriptor(){called++;throw Error('secret');}});const ports={...f.ports,fs:{...f.ports.fs,mkdir(){throw e;}}};await assert.rejects(()=>writeStage(stage(),'/owned/x',ports),e=>e.code==='PACKAGE_IO_ERROR'&&e.stack===undefined);assert.equal(called,0);
}));
test('maximum 50 project plus 20 evidence files stage/export/verify without a legacy 64-array cap',async()=>fixture(async f=>{
 const files=[...Array.from({length:25},(_,i)=>file('s'+i)),...Array.from({length:20},(_,i)=>file('a'+i,'LOCAL_ASSET')),...Array.from({length:5},(_,i)=>file('d'+i,'DOC'))];const p=stage(files);await writeStage(p,'/owned/stage',f.ports);
 const evidence=[...Array.from({length:10},(_,i)=>file('e'+i,'EVIDENCE_LOG')),...Array.from({length:10},(_,i)=>file('f'+i,'FRAME_CAPTURE'))];const ep=eplan(p,evidence);assert.equal(ep.total_files,70);assert.equal((await writeExport(ep,'/owned/stage','/owned/export',f.ports)).total_files,70);assert.equal((await verifyExport('/owned/export',f.ports)).status,'VERIFIED');
}));
test('forged oversized plan metadata is rejected before filesystem activity',async()=>fixture(async f=>{
 const p=stage(),huge={...p,manifest:{...p.manifest,caller_label:'x'.repeat(131073)}};await assert.rejects(()=>writeStage(huge,'/owned/no',f.ports),e=>e.code==='INVALID_MANIFEST');await assert.rejects(()=>fs.stat(f.map('/owned/no')),{code:'ENOENT'});
 const many={...p,manifest:Object.fromEntries(Array.from({length:21},(_,i)=>['key'+i,0]))};await assert.rejects(()=>writeStage(many,'/owned/no2',f.ports));
}));
test('build captures identifiers, binding and evidence bytes before reentrant IO changes caller state',async()=>fixture(async f=>{
 const p=stage();await writeStage(p,'/owned/stage',f.ports);const b=new Uint8Array([1,2,3]),spec={export_operation_id:'original',caller_label:'original',stage_dir:'/owned/stage',export_dir:'/owned/export',stage_manifest_sha256:p.manifest_sha256,evidence_files:[file('e','EVIDENCE_LOG',b)]};let changed=false;
 const io={...f.ports.fs,async mkdir(...args){if(!changed){changed=true;b[0]=99;spec.export_operation_id='changed';spec.caller_label='changed';spec.stage_manifest_sha256='f'.repeat(64);spec.evidence_files=[];}return f.ports.fs.mkdir(...args);}};
 const ack=await buildExport(spec,{...f.ports,fs:io});assert.equal(ack.export_operation_id,'original');assert.equal(ack.caller_label,'original');assert.deepEqual(await fs.readFile(f.map('/owned/export/evidence/e')),Buffer.from([1,2,3]));
}));
test('manifest duplicate keys, noncanonical bytes, bad counts and changed export partitions reject',async()=>fixture(async f=>{
 for(const [i,transform]of [(t)=>t.replace('{','{"caller_label":"synthetic",'),t=>t+'\n',t=>t.replace('"file_count":1','"file_count":0')].entries()){
  const dest='/owned/s'+i;await writeStage(stage(),dest,f.ports);const path=f.map(dest+'/stage-manifest.json');await fs.chmod(path,0o600);await fs.writeFile(path,transform(await fs.readFile(path,'utf8')));await fs.chmod(path,0o400);assert.equal((await verifyStage(dest,f.ports)).status,'CORRUPT_OR_INCOMPLETE');}
 const p=stage();await writeStage(p,'/owned/stage',f.ports);await writeExport(eplan(p),'/owned/stage','/owned/export',f.ports);await fs.mkdir(f.map('/owned/export/evidence'),{mode:0o700});assert.equal((await verifyExport('/owned/export',f.ports)).status,'CORRUPT_OR_INCOMPLETE');
}));
test('read ports are bounded and overflow never becomes a verified artifact',async()=>fixture(async f=>{
 await writeStage(stage(),'/owned/stage',f.ports);let max=0;const io={...f.ports.fs,async open(...a){const h=await f.ports.fs.open(...a);return new Proxy(h,{get(t,k){if(k==='read')return async(...args)=>{max=Math.max(max,args[2]);const r=await t.read(...args);return {...r,bytesRead:args[2]+1};};const v=t[k];return typeof v==='function'?v.bind(t):v;}});}};
 assert.equal((await verifyStage('/owned/stage',{...f.ports,fs:io})).status,'CORRUPT_OR_INCOMPLETE');assert.ok(max<=4096);
}));
async function ancestorAttempt(target,stats,uid=1000){let mkdir=0,targetReads=0;const io={async lstat(p){if(p===target)targetReads++;if(!Object.hasOwn(stats,p))throw Object.assign(Error('missing'),{code:'ENOENT'});return stats[p];},async mkdir(){mkdir++;throw Error('stop after validated ancestors');},open(){throw Error('no reads');},chmod(){throw Error('no chmod');},readdir(){throw Error('no listing');}};let code;try{await writeStage(stage([]),target,{fs:io,uid});}catch(e){code=e.code;}return {code,mkdir,targetReads};}
test('ancestor amendment permits protected root/caller ancestors and bounded root-sticky parent',async()=>{
 const root=directoryStat(0,0o40755),caller=directoryStat(1000,0o40755);
 for(const [target,stats,uid]of [['/home/user/stage',{'/':root,'/home':root,'/home/user':caller},1000],['/tmp/stage',{'/':root,'/tmp':directoryStat(0,0o41777)},1000],['/tmp/user/stage',{'/':root,'/tmp':directoryStat(0,0o41777),'/tmp/user':caller},1000],['/home/stage',{'/':root,'/home':root},0],['/stage',{'/':root},0]]){
  assert.deepEqual(await ancestorAttempt(target,stats,uid),{code:'PACKAGE_IO_ERROR',mkdir:1,targetReads:0});}
});
test('ancestor amendment rejects writable, foreign, symlink and non-root root-parent cases before mkdir',async()=>{
 const root=directoryStat(0,0o40755),safe=directoryStat(1000,0o40700);
 for(const [uid,mode]of [[0,0o40775],[0,0o40777],[1000,0o40770],[1000,0o41777],[1001,0o40755],[1001,0o41777]]){
  const r=await ancestorAttempt('/a/user/stage',{'/':root,'/a':directoryStat(uid,mode),'/a/user':safe});assert.equal(r.code,'SPECIAL_FILE_REJECTED');assert.equal(r.mkdir,0);}
 assert.equal((await ancestorAttempt('/home/stage',{'/':root,'/home':root})).code,'SPECIAL_FILE_REJECTED');
 assert.equal((await ancestorAttempt('/a/stage',{'/':root,'/a':{...safe,isSymbolicLink:()=>true}})).code,'SPECIAL_FILE_REJECTED');
 assert.equal((await ancestorAttempt('/a/stage',{'/':root,'/a':{...safe,isDirectory:()=>false}})).code,'SPECIAL_FILE_REJECTED');
 for(const mode of [0o40770,0o41777])assert.equal((await ancestorAttempt('/a/stage',{'/':root,'/a':directoryStat(1000,mode)})).code,'SPECIAL_FILE_REJECTED');
});
test('stat uid/mode are validated before masks; missing ancestor errors stay IO failure',async()=>{
 const root=directoryStat(0,0o40755);
 for(const key of ['uid','mode'])for(const value of [undefined,null,NaN,-1,1.5,Infinity,'0',Number.MAX_SAFE_INTEGER+1]){
  const s={...directoryStat(1000,0o40700),[key]:value},r=await ancestorAttempt('/a/stage',{'/':root,'/a':s});assert.equal(r.code,'SPECIAL_FILE_REJECTED');assert.equal(r.mkdir,0);}
 for(const s of [null,{}, {...directoryStat(1000,0o40700),isDirectory:true},{...directoryStat(1000,0o40700),isSocket:()=>true}])assert.equal((await ancestorAttempt('/a/stage',{'/':root,'/a':s})).code,'SPECIAL_FILE_REJECTED');
 assert.equal((await ancestorAttempt('/missing/stage',{'/':root})).code,'PACKAGE_IO_ERROR');
});
test('precreation validation never stats target, creates it once, and verification creates nothing',async()=>fixture(async f=>{
 let created=false,mkdir=0,preTarget=0;const io={...f.ports.fs,async lstat(p,...a){if(p==='/owned/stage'&&!created)preTarget++;return f.ports.fs.lstat(p,...a);},async mkdir(p,...a){mkdir++;const r=await f.ports.fs.mkdir(p,...a);if(p==='/owned/stage')created=true;return r;}};
 assert.equal((await writeStage(stage([]),'/owned/stage',{...f.ports,fs:io})).operation_acknowledgement,'ACKNOWLEDGED');assert.equal(mkdir,1);assert.equal(preTarget,0);
 assert.equal((await verifyStage('/owned/stage',{...f.ports,fs:io})).status,'VERIFIED');assert.equal(mkdir,1);
}));
test('postcreate uid/mode failure stops without content writes or permission repair',async()=>fixture(async f=>{
 for(const [i,patch]of [{uid:process.getuid()+1},{mode:0o40755},{mode:undefined}].entries()){
  let mkdir=0,opens=0,chmods=0;const target='/owned/s'+i;const io={...f.ports.fs,async mkdir(...a){mkdir++;return f.ports.fs.mkdir(...a);},async lstat(p,...a){const s=await f.ports.fs.lstat(p,...a);return p===target?{...s,...patch,isDirectory:s.isDirectory.bind(s),isSymbolicLink:s.isSymbolicLink.bind(s)}:s;},open(){opens++;throw Error('must not write');},chmod(){chmods++;throw Error('must not repair');}};
  await assert.rejects(()=>writeStage(stage([]),target,{...f.ports,fs:io}),e=>e.code==='SPECIAL_FILE_REJECTED');assert.equal(mkdir,1);assert.equal(opens,0);assert.equal(chmods,0);}
}));
test('native ports create only fresh owned test roots under ordinary protected ancestors',async()=>{
 const root=await fs.mkdtemp('/tmp/squire-multifile-owned-fixture-');await fs.chmod(root,0o700);const ports={fs,uid:process.getuid()};try{
  const p=stage(),dest=join(root,'stage'),out=join(root,'export');assert.equal((await writeStage(p,dest,ports)).completion_status,'COMPLETE');assert.equal((await verifyStage(dest,ports)).status,'VERIFIED');assert.equal((await writeExport(eplan(p),dest,out,ports)).completion_status,'COMPLETE');assert.equal((await verifyExport(out,ports)).status,'VERIFIED');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
