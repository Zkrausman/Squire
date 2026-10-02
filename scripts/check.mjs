import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await check(filename);
    else if (filename.endsWith('.mjs')) execFileSync(process.execPath, ['--check', filename], { stdio: 'inherit', windowsHide: true });
  }
}
for (const directory of ['bin', 'src', 'scripts', 'test']) await check(directory);
