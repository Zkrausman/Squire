#!/usr/bin/env node
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { assertReleaseSemantics, REQUIRED_LLM_WIKI_RUNTIME_VERSION, REQUIRED_PI_RUNTIME_VERSION } from "../dist/src/sandbox/contracts.js";
import { canonicalBytes } from "../dist/src/sandbox/identity.js";
import { releaseSignaturePayload, verifyHmacSignature } from "../dist/src/sandbox/release-resolver.js";
import { hostConformanceEvidenceDigest, validateHostConformanceEvidence, HOST_CONFORMANCE_SCHEMA_ID } from "../dist/src/sandbox/host-conformance.js";

const SHA = /^[0-9a-f]{64}$/u;
const REF = /^([a-z0-9.-]+\/)?[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[0-9a-f]{64}$/u;
const USAGE = "usage: verify-sandbox-release.mjs RELEASE.json [--ed25519-public-key FILE|--hmac-key-file FILE]";
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function fail(message) { throw new Error(`sandbox release rejected: ${message}`); }

function parseArgs(argv) {
  if (argv.length !== 1 && argv.length !== 3) fail(USAGE);
  const release = argv[0];
  if (!release || release.startsWith("--")) fail(USAGE);
  const result = { release };
  if (argv.length === 3) {
    if (!["--ed25519-public-key", "--hmac-key-file"].includes(argv[1]) || !argv[2] || argv[2].startsWith("--")) fail(USAGE);
    result.keyKind = argv[1];
    result.keyFile = argv[2];
  }
  return result;
}

function canonicalFilePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || value === path.parse(value).root || value.endsWith(path.sep) || value.includes("\\") || value.includes("//") || /[\u0000-\u001f\u007f\r\n]/u.test(value)) fail(`${label} is not a canonical absolute path`);
  return value;
}

async function assertNoSymlinkPath(file, label) {
  canonicalFilePath(file, label);
  const resolved = await realpath(file).catch(() => undefined);
  if (resolved !== file) fail(`${label} is a symlink or has a symlink ancestor`);
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => { if (error?.code === "ENOENT") return undefined; throw error; });
    if (info?.isSymbolicLink()) fail(`${label} has a symlink path component`);
  }
}

async function readStable(file, label, maxBytes, privateOnly = false) {
  if (constants.O_NOFOLLOW === undefined) fail(`${label} requires descriptor no-follow support`);
  canonicalFilePath(file, label); await assertNoSymlinkPath(file, label);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || privateOnly && (before.mode & 0o077) !== 0) fail(`${label} is not a bounded exact regular file`);
    const bytes = Buffer.allocUnsafe(before.size); let offset = 0;
    while (offset < before.size) { const result = await handle.read(bytes, offset, before.size - offset, offset); if (result.bytesRead <= 0) fail(`${label} ended during a bounded read`); offset += result.bytesRead; }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail(`${label} changed during a bounded read`);
    return bytes;
  } finally { await handle.close(); }
}
async function readKey(file, kind) {
  const bytes = await readStable(file, "promotion key file", 64 * 1024, kind === "--hmac-key-file");
  if (bytes.length < 1) fail("promotion key file is empty");
  return bytes;
}

async function verifyReferencedFile(relative, expected, label) {
  if (typeof relative !== "string" || !/^(?:artifacts|evidence)(?:\/[A-Za-z0-9._-]+)+$/u.test(relative)) fail(`${label} path is not a safe repository reference`);
  const target = path.resolve(REPOSITORY_ROOT, relative);
  if (target !== REPOSITORY_ROOT && !target.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) fail(`${label} escapes the repository root`);
  await assertNoSymlinkPath(target, label);
  const info = await lstat(target);
  if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) fail(`${label} is not a bounded regular file`);
  const bytes = await readStable(target, label, 16 * 1024 * 1024);
  if (digest(bytes) !== expected) fail(`${label} digest differs from the release manifest`);
}

