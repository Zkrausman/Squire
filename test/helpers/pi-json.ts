import path from "node:path";
import { pathToFileURL } from "node:url";
// Also used by actual-process fixtures; resolve from the test repository, not dist.
const fixture = await import(pathToFileURL(path.resolve("fixtures/pi-json-stream.mjs")).href) as typeof import("../../fixtures/pi-json-stream.mjs");
export const piJsonEvents = fixture.piJsonEvents;
export const piJsonStream = fixture.piJsonStream;
