// Explicit local byte-copy ports only. No execution, discovery, publication or recovery.
import {types} from 'node:util';
import {constants} from 'node:fs';
import {resolve,join,dirname,parse} from 'node:path';
import {createHash} from 'node:crypto';
import {closed} from '../job-spec.mjs';

const limits=Object.freeze({SOURCE:[25,65536,524288,'source'],LOCAL_ASSET:[20,524288,2097152,'local_asset'],DOC:[5,65536,131072,'doc'],EVIDENCE_LOG:[10,262144,1048576,'evidence_log'],FRAME_CAPTURE:[10,1048576,5242880,'frame_capture']});
const project=['SOURCE','LOCAL_ASSET','DOC'],evidence=['EVIDENCE_LOG','FRAME_CAPTURE'];
const codes=new Set(['DESTINATION_ALREADY_EXISTS','SOURCE_NOT_FOUND','SOURCE_INTEGRITY_MISMATCH','STAGE_INTEGRITY_MISMATCH','STAGE_BINDING_MISMATCH','INVALID_STAGE_SPEC','INVALID_EXPORT_SPEC','INVALID_MANIFEST','SPECIAL_FILE_REJECTED','PATH_TRAVERSAL_REJECTED','PATH_COLLISION_REJECTED','CAPACITY_EXCEEDED','PRIVACY_VIOLATION_REJECTED','PACKAGE_IO_ERROR','PACKAGE_ABORTED']);
export class MultifilePackageError extends Error{constructor(code){super(codes.has(code)?code:'PACKAGE_IO_ERROR');this.code=codes.has(code)?code:'PACKAGE_IO_ERROR';delete this.stack;}}
const stop=code=>{throw new MultifilePackageError(code);};
function errorCode(e){try{if(types.isProxy(e))return null;return Object.getOwnPropertyDescriptor(e,'code')?.value;}catch{return null;}}
export const safeMultifileErrorCode=e=>codes.has(errorCode(e))?errorCode(e):'PACKAGE_IO_ERROR';
const digest=b=>createHash('sha256').update(b).digest('hex');
const compare=(a,b)=>a<b?-1:a>b?1:0;
const encoder=new TextEncoder();
function canonical(value){const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort(compare).map(k=>[k,sort(v[k])])):v;return encoder.encode(JSON.stringify(sort(value)));}
const frozen=v=>{if(v&&typeof v==='object'&&!types.isUint8Array(v)){for(const c of Object.values(v))frozen(c);Object.freeze(v);}return v;};
function boundary(code,fn){try{return fn();}catch(e){stop(codes.has(errorCode(e))?errorCode(e):code);}}
async function ioBoundary(fn){try{return await fn();}catch(e){stop(safeMultifileErrorCode(e));}}
const token=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
function array(value,max,code){
 if(types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)stop(code);
 const n=Object.getOwnPropertyDescriptor(value,'length')?.value;
 if(!integer(n)||n>max)stop('CAPACITY_EXCEEDED');
 if(Reflect.ownKeys(value).length!==n+1)stop(code);
 const out=[];for(let i=0;i<n;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))stop(code);out.push(d.value);}return out;
}
function bytes(v,max,code){
 if(types.isProxy(v)||!types.isUint8Array(v)||Object.getPrototypeOf(v)!==Uint8Array.prototype)stop(code);
 const n=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get.call(v);
 if(n>max)stop('CAPACITY_EXCEEDED');const copy=new Uint8Array(n);copy.set(v);return copy;
}
function relative(path){
 if(typeof path!=='string'||!path||path.length>256||!/^[a-zA-Z0-9._/-]+$/.test(path)||path.startsWith('/')||path.endsWith('/'))stop('PATH_TRAVERSAL_REJECTED');
 const parts=path.split('/');if(parts.length>7||parts.some(p=>!p||p==='.'||p==='..'||p.length>64||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)||['stage-manifest.json','export-manifest.json','package-manifest.json'].includes(p.toLowerCase()))||['project','evidence','frames'].includes(parts[0].toLowerCase()))stop('PATH_TRAVERSAL_REJECTED');return path;
}
function collisions(paths){
 const keys=paths.map(p=>p.toLowerCase()),seen=new Set();for(const key of keys){if(seen.has(key))stop('PATH_COLLISION_REJECTED');seen.add(key);}for(const key of keys){const parts=key.split('/');for(let i=1;i<parts.length;i++)if(seen.has(parts.slice(0,i).join('/')))stop('PATH_COLLISION_REJECTED');}
 const dirs=new Map();for(const path of paths){const p=path.split('/');for(let i=1;i<p.length;i++){const d=p.slice(0,i).join('/'),k=d.toLowerCase();if(dirs.has(k)&&dirs.get(k)!==d)stop('PATH_COLLISION_REJECTED');dirs.set(k,d);}}
}
function file(input,classes,content,code){
 closed(input,content?['path','classification','content']:['path','classification','bytes','sha256'],[],code);
 const path=relative(input.path),classification=input.classification;if(!classes.includes(classification))stop(code);
 if(content){const b=bytes(input.content,limits[classification][1],code);return {path,classification,bytes:b.length,sha256:digest(b),content:b};}
 if(!integer(input.bytes)||input.bytes>limits[classification][1])stop('CAPACITY_EXCEEDED');if(!sha(input.sha256))stop(code);return {path,classification,bytes:input.bytes,sha256:input.sha256};
}
function tally(files,classes){
 const counts=Object.fromEntries(classes.map(c=>[limits[c][3],0])),sums={};let total=0;
 for(const f of files){const [max,,aggregate,key]=limits[f.classification];counts[key]++;sums[key]=(sums[key]??0)+f.bytes;total+=f.bytes;if(counts[key]>max||sums[key]>aggregate||total>20971520)stop('CAPACITY_EXCEEDED');}return {counts,total};
}
function binding(value,code){closed(value,['stage_operation_id','stage_manifest_sha256'],[],code);if(!token(value.stage_operation_id)||!sha(value.stage_manifest_sha256))stop(code);return {...value};}
const metadata=f=>({path:f.path,classification:f.classification,bytes:f.bytes,sha256:f.sha256});
function finishPlan(kind,id,label,files,stageBinding){
 const exporting=kind==='export',classes=exporting?[...project,...evidence]:project,{counts,total}=tally(files,classes);
 files.sort((a,b)=>compare(exporting?a.export_subpath:a.path,exporting?b.export_subpath:b.path));collisions(files.map(f=>exporting?f.export_subpath:f.path));
 const manifest=exporting?{schema_version:'squire4.export_manifest.v1',export_operation_id:id,caller_label:label,stage_binding:stageBinding,file_counts:counts,total_files:files.length,total_bytes:total,files:files.map(f=>({...metadata(f),export_subpath:f.export_subpath}))}:{schema_version:'squire4.stage_manifest.v1',stage_operation_id:id,caller_label:label,file_counts:counts,file_count:files.length,total_bytes:total,files:files.map(metadata)};
 const mb=canonical(manifest);if(mb.length>(exporting?131072:65536)||total+mb.length>20971520)stop('CAPACITY_EXCEEDED');
 return frozen({schema:exporting?'SQUIRE4_EXPORT_PLAN_V1':'SQUIRE4_STAGE_PLAN_V1',[exporting?'export_operation_id':'stage_operation_id']:id,caller_label:label,...(exporting?{stage_binding:stageBinding}:{}),file_counts:counts,[exporting?'total_files':'file_count']:files.length,total_bytes:total,files,manifest,manifest_bytes:mb,manifest_sha256:digest(mb)});
}
export function planStaging(spec){return boundary('INVALID_STAGE_SPEC',()=>{
 closed(spec,['stage_operation_id','caller_label','files'],[],'stage');if(!token(spec.stage_operation_id)||!token(spec.caller_label))stop('INVALID_STAGE_SPEC');
 const files=array(spec.files,50,'INVALID_STAGE_SPEC').map(f=>file(f,project,true,'INVALID_STAGE_SPEC'));return finishPlan('stage',spec.stage_operation_id,spec.caller_label,files);
});}
export function planExport(spec){return boundary('INVALID_EXPORT_SPEC',()=>{
 closed(spec,['export_operation_id','caller_label','stage_binding','staged_files'],['evidence_files'],'export');if(!token(spec.export_operation_id)||!token(spec.caller_label))stop('INVALID_EXPORT_SPEC');
 const b=binding(spec.stage_binding,'INVALID_EXPORT_SPEC');
 const staged=array(spec.staged_files,50,'INVALID_EXPORT_SPEC').map(f=>{const v=file(f,project,false,'INVALID_EXPORT_SPEC');return {...v,export_subpath:'project/'+v.path,is_staged:true,content:null};});
 const extra=array(spec.evidence_files??[],20,'INVALID_EXPORT_SPEC').map(f=>{const v=file(f,evidence,true,'INVALID_EXPORT_SPEC');return {...v,export_subpath:(v.classification==='EVIDENCE_LOG'?'evidence/':'frames/')+v.path,is_staged:false};});
 return finishPlan('export',spec.export_operation_id,spec.caller_label,[...staged,...extra],b);
});}
function capture(plan,kind){return boundary(kind==='stage'?'INVALID_STAGE_SPEC':'INVALID_EXPORT_SPEC',()=>{
 const exporting=kind==='export',id=exporting?'export_operation_id':'stage_operation_id',count=exporting?'total_files':'file_count';
 closed(plan,['schema',id,'caller_label','file_counts',count,'total_bytes','files','manifest','manifest_bytes','manifest_sha256',...(exporting?['stage_binding']:[])],[],'plan');
 if(plan.schema!==(exporting?'SQUIRE4_EXPORT_PLAN_V1':'SQUIRE4_STAGE_PLAN_V1'))stop(exporting?'INVALID_EXPORT_SPEC':'INVALID_STAGE_SPEC');
 const fs=array(plan.files,exporting?70:50,'INVALID_STAGE_SPEC'),staged=[],extra=[];
 for(const f of fs){closed(f,['path','classification','bytes','sha256','content',...(exporting?['export_subpath','is_staged']:[])],[],'plan_file');
  if(exporting&&project.includes(f.classification)){if(f.content!==null||f.is_staged!==true||f.export_subpath!=='project/'+f.path)stop('INVALID_EXPORT_SPEC');staged.push(metadata(f));}
  else{const v=file({path:f.path,classification:f.classification,content:f.content},exporting?evidence:project,true,'INVALID_STAGE_SPEC');if(v.bytes!==f.bytes||v.sha256!==f.sha256||exporting&&(f.is_staged!==false||f.export_subpath!==(f.classification==='EVIDENCE_LOG'?'evidence/':'frames/')+f.path))stop(exporting?'INVALID_EXPORT_SPEC':'INVALID_STAGE_SPEC');extra.push(v);}}
 const p=exporting?planExport({export_operation_id:plan[id],caller_label:plan.caller_label,stage_binding:plan.stage_binding,staged_files:staged,evidence_files:extra.map(f=>({path:f.path,classification:f.classification,content:f.content}))}):planStaging({stage_operation_id:plan[id],caller_label:plan.caller_label,files:extra.map(f=>({path:f.path,classification:f.classification,content:f.content}))});
 // Metadata snapshot prevents getters/toJSON from entering canonical serialization.
 const data=snapshot(plan.manifest),counts=snapshot(plan.file_counts),mb=bytes(plan.manifest_bytes,exporting?131072:65536,'INVALID_MANIFEST');
 if(digest(canonical(data))!==p.manifest_sha256||digest(mb)!==p.manifest_sha256||plan.manifest_sha256!==p.manifest_sha256||JSON.stringify(counts)!==JSON.stringify(p.file_counts)||plan[count]!==p[count]||plan.total_bytes!==p.total_bytes)stop('INVALID_MANIFEST');return p;
});}
function snapshot(v,depth=0,budget={nodes:0,chars:0}){
 if(depth>12||++budget.nodes>2000)stop('INVALID_MANIFEST');
 if(typeof v==='string'){budget.chars+=v.length;if(v.length>1024||budget.chars>131072)stop('INVALID_MANIFEST');return v;}
 if(v===null||typeof v==='boolean'||integer(v))return v;if(types.isProxy(v))stop('INVALID_MANIFEST');
 if(Array.isArray(v))return array(v,70,'INVALID_MANIFEST').map(x=>snapshot(x,depth+1,budget));
 const keys=Object.keys(v??{});if(keys.length>20)stop('INVALID_MANIFEST');closed(v,[],keys,'data');const o={};for(const k of keys){budget.chars+=k.length;if(k.length>64||budget.chars>131072||['__proto__','prototype','constructor'].includes(k))stop('INVALID_MANIFEST');o[k]=snapshot(v[k],depth+1,budget);}return o;
}
function parseManifest(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{stop('INVALID_MANIFEST');}}
function portsOf(p){closed(p,['fs','uid'],['signal'],'ports');if(!integer(p.uid)||!p.fs)stop('PACKAGE_IO_ERROR');for(const k of ['open','mkdir','lstat','chmod','readdir'])if(typeof p.fs[k]!=='function')stop('PACKAGE_IO_ERROR');if(p.signal!==undefined&&(types.isProxy(p.signal)||!(p.signal instanceof AbortSignal)))stop('PACKAGE_IO_ERROR');return {fs:p.fs,uid:p.uid,signal:p.signal};}
const check=p=>{if(p.signal?.aborted)stop('PACKAGE_ABORTED');};
async function checked(p,fn){check(p);const v=await fn();check(p);return v;}
function selected(v){if(typeof v!=='string'||!v||v.includes('\0')||v.includes('\\')||v.split('/').includes('..'))stop('SPECIAL_FILE_REJECTED');const s=resolve(v);if(s===parse(s).root)stop('SPECIAL_FILE_REJECTED');return s;}
function statMetadata(s){if(!s||typeof s!=='object'||types.isProxy(s)||!integer(s.uid)||!integer(s.mode))stop('SPECIAL_FILE_REJECTED');}
function directory(s){statMetadata(s);if(typeof s.isDirectory!=='function'||typeof s.isSymbolicLink!=='function'||s.isDirectory()!==true||s.isSymbolicLink()!==false)stop('SPECIAL_FILE_REJECTED');for(const k of ['isSocket','isFIFO','isCharacterDevice','isBlockDevice'])if(s[k]!==undefined&&(typeof s[k]!=='function'||s[k]()!==false))stop('SPECIAL_FILE_REJECTED');}
async function validateAncestors(target,p){
 const parent=dirname(target),root=parse(parent).root,paths=[root];let current=root;
 for(const c of parent.slice(root.length).split('/').filter(Boolean)){current=join(current,c);paths.push(current);}
 for(const path of paths){const s=await checked(p,()=>p.fs.lstat(path));directory(s);const protectedMode=(s.mode&0o022)===0,rootSticky=s.uid===0&&(s.mode&0o1000)===0o1000;
  const permitted=path===parent?(s.uid===p.uid&&protectedMode)||rootSticky:((s.uid===0||s.uid===p.uid)&&protectedMode)||rootSticky;
  if(!permitted)stop('SPECIAL_FILE_REJECTED');
 }
}
async function validateTarget(root,p){const s=await checked(p,()=>p.fs.lstat(root));directory(s);if(s.uid!==p.uid||(s.mode&0o777)!==0o700)stop('SPECIAL_FILE_REJECTED');}
async function rootCheck(root,p){await validateAncestors(root,p);await validateTarget(root,p);}
async function reserve(root,p){await validateAncestors(root,p);try{await checked(p,()=>p.fs.mkdir(root,{recursive:false,mode:0o700}));}catch(e){if(errorCode(e)==='EEXIST')stop('DESTINATION_ALREADY_EXISTS');throw e;}await validateTarget(root,p);}
function regular(s,p,mode){statMetadata(s);if(typeof s.isFile!=='function'||typeof s.isSymbolicLink!=='function'||s.isFile()!==true||s.isSymbolicLink()!==false||s.uid!==p.uid||s.nlink!==1||(s.mode&0o777)!==mode)stop('SPECIAL_FILE_REJECTED');}
async function read(path,max,p,mode=0o400){await rootCheck(dirname(path),p);let h;try{
 const before=await checked(p,()=>p.fs.lstat(path));regular(before,p,mode);if(before.size>max)stop('CAPACITY_EXCEEDED');
 h=await p.fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);check(p);const opened=await checked(p,()=>h.stat());regular(opened,p,mode);if(before.dev!==opened.dev||before.ino!==opened.ino||before.size!==opened.size||before.mtimeMs!==opened.mtimeMs||before.ctimeMs!==opened.ctimeMs)stop('STAGE_INTEGRITY_MISMATCH');
 const b=new Uint8Array(max+1);let n=0;while(n<b.length){const length=Math.min(4096,b.length-n),r=await checked(p,()=>h.read(b,n,length,n));if(!integer(r.bytesRead)||r.bytesRead>length)stop('PACKAGE_IO_ERROR');if(!r.bytesRead)break;n+=r.bytesRead;if(n>max)stop('CAPACITY_EXCEEDED');}
 const after=await checked(p,()=>h.stat()),leaf=await checked(p,()=>p.fs.lstat(path));regular(after,p,mode);regular(leaf,p,mode);if(n!==before.size||[after,leaf].some(s=>s.dev!==opened.dev||s.ino!==opened.ino||s.size!==opened.size||s.mtimeMs!==opened.mtimeMs||s.ctimeMs!==opened.ctimeMs))stop('STAGE_INTEGRITY_MISMATCH');return b.slice(0,n);
 }finally{if(h)try{await h.close();}catch{stop('PACKAGE_IO_ERROR');}check(p);}}
