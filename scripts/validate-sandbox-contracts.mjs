#!/usr/bin/env node
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertAttestationSemantics, assertReleaseSemantics, assertSpecSemantics, assertTransferSemantics } from "../dist/src/sandbox/contracts.js";

const root = path.resolve(import.meta.dirname, "..");
const schemaRoot = path.join(root, "contracts/sandbox/v1");
const fixtureRoot = path.join(root, "fixtures/contracts/sandbox/v1");
const names = ["sandbox-spec", "sandbox-release-manifest", "sandbox-attestation", "sandbox-transfer-manifest"];
const semantic = { "sandbox-spec": assertSpecSemantics, "sandbox-release-manifest": assertReleaseSemantics, "sandbox-attestation": assertAttestationSemantics, "sandbox-transfer-manifest": assertTransferSemantics };
async function files(directory) { const entries = await readdir(directory, { withFileTypes: true }); const result = []; for (const entry of entries) { const target = path.join(directory, entry.name); if (entry.isDirectory()) result.push(...await files(target)); else if (entry.name.endsWith(".json")) result.push(target); } return result; }
async function main() {
  const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
  for (const name of names) ajv.addSchema(JSON.parse(await readFile(path.join(schemaRoot, `${name}.schema.json`), "utf8")));
  let validCount = 0; let structuralCount = 0; let semanticCount = 0;
  for (const file of await files(path.join(fixtureRoot, "valid"))) {
    const data = JSON.parse(await readFile(file, "utf8")); const name = data.kind.replace("squire-", ""); const validate = ajv.getSchema(`urn:squire:sandbox:v1:${name}`); if (!validate || !validate(data)) throw new Error(`valid sandbox fixture rejected: ${file}\n${ajv.errorsText(validate?.errors)}`); if (!semantic[name]) throw new Error(`valid sandbox fixture has an unknown schema kind: ${file}`); semantic[name](data); validCount += 1;
  }
  for (const file of await files(path.join(fixtureRoot, "invalid/structural"))) {
    const data = JSON.parse(await readFile(file, "utf8")); const name = data.kind.replace("squire-", ""); const validate = ajv.getSchema(`urn:squire:sandbox:v1:${name}`); if (!validate || validate(data)) throw new Error(`invalid sandbox structural fixture accepted: ${file}`); structuralCount += 1;
  }
  for (const file of await files(path.join(fixtureRoot, "invalid/semantic"))) {
    const data = JSON.parse(await readFile(file, "utf8")); const name = data.kind.replace("squire-", ""); const validate = ajv.getSchema(`urn:squire:sandbox:v1:${name}`); if (!validate || !validate(data) || !semantic[name]) throw new Error(`invalid sandbox semantic fixture is not structurally valid: ${file}`); let rejected = false; try { semantic[name](data); } catch { rejected = true; } if (!rejected) throw new Error(`invalid sandbox semantic fixture accepted: ${file}`); semanticCount += 1;
  }
  console.log(`Validated ${names.length} sandbox schemas, ${validCount} valid fixtures, ${structuralCount} structural rejections, and ${semanticCount} semantic rejections.`);
}
main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
