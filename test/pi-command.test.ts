import assert from "node:assert/strict"; import test from "node:test"; import { assertSafeResumeArgs, buildPiCommand } from "../src/pi/pi-command.js";
test("Pi command requires controller-resolved executable and exact session resume", () => { const registration = { runId: "run", role: "implement" as const, sessionId: "id", sessionFile: "/ticket/sessions/implement/x_id.jsonl", processGeneration: 1, registeredAt: "now" }; const command = buildPiCommand({ piBinary: "/ticket/runtime/pi", instructions: "trusted role", role: "implement", config: { provider: "p", model: "m", instructionsPath: "/ticket/control/roles/implement.md" }, registration }); assert.equal(command.command, "/ticket/runtime/pi"); assert.equal(command.args[command.args.indexOf("--provider") + 1], "p"); assert.equal(command.args[command.args.indexOf("--model") + 1], "m"); assert.equal(command.args[command.args.indexOf("--thinking") + 1], "max"); assert.equal(command.env["PI_SKIP_VERSION_CHECK"], "1"); assertSafeResumeArgs(command.args, registration.sessionFile); assert.throws(() => assertSafeResumeArgs([...command.args, "--continue"], registration.sessionFile), /forbidden/); });

test("trusted Pi command passes the run agent directory and ordered extensions while retaining role session roots", () => {
  const command = buildPiCommand({
    piBinary: "/ticket/runtime/pi",
    instructions: "trusted role",
    role: "review",
    workspace: "/ticket/workspace",
    sessionRoot: "/ticket/sessions",
    agentDir: "/ticket/runtime/run_test/pi-agent",
    homeDir: "/ticket/runtime/run_test/home",
    wikiHomeDir: "/ticket/runtime/run_test/wiki-home",
    trustedExtensionPaths: ["/ticket/runtime/wiki/index.ts", "/ticket/runtime/run_test/pi-agent/footer.mjs"],
    config: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium", instructionsPath: "/ticket/config/review.md" },
  });
  assert.equal(command.cwd, "/ticket/workspace");
  assert.equal(command.args[command.args.indexOf("--session-dir") + 1], "/ticket/sessions/review");
  assert.equal(command.env["PI_CODING_AGENT_DIR"], "/ticket/runtime/run_test/pi-agent");
  assert.equal(command.env["HOME"], "/ticket/runtime/run_test/home");
  assert.equal(command.env["WIKI_HOME"], "/ticket/runtime/run_test/wiki-home");
  assert.ok(command.args.includes("--no-extensions"));
  const first = command.args.indexOf("--extension");
  assert.equal(command.args[first + 1], "/ticket/runtime/wiki/index.ts");
  assert.equal(command.args[first + 2], "--extension");
  assert.equal(command.args[first + 3], "/ticket/runtime/run_test/pi-agent/footer.mjs");
});