function dirsFor(paths){const dirs=new Set();for(const path of paths){const parts=path.split('/');for(let i=1;i<parts.length;i++)dirs.add(parts.slice(0,i).join('/'));}return [...dirs].sort((a,b)=>a.split('/').length-b.split('/').length||compare(a,b));}
async function inventory(root,paths,p){const map=new Map([['',new Set()]]);for(const path of paths){const parts=path.split('/');for(let i=0;i<parts.length;i++){const dir=parts.slice(0,i).join('/');if(!map.has(dir))map.set(dir,new Set());map.get(dir).add(parts[i]);}}
 for(const [dir,names]of map){const d=dir?join(root,dir):root;await rootCheck(d,p);const entries=await checked(p,()=>p.fs.readdir(d));if(entries.length!==names.size||entries.some(n=>!names.has(n)))stop('STAGE_INTEGRITY_MISMATCH');}}
async function createDirs(root,paths,p){for(const d of dirsFor(paths)){await checked(p,()=>p.fs.mkdir(join(root,d),{recursive:false,mode:0o700}));await rootCheck(join(root,d),p);}}
async function write(path,content,p){let h;try{check(p);h=await p.fs.open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);check(p);await checked(p,()=>h.writeFile(content));}finally{if(h)try{await h.close();}catch{stop('PACKAGE_IO_ERROR');}check(p);}
 // Readback has the same bounded descriptor checks; transition only newly created files.
 const b=await read(path,content.length,p,0o600);if(b.length!==content.length||digest(b)!==digest(content))stop('SOURCE_INTEGRITY_MISMATCH');await checked(p,()=>p.fs.chmod(path,0o400));const s=await checked(p,()=>p.fs.lstat(path));regular(s,p,0o400);}
