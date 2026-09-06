import path from "node:path";

/** Host-path helpers deliberately keep host paths separate from Linux guest
 * paths.  The controller can run on Windows while the guest contract remains
 * POSIX (`/ticket/...`).  Callers may pass a platform in tests; production
 * callers use the running Node platform. */
export type HostPathPlatform = "win32" | "posix";

export function hostPathPlatform(value: string, platform: NodeJS.Platform | HostPathPlatform = process.platform): HostPathPlatform {
  if (platform === "win32") return "win32";
  // This detection is only for validating a command object constructed on a
  // different host in a test or during recovery.  It never makes a guest path
  // a host path: guest paths are validated by their own POSIX validators.
  if (/^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\")) return "win32";
  return "posix";
}

export function hostPathApi(value: string, platform: NodeJS.Platform | HostPathPlatform = process.platform): typeof path.posix | typeof path.win32 {
  return hostPathPlatform(value, platform) === "win32" ? path.win32 : path.posix;
}

export function isCanonicalHostPath(value: unknown, allowRoot = false, platform?: NodeJS.Platform | HostPathPlatform): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\u0000-\u001f\u007f\r\n]/u.test(value)) return false;
  const kind = hostPathPlatform(value, platform);
  const api = kind === "win32" ? path.win32 : path.posix;
  if (!api.isAbsolute(value) || api.normalize(value) !== value) return false;
  const root = api.parse(value).root;
  if (!allowRoot && value === root) return false;
  if (!(allowRoot && value === root) && value.endsWith(kind === "win32" ? "\\" : "/")) return false;
  if (kind === "win32") {
    // Do not accept UNC/device paths or mixed separators.  The trusted host
    // root is a local volume; a network/reparse path is not a private root.
    if (!/^[A-Z]:\\/u.test(value) || value.includes("/") || value.startsWith("\\\\") || value.startsWith("\\\\?\\") || value.startsWith("\\.\\")) return false;
    if (value.split("\\").some(part => part === "." || part === ".." || part.length === 0)) return false;
  } else if (value.includes("\\") || value.includes("//") || value.split("/").some(part => part === "." || part === "..")) return false;
  return true;
}

export function assertCanonicalHostPath(value: unknown, label: string, allowRoot = false, platform?: NodeJS.Platform | HostPathPlatform): asserts value is string {
  if (!isCanonicalHostPath(value, allowRoot, platform)) throw new Error(`${label} is not a canonical absolute host path`);
}

export function hostPathJoin(root: string, ...parts: string[]): string {
  const api = hostPathApi(root);
  return api.join(root, ...parts);
}

export function hostPathDirname(value: string): string { return hostPathApi(value).dirname(value); }
export function hostPathBasename(value: string): string { return hostPathApi(value).basename(value); }
export function hostPathRoot(value: string): string { return hostPathApi(value).parse(value).root; }
export function hostPathResolve(value: string): string { return hostPathApi(value).resolve(value); }
export function hostPathRelative(root: string, value: string): string { return hostPathApi(root).relative(root, value); }
export function hostPathNormalize(value: string): string { return hostPathApi(value).normalize(value); }
export function hostPathSeparator(value: string): string { return hostPathPlatform(value) === "win32" ? "\\" : "/"; }

/** Windows path comparisons are case-insensitive, but separators and path
 * syntax have already been checked by isCanonicalHostPath. */
export function sameHostPath(left: string, right: string): boolean {
  const kind = hostPathPlatform(left);
  if (kind !== hostPathPlatform(right)) return false;
  return kind === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function hostPathWithin(root: string, target: string): boolean {
  if (hostPathPlatform(root) !== hostPathPlatform(target)) return false;
  const kind = hostPathPlatform(root);
  const api = kind === "win32" ? path.win32 : path.posix;
  const relative = api.relative(root, target);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${kind === "win32" ? "\\" : "/"}`) && !api.isAbsolute(relative);
}

export function defaultHostPathEnvironment(source: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): Readonly<Record<string, string>> {
  const allowed = platform === "win32"
    ? ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "PATH", "LANG", "LC_ALL", "MSYS_NO_PATHCONV", "MSYS2_ARG_CONV_EXCL"]
    : ["PATH", "LANG", "LC_ALL", "HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"];
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("host environment must be an explicit object");
  const result: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw new Error(`host environment contains an unallowlisted key: ${key}`);
    const value = source[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > 4_096 || /[\u0000-\u001f\u007f\r\n]/u.test(value)) throw new Error(`host environment value is invalid: ${key}`);
      result[key] = value;
    }
  }
  if (!result["PATH"]) throw new Error("host environment requires an explicit PATH");
  if (platform === "win32") {
    result["MSYS_NO_PATHCONV"] = "1";
    result["MSYS2_ARG_CONV_EXCL"] = "*";
  }
  return Object.freeze(result);
}
