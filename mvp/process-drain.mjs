import { open } from 'node:fs/promises';

// Subscribe to child stdout/stderr before awaiting filesystem work. On Windows,
// a short-lived child can close its pipe while the log is opening; subscribing
// afterward can lose bytes even when the process exited successfully.
export async function drainProcessStream(stream, filename, limit, keepMemory, kill, onChunk = undefined, openLog = open) {
  const opening = filename ? openLog(filename, 'wx', 0o600) : Promise.resolve(null);
  // The stream may be empty; observe an early open failure until finally awaits it.
  void opening.catch(() => {});
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
