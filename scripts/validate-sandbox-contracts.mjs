#!/usr/bin/env node
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertAttestationSemantics, assertReleaseSemantics, assertSpecSemantics, assertTransferSemantics } from "../dist/src/sandbox/contracts.js";
import { validateHostConformanceEvidence, validateHostObserverInput, validateHostObserverRequest, validateHostObserverResult } from "../dist/src/sandbox/host-conformance.js";

const root = path.resolve(import.meta.dirname, "..");
const schemaRoot = path.join(root, "contracts/sandbox/v1");
const fixtureRoot = path.join(root, "fixtures/contracts/sandbox/v1");
const names = ["sandbox-spec", "sandbox-release-manifest", "sandbox-attestation", "sandbox-transfer-manifest", "host-conformance", "host-observer-input", "host-observer-request", "host-observer-result"];
const semantic = { "sandbox-spec": assertSpecSemantics, "sandbox-release-manifest": assertReleaseSemantics, "sandbox-attestation": assertAttestationSemantics, "sandbox-transfer-manifest": assertTransferSemantics, "host-conformance": validateHostConformanceEvidence, "host-observer-input": validateHostObserverInput, "host-observer-request": validateHostObserverRequest, "host-observer-result": validateHostObserverResult };
async function files(directory) { const entries = await readdir(directory, { withFileTypes: true }); const result = []; for (const entry of entries) { const target = path.join(directory, entry.name); if (entry.isDirectory()) result.push(...await files(target)); else if (entry.name.endsWith(".json")) result.push(target); } return result; }
function schemaName(data) { if (data.kind === "squire-sandbox-host-conformance-evidence") return "host-conformance"; if (data.kind === "squire-sandbox-host-observer-input") return "host-observer-input"; if (data.kind === "squire-sandbox-host-observer-request") return "host-observer-request"; if (data.kind === "squire-sandbox-host-observer-result") return "host-observer-result"; return data.kind.replace("squire-", ""); }
async function main() {
  const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv); ajv.addSchema(JSON.parse(await readFile(path.join(root, "contracts/v1/common.schema.json"), "utf8")));
  for (const name of names) { const fileName = name === "host-conformance" ? "sandbox-host-conformance" : name; ajv.addSchema(JSON.parse(await readFile(path.join(schemaRoot, `${fileName}.schema.json`), "utf8"))); }
  let validCount = 0; let structuralCount = 0; let semanticCount = 0;
  for (const file of await files(path.join(fixtureRoot, "valid"))) {
    const data = JSON.parse(await readFile(file, "utf8")); const name = schemaName(data); const validate = ajv.getSchema(`urn:squire:sandbox:v1:${name}`); if (!validate || !validate(data)) throw new Error(`valid sandbox fixture rejected: ${file}\n${ajv.errorsText(validate?.errors)}`); if (!semantic[name]) throw new Error(`valid sandbox fixture has an unknown schema kind: ${file}`); semantic[name](data); validCount += 1;
  }
  for (const file of await files(path.join(fixtureRoot, "invalid/structural"))) {
    const data = JSON.parse(await readFile(file, "utf8")); const name = schemaName(data); const validate = ajv.getSchema(`urn:squire:sandbox:v1:${name}`); if (!validate || validate(data)) throw new Error(`invalid sandbox structural fixture accepted: ${file}`); structuralCount += 1;
  }
  for (const file of await files(path.join(fixtureRoot, "invalid/semantic"))) {
    const data = JSON.parse(await readFile(file, "utf8")); const name = schemaName(data); const validate = ajv.getSchema(`urn:squire:sandbox:v1:${name}`); if (!validate || !validate(data) || !semantic[name]) throw new Error(`invalid sandbox semantic fixture is not structurally valid: ${file}`); let rejected = false; try { semantic[name](data); } catch { rejected = true; } if (!rejected) throw new Error(`invalid sandbox semantic fixture accepted: ${file}`); semanticCount += 1;
  }
  console.log(`Validated ${names.length} sandbox schemas, ${validCount} valid fixtures, ${structuralCount} structural rejections, and ${semanticCount} semantic rejections.`);
}
main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
