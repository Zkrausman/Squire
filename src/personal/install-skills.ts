import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The only skill directories Squire is permitted to install or refresh. */
export const OWNED_SKILLS = ["squire-operator", "squire-bug-report"] as const;
/** The only packaged Pi agent Squire is permitted to install or refresh. */
export const OWNED_AGENTS = ["squire-observer"] as const;

export type OwnedSkill = typeof OWNED_SKILLS[number];
export type OwnedAgent = typeof OWNED_AGENTS[number];
export type InstallSkillStatus = "installed" | "refreshed" | "current";

export interface InstalledSkill {
  readonly skill: OwnedSkill;
  readonly status: InstallSkillStatus;
}

export interface InstalledAgent {
  readonly agent: OwnedAgent;
  readonly status: InstallSkillStatus;
}

export interface InstallSkillsResult {
  readonly skills: readonly InstalledSkill[];
  readonly agents: readonly InstalledAgent[];
}

export class SkillInstallError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillInstallError";
  }
}

export type InstallSkillsPlatform = NodeJS.Platform | "posix";

export interface PiAgentDirectoryOptions {
  readonly platform?: InstallSkillsPlatform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

interface MkdirOptions {
  readonly mode?: number;
  readonly recursive?: boolean;
}

interface WriteFileOptions {
  readonly mode?: number;
  readonly flag?: string;
}

interface RemoveOptions {
  readonly recursive?: boolean;
  readonly force?: boolean;
}

/**
 * A deliberately narrow filesystem seam keeps replacement cleanup testable
 * without adding a public source/target interface to the CLI.
 */
export interface InstallSkillsFileSystem {
  lstat(file: string): Promise<Stats>;
  readdir(directory: string): Promise<string[]>;
  readFile(file: string): Promise<Buffer>;
  mkdir(directory: string, options?: MkdirOptions): Promise<string | undefined>;
  mkdtemp(prefix: string): Promise<string>;
  writeFile(file: string, bytes: Buffer, options?: WriteFileOptions): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(target: string, options?: RemoveOptions): Promise<void>;
}

export interface InstallSkillsOptions extends PiAgentDirectoryOptions {
  /** Internal package-layout seam used by focused tests; the CLI never accepts a source flag. */
  readonly packageRoot?: string;
  /** Internal failure-injection seam; the CLI always uses the real filesystem. */
  readonly fileSystem?: Partial<InstallSkillsFileSystem>;
}

const INSTALL_DIRECTORY_MODE = 0o755;
const INSTALL_FILE_MODE = 0o644;
const POSIX_OWNER_WRITE = 0o200;

const realFileSystem: InstallSkillsFileSystem = {
  lstat: async file => await fs.lstat(file),
  readdir: async directory => await fs.readdir(directory),
  readFile: async file => await fs.readFile(file),
  mkdir: async (directory, options) => await fs.mkdir(directory, options),
  mkdtemp: async prefix => await fs.mkdtemp(prefix),
  writeFile: async (file, bytes, options) => await fs.writeFile(file, bytes, options),
  chmod: async (file, mode) => await fs.chmod(file, mode),
  rename: async (source, destination) => await fs.rename(source, destination),
  rm: async (target, options) => await fs.rm(target, options),
};

/** Resolve Pi's documented per-user agent directory without reading Squire configuration. */
export function resolvePiAgentDirectory(options: PiAgentDirectoryOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const explicitlyConfigured = Object.prototype.hasOwnProperty.call(environment, "PI_CODING_AGENT_DIR");
  let selected: string | undefined;

  if (explicitlyConfigured) {
    selected = environment["PI_CODING_AGENT_DIR"];
    if (typeof selected !== "string" || selected.length === 0) {
      throw new SkillInstallError("PI_CODING_AGENT_DIR must be an absolute directory");
    }
  } else if (platform === "win32") {
    const profile = nonempty(environment["USERPROFILE"])
      ?? (nonempty(environment["HOMEDRIVE"]) && nonempty(environment["HOMEPATH"])
        ? `${environment["HOMEDRIVE"]}${environment["HOMEPATH"]}`
        : undefined)
      ?? options.homeDirectory
      ?? os.homedir();
    selected = path.win32.join(profile, ".pi", "agent");
  } else {
    const home = nonempty(environment["HOME"]) ?? options.homeDirectory ?? os.homedir();
    selected = path.posix.join(home, ".pi", "agent");
  }

  if (selected.includes("\0") || !pathApi.isAbsolute(selected)) {
    throw new SkillInstallError("PI_CODING_AGENT_DIR must be an absolute directory");
  }
  const normalized = pathApi.normalize(selected);
  if (normalized === pathApi.parse(normalized).root) {
    throw new SkillInstallError("Pi agent directory must not be a filesystem root");
  }
  return normalized;
}

/** Install exactly the two packaged Squire skills and named observer agent, returning deterministic status records. */
export async function installSkills(options: InstallSkillsOptions = {}): Promise<InstallSkillsResult> {
  const fileSystem = { ...realFileSystem, ...(options.fileSystem ?? {}) };
  const platform = options.platform ?? process.platform;
  const agentDirectory = resolvePiAgentDirectory(options);
  const packageRoot = await resolvePackageRoot(options.packageRoot, fileSystem);
  const packagedSkillsRoot = path.join(packageRoot, "skills");
  const packagedAgentsRoot = path.join(packageRoot, "agents");

  await requireDirectory(packagedSkillsRoot, "packaged skills", fileSystem);
  await requireDirectory(packagedAgentsRoot, "packaged agents", fileSystem);
  const packaged = new Map<OwnedSkill, TreeSnapshot>();
  for (const skill of OWNED_SKILLS) {
    const source = path.join(packagedSkillsRoot, skill);
    packaged.set(skill, await snapshotTree(source, `packaged ${skill}`, fileSystem));
  }
  const packagedAgents = new Map<OwnedAgent, FileSnapshot>();
  for (const agent of OWNED_AGENTS) {
    const source = path.join(packagedAgentsRoot, `${agent}.md`);
    packagedAgents.set(agent, await snapshotFile(source, `packaged ${agent}`, fileSystem));
  }

  const createdDirectories: string[] = [];
  try {
    createdDirectories.push(...await ensureDirectory(agentDirectory, "Pi agent root", fileSystem));
    const installedSkillsRoot = path.join(agentDirectory, "skills");
    createdDirectories.push(...await ensureDirectory(installedSkillsRoot, "Pi skills directory", fileSystem));
    const installedAgentsRoot = path.join(agentDirectory, "agents");
    createdDirectories.push(...await ensureDirectory(installedAgentsRoot, "Pi agents directory", fileSystem));

    const plans: SkillPlan[] = [];
    for (const skill of OWNED_SKILLS) {
      const destination = path.join(installedSkillsRoot, skill);
      const installed = await optionalSnapshot(destination, `installed ${skill}`, fileSystem);
      const source = packaged.get(skill)!;
      plans.push({
        skill,
        destination,
        source,
        destinationExists: installed !== undefined,
        status: installed === undefined ? "installed" : snapshotsEqual(source, installed, platform) ? "current" : "refreshed",
      });
    }

    const agentPlans: AgentPlan[] = [];
    for (const agent of OWNED_AGENTS) {
      const destination = path.join(installedAgentsRoot, `${agent}.md`);
      const installed = await optionalFileSnapshot(destination, `installed ${agent}`, fileSystem);
      const source = packagedAgents.get(agent)!;
      agentPlans.push({
        agent,
        destination,
        source,
        destinationExists: installed !== undefined,
        status: installed === undefined ? "installed" : fileSnapshotsEqual(source, installed, platform) ? "current" : "refreshed",
      });
    }

    for (const plan of plans) {
      if (plan.status !== "current") {
        await replaceSkill(plan, installedSkillsRoot, platform, fileSystem);
      }
    }
    for (const plan of agentPlans) {
      if (plan.status !== "current") {
        await replaceAgent(plan, installedAgentsRoot, platform, fileSystem);
      }
    }

    return {
      skills: plans.map(({ skill, status }) => ({ skill, status })),
      agents: agentPlans.map(({ agent, status }) => ({ agent, status })),
    };
  } catch (error) {
    await removeEmptyDirectories(createdDirectories, fileSystem);
    throw asInstallError(error, "skill installation did not complete");
  }
}

/** Run the public command without loading Squire configuration or integrations. */
export async function installSkillsCommand(): Promise<number> {
  try {
    const result = await installSkills();
    process.stdout.write(formatInstallSkillsResult(result));
    return 0;
  } catch (error) {
    process.stderr.write(`Squire install-skills failed: ${publicErrorMessage(error)}\n`);
    return 1;
  }
}

export function formatInstallSkillsResult(result: InstallSkillsResult): string {
  const skills = result.skills.map(({ skill, status }) => `${skill}: ${status}`);
  const agents = (result.agents ?? []).map(({ agent, status }) => `${agent}: ${status}`);
  return `${[...skills, ...agents].join("\n")}\n`;
}

interface TreeSnapshot {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly directories: readonly string[];
  readonly writableFiles: ReadonlySet<string>;
  readonly writableDirectories: ReadonlySet<string>;
  readonly rootWritable: boolean;
}

interface FileSnapshot {
  readonly bytes: Buffer;
  readonly writable: boolean;
}

interface SkillPlan {
  readonly skill: OwnedSkill;
  readonly destination: string;
  readonly source: TreeSnapshot;
  readonly destinationExists: boolean;
  readonly status: InstallSkillStatus;
}

interface AgentPlan {
  readonly agent: OwnedAgent;
  readonly destination: string;
  readonly source: FileSnapshot;
  readonly destinationExists: boolean;
  readonly status: InstallSkillStatus;
}

async function resolvePackageRoot(override: string | undefined, fileSystem: InstallSkillsFileSystem): Promise<string> {
  if (override !== undefined) {
    if (!path.isAbsolute(override) || override.includes("\0")) {
      throw new SkillInstallError("packaged skill source is not an absolute package path");
    }
    return path.normalize(override);
  }

  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(directory, "skills");
    try {
      const stats = await fileSystem.lstat(candidate);
      if (stats.isSymbolicLink()) throw new SkillInstallError("packaged skill source contains an alias");
      if (stats.isDirectory()) return directory;
    } catch (error) {
      if (!isNotFound(error)) throw asInstallError(error, "packaged skill source could not be inspected");
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new SkillInstallError("packaged Squire skills are unavailable");
    directory = parent;
  }
}

async function requireDirectory(directory: string, label: string, fileSystem: InstallSkillsFileSystem): Promise<void> {
  await inspectDirectoryPath(directory, label, fileSystem, false);
}

async function ensureDirectory(directory: string, label: string, fileSystem: InstallSkillsFileSystem): Promise<string[]> {
  return await inspectDirectoryPath(directory, label, fileSystem, true);
}

async function inspectDirectoryPath(directory: string, label: string, fileSystem: InstallSkillsFileSystem, create: boolean): Promise<string[]> {
  const absolute = path.resolve(directory);
  if (absolute.includes("\0")) throw new SkillInstallError(`${label} contains an invalid path`);
  const missing: string[] = [];
  let cursor = absolute;

  for (;;) {
    try {
      const stats = await fileSystem.lstat(cursor);
      if (stats.isSymbolicLink()) throw new SkillInstallError(`${label} contains an alias`);
      if (!stats.isDirectory()) throw new SkillInstallError(`${label} is not a directory`);
      break;
    } catch (error) {
      if (!isNotFound(error)) throw asInstallError(error, `${label} could not be inspected`);
      if (!create) throw new SkillInstallError(`${label} is unavailable`);
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new SkillInstallError(`${label} has no safe parent directory`);
      cursor = parent;
    }
  }

  const created: string[] = [];
  for (const missingDirectory of missing.reverse()) {
    try {
      await fileSystem.mkdir(missingDirectory, { mode: INSTALL_DIRECTORY_MODE });
      created.push(missingDirectory);
    } catch (error) {
      if (!isAlreadyExists(error)) throw asInstallError(error, `${label} could not be created`);
    }
    try {
      const stats = await fileSystem.lstat(missingDirectory);
      if (stats.isSymbolicLink()) throw new SkillInstallError(`${label} contains an alias`);
      if (!stats.isDirectory()) throw new SkillInstallError(`${label} is not a directory`);
      if (created.includes(missingDirectory)) await fileSystem.chmod(missingDirectory, INSTALL_DIRECTORY_MODE);
    } catch (error) {
      throw asInstallError(error, `${label} could not be verified`);
    }
  }
  return created;
}

async function snapshotTree(root: string, label: string, fileSystem: InstallSkillsFileSystem): Promise<TreeSnapshot> {
  let rootStats: Stats;
  try {
    rootStats = await fileSystem.lstat(root);
  } catch (error) {
    throw asInstallError(error, `${label} is unavailable`);
  }
  if (rootStats.isSymbolicLink()) throw new SkillInstallError(`${label} contains an alias`);
  if (!rootStats.isDirectory()) throw new SkillInstallError(`${label} is not a directory`);

  const files = new Map<string, Buffer>();
  const directories: string[] = [];
  const writableFiles = new Set<string>();
  const writableDirectories = new Set<string>();

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    let names: string[];
    try {
      names = await fileSystem.readdir(directory);
    } catch (error) {
      throw asInstallError(error, `${label} could not be read`);
    }
    names.sort();
    for (const name of names) {
      const relative = relativeDirectory ? path.join(relativeDirectory, name) : name;
      const child = path.join(directory, name);
      let stats: Stats;
      try {
        stats = await fileSystem.lstat(child);
      } catch (error) {
        throw asInstallError(error, `${label} could not be inspected`);
      }
      if (stats.isSymbolicLink()) throw new SkillInstallError(`${label} contains an alias`);
      if (stats.isDirectory()) {
        directories.push(relative);
        if (isOwnerWritable(stats)) writableDirectories.add(relative);
        await visit(child, relative);
        continue;
      }
      if (!stats.isFile()) throw new SkillInstallError(`${label} contains a non-regular entry`);
      if (stats.nlink > 1) throw new SkillInstallError(`${label} contains an aliased file`);
      let bytes: Buffer;
      try {
        bytes = await fileSystem.readFile(child);
      } catch (error) {
        throw asInstallError(error, `${label} could not be read`);
      }
      files.set(relative, bytes);
      if (isOwnerWritable(stats)) writableFiles.add(relative);
    }
  };

