import { createHash } from "node:crypto";
import { assertSandboxRunId, canonicalJson, sha256Bytes } from "./identity.js";

const MAX_MOUNT_INFO_BYTES = 2 * 1024 * 1024;
const CONTROLLER_UID = 1000;
const PHASE_UID = 1001;
const FIXED_ENVIRONMENT = new Set(["HOME", "WIKI_HOME", "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK", "LANG", "LC_ALL", "TMPDIR", "DOCKER_HOST", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);

export interface GuestPrincipalObservation {
  readonly controllerUid: number;
  readonly controllerGid: number;
  readonly agentUid: number;
  readonly agentGid: number;
  readonly capabilities: readonly string[];
  readonly agentGroups: readonly string[];
  readonly sudoAvailable: boolean;
  readonly setuidEscape: boolean;
  readonly supervisorSocketReachable: boolean;
  readonly rootfulDockerSocketReachable: boolean;
  readonly noNewPrivs: boolean;
}

export interface GuestMountObservation {
  readonly mountInfo: string;
  readonly namespace: string;
  readonly ticketDevice: string;
  readonly ticketInode: string;
  readonly knownMounts: readonly string[];
  readonly forbiddenPathsObserved: readonly string[];
}

export interface GuestSocketObservation {
  readonly sockets: readonly string[];
  readonly rootlessDockerSocket: string;
  readonly controllerSockets: readonly string[];
  readonly hostSockets: readonly string[];
}

export interface GuestEnvironmentObservation {
  readonly environment: Readonly<Record<string, string>>;
  readonly configPaths: readonly string[];
  readonly procEnvironment: Readonly<Record<string, string>>;
  readonly gitRemote: string | null;
}

export interface GuestIsolationObservation {
  readonly principal: GuestPrincipalObservation;
  readonly mount: GuestMountObservation;
  readonly sockets: GuestSocketObservation;
  readonly environment: GuestEnvironmentObservation;
  readonly canaryValues: readonly string[];
}

export interface IsolationCanaryEvidence {
  readonly principalDigest: string;
  readonly mountDigest: string;
  readonly dockerDigest: string;
  readonly persistenceDigest: string;
  readonly isolationDigest: string;
  readonly environmentDigest: string;
  readonly credentialsAbsent: true;
}

export class IsolationProbeError extends Error {
  constructor(message: string) { super(message); this.name = "IsolationProbeError"; }
}

/** Strict guest-side proof. It consumes measured observations supplied by the
 * controller worker; it does not trust an agent-provided boolean or pathname
 * alone. */
export class GuestIsolationCanarySuite {
  readonly #allowedEnvironment: ReadonlySet<string>;
  constructor(allowedEnvironment: readonly string[] = ["HOME", "WIKI_HOME", "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK", "LANG", "LC_ALL", "TMPDIR", "DOCKER_HOST", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
    if (!Array.isArray(allowedEnvironment) || new Set(allowedEnvironment).size !== allowedEnvironment.length || allowedEnvironment.some(key => typeof key !== "string" || !FIXED_ENVIRONMENT.has(key))) throw new IsolationProbeError("guest environment allowlist is not a subset of the fixed role environment");
    this.#allowedEnvironment = new Set(allowedEnvironment);
  }

  verify(observation: GuestIsolationObservation, expected: { readonly controllerUid?: number; readonly agentUid?: number; readonly runId?: string }): IsolationCanaryEvidence {
    if (!expected || typeof expected !== "object" || Array.isArray(expected) || Object.keys(expected).some(key => !["agentUid", "controllerUid", "runId"].includes(key))) throw new IsolationProbeError("guest isolation expectations are not closed");
    assertIsolationShape(observation);
    if (expected.runId !== undefined) assertSandboxRunId(expected.runId);
    if ((expected.controllerUid !== undefined && expected.controllerUid !== CONTROLLER_UID) || (expected.agentUid !== undefined && expected.agentUid !== PHASE_UID)) throw new IsolationProbeError("guest principal expectations are fixed to the sandbox template identities");
    assertPrincipal(observation.principal, CONTROLLER_UID, PHASE_UID);
    const mounts = parseMountInfo(observation.mount.mountInfo);
    assertMountIsolation(mounts, observation.mount);
    assertSocketIsolation(observation.sockets);
    assertEnvironmentIsolation(observation.environment, this.#allowedEnvironment, observation.canaryValues, expected.runId);
    const principalDigest = sha256Bytes(Buffer.from(canonicalJson(observation.principal), "utf8"));
    const mountDigest = sha256Bytes(Buffer.from(canonicalJson({ namespace: observation.mount.namespace, ticketDevice: observation.mount.ticketDevice, ticketInode: observation.mount.ticketInode, mounts }), "utf8"));
    const dockerDigest = sha256Bytes(Buffer.from(canonicalJson({ rootlessDocker: observation.sockets.rootlessDockerSocket, sockets: observation.sockets.sockets }), "utf8"));
    const persistenceDigest = sha256Bytes(Buffer.from(canonicalJson({ runId: expected.runId ?? null, paths: ["/ticket/git/repo.git", "/ticket/workspace", "/ticket/sessions", "/ticket/runtime", "/ticket/artifacts", "/ticket/evidence", "/ticket/docker"] }), "utf8"));
    const isolationDigest = sha256Bytes(Buffer.from(canonicalJson({ forbiddenMounts: observation.mount.forbiddenPathsObserved, groups: observation.principal.agentGroups, configPaths: observation.environment.configPaths }), "utf8"));
    return { principalDigest, mountDigest, dockerDigest, persistenceDigest, isolationDigest, environmentDigest: environmentDigest(observation.environment), credentialsAbsent: true };
  }
}

export function assertPrincipal(observed: GuestPrincipalObservation, expectedControllerUid = CONTROLLER_UID, expectedAgentUid = PHASE_UID): void {
  if (!isObjectWithKeys(observed, ["agentGid", "agentGroups", "agentUid", "capabilities", "controllerGid", "controllerUid", "noNewPrivs", "rootfulDockerSocketReachable", "setuidEscape", "sudoAvailable", "supervisorSocketReachable"]) || !observed || typeof observed !== "object" || !Number.isSafeInteger(expectedControllerUid) || expectedControllerUid <= 0 || expectedControllerUid > 65_535 || !Number.isSafeInteger(expectedAgentUid) || expectedAgentUid <= 0 || expectedAgentUid > 65_535 || !Number.isSafeInteger(observed.controllerUid) || !Number.isSafeInteger(observed.controllerGid) || !Number.isSafeInteger(observed.agentUid) || !Number.isSafeInteger(observed.agentGid) || [observed.controllerUid, observed.controllerGid, observed.agentUid, observed.agentGid].some(value => value <= 0 || value > 65_535) || observed.controllerUid !== expectedControllerUid || observed.agentUid !== expectedAgentUid || observed.controllerGid !== expectedControllerUid || observed.agentGid !== expectedAgentUid || observed.controllerUid === observed.agentUid || observed.controllerGid === observed.agentGid || !Array.isArray(observed.capabilities) || !Array.isArray(observed.agentGroups)) throw new IsolationProbeError("guest controller and role principals are not the exact distinct numeric identities");
  const forbiddenGroups = new Set(["squirectl", "docker", "root", "sudo", "wheel", "adm", "disk", "shadow", "kmem", "tape", "tty", "video", "render", "audio", "lxd", "libvirt", "kvm", "systemd-journal", "setgid", "setuid"]);
  if (!Array.isArray(observed.capabilities) || !Array.isArray(observed.agentGroups) || observed.capabilities.length !== 0 || observed.capabilities.some(value => typeof value !== "string" || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) || observed.agentGroups.length !== 0 || new Set(observed.agentGroups).size !== observed.agentGroups.length || observed.agentGroups.some(group => typeof group !== "string" || group.length === 0 || group.length > 128 || /[\u0000-\u001f\u007f]/u.test(group) || forbiddenGroups.has(group.toLowerCase())) || observed.sudoAvailable !== false || observed.setuidEscape !== false || observed.supervisorSocketReachable !== false || observed.rootfulDockerSocketReachable !== false || observed.noNewPrivs !== true) throw new IsolationProbeError("guest role principal has an escalation or controller capability");
}

export function parseMountInfo(value: string): readonly { readonly mountPoint: string; readonly record: string }[] {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_MOUNT_INFO_BYTES) throw new IsolationProbeError("guest mountinfo exceeds its bound");
  const rawLines = value.split("\n");
  if (rawLines.at(-1) === "") rawLines.pop();
  const lines = rawLines;
  if (lines.length === 0 || lines.length > 100_000 || lines.some(line => line.length === 0 || line.startsWith(" ") || line.endsWith(" ") || line.includes("  ") || line.includes("\t"))) throw new IsolationProbeError("guest mountinfo is empty or unbounded");
  const result: Array<{ mountPoint: string; record: string }> = [];
  const mountIds = new Set<string>();
  for (const line of lines) {
    if (/[\u0000-\u001f\u007f]/u.test(line)) throw new IsolationProbeError("guest mountinfo contains control data");
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (fields.length < 7 || separator < 6 || separator !== fields.lastIndexOf("-") || separator + 3 >= fields.length || !fields[0] || !/^\d+$/u.test(fields[0]) || mountIds.has(fields[0]) || !fields[1] || !/^\d+$/u.test(fields[1]) || !/^\d+:\d+$/u.test(fields[2]!) || !fields[3] || !fields[4] || !fields[separator + 1] || !fields[separator + 2]) throw new IsolationProbeError("guest mountinfo record is malformed");
    const mountPoint = decodeMountPath(fields[4]);
    if (!isSafeGuestPath(mountPoint)) throw new IsolationProbeError("guest mountinfo path is not canonical");
    if (result.some(existing => existing.mountPoint === mountPoint)) throw new IsolationProbeError("guest mountinfo contains duplicate mount points");
    mountIds.add(fields[0]!);
    result.push({ mountPoint, record: line });
  }
  return Object.freeze(result);
}

export function assertMountIsolation(mounts: readonly { readonly mountPoint: string; readonly record: string }[], observed: GuestMountObservation): void {
  if (!Array.isArray(mounts) || mounts.length === 0 || mounts.length > 100_000 || mounts.some(mount => !isObjectWithKeys(mount, ["mountPoint", "record"]) || !isSafeGuestPath(mount.mountPoint) || typeof mount.record !== "string" || mount.record.length === 0 || mount.record.length > 1_000_000)) throw new IsolationProbeError("guest mount observation is malformed");
  if (!isObjectWithKeys(observed, ["forbiddenPathsObserved", "knownMounts", "mountInfo", "namespace", "ticketDevice", "ticketInode"])) throw new IsolationProbeError("guest mount observation fields are not closed");
  const ticket = mounts.find(mount => mount.mountPoint === "/ticket");
  const bridge = mounts.find(mount => mount.mountPoint === "/ticket/bridge");
  if (!ticket) throw new IsolationProbeError("guest mountinfo does not contain the persistent /ticket root");
  if (!bridge) throw new IsolationProbeError("guest mountinfo does not contain the exact untrusted /ticket/bridge mount");
  for (const mount of mounts) {
    const fields = mountFields(mount.record);
    const separator = fields.indexOf("-");
    const filesystem = fields[separator + 1]!;
    const source = decodeMountPath(fields[separator + 2]!);
    const lowerFilesystem = filesystem.toLowerCase();
    if (mount.mountPoint.startsWith("/ticket/") || mount.mountPoint === "/ticket") {
      if (mount.mountPoint !== "/ticket" && mount.mountPoint !== "/ticket/bridge" && mount.mountPoint !== "/ticket/tmp") throw new IsolationProbeError(`guest ticket root contains an unexpected nested mount: ${mount.mountPoint}`);
      if (mount.mountPoint === "/ticket" && !["ext4", "xfs", "btrfs", "f2fs", "zfs", "bcachefs"].includes(lowerFilesystem)) throw new IsolationProbeError("guest /ticket is not a persistent local filesystem");
      if (mount.mountPoint === "/ticket/bridge" && lowerFilesystem !== "virtiofs") throw new IsolationProbeError("guest /ticket/bridge is not the exact virtiofs passthrough");
      if (mount.mountPoint === "/ticket/tmp") {
        if (lowerFilesystem !== "tmpfs" || !/\brw(?:,|$)/u.test(fields[5]!) || !/(?:^|,)size=\d+(?:[kKmMgG])?(?:,|$)/u.test(fields[separator + 3]!)) throw new IsolationProbeError("guest /ticket/tmp is not a bounded writable tmpfs");
      }
    }
    const systemMount = mount.mountPoint === "/ticket/tmp" || isAllowedSystemMount(mount.mountPoint, lowerFilesystem);
    if (!systemMount && (/(?:^|\/)(?:ssh|\.ssh|\.docker|skills|mcp|herdr|source|home|control|secrets?|credentials?)(?:\/|$)/iu.test(mount.mountPoint) || /docker\.sock/iu.test(mount.mountPoint) || /(?:^|\/)(?:ssh|\.ssh|\.docker|skills|mcp|herdr|source|home|control|secrets?|credentials?)(?:\/|$)/iu.test(source) || /docker\.sock|host\.docker\.internal/iu.test(source) || ["fuse", "fuseblk", "nfs", "nfs4", "cifs", "smb3"].includes(lowerFilesystem) || ["tmpfs", "overlay", "proc", "sysfs", "devtmpfs", "devpts", "mqueue", "cgroup", "cgroup2"].includes(lowerFilesystem))) throw new IsolationProbeError("guest mountinfo exposes a forbidden host/controller surface");
  }
  if (!Array.isArray(observed.forbiddenPathsObserved) || observed.forbiddenPathsObserved.length !== 0 || !Array.isArray(observed.knownMounts) || observed.knownMounts.length !== 3 || observed.knownMounts.filter(mount => mount === "/ticket").length !== 1 || observed.knownMounts.filter(mount => mount === "/ticket/bridge").length !== 1 || observed.knownMounts.filter(mount => mount === "/ticket/tmp").length !== 1 || new Set(observed.knownMounts).size !== observed.knownMounts.length || observed.knownMounts.some(mount => typeof mount !== "string" || mount.length > 1_024 || !isSafeGuestPath(mount) || !isTicketPath(mount) || mount !== "/ticket" && mount !== "/ticket/bridge" && mount !== "/ticket/tmp" || /(?:ssh|docker\.sock|skills|mcp|herdr|source|home|control)/iu.test(mount)) || mounts.some(mount => mount.mountPoint === "/ticket" || mount.mountPoint === "/ticket/bridge" || mount.mountPoint === "/ticket/tmp" ? !observed.knownMounts.includes(mount.mountPoint) : mount.mountPoint.startsWith("/ticket/")) || observed.knownMounts.some(mount => !mounts.some(candidate => candidate.mountPoint === mount))) throw new IsolationProbeError("guest mount observation contains a forbidden host/controller surface");
  if (!/^mnt:\[[^\]\r\n]{1,128}\]$/u.test(observed.namespace) || !/^\d+:\d+$/u.test(observed.ticketDevice) || !/^\d+$/u.test(observed.ticketInode) || `${observed.namespace}${observed.ticketDevice}${observed.ticketInode}`.length > 1_536 || /[\u0000-\u001f\u007f\r\n]/u.test(`${observed.namespace}${observed.ticketDevice}${observed.ticketInode}`)) throw new IsolationProbeError("guest mount identity evidence is incomplete");
  if (mountDevice(ticket.record) !== observed.ticketDevice) throw new IsolationProbeError("guest /ticket device identity differs from the measured mount");
  if (mountDevice(bridge.record) === observed.ticketDevice && mountId(bridge.record) === mountId(ticket.record)) throw new IsolationProbeError("guest bridge is not an independently mounted untrusted surface");
}

export function assertSocketIsolation(observed: GuestSocketObservation): void {
  if (!isObjectWithKeys(observed, ["controllerSockets", "hostSockets", "rootlessDockerSocket", "sockets"]) || !observed || typeof observed !== "object" || !Array.isArray(observed.sockets) || !Array.isArray(observed.controllerSockets) || !Array.isArray(observed.hostSockets) || observed.controllerSockets.some(socket => typeof socket !== "string" || socket.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(socket)) || observed.hostSockets.some(socket => typeof socket !== "string" || socket.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(socket)) || observed.rootlessDockerSocket !== "/ticket/docker/run/docker.sock" || observed.controllerSockets.length !== 0 || observed.hostSockets.length !== 0 || observed.sockets.length !== 1 || new Set(observed.sockets).size !== observed.sockets.length || observed.sockets.some(socket => typeof socket !== "string" || socket.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(socket) || socket !== observed.rootlessDockerSocket)) throw new IsolationProbeError("guest socket inventory exposes a controller, host, or credential socket");
}

export function assertEnvironmentIsolation(observed: GuestEnvironmentObservation, allowed: ReadonlySet<string>, canaryValues: readonly string[], expectedRunId?: string): void {
  if (!isObjectWithKeys(observed, ["configPaths", "environment", "gitRemote", "procEnvironment"]) || !(allowed instanceof Set) || allowed.size > FIXED_ENVIRONMENT.size || [...allowed].some(key => !FIXED_ENVIRONMENT.has(key)) || !Array.isArray(canaryValues)) throw new IsolationProbeError("guest environment observation fields are not closed");
  if (expectedRunId !== undefined) assertSandboxRunId(expectedRunId);
  const forbiddenNames = /(?:SSH_AUTH_SOCK|DOCKER_HOST.*(?:tcp|unix:\/\/var)|GITHUB|GH_TOKEN|LINEAR|OPENAI_API_KEY|ANTHROPIC_API_KEY|NPM_TOKEN|AWS_SECRET|REGISTRY|DELIVERY|REVIEWER|SBX_SOCKET|HERDR)/iu;
  if (!observed || typeof observed !== "object" || !observed.environment || typeof observed.environment !== "object" || Array.isArray(observed.environment) || !observed.procEnvironment || typeof observed.procEnvironment !== "object" || Array.isArray(observed.procEnvironment)) throw new IsolationProbeError("guest environment observation is not a closed object");
  if (Object.keys(observed.environment).length > 32 || Object.keys(observed.procEnvironment).length > 32) throw new IsolationProbeError("guest environment observation is unbounded");
  for (const [key, value] of Object.entries(observed.environment)) {
    if (!allowed.has(key) || forbiddenNames.test(key) || typeof value !== "string" || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value) || (key === "DOCKER_HOST" && value !== "unix:///ticket/docker/run/docker.sock") || (["HTTP_PROXY", "HTTPS_PROXY"].includes(key) && !/^squire-proxy:\/\/[a-z0-9._-]{1,128}$/u.test(value)) || (key === "NO_PROXY" && !/^squire-no-proxy:\/\/[a-z0-9._-]{1,128}$/u.test(value))) throw new IsolationProbeError(`guest environment contains a forbidden variable: ${key}`);
  }
  for (const [key, value] of Object.entries(observed.procEnvironment)) if (!allowed.has(key) || forbiddenNames.test(key) || typeof value !== "string" || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value) || (key === "DOCKER_HOST" && value !== "unix:///ticket/docker/run/docker.sock") || (["HTTP_PROXY", "HTTPS_PROXY"].includes(key) && !/^squire-proxy:\/\/[a-z0-9._-]{1,128}$/u.test(value)) || (key === "NO_PROXY" && !/^squire-no-proxy:\/\/[a-z0-9._-]{1,128}$/u.test(value))) throw new IsolationProbeError(`guest /proc environment contains a forbidden variable: ${key}`);
  const required = ["HOME", "WIKI_HOME", "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK", "TMPDIR", "DOCKER_HOST"];
  if (required.some(key => !Object.hasOwn(observed.environment, key) || !Object.hasOwn(observed.procEnvironment, key) || observed.environment[key] === undefined || observed.procEnvironment[key] === undefined)) throw new IsolationProbeError("guest role environment is missing a required ticket-scoped variable");
  if (observed.environment["PI_SKIP_VERSION_CHECK"] !== "1" || observed.environment["TMPDIR"] !== "/ticket/tmp" || expectedRunId !== undefined && (observed.environment["HOME"] !== `/ticket/runtime/${expectedRunId}/home` || observed.environment["WIKI_HOME"] !== `/ticket/runtime/${expectedRunId}/wiki-home` || observed.environment["PI_CODING_AGENT_DIR"] !== `/ticket/runtime/${expectedRunId}/pi-agent`)) throw new IsolationProbeError("guest role environment is not run-scoped");
  const environmentKeys = Object.keys(observed.environment).sort(); const procKeys = Object.keys(observed.procEnvironment).sort();
  if (environmentKeys.length !== procKeys.length || environmentKeys.some((key, index) => key !== procKeys[index] || observed.environment[key] !== observed.procEnvironment[key])) throw new IsolationProbeError("guest environment differs from /proc/self/environ");
  if (!Array.isArray(observed.configPaths) || observed.configPaths.length > 128 || new Set(observed.configPaths).size !== observed.configPaths.length || observed.configPaths.some(value => typeof value !== "string" || value.length === 0 || value.length > 1_024 || !value.startsWith("/ticket/") || value.includes("//") || value.split("/").some(part => part === "." || part === "..") || /[\u0000-\u001f\u007f]/u.test(value) || /(?:\.ssh|\.docker\/config|credentials|mcp|skills|\.npmrc|linear|github|host)/iu.test(value))) throw new IsolationProbeError("guest configuration scan found a forbidden host credential/config path");
  if (observed.gitRemote !== null) throw new IsolationProbeError("guest Git remote must remain absent; repository transport is controller-mediated");
  if (!Array.isArray(canaryValues) || canaryValues.length === 0 || canaryValues.length > 128 || canaryValues.some(value => typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000\r\n]/u.test(value))) throw new IsolationProbeError("guest credential canary is malformed");
  const serialized = canonicalJson({ environment: observed.environment, proc: observed.procEnvironment, config: observed.configPaths, gitRemote: observed.gitRemote });
  if (canaryValues.some(value => serialized.includes(value))) throw new IsolationProbeError("guest environment/config scan found a forbidden canary value");
}

