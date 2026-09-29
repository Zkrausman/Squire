import { open } from 'node:fs/promises';

// Subscribe to child stdout/stderr before awaiting filesystem work. On Windows,
// a short-lived child can close its pipe while the log is opening; subscribing
// afterward can lose bytes even when the process exited successfully.
export async function drainProcessStream(stream, filename, limit, keepMemory, kill, onChunk = undefined, openLog = open) {
  const opening = filename ? openLog(filename, 'wx', 0o600) : Promise.resolve(null);
  // A silent child cannot advance the read loop: terminate promptly if opening
  // fails, while leaving the original rejection for the drain's finally block.
  void opening.catch(() => { kill(); });
  const chunks = [];
  let bytes = 0;
  let exceeded = false;
  let writeError;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > limit) {
        exceeded = true;
        kill();
        continue;
      }
      if (onChunk) {
        try { onChunk(chunk); } catch { /* activity extraction must never interrupt the primary session */ }
      }
      if (writeError) continue;
      try {
        const file = await opening;
        if (file) await file.write(chunk);
        if (keepMemory) chunks.push(chunk);
      } catch (error) {
        writeError = error;
        kill();
      }
    }
  } finally {
    await (await opening)?.close();
  }
  return { bytes, exceeded, writeError, buffer: keepMemory ? Buffer.concat(chunks) : undefined };
}
