import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DetachedProcessFixture } from "./helpers/detached-process-fixture.js";
import { launchTestRoot } from "./helpers/windows-launch.js";

const executable = path.resolve("build/Release", `process_exit_observer${process.platform === "win32" ? ".exe" : ""}`);

test("native exit observer cancels an acquired live process reference without claiming exit", async () => {
  const observer = spawn(executable, [String(process.pid)], { stdio: "pipe", windowsHide: true });
  const closed = once(observer, "close");
  void closed.catch(() => {});
  observer.stdin.on("error", () => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    const output = await Promise.race([
      once(observer.stdout, "data"),
      closed.then(() => { throw new Error("observer closed before acquisition"); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("observer acquisition timeout")), 10000); }),
    ]);
    assert.equal(String(output[0]), "acquired\n");
    assert.equal(observer.exitCode, null);
  } finally {
    clearTimeout(timer);
    observer.stdin.end();
    const [code, signal] = await closed;
    assert.equal(code, 2);
    assert.equal(signal, null);
  }
});

test("native exit observer rejects invalid identity without acquisition", async () => {
  const observer = spawn(executable, ["0"], { stdio: "pipe", windowsHide: true });
  const closed = once(observer, "close");
  let output = "";
  observer.stdout.on("data", chunk => { output += String(chunk); });
  const [code, signal] = await closed;
  assert.equal(code, 3);
  assert.equal(signal, null);
  assert.equal(output, "");
});

test("fixture failure teardown reaps a direct child without a release acknowledgement", async () => {
  const fixture = new DetachedProcessFixture(await launchTestRoot("squire-detached-teardown-"));
  try {
    await fixture.listen();
    assert.equal(await fixture.launchDirect(), await fixture.ready());
  } finally {
    await fixture.dispose();
  }
  await assert.rejects(access(fixture.root), { code: "ENOENT" });
});

test("fixture failure teardown waits on an identity-bound grandchild observer", async () => {
  const fixture = new DetachedProcessFixture(await launchTestRoot("squire-observed-teardown-"));
  try {
    await fixture.listen();
    fixture.launchParent();
    await fixture.ready();
    await fixture.parentClosed();
    await fixture.acquireObserver();
  } finally {
    await fixture.dispose();
  }
  await assert.rejects(access(fixture.root), { code: "ENOENT" });
});

test("fixture teardown retains the root when no intended-child exit is proven", async () => {
  const fixture = new DetachedProcessFixture(await launchTestRoot("squire-unproven-exit-"));
  try {
    await fixture.listen();
    await assert.rejects(fixture.dispose(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.some((item: Error) => item.message.includes(`fixture retained: ${fixture.root}`)));
      return true;
    });
    await access(fixture.root);
  } finally {
    // This negative case never launches a child; only the test may remove it.
    await rm(fixture.root, { recursive: true });
  }
});
