import { writeSync, closeSync, createReadStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { SimpleQueueStore, runSimpleQueue } from '../dist/src/personal/simple-queue.js';

const [, , mode, id, flag, config] = process.argv;
if (mode !== '__queue_worker' || flag !== '--config' || process.env.SQUIRE_QUEUE_WORKER_CHANNEL !== 'fd3-v1') process.exit(2);
const stream = createReadStream('', { fd: 3, autoClose: false });
for await (const chunk of stream) { if (chunk.length > 2048) process.exit(2); }
const root = path.dirname(config);
const seal = { queueId: id, attestation: { approved: ['AIDEV-1', 'AIDEV-2'].map(ticketId => ({ ticketId, contractSha256: 'a'.repeat(64) })) } };
const result = await runSimpleQueue({ store: new SimpleQueueStore(root), seal,
  onReady() { writeSync(4, `READY ${id}\n`); closeSync(4); },
  async run(ticket, _digest, _signal, onReserved) {
    await onReserved(`fixture-${ticket}`);
    await delay(125);
    return { ticketId: ticket, runId: `fixture-${ticket}`, status: 'completed', publicationState: 'published', prUrl: `https://github.com/acme/repo/pull/${ticket.slice(-1)}` };
  },
});
process.exit(result.status === 'completed' ? 0 : 1);
