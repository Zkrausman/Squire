import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { CommandPort, CommandRequest, CommandResult } from "../src/personal/command.js";
import { DockerSandboxWorkspace } from "../src/personal/docker-sandbox.js";
import { APPROVED_PERSONAL_MODEL_POLICY } from "../src/personal/model-policy.js";
import type { OwnerPiIdentity } from "../src/personal/runtime-parity.js";

const identity: OwnerPiIdentity = {
  schema: 1, pid: process.pid, cliPath: process.execPath, version: "0.87.0", manifestSha256: "a".repeat(64), cliSha256: "b".repeat(64), modelStorePath: path.resolve("models-store.json"), modelStoreSha256: "c".repeat(64),
  models: ["openai-codex/gpt-6-luna", "openai-codex/gpt-6-sol"], extensions: [],
};

class ParityCommands implements CommandPort {
  readonly requests: CommandRequest[] = [];
  constructor(readonly details: Record<string, string>, readonly catalog: string) {}
  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    if (request.args.includes("-e")) return { stdout: JSON.stringify(this.details), stderr: "" };
    return { stdout: this.catalog, stderr: "" };
  }
}

const allModels = "openai-codex  gpt-6-luna  text\nopenai-codex  gpt-6-sol  text\n";
function workspace(commands: ParityCommands): DockerSandboxWorkspace {
  return new DockerSandboxWorkspace({ commands, bridgeRoot: "/private/bridge", stagingRoot: "/private/staging", ownerPi: identity, modelPolicy: APPROVED_PERSONAL_MODEL_POLICY });
}

test("sandbox parity checks package hashes and the actual extension-free Pi catalog", async () => {
  const commands = new ParityCommands({ name: "@earendil-works/pi-coding-agent", version: identity.version, manifestSha256: identity.manifestSha256, cliSha256: identity.cliSha256, modelStoreSha256: identity.modelStoreSha256 }, allModels);
  await workspace(commands).assertRuntimeParity("sbx-name");
  assert.match(commands.requests[0]!.args.at(-1)!, /owned\('\/ticket'\).*visit\(tree\)/u);
  assert.deepEqual(commands.requests[1]!.args.slice(-4), ["--no-extensions", "--no-skills", "--list-models", "openai-codex"]);
  assert.ok(commands.requests[1]!.args.includes("PI_CODING_AGENT_DIR=/ticket/runtime/pi-agent"));
});

test("runtime install is sealed by root before model auth and before paid phases", async () => {
  const source = await readFile(path.resolve("src/personal/docker-sandbox.ts"), "utf8");
  assert.match(source, /await this\.#installPi\(input\.sandbox, signal\); await this\.#sealPi\(input\.sandbox, signal\)/u);
  assert.match(source, /chown -R root:root \/ticket\/runtime\/node_modules; chmod -R a-w/u);
  assert.match(source, /chown root:root \/ticket \/ticket\/runtime; chmod 755/u);
  assert.match(source, /async assertRuntimeParity\(sandbox:/u);
});

test("sandbox parity rejects differing executable hash and missing phase model before paid phases", async () => {
  const details = { name: "@earendil-works/pi-coding-agent", version: identity.version, manifestSha256: identity.manifestSha256, cliSha256: identity.cliSha256, modelStoreSha256: identity.modelStoreSha256 };
  await assert.rejects(workspace(new ParityCommands({ ...details, cliSha256: "d".repeat(64) }, allModels)).assertRuntimeParity("sbx-name"), /package differs/);
  await assert.rejects(workspace(new ParityCommands({ ...details, modelStoreSha256: "e".repeat(64) }, allModels)).assertRuntimeParity("sbx-name"), /package differs/);
  await assert.rejects(workspace(new ParityCommands(details, "openai-codex  gpt-6-luna  text\n")).assertRuntimeParity("sbx-name"), /lacks openai-codex\/gpt-6-sol/);
});
