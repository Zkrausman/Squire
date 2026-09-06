import { isIP } from "node:net";
import type { GitObjectFormat } from "./domain.js";

export const RUN_ID_PATTERN = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const TICKET_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
export const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

export class GitIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitIdentityError";
  }
}

export function assertRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new GitIdentityError("invalid run ID");
  assertRefSafeSegment(runId, "run ID");
  return runId;
}

export function assertSha256(value: string, label = "SHA-256 digest"): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new GitIdentityError(`${label} is invalid`);
  return value;
}

export function assertTicketIdentifier(ticketIdentifier: string): string {
  if (typeof ticketIdentifier !== "string" || ticketIdentifier.length > 200 || !TICKET_IDENTIFIER_PATTERN.test(ticketIdentifier)) throw new GitIdentityError("invalid ticket identifier");
  return ticketIdentifier;
}

export function assertRepositoryPart(value: string, label: string): string {
  if (!SAFE_NAME_PATTERN.test(value) || value === "." || value === ".." || value.toLowerCase().endsWith(".git")) {
    throw new GitIdentityError(`invalid repository ${label}`);
  }
  return value;
}

/** Derives the only feature branch accepted by AIDEV-222. */
export function deriveFeatureBranch(ticketIdentifier: string, runId: string): string {
  assertTicketIdentifier(ticketIdentifier);
  assertRunId(runId);
  const branch = `squire/${ticketIdentifier.toLowerCase()}-${runId}`;
  assertValidRefName(`refs/heads/${branch}`);
  return branch;
}

/** Validates a complete heads ref without silently sanitizing caller input. */
export function assertValidRefName(refName: string): string {
  return assertCompleteRef(refName, "refs/heads/");
}

/** Internal refs are controller-generated and may live outside refs/heads, but
 * they receive the same complete-ref safety checks. */
export function assertValidInternalRefName(refName: string): string {
  return assertCompleteRef(refName, "refs/");
}

function assertCompleteRef(refName: string, requiredPrefix: string): string {
  if (typeof refName !== "string" || refName.length === 0 || refName.length > 1024) throw new GitIdentityError("invalid Git ref name");
  if (Buffer.from(refName, "utf8").includes(0) || /[\u0000-\u001f\u007f\n\r\\\s~^:?*\[]/u.test(refName)) throw new GitIdentityError("Git ref contains forbidden characters");
  if (!refName.startsWith(requiredPrefix)) throw new GitIdentityError(`Git ref must be under ${requiredPrefix}`);
  const remainder = refName.slice(requiredPrefix.length);
  if (!remainder || remainder.startsWith("/") || remainder.endsWith("/") || remainder.includes("//") || remainder.includes("..") || remainder.includes("@{")) throw new GitIdentityError("Git ref has unsafe path components");
  if (remainder.startsWith(".") || remainder.endsWith(".") || remainder.endsWith(".lock") || remainder.includes("/.") || remainder.includes("//")) throw new GitIdentityError("Git ref has an unsafe dot or lock component");
  for (const part of remainder.split("/")) {
    if (!part || part === "." || part === ".." || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock")) throw new GitIdentityError("Git ref has an unsafe component");
  }
  return refName;
}

export interface RefFormatChecker {
  checkRefFormat(refName: string): Promise<void>;
}

/** Runs the fixed Git `check-ref-format` helper after pure prechecks. */
export async function assertGitRefFormat(refName: string, checker: RefFormatChecker): Promise<void> {
  assertValidRefName(refName);
  await checker.checkRefFormat(refName);
}

export function branchRef(branch: string): string {
  assertValidRefName(`refs/heads/${branch}`);
  return `refs/heads/${branch}`;
}

export function assertBaseBranch(baseBranch: string): string {
  if (typeof baseBranch !== "string" || baseBranch.length === 0 || baseBranch.length > 200 || baseBranch.startsWith("-") || baseBranch.startsWith("/") || baseBranch.endsWith("/") || baseBranch.includes("\\") || baseBranch.includes("..") || baseBranch.includes("@{")) throw new GitIdentityError("invalid base branch");
  return assertValidRefName(`refs/heads/${baseBranch}`);
}

export function assertFullObjectId(value: string, objectFormat: GitObjectFormat): string {
  const length = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : 0;
  if (!length || typeof value !== "string" || value.length !== length || !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value)) throw new GitIdentityError(`expected a full lowercase ${objectFormat} object ID`);
  if (/^0+$/.test(value)) throw new GitIdentityError("all-zero object ID is not a commit identity");
  return value;
}

export function objectIdLength(objectFormat: GitObjectFormat): 40 | 64 {
  return objectFormat === "sha1" ? 40 : 64;
}

export function zeroObjectId(objectFormat: GitObjectFormat): string {
  return "0".repeat(objectIdLength(objectFormat));
}

export interface ApprovedCloneUrl {
  readonly url: URL;
  readonly owner: string;
  readonly name: string;
}

/** Structural URL validation. Host authorization and redirect policy remain a
 * trusted source-authorizer concern. */
export function assertCredentialFreeHttpsCloneUrl(cloneUrl: string, owner: string, name: string): ApprovedCloneUrl {
  assertRepositoryPart(owner, "owner");
  if (typeof cloneUrl !== "string" || cloneUrl.length === 0 || cloneUrl.length > 2048) throw new GitIdentityError("repository clone URL is not bounded");
  assertRepositoryPart(name, "name");
  let parsed: URL;
  try { parsed = new URL(cloneUrl); } catch { throw new GitIdentityError("repository clone URL is not a URL"); }
  if (parsed.protocol !== "https:") throw new GitIdentityError("repository clone URL must use HTTPS");
  if (parsed.username || parsed.password || parsed.hash || parsed.search) throw new GitIdentityError("repository clone URL contains credentials or mutable URL components");
  if (parsed.port && parsed.port !== "443") throw new GitIdentityError("repository clone URL uses an unexpected port");
  if (isUnsafeNetworkAddress(parsed.hostname)) throw new GitIdentityError("repository clone URL resolves to a private or local address");
  const decodedPath = decodePath(parsed.pathname);
  const expected = `/${owner}/${name}`;
  const expectedGit = `${expected}.git`;
  if (decodedPath !== expected && decodedPath !== expectedGit) throw new GitIdentityError("repository clone URL does not identify the recorded repository");
  return { url: parsed, owner, name };
}

/** Rejects literal destinations that can never be approved as a production
 * source. Hostname DNS policy is intentionally separate because it is async. */
export function isUnsafeNetworkAddress(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/gu, "").toLowerCase();
  const version = isIP(hostname);
  if (version === 4) return unsafeIpv4(hostname);
  if (version === 6) {
    const words = parseIpv6Words(hostname);
    if (!words) return true;
    const mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
    if (mapped) return unsafeIpv4(`${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`);
    const first = words[0]!;
    return words.every(word => word === 0) || (words.slice(0, 7).every(word => word === 0) && words[7] === 1) || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
  }
  // A hostname is checked again after DNS resolution by the production source
  // authorizer. Non-IP strings are not address literals and are therefore not
  // rejected here solely by their spelling (for example, github.com).
  return false;
}

function unsafeIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
  const [a, b, c] = octets;
  if (a === undefined || b === undefined || c === undefined) return true;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && b >= 18 && b <= 19) || (a === 203 && b === 0 && c >= 113) || (a === 198 && b === 51 && c >= 100);
}

function parseIpv6Words(value: string): number[] | undefined {
  if (value.includes("%")) return undefined;
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (!part) return [];
    const pieces = part.split(":");
    const words: number[] = [];
    for (const piece of pieces) {
      if (piece.includes(".")) {
        const octets = piece.split(".").map(Number);
        if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
        words.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else if (/^[0-9a-f]{1,4}$/u.test(piece)) words.push(Number.parseInt(piece, 16));
      else return undefined;
    }
    return words;
  };
  const left = parse(halves[0]!);
  const right = parse(halves[1] ?? "");
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  if (left.length + right.length >= 8) return undefined;
  return [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right];
}

function decodePath(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes("/") && value.split("/").length !== decoded.split("/").length) throw new GitIdentityError("encoded repository path separator is not allowed");
    if (/[^\x20-\x7e]/u.test(decoded)) throw new GitIdentityError("repository URL contains non-ASCII control data");
    return decoded;
  } catch (error) {
    if (error instanceof GitIdentityError) throw error;
    throw new GitIdentityError("repository clone URL has malformed escaping");
  }
}

function assertRefSafeSegment(value: string, label: string): void {
  if (value.includes("..") || value.endsWith(".") || value.endsWith(".lock") || value.includes("@{")) throw new GitIdentityError(`${label} is unsafe as a Git ref component`);
  if (/[\u0000-\u001f\u007f\s\\/]/u.test(value)) throw new GitIdentityError(`${label} contains forbidden ref characters`);
}

// Compatibility aliases keep the contract vocabulary explicit at call sites.
export const validateRunId = assertRunId;
export const validateTicketIdentifier = assertTicketIdentifier;
export const validateObjectId = assertFullObjectId;
