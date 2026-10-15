#!/usr/bin/env node
import { readInspectionConfig } from '../src/inspection-snapshot.mjs';
import { inspectTerminalStatus, parseTerminalStatusArgs, runTerminalStatusWatch,
  writeTerminalStatusFrame } from '../src/terminal-status.mjs';

const usage = 'Usage: node bin/squire-status.mjs PROJECT_CONFIG [TICKET_ID ...] [--watch=SECONDS]';
const shutdown = new AbortController();
let stdoutFailed = false;

function stopForSignal(signalCode) {
  if (!shutdown.signal.aborted) process.exitCode = signalCode;
  shutdown.abort();
  process.stdout.destroy();
}
process.once('SIGINT', () => stopForSignal(130));
process.once('SIGTERM', () => stopForSignal(143));
process.stdout.on('error', error => {
  stdoutFailed = true;
  if (shutdown.signal.aborted) return;
  shutdown.abort();
  process.exitCode = error?.code === 'EPIPE' ? 0 : 1;
});
process.stderr.on('error', () => {});

function failureFrame(ticketIds, failureCode) {
  return {
    type: 'squire.terminal-status', version: 1, projectId: null, capturedAt: null, durableUpdatedAt: null,
    durableFreshness: 'unknown', availability: 'unavailable', failureCode, projectStatus: 'unknown',
    tickets: ticketIds
      .map(ticketId => ({ ticketId, durableStatus: 'unknown', failureCode })),
    liveness: 'unknown'
  };
}

async function writeFrame(frame) {
  if (shutdown.signal.aborted || stdoutFailed) return false;
  const written = await writeTerminalStatusFrame(process.stdout, frame, { signal: shutdown.signal });
  if (!written && !shutdown.signal.aborted && !stdoutFailed) {
    stdoutFailed = true;
    shutdown.abort();
    process.exitCode = 1;
  }
  return written && !shutdown.signal.aborted && !stdoutFailed;
}

async function main() {
  const parsed = parseTerminalStatusArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage}\nDisplays selected durable status only; OS process liveness is always UNKNOWN.\n`);
    return;
  }
  if (parsed.failureCode) {
    await writeFrame(failureFrame([], parsed.failureCode));
    process.exitCode = 2;
    return;
  }

  const { configPath, ticketIds, watchSeconds } = parsed;
  if (!configPath) {
    process.stderr.write(`${usage}\n`); process.exitCode = 2; return;
  }

  let config;
  try { config = readInspectionConfig(configPath); }
  catch {
    await writeFrame(failureFrame(ticketIds, 'invalid_request')); process.exitCode = 1; return;
  }
  const read = () => inspectTerminalStatus({ ...config, ticketIds });
  if (watchSeconds === null || ticketIds.length === 0) {
    const result = read();
    await writeFrame(result);
    if (result.availability === 'unavailable' && !shutdown.signal.aborted) process.exitCode = 1;
    return;
  }

  await runTerminalStatusWatch(read, writeFrame, watchSeconds, { signal: shutdown.signal });
}

main().catch(() => {
  if (!shutdown.signal.aborted && !stdoutFailed) process.stderr.write('Squire terminal status failed [state_unavailable].\n');
  if (!shutdown.signal.aborted && !stdoutFailed) process.exitCode = 1;
});
