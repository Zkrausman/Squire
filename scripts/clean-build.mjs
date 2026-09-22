// Removed source files must not remain as executable legacy modules or tests.
import { rmSync } from "node:fs";
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
