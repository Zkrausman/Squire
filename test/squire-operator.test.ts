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
  const frontmatter = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/u.exec(body);
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

test("every public Squire example parses with the shipped CLI; invented interfaces fail", async () => {
  const text = await operations();
  const examples = text.split("\n").filter(line => line.startsWith("squire "));
  assert.equal(examples.length, 5);
  for (const example of examples) {
    const argv = example.split(" ").slice(1).map(value => ({
      "TICKET-ID": "DEMO-123", "RUN-ID": "demo-123-1234567890", CONFIG: "operator-config.json",
    })[value] ?? value);
    const parsed = parseArguments(argv);
    assert.ok(parsed, example);
    assert.equal(parsed.command, argv[0]);
    assert.equal(parsed.config, path.resolve("operator-config.json"));
  }
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
  assert.ok((await read("docs/first-run.md")).includes("npm ci --ignore-scripts --no-audit --no-fund"));
  const workspace = await read("src/personal/docker-sandbox.ts");
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
