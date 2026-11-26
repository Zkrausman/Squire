// Prepare a private array of observed base facts, not an import authorization.
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import {basename,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {draftProjectBasePreimages} from '../src/project-review-candidate.mjs';
import {absolute,ancestors,stable} from '../src/internal/revision-review-core.mjs';

const usage='Usage: node bin/squire-base-preimage-draft.mjs <standard|large> <base-git-dir> <dev> <ino> <commit> <tree> <fresh-draft.json> <path> [<path> ...]\n';
const overlaps=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const reject=()=>{throw new Error('PROJECT_BASE_PREIMAGE_DRAFT_REJECTED');};
function identityNumber(text){
  if(typeof text!=='string'||!/^(0|[1-9][0-9]*)$/.test(text))reject();
  const number=Number(text);
  if(!Number.isSafeInteger(number))reject();
  return number;
}
async function saveDraft(destination,bytes){
  await ancestors(fs,destination);
  const handle=await fs.open(destination,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{
    async function verify(size){
      const opened=await handle.stat(),leaf=await fs.lstat(destination);
      if(!leaf.isFile()||leaf.uid!==process.getuid()||leaf.nlink!==1||
         (leaf.mode&0o7777)!==0o600||leaf.size!==size||!stable(opened,leaf))reject();
    }
    await verify(0);
    await handle.writeFile(bytes);
    await verify(bytes.length);
    const readback=Buffer.alloc(bytes.length);
    let offset=0;
    while(offset<readback.length){
      const {bytesRead}=await handle.read(readback,offset,readback.length-offset,offset);
      if(bytesRead<=0)reject();
      offset+=bytesRead;
    }
    if(!readback.equals(bytes))reject();
    await verify(bytes.length);
  }finally{await handle.close();}
}

async function main(args){
  if(args.length===1&&args[0]==='--help')return process.stdout.write(usage);
  const [profile,base_git_dir,dev,ino,base_commit,base_tree,destination,...paths]=args;
  if(!['standard','large'].includes(profile)||!absolute(base_git_dir)||!absolute(destination)||
     paths.length<1||paths.length>50)reject();
  const protectedBase=basename(base_git_dir)==='.git'?dirname(base_git_dir):base_git_dir;
  if(overlaps(protectedBase,destination))reject();
  const rows=await draftProjectBasePreimages({profile,base_git_dir,base_git_identity:{dev:identityNumber(dev),ino:identityNumber(ino)},
    base_commit,base_tree,paths});
  const bytes=Buffer.from(JSON.stringify(rows,null,2)+'\n');
  if(bytes.length>65536)reject();
  await saveDraft(destination,bytes);
  process.stdout.write('PROJECT_BASE_PREIMAGE_DRAFT_PREPARED\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const outputError=()=>{process.exitCode=2;};
  process.stdout.on('error',outputError);
  process.stderr.on('error',outputError);
  try{await main(process.argv.slice(2));}
  catch{process.exitCode=2;process.stderr.write('PROJECT_BASE_PREIMAGE_DRAFT_REJECTED\n');}
}
