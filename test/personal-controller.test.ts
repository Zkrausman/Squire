import assert from "node:assert/strict";
import test from "node:test";
import { PersonalMvpController } from "../src/personal/controller.js";
import { APPROVED_PERSONAL_MODEL_POLICY, resolvePhaseProfiles, type PersonalModelPolicy } from "../src/personal/model-policy.js";
import { deterministicFeatureBranch } from "../src/personal/identity.js";
import { validatePhaseResultShape } from "../src/personal/phase-result.js";
import type { CandidateBundle, ImplementPhaseResult, PersonalPhase, PersonalRunState, PhaseInput, PhaseResult, PublicationInput, RunStatePort, WorkspacePort } from "../src/personal/types.js";

const BASE = "a".repeat(40);
const IMPLEMENTED = "b".repeat(40);
const REMEDIATED = "c".repeat(40);

class MemoryStates implements RunStatePort {
  state: PersonalRunState | undefined;
  reserve?: (state: PersonalRunState) => Promise<void>;
  release?: (ticketId: string, runId: string) => Promise<void>;
  reservationOwner?: (ticketId: string) => Promise<string | undefined>;
  throwAfterTerminal = false;
  constructor(readonly events: string[] = []) {}
  async create(state: PersonalRunState): Promise<void> { assert.equal(this.state, undefined); this.events.push("state:create"); this.state = state; }
  async save(state: PersonalRunState): Promise<void> { assert.equal(state.version, (this.state?.version ?? 0) + 1); this.events.push("state:save"); this.state = state; if (this.throwAfterTerminal && state.status !== "running") throw new Error("event publication rejected after terminal commit"); }
  async findActive(ticketId: string): Promise<PersonalRunState | undefined> { return this.state?.ticketId === ticketId && this.state.status === "running" ? this.state : undefined; }
  async read(): Promise<PersonalRunState | undefined> { return this.state; }
}

class MemoryWorkspace implements WorkspacePort {
  head = BASE;
  clean = true;
  wikiPaths: string[] = [];
  cleanChecks = 0;
  cleanFailureAt: number | undefined;
  cleanFailure: unknown;
  constructor(readonly events: string[] = []) {}
  async prepare(): Promise<{ sandbox: string; baseSha: string; head: string }> { this.events.push("workspace:prepare"); return { sandbox: "squire-aidev-1-0123456789", baseSha: BASE, head: BASE }; }
  async currentHead(): Promise<string> { return this.head; }
  async assertClean(): Promise<void> {
    this.cleanChecks += 1;
    if (!this.clean) throw new Error("workspace has uncommitted changes");
    if (this.cleanFailureAt === this.cleanChecks) throw this.cleanFailure;
  }
  async committedProjectWikiPaths(): Promise<readonly string[]> { return [...this.wikiPaths]; }
  async exportBundle(input: { runId: string; sandbox: string; branch: string; baseSha: string; head: string }): Promise<CandidateBundle> {
    assert.equal(input.head, this.head);
    return { path: "/staging/candidate.bundle", sha256: "d".repeat(64), byteLength: 10, baseSha: input.baseSha, head: input.head, branch: input.branch };
  }
}

function phaseResult(input: PhaseInput, head: string, status: PhaseResult["status"] = "passed", feedback: readonly string[] = [], wikiPaths: readonly string[] = []): PhaseResult {
  const common = {
    runId: input.runId,
    attempt: input.attempt,
    sessionId: `${input.phase}-${input.attempt}`,
    sessionFile: `/ticket/sessions/${input.phase}/${input.attempt}.jsonl`,
    inputHead: input.expectedHead,
    outputHead: head,
    status,
    summary: `${input.phase} ${status}`,
  };
  if (input.phase === "plan") return { ...common, phase: "plan", details: { steps: ["Make the focused change"] } };
  if (input.phase === "implement") return { ...common, phase: "implement", details: { changes: ["Changed the requested file"], projectWiki: wikiPaths.length > 0 ? { status: "updated", paths: [...wikiPaths], summary: "documented the durable project knowledge" } : { status: "not_required", reason: "the ticket adds no durable project knowledge" } } };
  if (input.phase === "review") return { ...common, phase: "review", details: { findings: status === "remediation_required" ? feedback : [] } };
  if (input.phase === "test") return { ...common, phase: "test", details: { commands: [{ command: "npm test", exitCode: status === "remediation_required" ? 1 : 0, summary: feedback[0] ?? status }] } };
  return { ...common, phase: "retro", details: { lessons: ["Keep exact HEAD gates explicit"], followUps: feedback } };
}

