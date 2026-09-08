import assert from "node:assert/strict";
import test from "node:test";
import { stat } from "node:fs/promises";
import type { Lease, RunPreparationLease } from "../src/control/domain.js";
import { SafeArtifactReader, type ImmutableArtifactReader } from "../src/control/safe-artifact-reader.js";
import { FileGitContractWriter, GitWorkspaceContractValidator, type GitContractArtifactWriter } from "../src/git/contracts.js";
import { GitWorkspaceService, type GitSourceAuthorization, type RepositorySourceAuthorizer } from "../src/git/workspace-service.js";
import { createGitFixture, type GitFixture } from "./support/git-fixture.js";
import { createControllableClock, type ControllableClock } from "./support/controllable-clock.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value?: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = value => resolvePromise(value as T);
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function grant(fixture: GitFixture, release: () => void): GitSourceAuthorization {
  return { cloneUrl: fixture.source, localTransport: true, release };
}

function serviceOptions(
  fixture: GitFixture,
  clock: ControllableClock,
  sourceAuthorizer: RepositorySourceAuthorizer,
  extras: {
    readonly artifactReader?: ImmutableArtifactReader;
    readonly artifactWriter?: GitContractArtifactWriter;
    readonly contractValidator?: GitWorkspaceContractValidator;
    readonly allowLocalTransport?: boolean;
  } = {},
) {
  return {
    store: fixture.store,
    ticketRoot: fixture.ticketRoot,
    filesystemAuthority: fixture.filesystemAuthority,
    clock,
    operationLeaseMs: 1_000,
    allowLocalTransport: extras.allowLocalTransport ?? true,
    requirePublishingGates: false,
    sourceAuthorizer,
    ...(extras.artifactReader ? { artifactReader: extras.artifactReader } : {}),
    ...(extras.artifactWriter ? { artifactWriter: extras.artifactWriter } : {}),
    ...(extras.contractValidator ? { contractValidator: extras.contractValidator } : {}),
  };
}

async function captureLifecycle(fixture: GitFixture): Promise<{ preparation: RunPreparationLease; generic: Lease }> {
  const snapshot = await fixture.store.read(fixture.input.runId);
  const preparationLeases = snapshot?.preparationLeases ?? [];
  assert.equal(preparationLeases.length, 1, "createSpec must hold one preparation lease at its barrier");
  const preparation = preparationLeases[0]!;
  assert.equal(preparation.runId, fixture.input.runId);
  assert.equal(preparation.state, "held");
  assert.match(preparation.owner, /^git-create-spec-[0-9a-f-]{36}$/u);
  assert.ok(preparation.fencingToken > 0);
  const generic = fixture.store.leases.get(`${fixture.input.runId}:git-workspace`);
  assert.ok(generic, "createSpec must hold the generic Git lease at its barrier");
  return { preparation, generic };
}

async function assertTerminalFenceBlocked(
  fixture: GitFixture,
  clock: ControllableClock,
  lifecycle: { preparation: RunPreparationLease; generic: Lease },
  owner: string,
): Promise<void> {
  clock.advance(lifecycle.generic.expiresAt - clock.now() + 1);
  await assert.rejects(
    () => fixture.store.acquireRunTerminalFence(fixture.input.runId, owner, clock.now()),
    /preparation lease remains/u,
  );
  assert.equal((await fixture.store.read(fixture.input.runId))?.terminalFence, undefined, "a blocked contender must not publish a terminal fence");
}

async function assertLifecycleReleased(fixture: GitFixture, lifecycle: { preparation: RunPreparationLease }): Promise<void> {
  const snapshot = await fixture.store.read(fixture.input.runId);
  assert.equal(
    (snapshot?.preparationLeases ?? []).some(candidate => candidate.runId === lifecycle.preparation.runId && candidate.owner === lifecycle.preparation.owner && candidate.fencingToken === lifecycle.preparation.fencingToken),
    false,
    "the exact createSpec preparation lease must be released",
  );
  assert.equal(fixture.store.leases.has(`${fixture.input.runId}:git-workspace`), false, "the exact generic Git lease must be released");
}

async function createService(
  fixture: GitFixture,
  clock: ControllableClock,
  sourceAuthorizer: RepositorySourceAuthorizer,
  extras: Parameters<typeof serviceOptions>[3] = {},
): Promise<GitWorkspaceService> {
  return new GitWorkspaceService(serviceOptions(fixture, clock, sourceAuthorizer, extras));
}

