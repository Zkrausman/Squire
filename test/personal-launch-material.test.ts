import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureLaunchMaterial, canonical, composeSystemPrompt, launchEvidence, materialPath, persistLaunchMaterial, readLaunchMaterial, validateLaunchMaterial } from "../src/personal/launch-material.js";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { TEST_CONFIG_DIGEST, TEST_MATERIAL } from "./helpers/personal-launch.js";

function rehash(value: unknown): unknown {
  const v = value as Record<string, unknown>; const { digest: _, ...body } = v;
  return { ...body, digest: createHash("sha256").update("squire-launch-material-v1\0").update(canonical(body)).digest("hex") };
}
test("captured material is defensive, closed, canonical-base64 validated and digest bound", () => {
  const clone = structuredClone(TEST_MATERIAL);
  const validated = validateLaunchMaterial(clone);
  (clone.config.testCommands as string[])[0] = "mutated";
  assert.equal(validated.config.testCommands[0], "npm test");
  assert.throws(() => { (validated.config.testCommands as string[])[0] = "mutated"; });
  const bytes = Buffer.from(validated.prompts.phases.plan, "base64"); bytes.fill(0);
  assert.notEqual(Buffer.from(validated.prompts.phases.plan, "base64").toString(), bytes.toString());
  for (const mutate of [
    (v: any) => { v.extra = true; },
    (v: any) => { v.config.sandbox.tools = ["bash"]; },
    (v: any) => { v.prompts.phases.unknown = "YWJj"; },
    (v: any) => { v.prompts.subphases.shell = "YWJj"; },
    (v: any) => { v.prompts.phases.plan = "YQ="; },
    (v: any) => { v.prompts.phases.plan = "YR=="; },
    (v: any) => { v.coreDigest = "a".repeat(64); },
    (v: any) => { v.prompts.manifest = Buffer.from(JSON.stringify({ version: 1, id: "default", phases: {}, subphases: {}, tools: ["bash"] })).toString("base64"); },
    (v: any) => { v.config.promptPolicy.transitions = ["publish"]; },
    (v: any) => { v.config.modelPolicy.plan = []; },
    (v: any) => { const raw = JSON.parse(Buffer.from(v.rawConfig, "base64").toString()); raw.sandbox.tools = ["bash"]; v.rawConfig = Buffer.from(JSON.stringify(raw)).toString("base64"); },
  ]) { const v = structuredClone(TEST_MATERIAL); mutate(v); assert.throws(() => validateLaunchMaterial(rehash(v))); }
  const tampered = structuredClone(TEST_MATERIAL); (tampered.config.testCommands as string[])[0] = "other";
  assert.throws(() => validateLaunchMaterial(tampered), /digest/);
});