function createHarness(runPhase: (input: PhaseInput, workspace: MemoryWorkspace) => Promise<PhaseResult>, modelPolicy: PersonalModelPolicy = APPROVED_PERSONAL_MODEL_POLICY) {
  const events: string[] = [];
  const states = new MemoryStates(events);
  const workspace = new MemoryWorkspace(events);
  const calls: PersonalPhase[] = [];
  const inputs: PhaseInput[] = [];
  const publications: PublicationInput[] = [];
  const controller = new PersonalMvpController({
    tickets: { async get(id) { return { id, title: "Small change", description: "Make one focused change", url: "https://linear.example/AIDEV-1" }; } },
    workspaces: workspace,
    phases: { async run(input) { calls.push(input.phase); inputs.push(input); return runPhase(input, workspace); } },
    publication: { async publish(input) { publications.push(input); return { url: "https://github.com/example/repo/pull/1", number: 1, reused: false }; } },
    states,
    modelPolicy,
    now: () => new Date("2026-09-10T00:00:00.000Z"),
    newId: () => "01234567-89ab-cdef-0123-456789abcdef",
  });
  return { controller, states, workspace, calls, inputs, publications, events };
}

const REQUEST = { ticketId: "AIDEV-1", repository: "example/repo", repositoryPath: "/source/repo", sourceRef: "refs/remotes/origin/main", baseBranch: "main" } as const;

async function implementAndPass(input: PhaseInput, workspace: MemoryWorkspace): Promise<PhaseResult> {
  if (input.phase === "implement") workspace.head = IMPLEMENTED;
  return phaseResult(input, workspace.head);
}

function replacePolicy(policy: PersonalModelPolicy): void {
  for (const profile of [policy.plan[0], policy.plan[1], policy.implement, policy.review, policy.test, policy.retro]) {
    Object.assign(profile, { provider: "changed-provider", model: "changed-model", thinking: "low" });
  }
}

test("reservation-capable state store without release fails closed before creating state", async () => {
  const harness = createHarness(implementAndPass);
  harness.states.reserve = async () => { throw new Error("must not reserve"); };
  await assert.rejects(harness.controller.run(REQUEST), /must provide release/);
  assert.equal(harness.states.state, undefined);
});

test("terminal state commit followed by rejection is reconciled before release", async () => {
  const harness = createHarness(async () => { throw new Error("phase contract failure"); });
  harness.states.throwAfterTerminal = true;
  let releases = 0;
  harness.states.release = async () => { releases++; };
  await assert.rejects(harness.controller.run(REQUEST), /phase contract failure/);
  assert.equal(harness.states.state?.status, "failed");
  assert.equal(releases, 1);
});

for (const field of ["head", "baseSha", "launchState", "lifecycle", "version", "controllerPid", "updatedAt"] as const) {
  test(`terminal readback rejects changed ${field} without releasing reservation`, async () => {
    const harness = createHarness(async () => { throw new Error("original phase failure"); });
    const save = harness.states.save.bind(harness.states);
    harness.states.save = async state => {
      await save(state);
      if (state.status === "running") return;
      const value = field === "head" || field === "baseSha" ? REMEDIATED
        : field === "launchState" ? "claimed"
        : field === "lifecycle" ? "running"
        : field === "version" ? state.version + 1
        : field === "controllerPid" ? 123456 : "2026-09-11T00:00:00.000Z";
      const replacement: PersonalRunState = { ...structuredClone(state), [field]: value };
      harness.states.state = replacement;
      throw new Error("terminal write outcome is ambiguous");
    };
    let releases = 0;
    harness.states.release = async () => { releases++; };
    await assert.rejects(harness.controller.run(REQUEST), /original phase failure/);
    assert.equal(releases, 0);
    assert.equal(harness.states.state?.lastError, "original phase failure");
  });
}

