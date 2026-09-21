import { nodeRuntimeDiagnostic } from "../src/runtime-policy.mjs";

const diagnostic = nodeRuntimeDiagnostic();
if (diagnostic) {
  console.error(diagnostic);
  process.exit(1);
}
