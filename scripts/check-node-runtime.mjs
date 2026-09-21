import { assertSupportedNode } from "../src/node-runtime-policy.mjs";
try {
  assertSupportedNode();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