test("createSpec holds durable preparation across source authorization, publication, and validation", async t => {
  for (const stage of ["authorization", "publication", "validation"] as const) {
    await t.test(stage, async t => {
      const clock = createControllableClock();
      const fixture = await createGitFixture({ clock });
      t.after(fixture.cleanup);

      const entered = deferred<void>();
      const release = deferred<void>();
      let authorizeCalls = 0;
      let releaseCalls = 0;
      const sourceAuthorizer: RepositorySourceAuthorizer = {
        authorize: async () => {
          authorizeCalls += 1;
          if (stage === "authorization") {
            entered.resolve();
            await release.promise;
          }
          return grant(fixture, () => { releaseCalls += 1; });
        },
      };

      let service: GitWorkspaceService;
      if (stage === "publication") {
        const realWriter = new FileGitContractWriter(fixture.ticketRoot);
        const publicationRelease = release;
        const writer: GitContractArtifactWriter = {
          writeCreateOnly: async (relativePath, bytes) => {
            const reference = await realWriter.writeCreateOnly(relativePath, bytes);
            entered.resolve();
            await publicationRelease.promise;
            return reference;
          },
        };
        service = await createService(fixture, clock, sourceAuthorizer, { artifactWriter: writer });
      } else if (stage === "validation") {
        const realReader = new SafeArtifactReader(fixture.ticketRoot);
        const validatingReader: ImmutableArtifactReader = {
          readExact: async reference => {
            const bytes = await realReader.readExact(reference);
            entered.resolve();
            await release.promise;
            return bytes;
          },
        };
        const validator = await GitWorkspaceContractValidator.create(validatingReader);
        service = await createService(fixture, clock, sourceAuthorizer, { artifactReader: validatingReader, contractValidator: validator });
      } else {
        service = await createService(fixture, clock, sourceAuthorizer);
      }

      const operation = service.createSpec(fixture.input);
      await entered.promise;
      const lifecycle = await captureLifecycle(fixture);
      await assertTerminalFenceBlocked(fixture, clock, lifecycle, `terminal-${stage}`);
      release.resolve();
      const reference = await operation;
      assert.equal(reference.path, `artifacts/git/${fixture.input.runId}/workspace-spec.json`);
      assert.equal(authorizeCalls, 1);
      assert.equal(releaseCalls, 1, "the returned source grant must be released exactly once");
      await assertLifecycleReleased(fixture, lifecycle);
    });
  }
});

