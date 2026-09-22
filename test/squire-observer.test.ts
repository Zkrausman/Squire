import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const observerPath = path.join(process.cwd(), "agents", "squire-observer.md");

function frontmatter(source: string): Map<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(source);
  assert.ok(match, "observer frontmatter is required");
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    assert.ok(separator > 0, `invalid frontmatter line: ${line}`);
    fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return fields;
}

test("squire-observer advertises the exact bounded runtime", async () => {
  const source = await readFile(observerPath, "utf8");
  const fields = frontmatter(source);
  assert.equal(fields.get("name"), "squire-observer");
  assert.ok((fields.get("description") ?? "").length > 0);
  assert.equal(fields.get("model"), "openai-codex/gpt-5.6-luna");
  assert.equal(fields.get("thinking"), "minimal");
  assert.equal(fields.get("tools"), "bash");
  assert.equal(fields.get("async"), "true");
  assert.equal(fields.get("context"), "fresh");
  assert.equal(fields.get("skills"), "[]");
  assert.equal(fields.get("advertise"), "true");
  assert.equal(fields.get("timeoutMs"), "36000000");
});

test("squire-observer has one trusted-entrypoint watch-then-status protocol", async () => {
  const source = await readFile(observerPath, "utf8");
  const watch = '(cd -- "$SQUIRE_CWD" && "$SQUIRE_CLI" watch "$RUN_ID" --config "$CONFIG_PATH")';
  const status = '(cd -- "$SQUIRE_CWD" && "$SQUIRE_CLI" status "$RUN_ID" --config "$CONFIG_PATH")';
  assert.equal(source.split(watch).length - 1, 1);
  assert.equal(source.split(status).length - 1, 1);
  assert.ok(source.indexOf(watch) < source.indexOf(status));
  assert.doesNotMatch(source, /(?:^|[`\s])squire\s+(?:watch|status)\b/iu);
  assert.match(source, /missing, ambiguous/u);
  assert.match(source, /PATH/u);
  assert.match(source, /observer_timeout/u);
  assert.match(source, /workflow, retry, publication, merge/u);
  assert.match(source, /candidate or PR/u);
  assert.match(source, /exactly once/u);
});
