import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { test } from "node:test";
import type { CommandPort, CommandRequest, CommandResult } from "../src/personal/command.js";
import { DockerSandboxWorkspace } from "../src/personal/docker-sandbox.js";
import { APPROVED_PERSONAL_MODEL_POLICY } from "../src/personal/model-policy.js";
import type { OwnerPiIdentity } from "../src/personal/runtime-parity.js";
import { launchTestRoot } from "./helpers/windows-launch.js";

const snapshot = Buffer.from('{"providers":{}}');
const snapshotHash = createHash("sha256").update(snapshot).digest("hex");
const identity: OwnerPiIdentity = {
  schema: 1, pid: process.pid, cliPath: process.execPath, version: "0.87.0", manifestSha256: "a".repeat(64), cliSha256: "b".repeat(64), codeTreeSha256: "d".repeat(64), modelConfigPath: path.resolve("models.json"), modelConfigSha256: null, phaseModelsSha256: "e".repeat(64), modelStorePath: path.resolve("models-store.json"), modelStoreSha256: snapshotHash, modelStoreSnapshotBase64: snapshot.toString("base64"),
  models: ["openai-codex/gpt-6-luna", "openai-codex/gpt-6-sol"], extensions: [],
};

class ParityCommands implements CommandPort {
  readonly requests: CommandRequest[] = [];
  constructor(readonly details: Record<string, string>, readonly catalog: string) {}
  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    if (request.args.includes("--input-type=module")) return { stdout: this.details["phaseModelsSha256"] ?? identity.phaseModelsSha256, stderr: "" };
    if (request.args.includes("-e")) return { stdout: JSON.stringify(this.details), stderr: "" };
    return { stdout: this.catalog, stderr: "" };
  }
}

const allModels = "openai-codex  gpt-6-luna  text\nopenai-codex  gpt-6-sol  text\n";
function workspace(commands: ParityCommands): DockerSandboxWorkspace {
  return new DockerSandboxWorkspace({ commands, bridgeRoot: "/private/bridge", stagingRoot: "/private/staging", ownerPi: identity, modelPolicy: APPROVED_PERSONAL_MODEL_POLICY });
}

test("sandbox parity checks package hashes and the actual extension-free Pi catalog", async () => {
  const commands = new ParityCommands({ name: "@earendil-works/pi-coding-agent", version: identity.version, manifestSha256: identity.manifestSha256, cliSha256: identity.cliSha256, modelStoreSha256: identity.modelStoreSha256, codeTreeSha256: identity.codeTreeSha256 }, allModels);
  await workspace(commands).assertRuntimeParity("sbx-name");
  assert.match(commands.requests[0]!.args.at(-1)!, /owned\('\/ticket'\).*visit\(tree\)/u);
  assert.deepEqual(commands.requests[2]!.args.slice(-4), ["--no-extensions", "--no-skills", "--list-models", "openai-codex"]);
  assert.ok(commands.requests[2]!.args.includes("PI_CODING_AGENT_DIR=/ticket/runtime/pi-agent"));
});

