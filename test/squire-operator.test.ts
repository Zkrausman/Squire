import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseArguments } from "../src/personal/cli.js";

const root = process.cwd();
const skillRoot = path.join(root, "skills/squire-operator");
const read = (file: string): Promise<string> => readFile(path.join(root, file), "utf8");
const operations = (): Promise<string> => read("skills/squire-operator/references/operations.md");

test("operator skill frontmatter and all packaged references are portable", async () => {
  assert.deepEqual((await readdir(skillRoot)).sort(), ["SKILL.md", "references"]);
  const body = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const frontmatter = /^---\r?\nname: ([^\r\n]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n/u.exec(body);
  assert.ok(frontmatter);
  assert.equal(frontmatter[1], "squire-operator");
  assert.ok(frontmatter[2]!.length > 0 && frontmatter[2]!.length <= 1024);
  const files = ["SKILL.md", ...(await readdir(path.join(skillRoot, "references"))).map(file => `references/${file}`)];
  let links = 0;
  for (const file of files) {
    const text = await readFile(path.join(skillRoot, file), "utf8");
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1]!;
      assert.ok(!path.isAbsolute(target) && !target.includes(":") && !target.startsWith("~"));
      const resolved = await realpath(path.resolve(path.dirname(path.join(skillRoot, file)), target));
      assert.ok(resolved.startsWith(`${await realpath(skillRoot)}${path.sep}`));
      assert.ok((await readFile(resolved, "utf8")).length > 0);
      links++;
    }
  }
  assert.equal(links, 2);
});