test("terminal contract failure preserves its error when reservation release fails", async () => {
  const harness = createHarness(async () => { throw new Error("original phase failure"); });
  harness.states.release = async () => { throw new Error("ticket operation is locked or ambiguous"); };
  await assert.rejects(harness.controller.run(REQUEST), /original phase failure/);
  assert.equal(harness.states.state?.status, "failed");
  assert.equal(harness.states.state?.lastError, "original phase failure");
  assert.match(harness.states.state?.reservationCleanupFailure ?? "", /locked or ambiguous/);
});

test("reservation release failure preserves terminal error and records actionable cleanup", async () => {
  const harness = createHarness(implementAndPass);
  const releaseError = new Error("ticket operation remained ambiguous");
  harness.states.release = async () => { throw releaseError; };
  harness.states.reservationOwner = async () => "aidev-1-0123456789";
  const result = await harness.controller.run(REQUEST);
  assert.equal(result.status, "completed");
  assert.equal(result.lastError, null);
  assert.match(result.reservationCleanupFailure ?? "", /blocked or unverified/);
  assert.equal(harness.states.state?.reservationCleanupFailure, result.reservationCleanupFailure);
});

test("personal controller completes one ticket and publishes only fresh passing gates", async () => {
  const harness = createHarness(implementAndPass);
  const result = await harness.controller.run(REQUEST);
  assert.equal(result.status, "completed");
  assert.equal(result.head, IMPLEMENTED);
  assert.equal(result.branch, deterministicFeatureBranch(REQUEST.repository, REQUEST.ticketId));
  assert.equal(result.prUrl, "https://github.com/example/repo/pull/1");
  assert.deepEqual(harness.calls, ["plan", "implement", "review", "test", "retro"]);
  assert.equal(harness.workspace.cleanChecks, 9);
  assert.equal(harness.publications.length, 1);
  assert.equal(harness.publications[0]?.phases.review.outputHead, IMPLEMENTED);
  assert.equal(harness.publications[0]?.phases.test.outputHead, IMPLEMENTED);
  assert.equal(harness.publications[0]?.phases.retro.outputHead, IMPLEMENTED);
  for (const phase of ["plan", "implement", "review", "test", "retro"] as const) {
    const persisted = result.results[phase];
    validatePhaseResultShape(persisted, phase);
    assert.deepEqual(Object.keys(persisted ?? {}).sort(), ["attempt", "details", "inputHead", "outputHead", "phase", "profile", "runId", "sessionFile", "sessionId", "status", "summary"]);
  }
});

test("controller persists an updated project-wiki disposition only for the cumulative committed diff", async () => {
  const wikiPaths = [".llm-wiki/wiki/concepts/project-wiki-gates.md"];
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") {
      workspace.head = IMPLEMENTED;
      workspace.wikiPaths = [...wikiPaths];
    }
    return phaseResult(input, workspace.head, "passed", [], workspace.wikiPaths);
  });
  const result = await harness.controller.run(REQUEST);
  const implementation = result.results.implement;
  assert.equal(implementation?.phase, "implement");
  if (implementation?.phase === "implement") assert.deepEqual(implementation.details.projectWiki, { status: "updated", paths: wikiPaths, summary: "documented the durable project knowledge" });
  const publishedImplement = harness.publications[0]?.phases.implement;
  assert.equal(publishedImplement?.phase, "implement");
  if (publishedImplement?.phase === "implement") assert.deepEqual(publishedImplement.details.projectWiki, { status: "updated", paths: wikiPaths, summary: "documented the durable project knowledge" });
});

test("controller fails closed when not_required contradicts committed project-wiki paths", async () => {
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") {
      workspace.head = IMPLEMENTED;
      workspace.wikiPaths = [".llm-wiki/wiki/concepts/project-wiki-gates.md"];
      const implementation = phaseResult(input, workspace.head) as ImplementPhaseResult;
      return { ...implementation, details: { changes: ["Changed the requested file"], projectWiki: { status: "not_required", reason: "the ticket adds no durable project knowledge" } } };
    }
    return phaseResult(input, workspace.head);
  });
  await assert.rejects(harness.controller.run(REQUEST), /not_required disposition contradicts committed diff/);
  assert.deepEqual(harness.calls, ["plan", "implement"]);
  assert.equal(harness.publications.length, 0);
});

