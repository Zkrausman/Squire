#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const templateRoot = path.join(root, "sandbox/template/v1");
const files = ["Dockerfile", "config/principals-and-mounts.sh", "config/rootless-docker.sh", "supervisor/squire-supervisor.service", "supervisor/squire-guest-supervisor.ts"];
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function parse(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!["--base-image", "--base-digest", "--output"].includes(key) || !argv[i + 1] || result[key.slice(2)]) throw new Error("usage: build-sandbox-template.mjs --base-image IMAGE --base-digest sha256:DIGEST --output FILE");
    result[key.slice(2)] = argv[++i];
  }
  if (!result["base-image"] || !/^([a-z0-9.-]+\/)?[a-z0-9._-]+\/[a-z0-9._-]+$/.test(result["base-image"]) || !/^sha256:[0-9a-f]{64}$/.test(result["base-digest"]) || !result.output || !path.isAbsolute(result.output)) throw new Error("an exact qualified base image and digest plus absolute output are required");
  return result;
}
function replaceFrom(dockerfile, image, digestValue) {
  const replaced = dockerfile.replace("FROM ${SQUIRE_BASE_IMAGE}@${SQUIRE_BASE_DIGEST}", `FROM ${image}@${digestValue}`);
  if (replaced === dockerfile || !/^FROM [^\s@]+@sha256:[0-9a-f]{64}$/m.test(replaced)) throw new Error("template does not resolve to one immutable base image");
  return replaced;
}
async function main() {
  const options = parse(process.argv.slice(2));
  const source = await Promise.all(files.map(async relative => ({ relative, bytes: await readFile(path.join(templateRoot, relative)) })));
  const dockerfile = replaceFrom(source.find(item => item.relative === "Dockerfile").bytes.toString("utf8"), options["base-image"], options["base-digest"]);
  const entries = source.map(item => ({ path: item.relative, sha256: digest(item.relative === "Dockerfile" ? Buffer.from(dockerfile) : item.bytes) }));
  const configDigest = digest(Buffer.from(entries.filter(item => item.path !== "supervisor/squire-guest-supervisor.ts").map(item => `${item.path}\0${item.sha256}`).join("\n")));
  const helperDigests = entries.filter(item => item.path.includes("supervisor")).map(item => item.sha256);
  const manifest = { schemaVersion: 1, kind: "squire-sandbox-template-build-input", version: "v1", releaseState: "blocked-until-external-conformance", baseImage: options["base-image"], baseDigest: options["base-digest"], configDigest, helperDigests, files: entries };
  await writeFile(options.output, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
