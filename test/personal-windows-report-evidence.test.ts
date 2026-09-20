import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, rename, link, symlink, writeFile, truncate } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WindowsReportEvidence, verifyReportEvidence, MAX_REPORT_BYTES } from "../src/personal/report-evidence.js";
import { windowsLaunch } from "../src/personal/windows-launch.js";
import { launchTestRoot, powershell, grant, assertProtectedAcl } from "./helpers/windows-launch.js";
import { withWritableSourceMapping } from "./helpers/windows-mapped-source.js";
const windows = { skip: process.platform !== "win32", timeout: 60000 };
async function fixture() {
  const root = await launchTestRoot("squire-report-security-");
  const port = new WindowsReportEvidence(path.join(root, "evidence"));
  const ref = await port.write(Buffer.from("original bytes\r\n"));
  return { root, port, ref, async cleanup() { await port.release(); await rm(root, { recursive: true, force: true }); } };
}

test("Windows evidence atomic creation, canonical containment, private ACLs and exact reference", windows, async () => {
  const f = await fixture();
  try {
    assertProtectedAcl(f.ref.path); assertProtectedAcl(f.port.root);
    await verifyReportEvidence(f.port, f.ref, "original bytes\r\n");
    assert.throws(() => windowsLaunch().openReport(f.ref.path, Buffer.from("overwrite")), /open rejected/);
    for (const ref of [{ ...f.ref, byteLength: 1 }, { ...f.ref, sha256: "0".repeat(64) }, { ...f.ref, identity: "1:2" }, { ...f.ref, path: path.join(f.root, path.basename(f.ref.path)) }]) await assert.rejects(verifyReportEvidence(f.port, ref));
    await assert.rejects(f.port.write(Buffer.alloc(MAX_REPORT_BYTES + 1)), /bound/);
    assert.deepEqual(await readFile(f.ref.path), Buffer.from("original bytes\r\n"));
  } finally { await f.cleanup(); }
});
for (const fault of ["missing", "replacement", "truncation", "oversize", "hardlink", "leafReparse", "ancestorReparse", "acl", "unprotected", "owner", "ancestorAcl"] as const) test(`Windows evidence rejects ${fault} without repairing it`, windows, async () => {
  const f = await fixture();
  const target = path.join(f.root, "target");
  try {
    await f.port.release();
    if (fault === "missing") await rm(f.ref.path);
    if (fault === "replacement") {
      await rename(f.ref.path, f.ref.path + ".old");
      windowsLaunch().persist(f.ref.path, "", "original bytes\r\n");
    }
    if (fault === "truncation") await truncate(f.ref.path, 2);
    if (fault === "oversize") await truncate(f.ref.path, MAX_REPORT_BYTES + 1);
    if (fault === "hardlink") await link(f.ref.path, path.join(f.root, "linked"));
    if (fault === "leafReparse") { await rm(f.ref.path); await symlink(f.root, f.ref.path, "junction"); }
    if (fault === "ancestorReparse") { await rename(f.port.root, target); await symlink(target, f.port.root, "junction"); }
    if (fault === "acl") grant(f.ref.path, "S-1-1-0", "Read");
    if (fault === "ancestorAcl") grant(f.root, "S-1-1-0", "DeleteSubdirectoriesAndFiles");
    if (fault === "unprotected") powershell(`$a=Get-Acl -LiteralPath $p[0]; $a.SetAccessRuleProtection($false,$true); Set-Acl -LiteralPath $p[0] -AclObject $a`, f.ref.path);
    if (fault === "owner") powershell(`$a=Get-Acl -LiteralPath $p[0]; $a.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')); Set-Acl -LiteralPath $p[0] -AclObject $a`, f.ref.path);
    await assert.rejects(verifyReportEvidence(f.port, f.ref));
  } finally { await f.cleanup(); }
});

