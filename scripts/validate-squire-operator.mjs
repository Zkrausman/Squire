// Offline installed-layout proof. No agent session, model call or runtime install.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@earendil-works/pi-coding-agent";
function locatePackage() {
  const explicit = process.argv[2] ?? process.env.SQUIRE_OPERATOR_PI_PACKAGE;
  if (explicit) return realpathSync(explicit);
  const roots = createRequire(import.meta.url).resolve.paths(packageName) ?? [];
  // The ticket's provisioned runtime is a sibling of its workspace; no owner paths.
  for (let dir = repository; ; dir = path.dirname(dir)) {
    roots.push(path.join(dir, "runtime", "node_modules"));
    if (path.dirname(dir) === dir) break;
  }
  roots.push(path.resolve(path.dirname(process.execPath), "../lib/node_modules"));
  for (const root of roots) {
    const candidate = path.join(root, packageName);
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
  }
  throw new Error("Validation blocked: installed Pi package unavailable; supply its trusted directory as argv[2] or SQUIRE_OPERATOR_PI_PACKAGE. Do not install/upgrade globally or substitute a parser.");
}
const packageRoot = locatePackage();
const metadata = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
assert.equal(metadata.name, packageName);
const publicExport = metadata.exports?.["."]?.import;
assert.equal(typeof publicExport, "string", "Pi supported public import export unavailable");
const entry = path.resolve(packageRoot, publicExport);
assert.ok(entry.startsWith(`${packageRoot}${path.sep}`));
const docs = readFileSync(path.join(packageRoot, "docs/skills.md"), "utf8");
assert.ok(docs.includes("~/.pi/agent/skills/"), "installed Pi docs must support the tested global layout");
assert.ok(docs.includes("~/.agents/skills/"), "alternate documented global location must be supported");
assert.ok(docs.includes("/skill:name"), "documented skill command must be supported");
assert.ok(readFileSync(path.join(packageRoot, "README.md"), "utf8").includes("| `/reload` |"), "documented resource reload must be supported");

const root = mkdtempSync(path.join(os.tmpdir(), "squire-operator-loader-"));
try {
  const home = path.join(root, "home");
  const agent = path.join(home, ".pi", "agent");
  const project = path.join(root, "unrelated-project");
  const installed = path.join(agent, "skills", "squire-operator");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(project, ".git")); // Bound project ancestry without invoking Git.
  mkdirSync(agent, { recursive: true });
  writeFileSync(path.join(agent, "settings.json"), "{}\n");
  mkdirSync(path.join(project, ".pi"));
  writeFileSync(path.join(project, ".pi", "settings.json"), "{}\n");
  cpSync(path.join(repository, "skills/squire-operator"), installed, { recursive: true, errorOnExist: true, force: false });
  // A fresh process imports Pi only after environment isolation. Do not inherit
  // credentials, NODE_OPTIONS, owner settings or PI_* overrides/extensions.
  const env = {
    HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"), TMPDIR: root, TEMP: root, TMP: root,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const probe = `
    import assert from 'node:assert/strict';
    import { readFileSync, realpathSync } from 'node:fs';
    import path from 'node:path';
    const { loadSkills, formatSkillsForPrompt } = await import(${JSON.stringify(pathToFileURL(entry).href)});
    assert.equal(typeof loadSkills, 'function');
    assert.equal(typeof formatSkillsForPrompt, 'function');
    const result = loadSkills({ cwd: process.cwd(), skillPaths: [], includeDefaults: true });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.skills.length, 1);
    const skill = result.skills[0];
    assert.equal(skill.name, 'squire-operator');
    assert.equal(skill.baseDir, ${JSON.stringify(installed)});
    assert.ok(skill.description.length > 0 && skill.description.length <= 1024);
    const prompt = formatSkillsForPrompt(result.skills);
    assert.ok(prompt.includes('<name>squire-operator</name>'));
    assert.ok(prompt.includes(skill.description));
    assert.ok(prompt.includes(skill.filePath));
    const body = readFileSync(skill.filePath, 'utf8');
    assert.ok(body.startsWith('---\\nname: squire-operator\\n'));
    assert.ok(!prompt.includes('# Squire operator'), 'body must remain on-demand');
    let references = 0;
    for (const match of body.matchAll(/\\[[^\\]]+\\]\\(([^)]+)\\)/g)) {
      const target = realpathSync(path.resolve(skill.baseDir, match[1]));
      assert.ok(target.startsWith(skill.baseDir + path.sep));
      assert.ok(readFileSync(target, 'utf8').length > 0);
      references++;
    }
    assert.equal(references, 2);
    console.log(JSON.stringify({ discovery: 'passed', layout: 'isolated global installed copy', references, diagnostics: result.diagnostics }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: project, env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  console.log(JSON.stringify({ package: metadata.name, version: metadata.version, packageRoot, export: publicExport }));
  process.stdout.write(output);
} finally {
  rmSync(root, { recursive: true, force: true });
}
