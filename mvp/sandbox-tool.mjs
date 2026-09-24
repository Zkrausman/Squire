import { spawn } from 'node:child_process';

// Host-side Pi has credentials; the model sees only this tool. Its shell runs
// in an isolated Docker Sandbox containing a disposable repository clone.
export default function (pi) {
  const sandbox = process.env.SQUIRE_SANDBOX_NAME;
  if (!sandbox || !/^[a-z0-9][a-z0-9.-]{1,63}$/.test(sandbox)) throw Error('Missing trusted sandbox identity');
  pi.registerTool({
    name: 'sandbox_exec', label: 'Sandbox command',
    description: 'Run a shell command ONLY in the isolated /ticket/workspace repository. No host file or credential access. Keep output short; do not invoke GitHub or Linear.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    async execute(_id, {command}, signal) {
      if (typeof command !== 'string' || !command.trim() || command.length > 4096) throw Error('Invalid command');
      const child = spawn('sbx', ['exec','-w','/ticket/workspace', sandbox,'sh','-lc',command], {windowsHide:true, stdio:['ignore','pipe','pipe'], signal});
      let output = '', size = 0;
      const timer = setTimeout(() => child.kill(), 180000);
      for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { size += chunk.length; if (output.length < 16000) output += chunk.toString('utf8').slice(0,16000-output.length); });
      const exitCode = await new Promise((resolve, reject) => { child.on('error',reject); child.on('close',resolve); }).finally(() => clearTimeout(timer));
      return { content:[{type:'text',text:`exit=${exitCode}; bytes=${size}${size>16000?' (truncated)':''}\n${output}`}], details:{exitCode, bytes:size} };
    },
  });
}