test("Windows retained evidence denies writers and replacement across async continuation", windows, async () => {
  const f = await fixture();
  try {
    for (const file of [f.ref.path, f.port.root, f.root]) await assert.rejects(rename(file, file + ".replaced"), /EPERM|EBUSY|EACCES/);
    await assert.rejects(writeFile(f.ref.path, "concurrent mutation"), /EPERM|EBUSY|EACCES/);
    await assert.rejects(truncate(f.ref.path, 0), /EPERM|EBUSY|EACCES/);
    await new Promise(resolve => setTimeout(resolve, 10));
    await verifyReportEvidence(f.port, f.ref, "original bytes\r\n");
    await f.port.release();
    await rename(f.ref.path, f.ref.path + ".released"); // explicit release really closes handles
    await assert.rejects(verifyReportEvidence(f.port, f.ref));
  } finally { await f.cleanup(); }
});

test("Windows retained evidence rechecks ACLs and owner at every independent read", windows, async () => {
  const f = await fixture();
  try {
    // WRITE_DAC need not conflict with data sharing. Retention is not a substitute
    // for security descriptor validation on every continuation.
    grant(f.ref.path, "S-1-1-0", "Read");
    await assert.rejects(verifyReportEvidence(f.port, f.ref), /principal/);
  } finally { await f.cleanup(); }
});

test("Windows existing writable mapping is rejected before evidence consumption", windows, async () => {
  const f = await fixture();
  try {
    await f.port.release();
    await writeFile(f.ref.path, "A".repeat(64));
    await withWritableSourceMapping(f.ref.path, f.root, async () => {
      assert.throws(() => windowsLaunch().openReport(f.ref.path), /open rejected/);
    });
  } finally { await f.cleanup(); }
});

test("Windows evidence process crash releases leases without publishing partial artifacts", windows, async () => {
  const root = await launchTestRoot("squire-report-crash-");
  const file = path.join(root, "evidence", `${randomUUID()}.json`);
  const module = path.resolve("build/Release/windows_launch.node");
  const child = spawn(process.execPath, ["-e", `const n=require(process.argv[1]); const held=n.openReport(process.argv[2],Buffer.from('original')); process.stdout.write('ready'); setInterval(()=>n.readReport(held.lease),1000);`, module, file], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    const ready = await Promise.race([once(child.stdout!, "data"), exited.then(() => { throw new Error("native fixture exited before ready"); })]);
    assert.equal(String(ready[0]), "ready");
    await assert.rejects(writeFile(file, "changed"), /EPERM|EBUSY|EACCES/);
    child.kill(); await exited;
    assert.equal(await readFile(file, "utf8"), "original");
    await rename(file, file + ".after-crash");
    // No reference to a partial write was emitted; only a complete read lease
    // could announce readiness. A killed producer cannot authorize acceptance.
  } finally { child.kill(); await exited; await rm(root, { recursive: true, force: true }); }
});

test("Windows native mid-read probes prevent data mutation and detect security mutation", windows, async () => {
  const { createRequire } = await import("node:module");
  const { renameSync, writeFileSync } = await import("node:fs");
  const native = createRequire(import.meta.url)("../../build/Release/windows_launch.node") as {
    openReport(file: string, bytes: Buffer): { lease: object };
    readReport(lease: object, hook: () => void): Buffer;
    closeReport(lease: object): void;
  };
  const root = await launchTestRoot("squire-report-midread-");
  const file = path.join(root, `${randomUUID()}.json`);
  const held = native.openReport(file, Buffer.from("original bytes"));
  try {
    assert.equal(native.readReport(held.lease, () => {
      assert.throws(() => native.closeReport(held.lease), /busy/);
      assert.throws(() => renameSync(file, file + ".moved"), /EPERM|EBUSY|EACCES/);
      assert.throws(() => writeFileSync(file, "mutation"), /EPERM|EBUSY|EACCES/);
    }).toString(), "original bytes");
    assert.throws(() => native.readReport(held.lease, () => grant(file, "S-1-1-0", "Read")), /principal/);
  } finally { native.closeReport(held.lease); await rm(root, { recursive: true, force: true }); }
});
