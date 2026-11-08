import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {parse} from 'acorn';

const source=await readFile(new URL('../acceptance/project-entrypoint.mjs',import.meta.url),'utf8');
const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});

function walk(node,visit){
  if(!node||typeof node!=='object')return;
  if(typeof node.type==='string')visit(node);
  for(const value of Object.values(node)){
    if(Array.isArray(value))for(const child of value)walk(child,visit);
    else if(value&&typeof value==='object')walk(value,visit);
  }
}

function functionNode(name){
  let found=null;
  walk(ast,node=>{
    if(node.type==='FunctionDeclaration'&&node.id?.name===name)found=node;
  });
  assert.ok(found,`missing private function ${name}`);
  return found;
}

const adapterNode=functionNode('readNativeArtifactDirectory');
const adapterSource=source.slice(adapterNode.start,adapterNode.end);

function harness(options={}){
  const calls={open:[],read:0,close:0};
  const entries=options.entries??[];
  const fs={
    async opendir(path,settings){
      calls.open.push({path,settings});
      if(options.openError)throw options.openError;
      let index=0,reading=false;
      options.onOpen?.();
      return {
        async read(){
          assert.equal(reading,false,'directory reads must be sequential');
          reading=true;
          try{
            await Promise.resolve();
            calls.read++;
            if(options.readErrorAt===calls.read)throw options.readError;
            options.onRead?.({read:calls.read,index,eof:index>=entries.length});
            if(index>=entries.length)return null;
            const entry=entries[index++];
            return typeof entry==='string'?{name:entry}:entry;
          }finally{reading=false;}
        },
        async close(){
          calls.close++;
          if(options.closeError)throw options.closeError;
        }
      };
    }
  };
  const adapter=runInNewContext(`(${adapterSource})`,{
    fs,
    checkArtifactBootstrapAbort(signal){
      if(signal?.aborted){
        const error=new Error('OPERATION_ABORTED');
        error.code='OPERATION_ABORTED';
        throw error;
      }
    }
  });
  return {adapter,calls};
}

test('native wrapper wires its private adapter and passes the caller signal',()=>{
  const factory=source.slice(
    functionNode('nativeArtifactCheckPorts').start,
    functionNode('nativeArtifactCheckPorts').end
  );
  const wrapper=source.slice(
    functionNode('verifyProjectArtifactChecks').start,
    functionNode('verifyProjectArtifactChecks').end
  );
  assert.match(factory,/function nativeArtifactCheckPorts\(signal\)/);
  assert.match(factory,/readdir:path=>readNativeArtifactDirectory\(path,signal\)/);
  assert.match(wrapper,/nativeArtifactCheckPorts\(abortSignal\)/);
});

test('bounded native adapter reads empty and small directories sequentially and closes',async()=>{
  for(const entries of [[],['one'],['one','two','three']]){
    const f=harness({entries});
    const names=await f.adapter('/stage');
    assert.deepEqual(Array.from(names),entries);
    assert.equal(f.calls.open.length,1);
    assert.equal(f.calls.open[0].path,'/stage');
    assert.equal(f.calls.open[0].settings.bufferSize,1);
    assert.equal(f.calls.read,entries.length+1);
    assert.equal(f.calls.close,1);
  }
});

test('native adapter retains exactly 51 names through EOF',async()=>{
  const entries=Array.from({length:51},(_,index)=>`file-${index}`);
  const f=harness({entries});
  const names=await f.adapter('/stage');
  assert.deepEqual(Array.from(names),entries);
  assert.equal(f.calls.read,52);
  assert.equal(f.calls.close,1);
});

test('native adapter rejects the 52nd name before retaining it and closes',async()=>{
  const unreadNameError=new Error('52nd entry name must not be read');
  const unreadEntry=Object.defineProperty({},'name',{
    get(){throw unreadNameError;}
  });
  const entries=[
    ...Array.from({length:51},(_,index)=>`file-${index}`),unreadEntry
  ];
  const f=harness({entries});
  await assert.rejects(f.adapter('/stage'),/ARTIFACT_DIRECTORY_LIMIT/);
  assert.equal(f.calls.read,52);
  assert.equal(f.calls.close,1);
});

test('native adapter handles open, read, and close failures',async()=>{
  const openError=new Error('open failed');
  const unopened=harness({openError});
  await assert.rejects(unopened.adapter('/stage'),error=>error===openError);
  assert.equal(unopened.calls.close,0);

  const readError=new Error('read failed');
  const failedRead=harness({entries:['one'],readErrorAt:1,readError});
  await assert.rejects(failedRead.adapter('/stage'),error=>error===readError);
  assert.equal(failedRead.calls.close,1);

  const closeError=new Error('close failed');
  const failedClose=harness({closeError});
  await assert.rejects(failedClose.adapter('/stage'),error=>error===closeError);
  assert.equal(failedClose.calls.close,1);
});

test('native adapter closes after abort before, during, and at EOF',async()=>{
  const beforeSignal={aborted:true};
  const before=harness();
  await assert.rejects(before.adapter('/stage',beforeSignal),{code:'OPERATION_ABORTED'});
  assert.equal(before.calls.open.length,0);
  assert.equal(before.calls.close,0);

  const afterOpenSignal={aborted:false};
  const afterOpen=harness({onOpen(){afterOpenSignal.aborted=true;}});
  await assert.rejects(afterOpen.adapter('/stage',afterOpenSignal),{code:'OPERATION_ABORTED'});
  assert.equal(afterOpen.calls.close,1);

  const duringReadSignal={aborted:false};
  const duringRead=harness({entries:['one'],onRead(){duringReadSignal.aborted=true;}});
  await assert.rejects(duringRead.adapter('/stage',duringReadSignal),{code:'OPERATION_ABORTED'});
  assert.equal(duringRead.calls.read,1);
  assert.equal(duringRead.calls.close,1);

  const eofSignal={aborted:false};
  const atEof=harness({onRead({eof}){if(eof)eofSignal.aborted=true;}});
  await assert.rejects(atEof.adapter('/stage',eofSignal),{code:'OPERATION_ABORTED'});
  assert.equal(atEof.calls.read,1);
  assert.equal(atEof.calls.close,1);
});
