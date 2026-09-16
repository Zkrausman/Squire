import { rename as fsRename } from "node:fs/promises";

const RETRY_DELAYS_MS = [50, 100, 200] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

export interface RenameRetryOptions {
  readonly platform?: NodeJS.Platform | string;
  readonly rename?: (source: string, destination: string) => Promise<void>;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** Replace an existing file atomically, retrying only transient Windows sharing failures. */
export async function renameOverExistingWithRetry(source: string, destination: string, options: RenameRetryOptions = {}): Promise<void> {
  const rename = options.rename ?? fsRename;
  if ((options.platform ?? process.platform) !== "win32") return rename(source, destination);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await rename(source, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY") || attempt === MAX_ATTEMPTS - 1) throw error;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      await (options.sleep ?? sleep)(delay, options.signal);
    }
  }
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("operation was aborted");
}
