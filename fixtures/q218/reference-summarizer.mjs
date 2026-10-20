// Public independent oracle: pure byte transformation, never evaluates delivered code.
import {createHash} from 'node:crypto';
import {normalize} from 'node:path';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonicalBytes = value => new TextEncoder().encode(JSON.stringify(sort(value),null,2)+'\n');
function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
export function mean(total,count){if(count===0)return '0.00';const scaled=(BigInt(total)*200n+BigInt(count))/(BigInt(count)*2n);return `${scaled/100n}.${String(scaled%100n).padStart(2,'0')}`;}
export function parseArgs(args){
  if(!Array.isArray(args)||args.length!==10) return null;
  const found=Object.create(null),keys=['--input','--output','--manifest','--window-start','--window-end'];
  for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];if(!keys.includes(k)||Object.hasOwn(found,k)||typeof v!=='string'||!v.length)return null;found[k]=v;}
  for(const k of ['--window-start','--window-end'])if(!/^(0|[1-9][0-9]{0,15})$/.test(found[k])||!Number.isSafeInteger(Number(found[k])))return null;
  const paths=['--input','--output','--manifest'].map(k=>found[k]);
  if(new Set(paths).size!==3||paths.some(p=>normalize(p)!==p)||Number(found['--window-start'])>Number(found['--window-end']))return null;
  return found;
}
// JSON grammar first; flat-object token walk keeps original numeric lexemes and decoded key uniqueness.
export function record(line){
  try{
    if(line.includes('\r')||line.includes('\uFEFF'))return null;
    const value=JSON.parse(line);if(!value||Array.isArray(value)||typeof value!=='object')return null;
    const keys=new Set();let durationToken=null,i=0;
    const ws=()=>{while(/[\x20\t]/.test(line[i]??'!'))i++;};
    const string=()=>{const start=i++;while(i<line.length){if(line[i]==='\\'){i+=2;continue;}if(line[i++]==='"')return JSON.parse(line.slice(start,i));}throw Error('string');};
    ws();if(line[i++]!=='{')return null;ws();
    while(line[i]!=='}'){
      if(line[i]!=='"')return null;const k=string();if(keys.has(k))return null;keys.add(k);ws();if(line[i++]!==':')return null;ws();
      if(line[i]==='"')string();else{const begin=i;while(i<line.length&&![' ', '\t',',','}'].includes(line[i]))i++;const token=line.slice(begin,i);if(k==='duration_ms')durationToken=token;}
      ws();if(line[i]===','){i++;ws();continue;}if(line[i]!=='}')return null;
    }
    if(keys.size!==4||['timestamp','severity','duration_ms','message'].some(k=>!keys.has(k)))return null;
    if(typeof value.timestamp!=='string'||!/^20[0-9]{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$|^19[7-9][0-9]-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.timestamp))return null;
    const t=Date.parse(value.timestamp);if(!Number.isFinite(t)||new Date(t).toISOString()!==value.timestamp.replace('Z','.000Z'))return null;
    if(!['DEBUG','ERROR','INFO','WARN'].includes(value.severity)||!durationToken||!/^(0|[1-9][0-9]*)$/.test(durationToken)||value.duration_ms>86400000)return null;
    if(typeof value.message!=='string'||value.message.length>1024||/[\uD800-\uDFFF]/u.test(value.message)||value.message.includes('\uFEFF'))return null;
    return {...value,time:t};
  }catch{return null;}
}
export function oracle({argv,input_bytes,input_missing=false,write_error=false}){
  const args=parseArgs(argv);if(!args)return {exit_code:2,summary:null};
  if(input_missing||!(input_bytes instanceof Uint8Array)||input_bytes.length>5242880)return {exit_code:3,summary:null};
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input_bytes);}catch{return {exit_code:3,summary:null};}
  const lines=text.length?text.split('\n'):[];if(lines.at(-1)==='')lines.pop();if(lines.length>10000)return {exit_code:3,summary:null};
  const summary={total_processed_lines:lines.length,valid_records:0,unparsed_lines:0,by_severity:Object.fromEntries(['DEBUG','ERROR','INFO','WARN'].map(k=>[k,{count:0,min_duration_ms:null,max_duration_ms:null,total_duration_ms:0,mean_duration_ms:'0.00'}]))};
  for(let n=0;n<lines.length;n++){
    let line=lines[n]; // strip CR only when it was actually followed by LF
    if(line.endsWith('\r')&&(n<lines.length-1||text.endsWith('\n')))line=line.slice(0,-1);
    const r=record(line);if(!r){summary.unparsed_lines++;continue;}summary.valid_records++;
    if(r.time<Number(args['--window-start'])||r.time>=Number(args['--window-end']))continue;
    const s=summary.by_severity[r.severity];s.count++;s.min_duration_ms=s.min_duration_ms===null?r.duration_ms:Math.min(s.min_duration_ms,r.duration_ms);s.max_duration_ms=s.max_duration_ms===null?r.duration_ms:Math.max(s.max_duration_ms,r.duration_ms);s.total_duration_ms+=r.duration_ms;
  }
  for(const s of Object.values(summary.by_severity))s.mean_duration_ms=mean(s.total_duration_ms,s.count);
  if(write_error)return {exit_code:4,summary:null};
  return {exit_code:0,summary:canonicalBytes(summary)};
}
export function expectedManifest(source_sha256,summary){
  if(!/^[a-f0-9]{64}$/.test(source_sha256)||!(summary instanceof Uint8Array))throw Error('MANIFEST_RECIPE_INPUT');
  return canonicalBytes({manifest_version:'1.0',source_sha256,summary_bytes:summary.length,summary_sha256:sha256(summary)});
}
