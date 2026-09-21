import { createRequire } from "node:module";
import path from "node:path";

interface WindowsLaunchNative {
  observeOwnerFile(file: string): { bytes: string; identity: string } | undefined;
  ownerProcessIdentity(pid: number): string;
  openReport(file: string, bytes?: Buffer): { lease: object; identity: string };
  readReport(lease: object): Buffer;
  closeReport(lease: object): void;
  openSource(root: string, repository: string): object;
  readSource(lease: object, name: string): Buffer;
  closeSource(lease: object): void;
  persist(file: string, repository: string, bytes: string): void;
  read(file: string, repository: string): string;
  readPrivateBytes(file: string, repository: string, maximum: number): Buffer;
  openLog(file: string): number;
  closeLog(fd: number): void;
  replaceState(source: string, destination: string): void;
}
let binding: WindowsLaunchNative | undefined;
/** Native handle-relative ACL/reparse boundary; never substitute Node mode bits. */
export function windowsLaunch(): WindowsLaunchNative {
  if (process.platform !== "win32") throw new Error("Windows launch boundary requested on non-Windows host");
  if (!binding) {
    try { binding = createRequire(import.meta.url)("../../../build/Release/windows_launch.node") as WindowsLaunchNative; }
    catch (cause) { throw new Error("Windows detached launch requires native security support. Run npm ci and npm run build with Python and Visual Studio C++ build tools; no unsafe fallback is available.", { cause }); }
  }
  return binding;
}
/** Phase input bytes use the same protected creation, not a general FS API. */
export function persistWindowsPhaseInput(file: string, bytes: string): void {
  windowsLaunch().persist(path.resolve(file), "", bytes);
}
