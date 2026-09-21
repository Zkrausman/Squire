import { assertSupportedNode } from "../src/runtime-policy.mjs";

try {
  assertSupportedNode();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
