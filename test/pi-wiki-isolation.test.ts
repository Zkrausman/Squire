import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const WIKI_UTILS = "file:///ticket/runtime/node_modules/@zosmaai/pi-llm-wiki/dist/extensions/llm-wiki/lib/utils.js";
const WIKI_RECALL = "file:///ticket/runtime/node_modules/@zosmaai/pi-llm-wiki/dist/extensions/llm-wiki/lib/recall.js";

/**
 * Exercise the resolved extension's session-start migration path and its real
 * wiki_recall tool in a child process. Keeping HOME/WIKI_HOME process-local
 * makes this test prove the launch boundary rather than changing the test
 * runner's own environment.
 */
test("run-scoped HOME and WIKI_HOME fence session_start migration and wiki_recall from host personal state", async () => {
  const root = await mkdtemp();
  const hostHome = path.join(root, "fake-host-home");
  const wikiHome = path.join(root, "run-scoped-wiki-home");
  const workspace = path.join(root, "workspace");
  const agentDir = path.join(root, "pi-agent");
  await mkdir(path.join(hostHome, ".llm-wiki", ".llm-wiki", "wiki"), { recursive: true });
  await mkdir(wikiHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const hostConfig = JSON.stringify({ topic: "host personal vault", mode: "personal" });
  const doubledConfig = JSON.stringify({ topic: "legacy doubled vault", mode: "personal" });
  const hostSentinel = "HOST_PERSONAL_SENTINEL_228: do not return this\n";
  const doubledSentinel = "HOST_DOUBLED_SENTINEL_228: migration must not touch this\n";
  await writeFile(path.join(hostHome, ".llm-wiki", "config.json"), `${hostConfig}\n`);
  await writeFile(path.join(hostHome, ".llm-wiki", ".llm-wiki", "config.json"), `${doubledConfig}\n`);
  await writeFile(path.join(hostHome, ".llm-wiki", "sentinel.md"), hostSentinel);
  await writeFile(path.join(hostHome, ".llm-wiki", ".llm-wiki", "wiki", "doubled-sentinel.md"), doubledSentinel);

  const childSource = `
    const { getPersonalWikiRoot, migrateDoubledPersonalVault } = await import(${JSON.stringify(WIKI_UTILS)});
    const { registerWikiRecall } = await import(${JSON.stringify(WIKI_RECALL)});
    let recall;
    registerWikiRecall({ registerTool(tool) { recall = tool; } }, undefined);
    const migration = migrateDoubledPersonalVault();
    const result = await recall.execute("isolation-test", { query: "HOST_PERSONAL_SENTINEL_228" }, undefined, undefined, { cwd: process.cwd() });
    process.stdout.write(JSON.stringify({
      personalRoot: getPersonalWikiRoot(),
      migration,
      text: result.content?.[0]?.text,
      isError: result.isError === true,
    }));
  `;
  const { stdout } = await execFile(
    process.execPath,
    ["--input-type=module", "-e", childSource],
    {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: hostHome,
        WIKI_HOME: wikiHome,
        PI_CODING_AGENT_DIR: agentDir,
      },
    },
  );
  const observed = JSON.parse(stdout) as { personalRoot: string; migration: unknown; text: string; isError: boolean };
  assert.equal(observed.personalRoot, wikiHome);
  assert.equal(observed.migration, null);
  assert.equal(observed.isError, true);
  assert.match(observed.text, /No wiki vault found/);
  assert.doesNotMatch(observed.text, /HOST_PERSONAL_SENTINEL_228|HOST_DOUBLED_SENTINEL_228/);

  assert.equal(await readFile(path.join(hostHome, ".llm-wiki", "config.json"), "utf8"), `${hostConfig}\n`);
  assert.equal(await readFile(path.join(hostHome, ".llm-wiki", ".llm-wiki", "config.json"), "utf8"), `${doubledConfig}\n`);
  assert.equal(await readFile(path.join(hostHome, ".llm-wiki", ".llm-wiki", "wiki", "doubled-sentinel.md"), "utf8"), doubledSentinel);
  await assert.rejects(lstat(path.join(wikiHome, ".llm-wiki")), { code: "ENOENT" });
});

async function mkdtemp(): Promise<string> {
  return (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "squire-wiki-isolation-"));
}