test("competing createSpec invocations keep distinct durable preparation leases through persisted recovery", async t => {
  const clock = createControllableClock();
  const fixture = await createGitFixture({ clock });
  t.after(fixture.cleanup);

  const operationInput = { ...fixture.input, createdAt: "2026-09-01T12:00:00.000Z" };
  const spec = await fixture.service.createSpec(operationInput);
  await fixture.service.provision(fixture.input.runId, spec, "persisted-recovery-provision");
  const current = await fixture.store.read(fixture.input.runId);
  assert.ok(current?.gitWorkspace?.stage === "ready");
  const operationId = "persisted-recovery-operation";
  const persistedOperation = {
    operationId,
    owner: `git-operation-${operationId}`,
    generation: current.gitWorkspace.operationGeneration,
    step: "fetch" as const,
    startedAt: new Date(clock.now()).toISOString(),
  };
  await fixture.store.compareAndSet(fixture.input.runId, { version: current.version }, snapshot => ({
    ...snapshot,
    version: snapshot.version + 1,
    gitWorkspace: { ...snapshot.gitWorkspace!, operation: persistedOperation },
  }));
  const persisted = await fixture.store.read(fixture.input.runId);
  assert.equal(persisted?.gitWorkspace?.operation?.operationId, operationId, "the race must start from a persisted recoverable Git operation");

  const firstAuthorizationEntered = deferred<void>();
  const firstAuthorizationRelease = deferred<void>();
  const competitorPublicationEntered = deferred<void>();
  const competitorPublicationRelease = deferred<void>();
  let authorizeCalls = 0;
  let releaseCalls = 0;
  const sourceAuthorizer: RepositorySourceAuthorizer = {
    authorize: async () => {
      authorizeCalls += 1;
      if (authorizeCalls === 1) {
        firstAuthorizationEntered.resolve();
        await firstAuthorizationRelease.promise;
      }
      return grant(fixture, () => { releaseCalls += 1; });
    },
  };
  const realWriter = new FileGitContractWriter(fixture.ticketRoot);
  let publicationCalls = 0;
  const service = await createService(fixture, clock, sourceAuthorizer, {
    artifactWriter: {
      writeCreateOnly: async (relativePath, bytes) => {
        const reference = await realWriter.writeCreateOnly(relativePath, bytes);
        publicationCalls += 1;
        if (publicationCalls === 1) {
          competitorPublicationEntered.resolve();
          await competitorPublicationRelease.promise;
        }
        return reference;
      },
    },
  });

  const first = service.createSpec(operationInput);
  await firstAuthorizationEntered.promise;
  const firstSnapshot = await fixture.store.read(fixture.input.runId);
  const firstPreparation = firstSnapshot?.preparationLeases?.[0];
  assert.ok(firstPreparation);
  assert.equal(firstSnapshot?.preparationLeases?.length, 1);
  assert.notEqual(firstPreparation.owner, `git-operation-${operationId}`, "a live createSpec lease must not use the persisted operation identity");
  assert.match(firstPreparation.owner, /^git-create-spec-[0-9a-f-]{36}$/u);
  const firstGeneric = fixture.store.leases.get(`${fixture.input.runId}:git-workspace`);
  assert.ok(firstGeneric);
  clock.advance(firstGeneric.expiresAt - clock.now() + 1);

  const competitor = service.createSpec(operationInput);
  await competitorPublicationEntered.promise;
  const concurrentSnapshot = await fixture.store.read(fixture.input.runId);
  const concurrentPreparations = concurrentSnapshot?.preparationLeases ?? [];
  assert.equal(concurrentPreparations.length, 2, "the competing invocation must acquire its own preparation token");
  const competitorPreparation = concurrentPreparations.find(candidate => candidate.owner !== firstPreparation.owner);
  assert.ok(competitorPreparation);
  assert.notEqual(competitorPreparation.owner, firstPreparation.owner);
  assert.notEqual(competitorPreparation.fencingToken, firstPreparation.fencingToken);
  assert.match(competitorPreparation.owner, /^git-create-spec-[0-9a-f-]{36}$/u);
  const competitorGeneric = fixture.store.leases.get(`${fixture.input.runId}:git-workspace`);
  assert.ok(competitorGeneric);
  assert.notEqual(competitorGeneric.owner, firstGeneric.owner);

  // A stale/foreign token must not be able to release either live invocation.
  await fixture.store.releaseRunPreparationLease(fixture.input.runId, { ...firstPreparation, fencingToken: competitorPreparation.fencingToken + 1 }, clock.now());
  const afterForeignRelease = await fixture.store.read(fixture.input.runId);
  assert.equal(afterForeignRelease?.preparationLeases?.length, 2);
  assert.ok(afterForeignRelease?.preparationLeases?.some(candidate => candidate.owner === firstPreparation.owner && candidate.fencingToken === firstPreparation.fencingToken));
  assert.ok(afterForeignRelease?.preparationLeases?.some(candidate => candidate.owner === competitorPreparation.owner && candidate.fencingToken === competitorPreparation.fencingToken));

  competitorPublicationRelease.resolve();
  await competitor;
  assert.equal(releaseCalls, 1, "the competitor must release only its returned source grant");
  const afterCompetitor = await fixture.store.read(fixture.input.runId);
  assert.equal(afterCompetitor?.preparationLeases?.some(candidate => candidate.owner === competitorPreparation.owner && candidate.fencingToken === competitorPreparation.fencingToken), false, "the competitor must release its exact replacement token");
  assert.equal(afterCompetitor?.preparationLeases?.some(candidate => candidate.owner === firstPreparation.owner && candidate.fencingToken === firstPreparation.fencingToken), true, "the competitor must not release the first live invocation token");
  await assert.rejects(() => fixture.store.acquireRunTerminalFence(fixture.input.runId, "terminal-while-first-paused", clock.now()), /preparation lease remains/u);
  assert.equal((await fixture.store.read(fixture.input.runId))?.terminalFence, undefined);

  // Releasing the already-stale competitor token remains a no-op for the
  // first token. Keep a distinct foreign lease through the first settlement to
  // prove cleanup never bulk-clears a replacement owned by another caller.
  await fixture.store.releaseRunPreparationLease(fixture.input.runId, competitorPreparation, clock.now());
  const foreignPreparation = await fixture.store.acquireRunPreparationLease(fixture.input.runId, "foreign-create-spec-replacement", clock.now());
  firstAuthorizationRelease.resolve();
  await first;
  assert.equal(authorizeCalls, 2);
  assert.equal(releaseCalls, 2, "both returned source grants must be released exactly once");
  const afterFirst = await fixture.store.read(fixture.input.runId);
  assert.equal(afterFirst?.preparationLeases?.some(candidate => candidate.owner === firstPreparation.owner && candidate.fencingToken === firstPreparation.fencingToken), false, "the first invocation must release its exact token");
  assert.equal(afterFirst?.preparationLeases?.some(candidate => candidate.owner === foreignPreparation.owner && candidate.fencingToken === foreignPreparation.fencingToken), true, "the first invocation must not release a foreign token");
  await assert.rejects(() => fixture.store.acquireRunTerminalFence(fixture.input.runId, "terminal-while-foreign-held", clock.now()), /preparation lease remains/u);
  await fixture.store.releaseRunPreparationLease(fixture.input.runId, { ...foreignPreparation, fencingToken: foreignPreparation.fencingToken + 1 }, clock.now());
  assert.equal((await fixture.store.read(fixture.input.runId))?.preparationLeases?.some(candidate => candidate.owner === foreignPreparation.owner && candidate.fencingToken === foreignPreparation.fencingToken), true, "a stale foreign token must not release the foreign lease");
  await fixture.store.releaseRunPreparationLease(fixture.input.runId, foreignPreparation, clock.now());
  await assert.doesNotReject(() => fixture.store.acquireRunTerminalFence(fixture.input.runId, "terminal-after-createSpec-settlement", clock.now()));
});