  if (isOwnerWritable(rootStats)) writableDirectories.add("");
  await visit(root, "");
  return { files, directories, writableFiles, writableDirectories, rootWritable: isOwnerWritable(rootStats) };
}

async function snapshotFile(file: string, label: string, fileSystem: InstallSkillsFileSystem): Promise<FileSnapshot> {
  let stats: Stats;
  try {
    stats = await fileSystem.lstat(file);
  } catch (error) {
    throw asInstallError(error, `${label} is unavailable`);
  }
  if (stats.isSymbolicLink()) throw new SkillInstallError(`${label} contains an alias`);
  if (!stats.isFile()) throw new SkillInstallError(`${label} is not a regular file`);
  if (stats.nlink > 1) throw new SkillInstallError(`${label} contains an aliased file`);
  let bytes: Buffer;
  try {
    bytes = await fileSystem.readFile(file);
  } catch (error) {
    throw asInstallError(error, `${label} could not be read`);
  }
  return { bytes, writable: isOwnerWritable(stats) };
}

async function optionalFileSnapshot(file: string, label: string, fileSystem: InstallSkillsFileSystem): Promise<FileSnapshot | undefined> {
  try {
    await fileSystem.lstat(file);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw asInstallError(error, `${label} could not be inspected`);
  }
  return await snapshotFile(file, label, fileSystem);
}