test("controller rejects updated disposition omitting a cumulative wiki path", async () => {
  const paths = [".llm-wiki/wiki/concepts/first.md", ".llm-wiki/wiki/concepts/second.md"];
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") {
      workspace.head = IMPLEMENTED;
      workspace.wikiPaths = paths;
      return phaseResult(input, workspace.head, "passed", [], paths.slice(0, 1));
    }
    return phaseResult(input, workspace.head);
  });
  await assert.rejects(harness.controller.run(REQUEST), /project-wiki/);
  assert.equal(harness.publications.length, 0);
});

test("controller accepts not_required after remediation reverts the earlier wiki change", async () => {
  const firstPath = ".llm-wiki/wiki/concepts/first.md";
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") {
      workspace.head = input.attempt === 1 ? IMPLEMENTED : REMEDIATED;
      workspace.wikiPaths = input.attempt === 1 ? [firstPath] : [];
      assert.equal(input.originalTicketBaseSha, BASE);
      if (input.attempt === 2) {
        const prior = input.previousCumulative.find(result => result.phase === "implement");
        assert.equal(prior?.phase === "implement" && prior.details.projectWiki.status, "updated");
      }
    }
    if (input.phase === "review" && input.attempt === 1) {
      return phaseResult(input, workspace.head, "remediation_required", ["revert the wiki addition"]);
    }
    return phaseResult(input, workspace.head, "passed", [], workspace.wikiPaths);
  });
  const result = await harness.controller.run(REQUEST);
  assert.equal(result.status, "completed");
  assert.equal(result.head, REMEDIATED);
  assert.equal(result.results.implement?.phase === "implement" && result.results.implement.details.projectWiki.status, "not_required");
  assert.equal(harness.publications.length, 1);
});

test("controller compares remediation dispositions with the cumulative wiki diff", async () => {
  let firstReview = true;
  let implementationCount = 0;
  let secondInput: PhaseInput | undefined;
  let laterInput: PhaseInput | undefined;
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "review" && implementationCount === 2) laterInput = input;
    if (input.phase === "implement") {
      implementationCount += 1;
      if (implementationCount === 2) {
        secondInput = input;
        workspace.head = REMEDIATED;
        workspace.wikiPaths = [".llm-wiki/wiki/concepts/first.md"];
        const prior = input.previousCumulative.find(item => item.phase === "implement");
        if (prior?.phase === "implement") (prior.details.changes as string[]).push("mutated clone only");
      } else {
        workspace.head = IMPLEMENTED;
        workspace.wikiPaths = [".llm-wiki/wiki/concepts/first.md"];
      }
    }
    if (input.phase === "review" && firstReview) {
      firstReview = false;
      return phaseResult(input, workspace.head, "remediation_required", ["fix the review finding"]);
    }
    return phaseResult(input, workspace.head, "passed", [], workspace.wikiPaths);
  });
  const result = await harness.controller.run(REQUEST);
  assert.equal(result.status, "completed");
  const implementation = result.results.implement;
  assert.equal(implementation?.phase, "implement");
  if (implementation?.phase === "implement" && implementation.details.projectWiki.status === "updated") assert.deepEqual(implementation.details.projectWiki.paths, [".llm-wiki/wiki/concepts/first.md"]);
  assert.equal(secondInput?.originalTicketBaseSha, BASE);
  const laterImplement = laterInput?.previousCumulative.find(item => item.phase === "implement");
  assert.equal(laterImplement?.phase === "implement" && laterImplement.details.changes.includes("mutated clone only"), false);
});

test("resolved profiles are persisted before workspace preparation", async () => {
  const harness = createHarness(implementAndPass);
  await harness.controller.run(REQUEST);
  assert.equal(harness.events[0], "state:create");
  assert.ok(harness.events.indexOf("state:create") < harness.events.indexOf("workspace:prepare"));
  assert.deepEqual(harness.states.state?.profiles, resolvePhaseProfiles(REQUEST.repository, REQUEST.ticketId).profiles);
  assert.deepEqual(harness.states.state?.planSelection, resolvePhaseProfiles(REQUEST.repository, REQUEST.ticketId).planSelection);
});