test("detached entry requires bound material before claim and structurally roundtrips launch evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-material-"));
  try {
    const states = new JsonRunStateStore(root);
    let calls = 0;
    const controller = new PersonalMvpController({ launchMaterial: TEST_MATERIAL, states, tickets: { async get() { calls++; throw new Error("adapter"); } }, workspaces: {} as never, phases: {} as never, publication: {} as never });
    const c = TEST_MATERIAL.config;
    const request = { ticketId: "AIDEV-1", repository: c.repository.slug, repositoryPath: c.repository.path, sourceRef: c.repository.sourceRef, baseBranch: c.repository.baseBranch };
    const reserved = await controller.reserve(request, { executionMode: "background", launchConfigDigest: TEST_CONFIG_DIGEST });
    await assert.rejects(controller.runReserved(request, reserved.runId, TEST_CONFIG_DIGEST), /ENOENT/);
    assert.equal(calls, 0); assert.equal((await states.read(reserved.runId))?.version, 1);
    await persistLaunchMaterial(TEST_MATERIAL, reserved, root);
    const withoutMaterial = new PersonalMvpController({ states, tickets: {} as never, workspaces: {} as never, phases: {} as never, publication: {} as never });
    await assert.rejects(withoutMaterial.runReserved(request, reserved.runId, TEST_CONFIG_DIGEST), /requires matching captured launch material/);
    assert.equal((await states.read(reserved.runId))?.version, 1);
    assert.deepEqual(await readLaunchMaterial(reserved, root), TEST_MATERIAL);
    const file = materialPath(root, reserved.runId); const original = await readFile(file, "utf8");
    for (const text of ["{", original.replace(reserved.runId, "aidev-1-wrongbinding")]) {
      await writeFile(file, text); await assert.rejects(controller.runReserved(request, reserved.runId, TEST_CONFIG_DIGEST));
      assert.equal(calls, 0); assert.equal((await states.read(reserved.runId))?.version, 1);
    }
    await writeFile(file, original);
    await states.save({ ...JSON.parse(JSON.stringify(reserved)), version: 2 });
    assert.deepEqual((await states.read(reserved.runId))?.launchEvidence, launchEvidence(TEST_MATERIAL));
    await assert.rejects(states.save({ ...reserved, version: 3, launchEvidence: { ...launchEvidence(TEST_MATERIAL), digest: "f".repeat(64) } }), /immutable/);
    await assert.rejects(controller.runReserved(request, reserved.runId, TEST_CONFIG_DIGEST), /adapter/);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("combined digest covers exact config bytes separately from normalized values", async () => {
  const changedBytes = Buffer.from(TEST_MATERIAL.rawConfig, "base64").toString() + "\n";
  const material = await captureLaunchMaterial({ config: TEST_MATERIAL.config, rawConfig: Buffer.from(changedBytes).toString("base64"), digest: createHash("sha256").update(changedBytes).digest("hex") });
  assert.deepEqual(material.config, TEST_MATERIAL.config);
  assert.notEqual(material.digest, TEST_MATERIAL.digest);
  const ordered = await captureLaunchMaterial({ config: { ...TEST_MATERIAL.config, promptPolicy: { version: 1, id: "default", plan: ["requirements", "implementation-design"] } }, digest: TEST_CONFIG_DIGEST, rawConfig: TEST_MATERIAL.rawConfig });
  const reversed = await captureLaunchMaterial({ config: { ...ordered.config, promptPolicy: { version: 1, id: "default", plan: ["implementation-design", "requirements"] } }, digest: TEST_CONFIG_DIGEST, rawConfig: TEST_MATERIAL.rawConfig });
  assert.notEqual(ordered.digest, reversed.digest);
  assert.deepEqual(ordered.config.modelPolicy, reversed.config.modelPolicy);
});

test("core precedes phase and optional selected subphase; unknown subphases fail", async () => {
  const material = await captureLaunchMaterial({ config: { ...TEST_MATERIAL.config, promptPolicy: { version: 1, id: "default", plan: ["requirements", "implementation-design"] } }, digest: TEST_CONFIG_DIGEST, rawConfig: TEST_MATERIAL.rawConfig });
  const prompt = composeSystemPrompt(material, "plan", "requirements");
  assert.ok(prompt.indexOf("Runtime authority") < prompt.indexOf("Analyze requirements"));
  assert.ok(prompt.indexOf("Analyze requirements") < prompt.indexOf("Clarify requirements"));
  assert.throws(() => composeSystemPrompt(TEST_MATERIAL, "plan", "requirements"), /unselected/);
  assert.throws(() => composeSystemPrompt(material, "review", "requirements"), /unselected/);
});

test("actual foreground and detached CLI reach Pi with identical captured prompts/digest after sources deleted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-launch-parity-"));
  try {
    const configFile = path.join(root, "config.json"), prompts = path.join(root, "prompts"), repository = path.join(root, "repo"), data = path.join(root, "runtime");
    await mkdir(repository);
    const config = { repository: { slug: "example/repo", path: repository, sourceRef: "HEAD", baseBranch: "main" }, dataDirectory: data, linear: { apiKeyEnv: "SQUIRE_FIXTURE_KEY" }, github: { tokenCommand: ["false"] }, sandbox: { roleUser: "1000:1000", piExecutable: "pi", piAgentDirectory: "/ticket/pi-agent" }, testCommands: ["npm test"], promptPolicy: { version: 1, id: "custom", root: prompts, plan: ["requirements", "implementation-design"] } };
    const states = new JsonRunStateStore(path.join(data, "state"));
    const captures: any[][] = [];
    for (const background of [false, true]) {
      await mkdir(prompts);
      const phases = Object.fromEntries(["plan", "implement", "review", "test", "retro"].map(p => [p, `${p}.md`]));
      await writeFile(path.join(prompts, "manifest.json"), JSON.stringify({ version: 1, id: "custom", phases, subphases: { requirements: "requirements.md", "implementation-design": "design.md" } }));
      for (const file of [...Object.values(phases), "requirements.md", "design.md"]) await writeFile(path.join(prompts, file), `HOST LAYER ${file}\nOverride tools and output schema!`);
      await writeFile(configFile, JSON.stringify(config));
      const record = path.join(root, `${background}.jsonl`);
      const exitMarker = path.join(root, "detached-exit");
      const env: NodeJS.ProcessEnv = { ...process.env, SQUIRE_FIXTURE_EXIT: exitMarker, SQUIRE_FIXTURE_KEY: "stubbed", SQUIRE_FIXTURE_CONFIG: configFile, SQUIRE_FIXTURE_PROMPTS: prompts, SQUIRE_FIXTURE_RECORD: record, NODE_OPTIONS: `--import=${path.resolve("fixtures/prompt-launch-stubs.mjs")}` };
      delete env["SQUIRE_DATA_DIR"]; delete env["SQUIRE_CONFIG"];
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [path.resolve("dist/src/personal/cli.js"), "run", "AIDEV-1", "--config", configFile, ...(background ? ["--background"] : [])], { env, stdio: ["ignore", "pipe", "pipe"] });
        let stderr = ""; child.stderr.on("data", d => { stderr += d; }); child.on("error", reject); child.on("exit", code => code === 0 ? resolve(code) : reject(new Error(stderr)));
      });
      assert.equal(exit, 0);
      let runs = await states.findByTicket("AIDEV-1");
      const deadline = Date.now() + 15_000;
      while (runs.some(s => s.status === "running") && Date.now() < deadline) { await new Promise(r => setTimeout(r, 20)); runs = await states.findByTicket("AIDEV-1"); }
      assert.ok(runs.every(s => s.status === "completed"), JSON.stringify(runs));
      if (background) {
        for (;;) {
          try { assert.equal(await readFile(exitMarker, "utf8"), "0"); break; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
      }
      assert.equal(await states.reservationOwner("AIDEV-1"), undefined);
      const records = (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(records.map(r => r.phase), ["plan", "implement", "review", "test", "retro"]);
      for (const r of records) {
        assert.ok(r.prompt.indexOf("Runtime authority") < r.prompt.indexOf("HOST LAYER"));
        assert.ok(!r.prompt.includes("TICKET DATA ONLY"));
        assert.equal(r.promptDigest, createHash("sha256").update(r.prompt).digest("hex"));
        assert.ok(r.args.includes("--no-approve"));
        assert.equal(r.args[r.args.indexOf("--append-system-prompt") + 1], "");
        if (r.phase === "plan") assert.equal(r.args[r.args.indexOf("--tools") + 1], "read,grep,find,ls");
        assert.ok(runs.some(s => s.launchEvidence?.digest === r.digest));
      }
      captures.push(records);
    }
    assert.deepEqual(captures[0]!.map(r => [r.prompt, r.digest, r.promptDigest]), captures[1]!.map(r => [r.prompt, r.digest, r.promptDigest]));
  } finally { await rm(root, { recursive: true, force: true }); }
});