async function optionalSnapshot(root: string, label: string, fileSystem: InstallSkillsFileSystem): Promise<TreeSnapshot | undefined> {
  try {
    await fileSystem.lstat(root);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw asInstallError(error, `${label} could not be inspected`);
  }
  return await snapshotTree(root, label, fileSystem);
}

function fileSnapshotsEqual(source: FileSnapshot, installed: FileSnapshot, platform: InstallSkillsPlatform): boolean {
  if (!source.bytes.equals(installed.bytes)) return false;
  return platform === "win32" || installed.writable;
}

function snapshotsEqual(source: TreeSnapshot, installed: TreeSnapshot, platform: InstallSkillsPlatform): boolean {
  if (source.files.size !== installed.files.size || source.directories.length !== installed.directories.length) return false;
  const sourceDirectories = [...source.directories].sort();
  const installedDirectories = [...installed.directories].sort();
  for (let index = 0; index < sourceDirectories.length; index += 1) {
    if (sourceDirectories[index] !== installedDirectories[index]) return false;
  }
  for (const [relative, sourceBytes] of source.files) {
    const installedBytes = installed.files.get(relative);
    if (installedBytes === undefined || !sourceBytes.equals(installedBytes)) return false;
  }
  if (platform !== "win32") {
    if (!installed.rootWritable) return false;
    for (const relative of installed.directories) if (!installed.writableDirectories.has(relative)) return false;
    for (const relative of installed.files.keys()) if (!installed.writableFiles.has(relative)) return false;
  }
  return true;
}

