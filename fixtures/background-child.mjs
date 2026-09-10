import { writeFile } from "node:fs/promises";

const [marker, delayText = "100"] = process.argv.slice(2);
if (!marker) throw new Error("marker path is required");
process.stdout.write("detached stdout inherited\n");
process.stderr.write("detached stderr inherited\n");
await new Promise(resolve => setTimeout(resolve, Number(delayText)));
await writeFile(marker, `${process.pid}\n`, "utf8");
