// Test-only actual-process crash at charged correction dispatch. No network,
// model, installed controller, activation, or historical run is involved.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PersonalMvpController } from '../dist/src/personal/controller.js';
import { JsonRunStateStore } from '../dist/src/personal/json-run-state.js';
import { SandboxPiPhaseRunner } from '../dist/src/personal/pi-phase-runner.js';
const root = process.argv[2], base = 'a'.repeat(40), head = 'b'.repeat(40);
const states = new JsonRunStateStore(path.join(root, 'state'));
let input, current = base;
const runner = new SandboxPiPhaseRunner({ stagingRoot: root, testCommands: [], commands: {
  byteOutput: true,
  async run(spec) {
    if (spec.args[0] === 'cp') input = JSON.parse(await readFile(spec.args[1], 'utf8'));
    if (spec.args.includes('--no-tools')) {
      const state = await states.read('aidev-306-crash0123');
      if (state.reportCorrections.at(-1).kind !== 'launched') throw new Error('not charged before dispatch');
      process.exit(73); // hard controller exit, no finally/lease cleanup
    }
    if (!spec.args.includes('--print')) return { stdout: '', stdoutBytes: Buffer.alloc(0), stderr: '' };
    const implement = input.phase === 'implement';
    if (implement) current = head;
    const stdout = JSON.stringify({ outputHead: current, status: 'passed', summary: 'fixture', details: implement ? {
      changes: ['fixture'], projectWiki: { status: 'not_required', reason: 'fixture changes no durable knowledge' }, verification: ['untrusted'],
    } : { steps: ['implement'] } });
    return { stdout, stdoutBytes: Buffer.from(stdout), stderr: '' };
  },
} });
const controller = new PersonalMvpController({ states, phases: runner, newId: () => 'crash0123',
  tickets: { async get(id) { return { id, title: 'fixture', description: 'fixture' }; } },
  workspaces: { async prepare() { return { sandbox: 'fixture', baseSha: base, head: base }; }, async currentHead() { return current; }, async assertClean() {}, async committedProjectWikiPaths() { return []; }, async exportBundle() { throw new Error('no publication'); } },
  publication: { async publish() { throw new Error('no publication'); } },
});
await controller.run({ ticketId: 'AIDEV-306', repository: 'example/repo', repositoryPath: '/fixture', sourceRef: 'main', baseBranch: 'main' });
throw new Error('crash fixture unexpectedly returned');