async function replaceSkill(plan: SkillPlan, skillsRoot: string, platform: InstallSkillsPlatform, fileSystem: InstallSkillsFileSystem): Promise<void> {
  let temporary: string | undefined;
  let backup: string | undefined;
  let installed = false;
  try {
    temporary = await fileSystem.mkdtemp(path.join(skillsRoot, `.${plan.skill}.squire-install-`));
    await populateTemporaryDirectory(temporary, plan.source, fileSystem);

    if (plan.destinationExists) {
      backup = await unusedSibling(skillsRoot, plan.skill, "backup", fileSystem);
      try {
        await fileSystem.rename(plan.destination, backup);
      } catch (error) {
        throw asInstallError(error, "could not prepare the owned skill replacement");
      }
    }

    try {
      await fileSystem.rename(temporary, plan.destination);
      temporary = undefined;
      installed = true;
    } catch (error) {
      throw asInstallError(error, "could not install the owned skill replacement");
    }

    const verified = await snapshotTree(plan.destination, `installed ${plan.skill}`, fileSystem);
    if (!snapshotsEqual(plan.source, verified, platform)) {
      throw new SkillInstallError("installed skill does not match its packaged contents");
    }

    if (backup !== undefined) {
      try {
        await fileSystem.rm(backup, { recursive: true, force: false });
        backup = undefined;
      } catch (error) {
        throw asInstallError(error, "could not clean up the owned skill replacement");
      }
    }
  } catch (error) {
    if (backup !== undefined) {
      try {
        await restoreBackup(plan.destination, backup, skillsRoot, plan.skill, installed, fileSystem);
        backup = undefined;
      } catch {
        // Preserve an unrestored backup rather than deleting the prior owned
        // skill. The command remains failed and cannot report success.
      }
    } else if (installed) {
      // A first install that fails post-rename must not leave a partial owned
      // directory behind.
      await bestEffortRemove(plan.destination, fileSystem);
    }
    if (temporary !== undefined) await bestEffortRemove(temporary, fileSystem);
    throw asInstallError(error, "owned skill replacement did not complete");
  } finally {
    if (temporary !== undefined) await bestEffortRemove(temporary, fileSystem);
    // A backup is the only remaining copy of the prior owned skill. If
    // rollback failed, retaining it is safer than deleting user data.
  }
}