test("createSpec fails before source or artifact mutation when a terminal fence already exists", async t => {
  const clock = createControllableClock();
  const fixture = await createGitFixture({ clock });
  t.after(fixture.cleanup);
  let authorizeCalls = 0;
  let writeCalls = 0;
  const realWriter = new FileGitContractWriter(fixture.ticketRoot);
  const service = await createService(fixture, clock, {
    authorize: async () => {
      authorizeCalls += 1;
      return grant(fixture, () => undefined);
    },
  }, {
    artifactWriter: {
      writeCreateOnly: async (relativePath, bytes) => {
        writeCalls += 1;
        return realWriter.writeCreateOnly(relativePath, bytes);
      },
    },
  });
  await fixture.store.acquireRunTerminalFence(fixture.input.runId, "already-terminal", clock.now());

  await assert.rejects(() => service.createSpec(fixture.input), /permanent terminal fence/u);
  assert.equal(authorizeCalls, 0);
  assert.equal(writeCalls, 0);
  await assert.rejects(() => stat(fixture.ticketRoot + "/artifacts/git/" + fixture.input.runId), /ENOENT/u);
});

test("createSpec releases the exact leases on rejection, cancellation, writer failure, validation failure, and success", async t => {
  const cases = ["authorization rejection", "authorization cancellation", "writer failure", "validation failure", "success"] as const;
  for (const scenario of cases) {
    await t.test(scenario, async t => {
      const clock = createControllableClock();
      const fixture = await createGitFixture({ clock });
      t.after(fixture.cleanup);
      let releaseCalls = 0;
      const authEntered = deferred<void>();
      const authSettlement = deferred<void>();
      const writerEntered = deferred<void>();
      const writerSettlement = deferred<void>();
      const validationEntered = deferred<void>();
      const validationSettlement = deferred<void>();
      const sourceAuthorizer: RepositorySourceAuthorizer = {
        authorize: async () => {
          if (scenario === "authorization rejection") {
            authEntered.resolve();
            await authSettlement.promise;
            throw new Error("source policy rejected");
          }
          if (scenario === "authorization cancellation" || scenario === "success") {
            authEntered.resolve();
            await authSettlement.promise;
          }
          return grant(fixture, () => { releaseCalls += 1; });
        },
      };
      let service: GitWorkspaceService;
      if (scenario === "writer failure") {
        const realWriter = new FileGitContractWriter(fixture.ticketRoot);
        service = await createService(fixture, clock, sourceAuthorizer, {
          artifactWriter: {
            writeCreateOnly: async (relativePath, bytes) => {
              await realWriter.writeCreateOnly(relativePath, bytes);
              writerEntered.resolve();
              await writerSettlement.promise;
              throw new Error("artifact writer failed");
            },
          },
        });
      } else if (scenario === "validation failure") {
        const realReader = new SafeArtifactReader(fixture.ticketRoot);
        const failingReader: ImmutableArtifactReader = {
          readExact: async reference => {
            const bytes = await realReader.readExact(reference);
            validationEntered.resolve();
            await validationSettlement.promise;
            throw new Error("validation read failed");
          },
        };
        const validator = await GitWorkspaceContractValidator.create(failingReader);
        service = await createService(fixture, clock, sourceAuthorizer, { artifactReader: failingReader, contractValidator: validator });
      } else {
        service = await createService(fixture, clock, sourceAuthorizer);
      }

      const operationInput = scenario === "writer failure" || scenario === "validation failure"
        ? { ...fixture.input, createdAt: "2026-09-01T12:00:00.000Z" }
        : fixture.input;
      const operation = service.createSpec(operationInput);
      let lifecycle: { preparation: RunPreparationLease; generic: Lease };
      if (scenario === "authorization rejection" || scenario === "authorization cancellation" || scenario === "success") {
        await authEntered.promise;
        lifecycle = await captureLifecycle(fixture);
        if (scenario === "authorization cancellation") authSettlement.reject(new Error("operation cancelled"));
        else authSettlement.resolve();
      } else if (scenario === "writer failure") {
        await writerEntered.promise;
        lifecycle = await captureLifecycle(fixture);
        writerSettlement.resolve();
      } else {
        await validationEntered.promise;
        lifecycle = await captureLifecycle(fixture);
        validationSettlement.resolve();
      }

      if (scenario === "success") {
        const reference = await operation;
        assert.equal(reference.path, `artifacts/git/${fixture.input.runId}/workspace-spec.json`);
      } else {
        const expected = scenario === "authorization rejection"
          ? /source policy rejected/u
          : scenario === "authorization cancellation"
            ? /operation cancelled/u
            : scenario === "writer failure"
              ? /artifact writer failed/u
              : /validation read failed/u;
        await assert.rejects(operation, expected);
      }
      await assertLifecycleReleased(fixture, lifecycle);

      if (scenario === "authorization rejection" || scenario === "authorization cancellation") {
        assert.equal(releaseCalls, 0, "a source authorizer that rejects before returning a grant has no returned grant to release");
      } else {
        assert.equal(releaseCalls, 1, "a returned source grant must be released exactly once on downstream settlement");
      }

      if (scenario === "writer failure" || scenario === "validation failure") {
        const retry = await fixture.service.createSpec(operationInput);
        assert.equal(retry.path, `artifacts/git/${fixture.input.runId}/workspace-spec.json`);
        await assert.rejects(() => fixture.service.createSpec({ ...operationInput, baseSha: "1".repeat(40) }), error => {
          assert.equal(error instanceof Error, true);
          assert.equal((error as Error & { readonly cause?: { readonly code?: string } }).cause?.code, "EEXIST");
          return true;
        });
      }
    });
  }
});

