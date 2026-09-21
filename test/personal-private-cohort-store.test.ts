import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, lstat, readFile, symlink, writeFile, open, rename, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { canonicalJson } from "../src/personal/canonical-json.js";
import { digestBytes } from "../src/personal/cohort-manifest.js";
import { publishCohort, readBoundArtifact, readPrivateArtifact } from "../src/personal/private-cohort-store.js";
import { privateFixture, H } from "./helpers/cohort-fixture.js";
import { grant, acl, assertProtectedAcl } from "./helpers/windows-launch.js";

test("bounded immutable reads reject links, public permissions and repository containment", async () => {
  const f = await privateFixture();
  try {
    const ref = await f.write("source.jsonl", Buffer.from("immutable"));
    assert.equal((await readBoundArtifact(ref, f.repository)).toString(), "immutable");
    await assert.rejects(readBoundArtifact({ ...ref, digest: "0".repeat(64) }, f.repository));
    await assert.rejects(readBoundArtifact({ ...ref, bytes: ref.bytes - 1 }, f.repository));
    await assert.rejects(readPrivateArtifact(ref.file, f.root, f.repository, 1));
    await assert.rejects(readPrivateArtifact(ref.file, f.root, f.root));
    await assert.rejects(readPrivateArtifact(ref.file, path.join(f.root, "other"), f.repository));
    const linked = path.join(f.root, "linked"); await link(ref.file, linked);
    await assert.rejects(readPrivateArtifact(linked, f.root, f.repository));
    await assert.rejects(readBoundArtifact(ref, f.repository));
    const publicRef = await f.write("public.json", Buffer.from("public"));
    if (process.platform === "win32") {
      assert.throws(() => grant(publicRef.file, "S-1-1-0", "R"));
      // Explicit full enum name is mandatory. Verify the fixture actually added
      // read authority, not merely that a shell/enum cast happened to fail.
      grant(publicRef.file, "S-1-1-0", "Read");
      assert.ok(acl(publicRef.file).rules.some(r => r.sid === "S-1-1-0" && (r.rights & 131209) === 131209));
    } else await chmod(publicRef.file, 0o644);
    await assert.rejects(readBoundArtifact(publicRef, f.repository));
    const alias = path.join(f.base, "alias");
    await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(readPrivateArtifact(path.join(alias, "public.json"), alias, f.repository));
  } finally { await f.cleanup(); }
});
test("private publication is additive, atomic, digest-addressed, idempotent and rejects conflicts", async () => {
  const f = await privateFixture();
  try {
    const source = await f.write("source.json", Buffer.from("source-sentinel")), before = await readFile(source.file);
    const value = { schemaVersion: 1, manifestDigest: H, usage: "1.2" }, data = path.join(f.base, "data");
    const first = await publishCohort(data, f.repository, H, value);
    const file = path.join(data, "cohort-artifacts", `${first.artifactDigest}.json`), stat = await lstat(file);
    assert.equal(first.artifactDigest, digestBytes(canonicalJson(value)));
    assert.deepEqual(await publishCohort(data, f.repository, H, value), first);
    assert.equal((await lstat(file)).mtimeMs, stat.mtimeMs);
    assert.deepEqual(await readFile(source.file), before);
    if (process.platform === "win32") { assertProtectedAcl(file); assertProtectedAcl(path.dirname(file)); }
    else { assert.equal(stat.mode & 0o777, 0o600); assert.equal((await lstat(path.dirname(file))).mode & 0o777, 0o700); }
    const second = await publishCohort(data, f.repository, H, { ...value, usage: "2.4" });
    assert.notEqual(first.artifactDigest, second.artifactDigest);
    await writeFile(file, "conflicting-content");
    await assert.rejects(publishCohort(data, f.repository, H, value));
    await assert.rejects(publishCohort(f.repository, f.repository, H, value));
  } finally { await f.cleanup(); }
});
test("Windows historical leases retain the strict native read/ACL/replacement boundary", { skip: process.platform !== "win32" }, async () => {
  const f = await privateFixture();
  const native = createRequire(import.meta.url)("../../build/Release/windows_launch.node") as {
    openHistorical(file: string, forbidden?: Buffer): { lease: object }; openReport(file: string): { lease: object }; readReport(lease: object, hook?: () => void): Buffer; closeReport(lease: object): void;
  };
  try {
    const ref = await f.write("retained.jsonl", Buffer.alloc(3 * 1024 * 1024, 65));
    assert.equal((await readBoundArtifact(ref, f.repository)).length, ref.bytes);
    assert.throws(() => native.openReport(ref.file), /size bound/);
    assert.throws(() => native.openHistorical(ref.file, Buffer.from("forbidden")), /read-only/);
    const held = native.openHistorical(ref.file);
    try {
      await assert.rejects(writeFile(ref.file, "replacement"));
      assert.throws(() => native.readReport(held.lease, () => grant(ref.file, "S-1-1-0", "Read")), /principal/);
    } finally { native.closeReport(held.lease); }
  } finally { await f.cleanup(); }
});

test("Linux descriptor-relative immutable reads detect mid-read mutation and replacement races", { skip: process.platform !== "linux" }, async () => {
  for (const fault of ["bytes", "permissions", "hardlink", "replacement", "parent-replacement"] as const) {
    const f = await privateFixture();
    try {
      const ref = await f.write("source.jsonl", Buffer.from("immutable-source"));
      const probe = await open(ref.file, "r");
      const prototype = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown> };
      await probe.close();
      const original = prototype.read; let injected = false;
      prototype.read = async function(this: FileHandle, ...args: unknown[]): Promise<unknown> {
        const result = await Reflect.apply(original, this, args);
        if (!injected) {
          injected = true;
          if (fault === "bytes") await writeFile(ref.file, "changed-source!!");
          if (fault === "permissions") await chmod(ref.file, 0o644);
          if (fault === "hardlink") await link(ref.file, path.join(f.root, "alias"));
          if (fault === "replacement") { await rename(ref.file, ref.file + ".old"); await writeFile(ref.file, "immutable-source", { mode: 0o600 }); }
          if (fault === "parent-replacement") { await rename(f.root, f.root + "-old"); }
        }
        return result;
      };
      try { await assert.rejects(readBoundArtifact(ref, f.repository), fault); assert.ok(injected); }
      finally { prototype.read = original; }
    } finally { await f.cleanup(); }
  }
});
