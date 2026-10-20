// Owned, entirely public synthetic inputs. No private benchmarks or prior outputs.
const enc=s=>new TextEncoder().encode(s);
const row=(changes={})=>JSON.stringify({timestamp:'2026-10-02T00:00:00Z',severity:'INFO',duration_ms:10,message:'public synthetic',...changes});
const lines=xs=>enc(xs.join('\n')+'\n');
const nominal=()=>lines(Array.from({length:10},()=>row()));
export function fixtureArgv(id,{input_path,output_path,manifest_path},start='0',end='2000000000000'){
  const args=['--input',input_path,'--output',output_path,'--manifest',manifest_path,'--window-start',start,'--window-end',end];
  if(id===11)args.splice(0,2,'--input='+input_path);
  if(id===12)args.splice(7,1,'5000000'),args.splice(9,1,'1000000');
  if(id===13){args.splice(4,2);args[1]=input_path+'.missing';}
  if(id===17){args[3]='/proc/nonexistent-dir/summary.json';args[5]='/proc/nonexistent-dir/manifest.json';}
  return args;
}
export function publicFixtures(){
  const f=[];const add=(id,bytes,options={})=>f.push({id,input_bytes:bytes,window_start:'0',window_end:'2000000000000',...options});
  add(1,lines(Array.from({length:50},(_,i)=>row({timestamp:`2026-10-${String(1+i%5).padStart(2,'0')}T00:00:00Z`,severity:['DEBUG','INFO','WARN','ERROR'][i%4],duration_ms:10+(i*4990)%4991})+(i%2?'\r':''))),{window_start:'1790812800000',window_end:'1790985600000'});
  add(2,new Uint8Array(),{window_end:'1000000000000'});
  add(3,lines([...Array.from({length:5},()=>row()),...Array.from({length:5},()=>row().replace('"severity":"INFO"','"severity":"INFO","\\u0073everity":"WARN"'))]));
  add(4,lines(Array.from({length:10},(_,i)=>(i===0||i===5?'\uFEFF':'')+row())));
  add(5,lines(Array.from({length:8},(_,i)=>row({message:i<4?'😀':i%2?'\uD800':'\uDC00'}))));
  add(6,lines(['2024-02-29T12:00:00Z','2023-02-29T12:00:00Z','2026-10-02T00:00:60Z','2026-10-02T00:00:00+00:00','1970-01-01T00:00:00Z','2099-12-31T23:59:59Z'].map(timestamp=>row({timestamp}))));
  add(7,lines(['"100"','-10','10.5','+50','1e3','-0','0','86400000','86400001','12.0'].map(n=>row().replace('"duration_ms":10','"duration_ms":'+n))));
  add(8,lines(['2026-10-02T00:00:00Z','2026-10-01T23:59:59Z','2026-10-02T23:59:59Z','2026-10-03T00:00:00Z','2026-10-03T00:00:01Z'].map(timestamp=>row({timestamp}))),{window_start:'1790812800000',window_end:'1790899200000'});
  add(9,enc(row()+'\r\n'+row()+'\r '+ '\n\n \t\n'+row()+'\n'));
  add(10,lines([['DEBUG',10,3],['INFO',5,2],['WARN',1,8],['ERROR',3,8]].flatMap(([severity,total,count])=>Array.from({length:count},(_,i)=>row({severity,duration_ms:i===0?total:0})))));
  add(11,nominal(),{window_end:'1000'});add(12,nominal());add(13,null,{input_missing:true,window_end:'1000'});add(14,new Uint8Array([255,0]),{window_end:'1000000'});
  add(15,lines(Array.from({length:10001},()=>row())));add(16,enc('x'.repeat(5242881)));add(17,nominal(),{write_error:true,window_end:'1000'});
  return f;
}