async function verifyPromotionSignature(release, options) {
  if (release.promotion.algorithm === "sha256-hmac") {
    if (options.keyKind !== "--hmac-key-file") fail("a private HMAC key file is required for an HMAC promotion");
    const key = await readKey(options.keyFile, options.keyKind);
    if (!verifyHmacSignature(release, key)) fail("promotion HMAC signature is invalid");
    return;
  }
  if (options.keyKind !== "--ed25519-public-key") fail("an Ed25519 public key file is required for an Ed25519 promotion");
  const keyBytes = await readKey(options.keyFile, options.keyKind);
  let signature;
  if (/^[0-9a-f]{128}$/u.test(release.promotion.signature)) signature = Buffer.from(release.promotion.signature, "hex");
  else if (/^[A-Za-z0-9+/]{86}==$/u.test(release.promotion.signature) || /^[A-Za-z0-9_-]{86}==$/u.test(release.promotion.signature)) signature = Buffer.from(release.promotion.signature.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
  else fail("Ed25519 promotion signature encoding is invalid");
  if (signature.length !== 64) fail("Ed25519 promotion signature length is invalid");
  try {
    const publicKey = createPublicKey(keyBytes);
    if (!verifySignature(null, Buffer.from(releaseSignaturePayload(release), "utf8"), publicKey, signature)) fail("promotion Ed25519 signature is invalid");
  } catch (error) {
    if (error?.message?.startsWith("sandbox release rejected:")) throw error;
    fail(`promotion Ed25519 key is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const releaseFile = path.resolve(options.release);
  await assertNoSymlinkPath(releaseFile, "release manifest");
  const bytes = await readStable(releaseFile, "release manifest", 16 * 1024 * 1024);
  let release;
  try { release = JSON.parse(bytes.toString("utf8")); } catch { fail("manifest is not JSON"); }
  if (!bytes.equals(canonicalBytes(release))) fail("manifest is not deterministically serialized");
  try { assertReleaseSemantics(release); } catch (error) { fail(error instanceof Error ? error.message : "release semantic validation failed"); }
  if (release.promotion.state !== "validated") fail("promotion is blocked until independent host conformance");
  if (!REF.test(release.template?.reference ?? "") || release.template.reference !== `${release.template.reference.split("@")[0]}@${release.template.digest}` || !/^sha256:[0-9a-f]{64}$/u.test(release.template.digest)) fail("template is not qualified and digest pinned");
  if (release.runtimeCompatibility.pi.minimum !== REQUIRED_PI_RUNTIME_VERSION || release.runtimeCompatibility.pi.maximum !== REQUIRED_PI_RUNTIME_VERSION || release.runtimeCompatibility.llmWiki.minimum !== REQUIRED_LLM_WIKI_RUNTIME_VERSION || release.runtimeCompatibility.llmWiki.maximum !== REQUIRED_LLM_WIKI_RUNTIME_VERSION) fail("release runtime compatibility is not the exact immutable run selection");
  canonicalFilePath(release.sbxBinary.path, "release sbx binary");
  await assertNoSymlinkPath(release.sbxBinary.path, "release sbx binary");
  const binary = await readStable(release.sbxBinary.path, "release sbx binary", 256 * 1024 * 1024);
  if (digest(binary) !== release.sbxBinary.sha256) fail("installed sbx binary differs from the promoted digest");
  if (!SHA.test(release.sbxBinary.helpDigest)) fail("sbx help identity is incomplete");
  if (!Array.isArray(release.supportedResources) || release.supportedResources.length === 0 || release.supportedResources.some(tuple => tuple.disk?.enforcement === "unsupported")) fail("unsupported or unproven resource tuple was promoted");
  if (!Array.isArray(release.conformanceEvidence) || release.conformanceEvidence.length === 0 || release.conformanceEvidence.some(evidence => evidence.hostOnly !== true || !SHA.test(evidence.sha256))) fail("independent host conformance evidence is missing");
  let hostEvidenceCount = 0; const hostProbes = new Set(); let physicalIdentity;
  for (const evidence of release.conformanceEvidence) { await verifyReferencedFile(evidence.path, evidence.sha256, "host conformance evidence"); const target = path.resolve(REPOSITORY_ROOT, evidence.path); const evidenceBytes = await readStable(target, "host conformance evidence", 16 * 1024 * 1024); if (evidence.schemaId === HOST_CONFORMANCE_SCHEMA_ID) { let hostValue; try { hostValue = JSON.parse(evidenceBytes.toString("utf8")); validateHostConformanceEvidence(hostValue); } catch (error) { fail(`host conformance evidence is malformed: ${error instanceof Error ? error.message : String(error)}`); } if (hostConformanceEvidenceDigest(hostValue) !== evidence.sha256 || hostValue.hostOnly !== true || hostValue.status !== "pass" || hostValue.releaseId !== release.releaseId || hostValue.identity.templateDigest !== release.template.digest) fail("host conformance evidence is not a passing release-bound host-only artifact"); const identity = JSON.stringify(hostValue.identity); if (physicalIdentity === undefined) physicalIdentity = identity; else if (physicalIdentity !== identity) fail("host conformance evidence is bound to multiple physical sandbox identities"); if (hostProbes.has(hostValue.probe)) fail("release contains duplicate host conformance probes"); hostProbes.add(hostValue.probe); hostEvidenceCount += 1; } }
  const requiredHostProbes = ["sbx-identity", "resource-enforcement", "disk-quota", "bridge-isolation", "mount-isolation", "principal-separation", "rootless-docker", "persistence", "network-audit", "credential-absence", "process-topology", "herdr-topology", "exact-removal"]; if (hostEvidenceCount === 0 || !release.conformanceEvidence.some(evidence => evidence.kind === "host-conformance") || requiredHostProbes.some(probe => !hostProbes.has(probe))) fail("release lacks the complete release-bound host conformance probe set");
  for (const tuple of release.supportedResources) if (tuple.disk.proof) await verifyReferencedFile(tuple.disk.proof.path, tuple.disk.proof.sha256, "resource proof");
  await verifyPromotionSignature(release, options);
  process.stdout.write(JSON.stringify({ status: "validated", manifestSha256: digest(bytes) }) + "\n");
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
