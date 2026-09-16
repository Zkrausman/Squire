import { createHash } from "node:crypto";
import { captureLaunchMaterial } from "../../src/personal/launch-material.js";
import { APPROVED_PERSONAL_MODEL_POLICY } from "../../src/personal/model-policy.js";
const config = {
  repository: { slug: "example/repo", path: "/tmp/example-repo", sourceRef: "HEAD", baseBranch: "main" },
  dataDirectory: "/tmp/squire-test-data", paths: { state: "/tmp/squire-test-data/state", bridges: "/tmp/squire-test-data/bridges", staging: "/tmp/squire-test-data/staging" },
  linear: { apiKeyEnv: "SQUIRE_TEST_KEY" }, github: { tokenCommand: ["false"] },
  sandbox: { roleUser: "1000:1000", piExecutable: "pi", piAgentDirectory: "/ticket/pi-agent" },
  modelPolicy: APPROVED_PERSONAL_MODEL_POLICY, testCommands: ["npm test"],
};
const bytes = Buffer.from(JSON.stringify(config));
export const TEST_CONFIG_DIGEST = createHash("sha256").update(bytes).digest("hex");
export const TEST_MATERIAL = await captureLaunchMaterial({ rawConfig: bytes.toString("base64"), digest: TEST_CONFIG_DIGEST, config });