test("installed operator guide requires the active Pi bridge and same-version sandbox", async () => {
  const guide = await read("skills/squire-operator/references/install-and-handoff.md");
  assert.match(guide, /install the reviewed launch\s+extension from the same verified merged build/u);
  assert.match(guide, /install-skills` does \*\*not\*\* install the\s+extension/u);
  assert.match(guide, /Each new ticket sandbox must instead match the\s+authenticated owner-facing Pi package and model-store identity/u);
  assert.doesNotMatch(guide, /sandbox and host versions can differ/u);
});

test("operator skill defaults to async observer without granting workflow authority", async () => {
  const skill = await read("skills/squire-operator/SKILL.md");
  const ops = await operations();
  const text = `${skill}\n${ops}`;
  assert.match(skill, /default to the dedicated async `squire-observer` child/u);
  assert.match(ops, /exact trusted Squire executable entrypoint, cwd, run ID and config/u);
  assert.match(ops, /one event-driven non-model `watch`, then one public status/u);
  assert.match(text, /open watch tool call is expected|open bash call or long-running\s+attention notice/u);
  assert.match(text, /Never silently switch to a\s+parent-blocking watch|never silently block the orchestrator/u);
  assert.match(text, /owner explicitly.*blocking conversation|owner explicitly wants to block the conversation/su);
  assert.match(text, /observer infrastructure failure is not run completion/u);
  assert.match(text, /receipt is\s+observation only/u);
  assert.match(text, /no workflow.*retry.*publication.*merge authority/su);
});

test("owner-facing trigger authorizes bounded preflight and the normal delivery path", async () => {
  const skill = await read("skills/squire-operator/SKILL.md");
  const ops = (await operations()).replace(/\s+/gu, " ");
  assert.match(skill, /use Squire to orchestrate ticket XYZ-123/u);
  assert.match(skill, /existing owner-approved ticket contract/u);
  assert.match(skill, /launch of exactly one Squire run/u);
  assert.ok(ops.includes("The direct owner request `use Squire to orchestrate ticket XYZ-123` is the authority for trusted cold-start preflight, launch of exactly one initial Squire run"));
  assert.ok(ops.includes("do not request a second mechanical run/publication confirmation"));
  assert.ok(ops.includes("Contract → Implement → fresh independent read-only Verify"));
  assert.ok(ops.includes("required external CI at the exact PR head"));
});

test("mechanical contract-conformance corrections use immutable fresh replacements", async () => {
  const text = (await operations()).replace(/\s+/gu, " ");
  assert.ok(text.includes("deterministic mechanical contract-conformance defect that has one obvious correction inside the approved scope"));
  assert.ok(text.includes("does not require interrupting the owner for a mechanical choice"));
  assert.ok(text.includes("Preserve the failed candidate immutably"));
  assert.ok(text.includes("privately record the measured defect and evidence"));
  assert.ok(text.includes("narrow, auditable amendment to the contract/source condition"));
  assert.ok(text.includes("fresh replacement candidate under the original bounded orchestration authority"));
  assert.ok(text.includes("never repeat an unchanged condition"));
});

test("only genuine scope, tradeoff, authority, security, repetition, or activation issues escalate", async () => {
  const text = (await operations()).replace(/\s+/gu, " ");
  assert.ok(text.includes("Escalate only for genuine scope expansion, product/architecture tradeoffs, missing authority, security/credential ambiguity, repeated failure without materially new evidence, or activation outside the request"));
  assert.ok(text.includes("Other failures remain terminal: preserve and report them without an unauthorized retry"));
});

test("failure evidence stays private and failed candidates are never repaired or promoted", async () => {
  const text = (await operations()).replace(/\s+/gu, " ");
  assert.ok(text.includes("Keep detailed failure evidence private"));
  assert.ok(text.includes("report concise sanitized public facts and leave unknown evidence unknown"));
  assert.ok(text.includes("Do not repair phase JSON/state, resume, relabel or promote a failed candidate"));
  assert.ok(text.includes("or retry an unchanged condition"));
  assert.ok(text.includes("manually publish a failed candidate"));
});

test("verification and publication are gated on the exact candidate and PR head", async () => {
  const text = (await operations()).replace(/\s+/gu, " ");
  assert.ok(text.includes("Verify is fresh, independent and read-only"));
  assert.ok(text.includes("input and output must both equal the Implement candidate SHA"));
  assert.ok(text.includes("every configured test command must be represented"));
  assert.ok(text.includes("required hosted CI must pass at the exact published PR head, which must equal the candidate SHA"));
  assert.ok(text.includes("A changed/mismatched head or missing, failed or inconclusive gate is not success"));
  assert.ok(text.includes("Do not merge or bypass gates"));
});

test("direct request excludes merge and activation; observation grants no authority", async () => {
  const skill = (await read("skills/squire-operator/SKILL.md")).replace(/\s+/gu, " ");
  const ops = (await operations()).replace(/\s+/gu, " ");
  assert.ok(skill.includes("merge, tags, installation, deployment, delegation and unrelated external actions require separate applicable authority unless the owner request clearly includes them"));
  assert.ok(ops.includes("observation only and grants no workflow, retry, publication or merge authority"));
});

test("only observation examples parse as CLI commands; launching requires the Pi bridge", async () => {
  const text = await operations();
  const examples = text.split("\n").filter(line => line.startsWith("squire "));
  assert.equal(examples.length, 3);
  assert.match(text, /^\/squire-run TICKET-ID --config ABSOLUTE_PATH$/mu);
  assert.doesNotMatch(text, /^squire run /mu);
  assert.match(text, /Direct `squire run` is\s+\*\*not\*\*\s+a\s+supported operator launch/u);
  for (const example of examples) {
    const argv = example.trim().split(" ").slice(1).map(value => ({
      "TICKET-ID": "DEMO-123", "RUN-ID": "demo-123-1234567890", CONFIG: "operator-config.json",
    })[value] ?? value);
    const parsed = parseArguments(argv);
    assert.ok(parsed, example);
    assert.equal(parsed.command, argv[0]);
    assert.equal(parsed.config, path.resolve("operator-config.json"));
  }
  const bridge = await read("src/personal/pi-launch-bridge.ts");
  assert.match(bridge, /registerCommand\("squire-run"/u);
  assert.match(bridge, /captureOwnerPiIdentity\(process\.argv\[1\], ctx\.modelRegistry, config\.modelPolicy\)/u);
  for (const command of ["resume", "recover", "recovery", "health", "version"]) {
    assert.equal(parseArguments([command, "DEMO-123"]), undefined);
  }
  for (const argv of [["status", "DEMO-123", "--background"], ["watch", "DEMO-123", "--background"],
    ["run", "DEMO-123", "--resume"], ["watch", "DEMO-123", "--poll"], ["run", "DEMO-123", "--dry-run"]]) {
    assert.equal(parseArguments(argv), undefined);
  }
});

test("non-Squire command evidence stays tied to shipped build and native argv", async () => {
  const text = await operations();
  const pkg = JSON.parse(await read("package.json")) as { scripts: Record<string, string>; bin: { squire: string } };
  assert.ok(pkg.scripts["build"]);
  assert.ok(pkg.scripts["test"]);
  assert.equal(pkg.bin.squire, "./dist/src/personal/cli.js");
  assert.ok((await read("docs/first-run.md")).includes("sandbox installs that Pi version without lifecycle scripts"));
  const workspace = await read("src/personal/docker-sandbox.ts");
  assert.ok(workspace.includes('"--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"'));
  assert.ok(workspace.includes('["create", "--name", input.sandbox]'));
  assert.ok(workspace.includes('createArgs.push("--template", this.#template)'));
  assert.ok(workspace.includes('createArgs.push("shell", bridge)'));
  assert.ok((await read("src/personal/pi-phase-runner.ts")).includes('["exec", "-u", this.#roleUser, "-w", "/ticket/workspace", input.sandbox, ...environment]'));
  assert.ok(text.includes("sbx create --name <sandbox> --template <template> shell <bridge-path>"));
  assert.ok(text.includes("sbx exec -u <role-user> -w /ticket/workspace <sandbox> <command> <arg>..."));
  assert.ok(text.includes("not independently host-help-tested"));
  assert.ok(text.includes("shell: false"));
});

// Static checklist regression scenarios: these test documented decisions/evidence,
// not an executable policy engine, live App access, host sbx, or future push success.
const scenarios = [
  ["Wrong repository token scope", "STOP", ["exact target installation access", "read-only probe", "future push remains unproven"], ["Personal-token", "token dump"]],
  ["Unsafe inherited/default log path", "STOP", ["SQUIRE_DATA_DIR before dataDirectory", "paths overrides", "log redirects", "private outside-repo"], ["defaults", "shared ACLs"]],
  ["Copied test command/toolchain", "STOP", ["target manifests/CI/instructions", "actual template tools", "target-specific testCommands"], ["Go command", "weakening tests"]],
  ["Docker image absent", "VERIFY", ["native sbx template", "host", "inconclusive", "hold launch"], ["fallback", "nested sbx", "shared-template"]],
  ["Dirty checkout", "PRESERVE", ["uncommitted files", "committed SHA", "isolated source", "original baseline"], ["Reset/clean/stash", "unrelated work"]],
  ["Missing prerequisite approval", "STOP", ["paid launch", "visible prerequisite evidence", "explicit owner approval"], ["skill", "inherited conversation"]],
  ["Terminal publication failure", "FAILED", ["phases passed", "preserve state/logs/sandbox/candidate", "exact head", "terminal error", "reservation release", "escalate"], ["Repairing JSON/state", "manual candidate publication", "silent rerun"]],
] as const;
for (const [scenario, decision, evidence, prohibited] of scenarios) {
  test(`cold-start checklist: ${scenario}`, async () => {
    const row = (await operations()).split("\n").find(line => line.startsWith(`| ${scenario} |`));
    assert.ok(row, `missing scenario: ${scenario}`);
    const columns = row.split("|").map(column => column.trim());
    assert.ok(columns[2]!.startsWith(decision));
    for (const requirement of evidence) assert.ok(columns[2]!.includes(requirement), requirement);
    for (const shortcut of prohibited) assert.ok(columns[3]!.includes(shortcut), shortcut);
  });
}

test("real Pi public loader discovers the isolated installed copy, not source layout", { timeout: 90_000 }, async t => {
  const result = await promisify(execFile)(process.execPath, [path.join(root, "scripts/validate-squire-operator.mjs")], {
    cwd: root, timeout: 75_000, maxBuffer: 1024 * 1024,
  });
  assert.match(result.stdout, /"discovery":"passed"/u);
  assert.match(result.stdout, /"version":"[^"]+"/u);
  assert.match(result.stdout, /"references":2/u);
  assert.equal(result.stderr, "");
  t.diagnostic(result.stdout.trim());
});