test("Retro receives the tested HEAD and all prior phase results in its own recorded attempt", async () => {
  let retroInput: PhaseInput | undefined;
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") workspace.head = IMPLEMENTED;
    if (input.phase === "retro") retroInput = input;
    return phaseResult(input, workspace.head);
  });
  const result = await harness.controller.run(REQUEST);
  assert.equal(retroInput?.expectedHead, IMPLEMENTED);
  assert.equal(retroInput?.originalTicketBaseSha, BASE);
  assert.deepEqual(Object.keys(retroInput?.previous ?? {}).sort(), ["implement", "plan", "review", "test"]);
  assert.equal(retroInput?.previousCumulative.length, 4);
  assert.equal(result.attempts.retro, 1);
  assert.equal(result.sessions.retro, "retro-1");
  assert.deepEqual(result.results.retro?.details, { lessons: ["Keep exact HEAD gates explicit"], followUps: [] });
});

test("failed or malformed Retro stops visibly without publication and still checks cleanliness afterward", async t => {
  await t.test("failed result", async () => {
    const harness = createHarness(async (input, workspace) => {
      if (input.phase === "implement") workspace.head = IMPLEMENTED;
      return phaseResult(input, workspace.head, input.phase === "retro" ? "failed" : "passed");
    });
    await assert.rejects(harness.controller.run(REQUEST), /retro failed/);
    assert.equal(harness.states.state?.status, "failed");
    assert.equal(harness.publications.length, 0);
  });
  await t.test("malformed output error", async () => {
    const harness = createHarness(async (input, workspace) => {
      if (input.phase === "implement") workspace.head = IMPLEMENTED;
      if (input.phase === "retro") throw new Error("retro wrote malformed result JSON");
      return phaseResult(input, workspace.head);
    });
    await assert.rejects(harness.controller.run(REQUEST), /malformed result JSON/);
    assert.equal(harness.workspace.cleanChecks, 9);
    assert.equal(harness.publications.length, 0);
  });
});

test("undefined phase and workspace failures are tracked independently from their values", async t => {
  await t.test("successful phase plus undefined cleanliness failure is rejected", async () => {
    const harness = createHarness(async input => phaseResult(input, BASE));
    harness.workspace.cleanFailureAt = 2; // Plan's post-phase cleanliness check.
    harness.workspace.cleanFailure = undefined;
    await assert.rejects(harness.controller.run(REQUEST), error => error === undefined);
  });
  await t.test("undefined phase failure remains primary with a dirty Error diagnostic", async () => {
    const harness = createHarness(async input => {
      if (input.phase === "implement") throw undefined;
      return phaseResult(input, harness.workspace.head);
    });
    harness.workspace.cleanFailureAt = 3; // Implement's post-phase check (Plan used checks 1 and 2).
    harness.workspace.cleanFailure = new Error("workspace has uncommitted changes");
    await assert.rejects(harness.controller.run(REQUEST), error => {
      assert.match(String(error), /undefined; secondary workspace diagnostic: workspace has uncommitted changes/);
      return true;
    });
  });
  for (const rejected of ["phase failed", null]) {
    await t.test(`non-Error ${String(rejected)} phase rejection is not swallowed`, async () => {
      const harness = createHarness(async input => {
        if (input.phase === "plan") throw rejected;
        return phaseResult(input, harness.workspace.head);
      });
      await assert.rejects(harness.controller.run(REQUEST), error => error === rejected);
    });
  }
});

test("phase execution error remains primary when post-phase cleanliness diagnostics fail", async () => {
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") {
      workspace.clean = false;
      throw new Error("phase timed out");
    }
    return phaseResult(input, workspace.head);
  });
  await assert.rejects(harness.controller.run(REQUEST), error => {
    assert.match(String(error), /phase timed out/);
    assert.match(String(error), /secondary workspace diagnostic: workspace has uncommitted changes/);
    return true;
  });
  assert.equal(harness.publications.length, 0);
});