function manifestPlan(m,kind){return boundary('INVALID_MANIFEST',()=>{
 const exporting=kind==='export',id=exporting?'export_operation_id':'stage_operation_id',count=exporting?'total_files':'file_count';
 closed(m,['schema_version',id,'caller_label','file_counts',count,'total_bytes','files',...(exporting?['stage_binding']:[])],[],'manifest');if(m.schema_version!==`squire4.${kind}_manifest.v1`||!token(m[id])||!token(m.caller_label))stop('INVALID_MANIFEST');
 const entries=array(m.files,exporting?70:50,'INVALID_MANIFEST'),files=entries.map(f=>{closed(f,['path','classification','bytes','sha256',...(exporting?['export_subpath']:[])],[],'entry');const v=file(metadata(f),exporting?[...project,...evidence]:project,false,'INVALID_MANIFEST');if(exporting){const prefix=project.includes(v.classification)?'project/':v.classification==='EVIDENCE_LOG'?'evidence/':'frames/';if(f.export_subpath!==prefix+v.path)stop('INVALID_MANIFEST');return {...v,export_subpath:f.export_subpath,is_staged:project.includes(v.classification),content:null};}return v;});
 const p=finishPlan(kind,m[id],m.caller_label,files,exporting?binding(m.stage_binding,'INVALID_MANIFEST'):undefined);if(digest(canonical(snapshot(m)))!==p.manifest_sha256)stop('INVALID_MANIFEST');return p;
});}
async function inspect(root,p,kind){await rootCheck(root,p);const name=kind+'-manifest.json',mb=await read(join(root,name),kind==='stage'?65536:131072,p),m=parseManifest(mb),plan=manifestPlan(m,kind);
 // Exact canonical-byte equality rejects duplicate decoded keys, alternate number
 // spellings, extra whitespace, BOM and trailing bytes; no global parser change.
 if(digest(mb)!==plan.manifest_sha256)stop('INVALID_MANIFEST');await inventory(root,[...plan.files.map(f=>kind==='export'?f.export_subpath:f.path),name],p);const content=[];for(const f of plan.files){const b=await read(join(root,kind==='export'?f.export_subpath:f.path),limits[f.classification][1],p);if(b.length!==f.bytes||digest(b)!==f.sha256)stop('STAGE_INTEGRITY_MISMATCH');content.push(b);}check(p);return {plan,content};}