async function replaceAgent(plan: AgentPlan, agentsRoot: string, platform: InstallSkillsPlatform, fileSystem: InstallSkillsFileSystem): Promise<void> {
  let temporaryDirectory: string | undefined;
  let temporaryFile: string | undefined;
  let backup: string | undefined;
  let installed = false;
  try {
    temporaryDirectory = await fileSystem.mkdtemp(path.join(agentsRoot, `.${plan.agent}.squire-install-`));
    temporaryFile = path.join(temporaryDirectory, `${plan.agent}.md`);
    await fileSystem.writeFile(temporaryFile, plan.source.bytes, { flag: "wx", mode: INSTALL_FILE_MODE });
    await fileSystem.chmod(temporaryFile, INSTALL_FILE_MODE);

    if (plan.destinationExists) {
      backup = await unusedSibling(agentsRoot, plan.agent, "backup", fileSystem);
      try {
        await fileSystem.rename(plan.destination, backup);
      } catch (error) {
        throw asInstallError(error, "could not prepare the observer replacement");
      }
    }

    try {
      await fileSystem.rename(temporaryFile, plan.destination);
      temporaryFile = undefined;
      installed = true;
    } catch (error) {
      throw asInstallError(error, "could not install the observer replacement");
    }

    const verified = await snapshotFile(plan.destination, `installed ${plan.agent}`, fileSystem);
    if (!fileSnapshotsEqual(plan.source, verified, platform)) {
      throw new SkillInstallError("installed observer does not match its packaged contents");
    }

    if (backup !== undefined) {
      try {
        await fileSystem.rm(backup, { recursive: false, force: false });
        backup = undefined;
      } catch (error) {
        throw asInstallError(error, "could not clean up the observer replacement");
      }
    }
  } catch (error) {
    if (backup !== undefined) {
      try {
        await restoreAgentBackup(plan.destination, backup, agentsRoot, plan.agent, installed, fileSystem);
        backup = undefined;
      } catch {
        // Preserve an unrestored backup rather than deleting the prior owned
        // agent. The command remains failed and cannot report success.
      }
    } else if (installed) {
      await bestEffortRemove(plan.destination, fileSystem);
    }
    if (temporaryFile !== undefined) await bestEffortRemove(temporaryFile, fileSystem);
    throw asInstallError(error, "observer replacement did not complete");
  } finally {
    if (temporaryDirectory !== undefined) await bestEffortRemove(temporaryDirectory, fileSystem);
  }
}

