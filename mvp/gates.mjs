// Small, deterministic host decisions. Model prose is not test or CI evidence.
export function parsePi(raw) {
  let settled=false, final=null, usage={input:0,output:0,cacheRead:0,cacheWrite:0,cost:0};
  for(const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let x; try{x=JSON.parse(line)}catch{throw Error('Pi emitted invalid JSONL');}
    if(x.type==='agent_settled') settled=true;
    if(x.type==='message_end' && x.message?.role==='assistant') {
      let m=x.message;
      if(['stop','length','error','aborted'].includes(m.stopReason)) final=m;
      if(m.usage){for(let k of ['input','output','cacheRead','cacheWrite']) usage[k]+=m.usage[k]||0;usage.cost+=m.usage.cost?.total||0;}
    }
  }
  if(!settled || !final || final.stopReason!=='stop') throw Error('Pi did not settle with a successful final turn');
  return {usage, text:final.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||''};
}

export function reviewPassed(text) {
  return typeof text==='string' && /^PASS\r?\n/.test(text) && text.length < 16000;
}

export function exactHeadPassed({pr,expectedHead,expectedBase,checks,required}) {
  if(pr?.state!=='OPEN' || pr?.headRefOid!==expectedHead || pr?.baseRefName!==expectedBase) return false;
  if(!Array.isArray(checks) || !Array.isArray(required) || !required.length || new Set(required).size!==required.length) return false;
  if(checks.some(x=>x.bucket==='fail' || x.bucket==='pending' || x.bucket==='cancel')) return false;
  return required.every(name=>checks.some(x=>x.name===name && x.bucket==='pass' && x.state==='SUCCESS'));
}
