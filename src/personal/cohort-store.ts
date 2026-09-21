import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { canonicalJson, cohortAssert as assert, parseBoundedJson, sha256 } from "./canonical-json.js";
import { absoluteFile } from "./cohort-domain.js";
import { validateTrustRoots, type TrustRoots } from "./disposition-evidence.js";
import { aggregateCohort, readCohortSpec, reconcileCohort } from "./cohort-scorecard.js";
import { publishPrivateBytes, readPrivateBytes } from "./private-artifacts.js";
import { JsonRunStateStore } from "./json-run-state.js";
import { TelemetryStore } from "./telemetry-store.js";

/** Exact ancestor checks, not a repository or artifact directory scan. */
export async function assertOutsideRepository(file: string, repository: string): Promise<void> {
  absoluteFile(file); const repo = await realpath(repository);
  const relative = path.relative(repo, file); assert(relative !== "" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)));
  for (let cursor = path.dirname(file); ; cursor = path.dirname(cursor)) {
    const git = await lstat(path.join(cursor, ".git")).catch(e => { if (e.code !== "ENOENT") throw e; return undefined; }); assert(!git);
    if (cursor === path.dirname(cursor)) break;
  }
}
export async function publishCohort(dataDirectory: string, artifact: unknown): Promise<{ path: string; digest: string }> {
  absoluteFile(dataDirectory);
  const text = canonicalJson(artifact); const digest = sha256(text);
  const file = path.join(dataDirectory, "cohort-artifacts", `${digest}.json`);
  await publishPrivateBytes(file, text);
  return { path: file, digest };
}
/** Host-only orchestration: no credentials, signing, model, or network adapters. */
export async function runCohort(options: { specFile: string; trustRootsFile: string; repositoryPath: string; dataDirectory: string; stateDirectory: string; stagingDirectory: string }): Promise<{ path: string; digest: string }> {
  try {
    for (const file of [options.trustRootsFile, path.join(options.dataDirectory, "cohort-artifacts", "artifact.json")]) await assertOutsideRepository(file, options.repositoryPath);
    const spec = await readCohortSpec(options.specFile);
    let roots: TrustRoots = { schemaVersion: 1, keys: [] }; let trustRootsDigest: string | null = null; let trustRootsStatus = "unavailable";
    try {
      const bytes = await readPrivateBytes(options.trustRootsFile); trustRootsDigest = sha256(bytes);
      const value = parseBoundedJson(bytes); validateTrustRoots(value); roots = value; trustRootsStatus = "validated";
    } catch { /* All imported dispositions remain unknown; usage still works. */ }
    const observations = await reconcileCohort(spec, roots, { states: new JsonRunStateStore(options.stateDirectory), telemetry: new TelemetryStore(options.stagingDirectory) });
    return await publishCohort(options.dataDirectory, { ...aggregateCohort(spec, observations), trustRootsDigest, trustRootsStatus });
  } catch { throw new Error("Cohort unavailable: invalid configuration or private evidence"); }
}
