import assert from "node:assert/strict";
import test from "node:test";
import { assertSbxCommand, SbxV039CommandBuilder } from "../src/sandbox/sbx-command.js";
import { isCanonicalHostPath, hostPathPlatform } from "../src/sandbox/host-platform.js";
import { deriveBridgeName, deriveSandboxName } from "../src/sandbox/identity.js";

test("Windows host paths use local-volume canonical syntax without POSIX assumptions", () => {
  assert.equal(isCanonicalHostPath("C:\\Users\\zkrau\\AppData\\Local\\DockerSandboxes\\bin\\sbx.exe", false, "win32"), true);
  assert.equal(isCanonicalHostPath("C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe", false, "win32"), true);
  assert.equal(hostPathPlatform("C:\\ticket\\state"), "win32");
  for (const value of ["C:/ticket/state", "C:\\ticket\\state\\", "C:\\ticket\\..\\state", "\\\\server\\share\\state", "\\\\?\\C:\\state", "C:\\ticket\\a//b"]) assert.equal(isCanonicalHostPath(value, false, "win32"), false, value);
});

test("sbx argv validation accepts the Windows trusted-host executable and preserves MSYS isolation", () => {
  const builder = new SbxV039CommandBuilder({
    executable: "C:\\Users\\zkrau\\AppData\\Local\\DockerSandboxes\\bin\\sbx.exe",
    executableSha256: "a".repeat(64),
    cwd: "C:\\squire\\run-state",
    environment: {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: "C:\\squire\\run-state\\temp",
      TMP: "C:\\squire\\run-state\\temp",
      USERPROFILE: "C:\\squire\\run-state\\profile",
      PATH: "C:\\Windows\\System32",
      LANG: "C",
      LC_ALL: "C",
    },
  });
  const runId = "run_windows01";
  const sandboxName = deriveSandboxName(runId);
  const command = builder.create({
    sandboxName,
    templateReference: "registry.example/squire/template@sha256:" + "b".repeat(64),
    resources: { cpus: 2, memoryMiB: 512, disk: { enforcement: "quota-composed", ticketQuotaBytes: 1_048_576, bridgeQuotaBytes: 65_536, writableTmpfsBytes: 65_536, proof: { path: "evidence/disk.json", sha256: "c".repeat(64), schemaId: "urn:squire:sandbox:v1:disk-proof" } } },
    bridgeHostPath: `C:\\squire\\run-state\\${deriveBridgeName(runId)}`,
  });
  assertSbxCommand(command);
  assert.equal(command.argv.at(-1), `C:\\squire\\run-state\\${deriveBridgeName(runId)}`);
  assert.equal(command.environment["MSYS_NO_PATHCONV"], "1");
  assert.equal(command.environment["MSYS2_ARG_CONV_EXCL"], "*");
  assert.equal(Object.hasOwn(command.environment, "HOME"), false);
});