async function populateTemporaryDirectory(temporary: string, source: TreeSnapshot, fileSystem: InstallSkillsFileSystem): Promise<void> {
  try {
    await fileSystem.chmod(temporary, INSTALL_DIRECTORY_MODE);
    const directories = [...source.directories].sort((left, right) => {
      const depth = left.split(path.sep).length - right.split(path.sep).length;
      return depth || compareNames(left, right);
    });
    for (const relative of directories) {
      const directory = path.join(temporary, relative);
      await fileSystem.mkdir(directory, { mode: INSTALL_DIRECTORY_MODE });
      await fileSystem.chmod(directory, INSTALL_DIRECTORY_MODE);
    }
    const files = [...source.files.entries()].sort(([left], [right]) => compareNames(left, right));
    for (const [relative, bytes] of files) {
      const file = path.join(temporary, relative);
      await fileSystem.writeFile(file, bytes, { flag: "wx", mode: INSTALL_FILE_MODE });
      await fileSystem.chmod(file, INSTALL_FILE_MODE);
    }
  } catch (error) {
    throw asInstallError(error, "could not build the bounded skill replacement");
  }
}

async function restoreBackup(destination: string, backup: string, skillsRoot: string, skill: OwnedSkill, installed: boolean, fileSystem: InstallSkillsFileSystem): Promise<void> {
  if (!installed) {
    await fileSystem.rename(backup, destination);
    return;
  }
  const discarded = await unusedSibling(skillsRoot, skill, "rollback", fileSystem);
  try {
    await fileSystem.rename(destination, discarded);
    await fileSystem.rename(backup, destination);
  } catch (error) {
    throw asInstallError(error, "could not roll back the owned skill replacement");
  }
  await bestEffortRemove(discarded, fileSystem);
}

async function restoreAgentBackup(destination: string, backup: string, agentsRoot: string, agent: OwnedAgent, installed: boolean, fileSystem: InstallSkillsFileSystem): Promise<void> {
  if (!installed) {
    await fileSystem.rename(backup, destination);
    return;
  }
  const discarded = await unusedSibling(agentsRoot, agent, "rollback", fileSystem);
  try {
    await fileSystem.rename(destination, discarded);
    await fileSystem.rename(backup, destination);
  } catch (error) {
    throw asInstallError(error, "could not roll back the observer replacement");
  }
  await bestEffortRemove(discarded, fileSystem);
}

async function unusedSibling(directory: string, name: string, purpose: string, fileSystem: InstallSkillsFileSystem): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(directory, `.${name}.squire-${purpose}-${randomUUID()}`);
    try {
      await fileSystem.lstat(candidate);
    } catch (error) {
      if (isNotFound(error)) return candidate;
      throw asInstallError(error, "could not reserve a temporary skill path");
    }
  }
  throw new SkillInstallError("could not reserve a temporary skill path");
}

async function removeEmptyDirectories(directories: readonly string[], fileSystem: InstallSkillsFileSystem): Promise<void> {
  for (const directory of [...directories].reverse()) {
    try {
      await fileSystem.rm(directory, { recursive: false, force: true });
    } catch {
      // A non-empty directory, including one containing an unrelated skill, is
      // deliberately preserved. It is never a reason to delete user data.
    }
  }
}

async function bestEffortRemove(target: string, fileSystem: InstallSkillsFileSystem): Promise<void> {
  try {
    await fileSystem.rm(target, { recursive: true, force: true });
  } catch {
    // The primary operation remains failed; cleanup errors never become a
    // success signal or expose filesystem diagnostics.
  }
}

function isOwnerWritable(stats: Stats): boolean {
  return (stats.mode & POSIX_OWNER_WRITE) !== 0;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function asInstallError(error: unknown, fallback: string): SkillInstallError {
  return error instanceof SkillInstallError ? error : new SkillInstallError(fallback, { cause: error });
}

function publicErrorMessage(error: unknown): string {
  return error instanceof SkillInstallError ? error.message : "installation could not be completed";
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonempty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