test("Retro workspace or HEAD changes fail closed before publication", async t => {
  await t.test("dirty workspace", async () => {
    const harness = createHarness(async (input, workspace) => {
      if (input.phase === "implement") workspace.head = IMPLEMENTED;
      if (input.phase === "retro") workspace.clean = false;
      return phaseResult(input, workspace.head);
    });
    await assert.rejects(harness.controller.run(REQUEST), /uncommitted changes/);
    assert.equal(harness.states.state?.results.retro, undefined);
    assert.equal(harness.publications.length, 0);
  });
  await t.test("changed HEAD", async () => {
    const harness = createHarness(async (input, workspace) => {
      if (input.phase === "implement") workspace.head = IMPLEMENTED;
      if (input.phase === "retro") workspace.head = REMEDIATED;
      return phaseResult(input, workspace.head);
    });
    await assert.rejects(harness.controller.run(REQUEST), /retro changed Git HEAD/);
    assert.equal(harness.publications.length, 0);
  });
});

test("Review remediation returns once to Implement and reruns Review and Test at the new HEAD", async () => {
  let firstReview = true;
  let implementations = 0;
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") {
      implementations += 1;
      workspace.head = implementations === 1 ? IMPLEMENTED : REMEDIATED;
    }
    if (input.phase === "review" && firstReview) {
      firstReview = false;
      return phaseResult(input, workspace.head, "remediation_required", ["fix the review finding"]);
    }
    return phaseResult(input, workspace.head);
  });
  const result = await harness.controller.run(REQUEST);
  assert.equal(result.status, "completed");
  assert.equal(result.head, REMEDIATED);
  assert.equal(result.remediations.review, 1);
  assert.deepEqual(result.remediationAttempts, { review: [1], test: [] });
  assert.deepEqual(harness.calls, ["plan", "implement", "review", "implement", "review", "test", "retro"]);
});

test("approved resolved profiles remain unchanged through remediation and persisted evidence", async () => {
  const resolved = resolvePhaseProfiles(REQUEST.repository, REQUEST.ticketId);
  let firstReview = true;
  let implementations = 0;
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") {
      implementations += 1;
      workspace.head = implementations === 1 ? IMPLEMENTED : REMEDIATED;
    }
    if (input.phase === "review" && firstReview) {
      firstReview = false;
      return phaseResult(input, workspace.head, "remediation_required", ["fix the review finding"]);
    }
    return phaseResult(input, workspace.head);
  });
  const result = await harness.controller.run(REQUEST);

  assert.deepEqual(result.profiles, resolved.profiles);
  assert.deepEqual(result.planSelection, resolved.planSelection);
  assert.deepEqual(harness.states.state?.profiles, resolved.profiles);
  assert.deepEqual(harness.states.state?.planSelection, resolved.planSelection);
  assert.deepEqual(
    harness.inputs.map(input => input.profile),
    harness.inputs.map(input => resolved.profiles[input.phase]),
  );
  for (const phase of ["plan", "implement", "review", "test", "retro"] as const) {
    assert.deepEqual(result.results[phase]?.profile, resolved.profiles[phase]);
    assert.deepEqual(harness.states.state?.results[phase]?.profile, resolved.profiles[phase]);
  }
  assert.equal(result.remediations.review, 1);
  assert.deepEqual(result.remediationAttempts, { review: [1], test: [] });
  assert.deepEqual(harness.calls, ["plan", "implement", "review", "implement", "review", "test", "retro"]);
});

test("remediation keeps the initially persisted profiles when external policy objects change", async () => {
  const externalPolicy: PersonalModelPolicy = {
    plan: [
      { provider: "initial-provider", model: "initial-plan-a", thinking: "medium" },
      { provider: "initial-provider", model: "initial-plan-b", thinking: "high" },
    ],
    implement: { provider: "initial-provider", model: "initial-implement", thinking: "max" },
    review: { provider: "initial-provider", model: "initial-review", thinking: "medium" },
    test: { provider: "initial-provider", model: "initial-test", thinking: "high" },
    retro: { provider: "initial-provider", model: "initial-retro", thinking: "medium" },
  };
  const resolved = resolvePhaseProfiles(REQUEST.repository, REQUEST.ticketId, externalPolicy);
  let implementations = 0;
  let firstReview = true;
  let firstTest = true;
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") {
      implementations += 1;
      workspace.head = implementations === 1 ? IMPLEMENTED : REMEDIATED;
    }
    if (input.phase === "review" && firstReview) {
      firstReview = false;
      replacePolicy(externalPolicy);
      return phaseResult(input, workspace.head, "remediation_required", ["fix the review finding"]);
    }
    if (input.phase === "test" && firstTest) {
      firstTest = false;
      replacePolicy(externalPolicy);
      return phaseResult(input, workspace.head, "remediation_required", ["fix the failing test"]);
    }
    return phaseResult(input, workspace.head);
  }, externalPolicy);
  const result = await harness.controller.run(REQUEST);

  assert.deepEqual(result.profiles, resolved.profiles);
  assert.deepEqual(result.planSelection, resolved.planSelection);
  assert.deepEqual(
    harness.inputs.map(input => input.profile),
    harness.inputs.map(input => resolved.profiles[input.phase]),
  );
  for (const phase of ["plan", "implement", "review", "test", "retro"] as const) {
    assert.deepEqual(result.results[phase]?.profile, resolved.profiles[phase]);
  }
  assert.equal(result.remediations.review, 1);
  assert.equal(result.remediations.test, 1);
  assert.deepEqual(result.remediationAttempts, { review: [1], test: [1] });
});

