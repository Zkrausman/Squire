// Internal strict JSON grammar; callers supply finite byte/array profiles.
import {types} from 'node:util';
const invalid=reason=>{throw reason;};
function scalar(v){if(v!==null&&!['string','number','boolean'].includes(typeof v))invalid('SCHEMA_MISMATCH');if(typeof v==='number'&&!Number.isFinite(v))invalid('SCHEMA_MISMATCH');if(typeof v==='string'&&v.length>4096)invalid('SCHEMA_MISMATCH');return v;}
// Small bounded JSON grammar: decoded-key duplicates are rejected before JSON.parse.
export function parseBoundedJson(bytes,maxBytes,maxArrayLength) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxArrayLength)||maxArrayLength<1)invalid('SCHEMA_MISMATCH');
  if(!types.isUint8Array(bytes)||types.isProxy(bytes))invalid('MALFORMED_JSON');
  const length=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get.call(bytes);
  if(length>maxBytes)invalid('FILE_TOO_LARGE');
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{invalid('MALFORMED_UTF8');}
  let i=0;
  const ws=()=>{while(/[\x20\t\r\n]/.test(text[i]??'!'))i++;};
  function string(){
    if(text[i]!== '"')invalid('MALFORMED_JSON');const begin=i++;
    while(i<text.length){const c=text[i++];if(c==='"'){let v;try{v=JSON.parse(text.slice(begin,i));}catch{invalid('MALFORMED_JSON');}scalar(v);return v;}if(c==='\\')i++;}
    invalid('MALFORMED_JSON');
  }
  function value(depth){
    if(depth>10)invalid('SCHEMA_MISMATCH');ws();const c=text[i];
    if(c==='"')return string();
    if(c==='{'){
      i++;ws();const out=Object.create(null),seen=new Set();if(text[i]==='}'){i++;return out;}
      while(i<text.length){const k=string();if(seen.has(k))invalid('DUPLICATE_KEY_CONFLICT');if(['__proto__','constructor','prototype'].includes(k))invalid('SCHEMA_MISMATCH');seen.add(k);ws();if(text[i++]!==':')invalid('MALFORMED_JSON');out[k]=value(depth+1);ws();const t=text[i++];if(t==='}')return out;if(t!==',')invalid('MALFORMED_JSON');ws();}
      invalid('MALFORMED_JSON');
    }
    if(c==='['){i++;ws();const out=[];if(text[i]===']'){i++;return out;}while(i<text.length){if(out.length>=maxArrayLength)invalid('SCHEMA_MISMATCH');out.push(value(depth+1));ws();const t=text[i++];if(t===']')return out;if(t!==',')invalid('MALFORMED_JSON');}invalid('MALFORMED_JSON');}
    const match=/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if(!match)invalid('MALFORMED_JSON');i+=match[0].length;return scalar(JSON.parse(match[0]));
  }
  const result=value(0);ws();if(i!==text.length)invalid('MALFORMED_JSON');return result;
}
