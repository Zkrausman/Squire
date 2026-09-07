import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessLaunch } from "../src/pi/pi-process.js";
import { RealPiProcessFactory } from "./support/real-pi-process.js";

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

test("real Pi process reports a causal closed-stdin EPIPE without an uncaught exception", async () => {
  const factory = new RealPiProcessFactory();
  const spec: ProcessLaunch = {
    command: process.execPath,
    args: ["-e", "setTimeout(() => process.stdin.destroy(), 25); setTimeout(() => process.exit(0), 250);"],
    cwd: process.cwd(),
    env: {},
  };
  const real = await factory.spawn(spec);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  process.once("uncaughtException", onUncaught);
  let synchronousWriteError: unknown;
  const writer = setInterval(() => {
    try { real.stdin.write("late RPC bytes\n"); }
    catch (error) { synchronousWriteError = error; clearInterval(writer); }
  }, 1);
  try {
    const deadline = Date.now() + 5_000;
    while (!real.stdinError && Date.now() < deadline) await delay(5);
    assert.ok(real.stdinError, "the child must close stdin before its scheduled exit");
    const stdinError = real.stdinError as NodeJS.ErrnoException;
    assert.equal(stdinError.code, "EPIPE");
    assert.match(real.errors.join(""), /stdin: write EPIPE/u);
  } finally {
    clearInterval(writer);
    if (real.exitCode === null) real.kill("SIGKILL");
    await real.waitForExit(5_000);
    process.removeListener("uncaughtException", onUncaught);
  }
  assert.deepEqual(uncaught, [], "closed-child stdin errors must be observed by the support process, not uncaught");
  if (synchronousWriteError) assert.match(String(synchronousWriteError), /closed|destroyed|EPIPE/iu);
});
