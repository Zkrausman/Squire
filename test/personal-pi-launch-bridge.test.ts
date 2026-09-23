import assert from "node:assert/strict";
import { test } from "node:test";
import registerSquireLaunch from "../src/personal/pi-launch-bridge.js";

test("trusted Pi bridge exposes only the bounded /squire-run command", async () => {
  let command = "";
  let handler: ((args: string, context: any) => Promise<void>) | undefined;
  registerSquireLaunch({ registerCommand(name, options) { command = name; handler = options.handler; } });
  assert.equal(command, "squire-run");
  assert.ok(handler);
  const context = { cwd: process.cwd(), modelRegistry: { getAvailable: () => [] }, ui: { notify() {} } };
  await assert.rejects(handler("AIDEV-323", context), /usage:/);
  await assert.rejects(handler("AIDEV-323 --config relative.json", context), /usage:/);
  await assert.rejects(handler("AIDEV-323 --config /nonexistent", context));
});