function receipt(plan,kind,verification=false){const exporting=kind==='export',id=exporting?'export_operation_id':'stage_operation_id',count=exporting?'total_files':'file_count';return frozen({schema_version:`squire4.${kind}_${verification?'verification':'receipt'}.v1`,...(verification?{status:'VERIFIED'}:{completion_status:'COMPLETE'}),[id]:plan[id],caller_label:plan.caller_label,...(exporting?{stage_binding:plan.stage_binding}:{}),manifest_sha256:plan.manifest_sha256,[count]:plan[count],total_bytes:plan.total_bytes,...(verification?{original_operation_acknowledgement:'UNKNOWN',exit_code:0}:{operation_acknowledgement:'ACKNOWLEDGED'}),provenance_authenticity:'NOT_ESTABLISHED',crash_durability:'NOT_ESTABLISHED'});}
function corrupt(kind){return frozen({schema_version:`squire4.${kind}_verification.v1`,status:'CORRUPT_OR_INCOMPLETE',[kind==='stage'?'stage_operation_id':'export_operation_id']:null,caller_label:null,...(kind==='export'?{stage_binding:null}:{}),manifest_sha256:null,[kind==='stage'?'file_count':'total_files']:null,total_bytes:null,original_operation_acknowledgement:'UNKNOWN',provenance_authenticity:'NOT_ESTABLISHED',crash_durability:'NOT_ESTABLISHED',exit_code:2});}
export async function writeStage(plan,output_dir,ports){return ioBoundary(async()=>{const p=portsOf(ports),copy=capture(plan,'stage'),root=selected(output_dir);await reserve(root,p);await createDirs(root,copy.files.map(f=>f.path),p);for(const f of copy.files)await write(join(root,f.path),f.content,p);await write(join(root,'stage-manifest.json'),copy.manifest_bytes,p);await inspect(root,p,'stage');check(p);return receipt(copy,'stage');});}
export async function verifyStage(stage_dir,ports){try{const p=portsOf(ports),s=await inspect(selected(stage_dir),p,'stage');check(p);return receipt(s.plan,'stage',true);}catch{return corrupt('stage');}}
async function assembleExport(plan,stage,root,p){
 const first=await inspect(stage,p,'stage');if(first.plan.stage_operation_id!==plan.stage_binding.stage_operation_id||first.plan.manifest_sha256!==plan.stage_binding.stage_manifest_sha256)stop('STAGE_BINDING_MISMATCH');
 const staged=plan.files.filter(f=>f.is_staged);if(canonical(staged.map(metadata)).toString()!==canonical(first.plan.files.map(metadata)).toString())stop('STAGE_BINDING_MISMATCH');
 const contents=new Map(first.plan.files.map((f,i)=>[f.path,first.content[i]]));await createDirs(root,plan.files.map(f=>f.export_subpath),p);
 for(const f of plan.files)await write(join(root,f.export_subpath),f.is_staged?contents.get(f.path):f.content,p);
 await write(join(root,'export-manifest.json'),plan.manifest_bytes,p);await inspect(root,p,'export');
 const after=await inspect(stage,p,'stage');if(after.plan.manifest_sha256!==first.plan.manifest_sha256)stop('STAGE_BINDING_MISMATCH');check(p);return receipt(plan,'export');
}
export async function writeExport(plan,stage_dir,output_dir,ports){return ioBoundary(async()=>{const p=portsOf(ports),copy=capture(plan,'export'),stage=selected(stage_dir),root=selected(output_dir);await reserve(root,p);return assembleExport(copy,stage,root,p);});}
export async function buildExport(spec,ports){return ioBoundary(async()=>{
 closed(spec,['export_operation_id','caller_label','stage_dir','export_dir','stage_manifest_sha256'],['evidence_files'],'build_export');
 if(!token(spec.export_operation_id)||!token(spec.caller_label)||!sha(spec.stage_manifest_sha256))stop('INVALID_EXPORT_SPEC');
 const p=portsOf(ports),stage=selected(spec.stage_dir),root=selected(spec.export_dir),id=spec.export_operation_id,label=spec.caller_label,expected=spec.stage_manifest_sha256;
 const owned=planExport({export_operation_id:id,caller_label:label,stage_binding:{stage_operation_id:'capture-only',stage_manifest_sha256:expected},staged_files:[],evidence_files:spec.evidence_files??[]}).files.map(f=>({path:f.path,classification:f.classification,content:f.content}));
 await reserve(root,p);const s=await inspect(stage,p,'stage');if(s.plan.manifest_sha256!==expected)stop('STAGE_BINDING_MISMATCH');
 const plan=planExport({export_operation_id:id,caller_label:label,stage_binding:{stage_operation_id:s.plan.stage_operation_id,stage_manifest_sha256:expected},staged_files:s.plan.files.map(metadata),evidence_files:owned});return assembleExport(plan,stage,root,p);
});}
export async function verifyExport(export_dir,ports){try{const p=portsOf(ports),s=await inspect(selected(export_dir),p,'export');check(p);return receipt(s.plan,'export',true);}catch{return corrupt('export');}}