test("sandbox receives the captured model-store bytes, not a later live rewrite", async () => {
  const root = process.platform === "win32" ? await launchTestRoot("squire-model-store-race-") : await mkdtemp(path.join(os.tmpdir(), "squire-model-store-race-"));
  const live = path.join(root, "models-store.json");
  const auth = path.join(root, "auth.json");
  await writeFile(live, "later Pi refresh changed the live store");
  await writeFile(auth, "{}");
  const bound = { ...identity, modelStorePath: live };
  let stagedPath = "", copiedBytes = "";
  const commands: CommandPort = { async run(request) {
    if (request.command === "git" && request.args.includes("rev-parse")) return { stdout: "a".repeat(40), stderr: "" };
    if (request.args[0] === "cp" && request.args[2]?.endsWith("/models-store.json")) {
      stagedPath = request.args[1]!;
      copiedBytes = await readFile(stagedPath, "utf8");
    }
    if (request.args.includes("--input-type=module")) return { stdout: bound.phaseModelsSha256, stderr: "" };
    if (request.args.includes("-e")) return { stdout: JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: bound.version, manifestSha256: bound.manifestSha256, cliSha256: bound.cliSha256, modelStoreSha256: bound.modelStoreSha256, codeTreeSha256: bound.codeTreeSha256 }), stderr: "" };
    if (request.args.includes("--list-models")) return { stdout: allModels, stderr: "" };
    if (request.args.includes("rev-parse")) return { stdout: "a".repeat(40), stderr: "" };
    return { stdout: "", stderr: "" };
  } };
  try {
    const w = new DockerSandboxWorkspace({ commands, bridgeRoot: path.join(root, "bridges"), stagingRoot: path.join(root, "staging"), piAuthFile: auth, ownerPi: bound, modelPolicy: APPROVED_PERSONAL_MODEL_POLICY });
    await w.prepare({ runId: "aidev-322-1234567890", ticketId: "AIDEV-322", sandbox: "squire-aidev-322-test", branch: "squire/aidev-322-test", repositoryPath: root, sourceRef: "a".repeat(40) });
    assert.notEqual(stagedPath, live);
    assert.equal(copiedBytes, snapshot.toString("utf8"));
    assert.equal(await readFile(live, "utf8"), "later Pi refresh changed the live store");
    await assert.rejects(readFile(stagedPath), /ENOENT/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime install is sealed by root before model auth and before paid phases", async () => {
  const source = await readFile(path.resolve("src/personal/docker-sandbox.ts"), "utf8");
  assert.match(source, /await this\.#installPi\(input\.sandbox, signal\); await this\.#sealPi\(input\.sandbox, signal\)/u);
  assert.match(source, /chown -R root:root \/ticket\/runtime\/node_modules; chmod -R a-w/u);
  assert.match(source, /chown root:root \/ticket \/ticket\/runtime; chmod 755/u);
  assert.match(source, /async assertRuntimeParity\(sandbox:/u);
  assert.match(source, /chown root:root \$\{agent\} \$\{store\}; chmod 0444 \$\{store\}/u);
  assert.match(source, /chmod 1777 \$\{agent\}/u);
  assert.match(source, /\['models-store\.json','models\.json','settings\.json'\]/u);
  const phase = await readFile(path.resolve("src/personal/pi-phase-runner.ts"), "utf8");
  assert.match(phase, /legacyAgentOwnership = this\.#material\?\.ownerPi \? ""/u);
  assert.match(phase, /agentSetup = this\.#material\?\.ownerPi \? `test -d/u);
});

test("per-run Pi refuses an unprotected agent directory", () => {
  const commands = new ParityCommands({}, allModels);
  assert.throws(() => new DockerSandboxWorkspace({ commands, bridgeRoot: "/private/bridge", stagingRoot: "/private/staging", ownerPi: identity, modelPolicy: APPROVED_PERSONAL_MODEL_POLICY, piAgentDirectory: "/ticket/workspace/agent" }), /protected sandbox agent directory/);
});

test("sandbox parity rejects differing executable hash and missing phase model before paid phases", async () => {
  const details = { name: "@earendil-works/pi-coding-agent", version: identity.version, manifestSha256: identity.manifestSha256, cliSha256: identity.cliSha256, modelStoreSha256: identity.modelStoreSha256, codeTreeSha256: identity.codeTreeSha256 };
  await assert.rejects(workspace(new ParityCommands({ ...details, cliSha256: "d".repeat(64) }, allModels)).assertRuntimeParity("sbx-name"), /package differs/);
  await assert.rejects(workspace(new ParityCommands({ ...details, codeTreeSha256: "f".repeat(64) }, allModels)).assertRuntimeParity("sbx-name"), /package differs/);
  await assert.rejects(workspace(new ParityCommands({ ...details, phaseModelsSha256: "f".repeat(64) }, allModels)).assertRuntimeParity("sbx-name"), /effective phase models differ/);
  await assert.rejects(workspace(new ParityCommands({ ...details, modelStoreSha256: "e".repeat(64) }, allModels)).assertRuntimeParity("sbx-name"), /package differs/);
  await assert.rejects(workspace(new ParityCommands(details, "openai-codex  gpt-6-luna  text\n")).assertRuntimeParity("sbx-name"), /lacks openai-codex\/gpt-6-sol/);
});
