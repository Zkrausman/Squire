#!/usr/bin/env node
/* Compatibility entrypoint retained for the documented acceptance command.
 * The implementation is the auditable executable worker; this file no longer
 * accepts observer-input packets or delegates host proof to a packet validator. */
import { spawn } from "node:child_process";
import path from "node:path";

const worker = path.join(import.meta.dirname, "sandbox-host-worker.mjs");
const root = process.platform === "win32" ? (process.env.SystemRoot ?? process.env.WINDIR) : undefined;
const environment = process.platform === "win32"
  ? { SystemRoot: root, WINDIR: root, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: `${root}\\System32`, LANG: "C", LC_ALL: "C", MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" }
  : { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
const child = spawn(process.execPath, [worker, ...process.argv.slice(2)], { cwd: path.resolve(import.meta.dirname, "../.."), env: environment, shell: false, stdio: "inherit", windowsHide: true });
child.once("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