test("transport rejection still releases a returned source grant and the lifecycle leases", async t => {
  const clock = createControllableClock();
  const fixture = await createGitFixture({ clock });
  t.after(fixture.cleanup);
  let releaseCalls = 0;
  const service = await createService(fixture, clock, {
    authorize: async () => grant(fixture, () => { releaseCalls += 1; }),
  }, { allowLocalTransport: false });

  await assert.rejects(() => service.createSpec(fixture.input), /local Git transport is disabled/u);
  assert.equal(releaseCalls, 1);
  assert.equal((await fixture.store.read(fixture.input.runId))?.preparationLeases?.length ?? 0, 0);
  assert.equal(fixture.store.leases.has(`${fixture.input.runId}:git-workspace`), false);
});

test("a restarted service cannot recreate artifacts after terminal disposal", async t => {
  const clock = createControllableClock();
  const fixture = await createGitFixture({ clock });
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "disposal-provision");
  const retention = {
    outcome: "success" as const,
    workspaceRetainUntil: new Date(clock.now() + 60_000).toISOString(),
    bundleRetainUntil: new Date(clock.now() + 60_000).toISOString(),
  };
  await fixture.service.markRetained(fixture.input.runId, retention, "disposal-retention");
  clock.advance(120_000);
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "disposal-terminal", clock.now());
  await fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, {
    now: clock.now(),
    workspaceRetainUntil: retention.workspaceRetainUntil,
    bundleRetainUntil: retention.bundleRetainUntil,
  });
  await assert.rejects(() => stat(`${fixture.ticketRoot}/artifacts/git/${fixture.input.runId}`), /ENOENT/u);

  let authorizeCalls = 0;
  let writeCalls = 0;
  const realWriter = new FileGitContractWriter(fixture.ticketRoot);
  const restarted = await createService(fixture, clock, {
    authorize: async () => {
      authorizeCalls += 1;
      return grant(fixture, () => undefined);
    },
  }, {
    artifactWriter: {
      writeCreateOnly: async (relativePath, bytes) => {
        writeCalls += 1;
        return realWriter.writeCreateOnly(relativePath, bytes);
      },
    },
  });
  await assert.rejects(() => restarted.createSpec(fixture.input), /permanent terminal fence|removed/u);
  assert.equal(authorizeCalls, 0);
  assert.equal(writeCalls, 0);
  await assert.rejects(() => stat(`${fixture.ticketRoot}/artifacts/git/${fixture.input.runId}`), /ENOENT/u);
});