test("Test remediation reruns Implement, fresh Review, and Test", async () => {
  let firstTest = true;
  let implementations = 0;
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") {
      implementations += 1;
      workspace.head = implementations === 1 ? IMPLEMENTED : REMEDIATED;
    }
    if (input.phase === "test" && firstTest) {
      firstTest = false;
      return phaseResult(input, workspace.head, "remediation_required", ["fix the failing test"]);
    }
    return phaseResult(input, workspace.head);
  });
  const result = await harness.controller.run(REQUEST);
  assert.equal(result.status, "completed");
  assert.equal(result.remediations.test, 1);
  assert.deepEqual(result.remediationAttempts, { review: [], test: [1] });
  assert.deepEqual(harness.calls, ["plan", "implement", "review", "test", "implement", "review", "test", "retro"]);
});

test("a stale gate fails closed and persists a useful error", async () => {
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") workspace.head = IMPLEMENTED;
    if (input.phase === "review") return phaseResult(input, BASE);
    return phaseResult(input, workspace.head);
  });
  await assert.rejects(harness.controller.run(REQUEST), /output HEAD mismatch/);
  assert.equal(harness.states.state?.status, "failed");
  assert.match(harness.states.state?.lastError ?? "", /output HEAD mismatch/);
  assert.equal(harness.states.state?.results.review, undefined);
  assert.equal(harness.publications.length, 0);
});

test("uncommitted Implement output fails before Review and is not persisted as passing", async () => {
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") { workspace.head = IMPLEMENTED; workspace.clean = false; }
    return phaseResult(input, workspace.head);
  });
  await assert.rejects(harness.controller.run(REQUEST), /uncommitted changes/);
  assert.deepEqual(harness.calls, ["plan", "implement"]);
  assert.equal(harness.states.state?.results.implement, undefined);
  assert.equal(harness.publications.length, 0);
});

test("Review modifications fail before Test and are not persisted as passing", async () => {
  const harness = createHarness(async (input, workspace) => {
    if (input.phase === "implement") workspace.head = IMPLEMENTED;
    if (input.phase === "review") workspace.clean = false;
    return phaseResult(input, workspace.head);
  });
  await assert.rejects(harness.controller.run(REQUEST), /uncommitted changes/);
  assert.deepEqual(harness.calls, ["plan", "implement", "review"]);
  assert.equal(harness.states.state?.results.review, undefined);
  assert.equal(harness.publications.length, 0);
});

test("an active run prevents starting the same ticket twice", async () => {
  const harness = createHarness(async (input, workspace) => phaseResult(input, workspace.head));
  harness.states.state = {
    schemaVersion: 1, version: 1, runId: "aidev-1-existing", ticketId: "AIDEV-1", ticketTitle: "existing", status: "running", step: "plan",
    sandbox: "squire-aidev-1-existing", repository: "example/repo", baseBranch: "main", baseSha: BASE, branch: deterministicFeatureBranch("example/repo", "AIDEV-1"), head: BASE,
    sessions: {}, attempts: { plan: 1, implement: 0, review: 0, test: 0, retro: 0 }, results: {}, remediations: { review: 0, test: 0 }, prUrl: null, lastError: null, updatedAt: "2026-09-10T00:00:00.000Z",
  };
  await assert.rejects(harness.controller.run(REQUEST), /already has an active run/);
});