export function environmentDigest(observed: GuestEnvironmentObservation): string {
  return createHash("sha256").update(canonicalJson(observed), "utf8").digest("hex");
}

export function buildCanaryDigest(value: unknown): string { return sha256Bytes(Buffer.from(canonicalJson(value), "utf8")); }

function assertIsolationShape(value: unknown): asserts value is GuestIsolationObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IsolationProbeError("guest isolation observation is not an object");
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["canaryValues", "environment", "mount", "principal", "sockets"]) || !isObjectWithKeys(record["principal"], ["agentGid", "agentGroups", "agentUid", "capabilities", "controllerGid", "controllerUid", "noNewPrivs", "rootfulDockerSocketReachable", "setuidEscape", "sudoAvailable", "supervisorSocketReachable"]) || !isObjectWithKeys(record["mount"], ["forbiddenPathsObserved", "knownMounts", "mountInfo", "namespace", "ticketDevice", "ticketInode"]) || !isObjectWithKeys(record["sockets"], ["controllerSockets", "hostSockets", "rootlessDockerSocket", "sockets"]) || !isObjectWithKeys(record["environment"], ["configPaths", "environment", "gitRemote", "procEnvironment"]) || !Array.isArray(record["canaryValues"])) throw new IsolationProbeError("guest isolation observation contains unknown or missing fields");
}
function isObjectWithKeys(value: unknown, keys: readonly string[]): boolean { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && hasExactKeys(value as Record<string, unknown>, keys); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function isSafeGuestPath(value: string): boolean { return typeof value === "string" && value.length > 0 && value.startsWith("/") && (value === "/" || !value.endsWith("/")) && !value.includes("//") && !value.includes("\\") && !value.split("/").some(part => part === "." || part === "..") && !/[\u0000-\u001f\u007f]/u.test(value); }
function isTicketPath(value: string): boolean { return value === "/ticket" || value.startsWith("/ticket/"); }
function decodeMountPath(value: string): string {
  if (/\\(?![0-7]{3})/u.test(value)) throw new IsolationProbeError("guest mountinfo contains an invalid escape");
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}
function isAllowedSystemMount(mountPoint: string, filesystem: string): boolean {
  if (mountPoint === "/") return filesystem === "rootfs" || filesystem === "overlay";
  if (mountPoint === "/run") return filesystem === "tmpfs";
  if (mountPoint === "/proc" || mountPoint.startsWith("/proc/")) return filesystem === "proc" || filesystem === "tmpfs";
  if (mountPoint === "/sys" || mountPoint.startsWith("/sys/")) return filesystem === "sysfs" || filesystem === "tmpfs" || filesystem === "cgroup" || filesystem === "cgroup2" || filesystem === "efivarfs";
  if (mountPoint === "/dev" || mountPoint.startsWith("/dev/")) return filesystem === "devtmpfs" || filesystem === "devpts" || filesystem === "mqueue" || filesystem === "tmpfs";
  return false;
}
function mountFields(record: string): readonly string[] { const fields = record.split(" "); const separator = fields.indexOf("-"); if (fields.length < 7 || separator < 6 || separator !== fields.lastIndexOf("-") || separator + 3 >= fields.length || !fields[separator + 1] || !fields[separator + 2]) throw new IsolationProbeError("guest mountinfo record is malformed"); return fields; }
function mountDevice(record: string): string { return mountFields(record)[2]!; }
function mountId(record: string): string { return mountFields(record)[0]!; }
