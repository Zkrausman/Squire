import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const dir=path.dirname(fileURLToPath(import.meta.url));
const target=process.argv[2];if(!target)throw Error('Provide a new output archive path');
const m=JSON.parse(await readFile(path.join(dir,'evidence-parts.json'),'utf8')),pieces=[];
for(const p of m.parts){const b=await readFile(path.join(dir,p.name));if(b.length!==p.bytes||createHash('sha256').update(b).digest('hex')!==p.sha256)throw Error('Part integrity failure: '+p.name);pieces.push(b);}
const archive=Buffer.concat(pieces);if(createHash('sha256').update(archive).digest('hex')!==m.archiveSha256)throw Error('Archive integrity failure');
await writeFile(target,archive,{flag:'wx'});console.log(JSON.stringify({verified:true,bytes:archive.length,path:path.resolve(target)}));
