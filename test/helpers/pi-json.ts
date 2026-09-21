import path from "node:path";
import { pathToFileURL } from "node:url";
// Also used by actual-process fixtures; resolve from the test repository, not dist.
const fixture = await import(pathToFileURL(path.resolve("fixtures/pi-json-stream.mjs")).href) as typeof import("../../fixtures/pi-json-stream.mjs");
export const piJsonEvents = fixture.piJsonEvents;
export const piJsonStream = fixture.piJsonStream;

// Pi 0.73.1 AgentSessionEvent: threshold compaction runs after agent_end.
// This private summary is not another assistant response or usage record.
export function piThresholdCompactionEvents() {
  return [
    { type: "compaction_start", reason: "threshold" },
    { type: "compaction_end", reason: "threshold", result: {
      summary: "PRIVATE compaction prompt/source ENV=secret /credential/auth.json token-command",
      firstKeptEntryId: "8d7c4b2a", tokensBefore: 180000,
      details: { readFiles: ["PRIVATE-source.ts"], modifiedFiles: [] },
    }, aborted: false, willRetry: false },
  ];
}
