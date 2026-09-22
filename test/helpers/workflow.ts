import { launchTestRoot } from "./windows-launch.js";
import { rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PersonalMvpController } from "../../src/personal/controller.js";
import { JsonRunStateStore } from "../../src/personal/json-run-state.js";
import type { PhaseInput, PhaseResult, PublicationInput, WorkspacePort } from "../../src/personal/types.js";
export const BASE = "a".repeat(40), HEAD = "b".repeat(40);
export const REQUEST = { ticketId: "AIDEV-1", repository: "example/repo", repositoryPath: "/tmp/example-repo", sourceRef: "HEAD", baseBranch: "main" };
export function report(input: PhaseInput): PhaseResult {
  const common = { runId: input.runId, phase: input.phase, attempt: 1, sessionId: input.launchGeneration!.sessionId, sessionFile: input.launchGeneration!.sessionFile, inputHead: input.expectedHead, outputHead: HEAD, profile: input.profile, status: "passed" as const, summary: "bounded evidence" };
  return input.phase === "implement" ? { ...common, phase: "implement", details: { changes: ["implemented"], projectWiki: { status: "not_required", reason: "fixture changes no durable knowledge" } } } : { ...common, phase: "verify", details: { findings: [], commands: input.testCommands.map(command => ({ command, exitCode: 0, summary: "executed" })) } };
}
export async function fixture(options: { phase?: (i: PhaseInput, f: { head: string; dirty: boolean }) => Promise<PhaseResult>; publish?: () => void; retries?: 0 | 1; workspace?: Partial<WorkspacePort> } = {}) {
  const root = await launchTestRoot("squire-workflow-");
  const states = new JsonRunStateStore(root);
  const calls: PhaseInput[] = [], publications: PublicationInput[] = [];
  const workspace = { head: BASE, dirty: false };
  const controller = new PersonalMvpController({ states, testCommands: ["npm test"], launchRetryPolicy: { maxRetries: options.retries ?? 0 }, newId: () => "0123456789",
    tickets: { async get() { return { id: "AIDEV-1", title: "owner contract", description: "immutable requirement" }; } },
    workspaces: { async prepare(i) { return { sandbox: i.sandbox, baseSha: BASE, head: BASE }; }, async currentHead() { return workspace.head; }, async assertClean() { if(workspace.dirty) throw new Error("dirty workspace"); }, async assertDescendant(_sandbox,base,head) { if(base !== BASE || head !== HEAD) throw new Error("not descended"); }, async committedProjectWikiPaths() { return []; }, async exportBundle(i) { return { path: "/tmp/candidate.bundle", sha256: "c".repeat(64), byteLength: 20, baseSha: i.baseSha, head: i.head, branch: i.branch }; }, ...options.workspace },
    phases: { async run(i) { calls.push(i); if(i.phase === "implement") workspace.head = HEAD; return options.phase ? options.phase(i,workspace) : report(i); } },
    publication: { async publish(i) { publications.push(i); options.publish?.(); return { url: "https://github.com/example/repo/pull/1", reused: false }; } },
  });
  return { root, states, calls, publications, workspace, controller, async cleanup() { await rm(root,{recursive:true,force:true}); } };
}
