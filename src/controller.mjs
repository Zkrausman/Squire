import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Blocker, digest, validateTickets, validateReview, publicProjectContract } from './contracts.mjs';
import { GitWorkspace } from './workspace.mjs';
import { CodexRuntime } from './runtime-codex.mjs';
import { VerificationRunner } from './verification.mjs';
import { LocalDelivery, GitHubDelivery } from './delivery.mjs';
import { reconcileProcesses } from './process.mjs';
import { beginJobEvidence, finishJobEvidence, recordCandidateDisposition } from './job-evidence.mjs';
import { producerContext, withProducer, withProducerJob } from './producer-context.mjs';

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
});
const ticketPrompt = t => `${t.spec.id}: ${t.spec.title}\n${t.spec.description}\nAcceptance:\n${t.spec.acceptance.map(a => `- ${a}`).join('\n')}${t.spec.execution ? `\nImmutable execution contract:\n${JSON.stringify(t.spec.execution, null, 2)}\nWork on this single outcome. Every checklist item requires observed evidence at this candidate. Do not expand scope; report unmet criteria or a missing dependency. Self-reported completion does not authorize delivery.` : ''}${t.preparation ? `\nPreparation evidence (controller-generated before implementation dispatch):\n${JSON.stringify(t.preparation, null, 2)}\nUse the focused test ownership and native commands recorded here. Before editing implementation code, identify the focused regression path and its owner within the declared ownership or a planned dependency. If no valid test owner/path is available, stop and report that missing prerequisite. Run the listed configured checks on this native environment; do not substitute guessed commands.` : ''}${t.correctionAdmission ? `\nAuthorized bounded correction:\nOutcome: ${t.correctionAdmission.outcome}\nInstructions: ${t.correctionAdmission.instructions}\nAdditional regression checklist (in addition to the immutable contract):\n${JSON.stringify(t.correctionAdmission.checklist, null, 2)}\nThe original ticket, owned paths, and acceptance remain authoritative.` : ''}`;
const effectiveExecution = t => t.spec.execution && t.correctionAdmission ? {
  ...t.spec.execution,
  checklist: [...t.spec.execution.checklist, ...t.correctionAdmission.checklist]
} : t.spec.execution;
const repairCeiling = (t, configured) => t.correctionAdmission?.ceilings?.repairs ?? configured;
const deliveryPhase = status => ['publishing', 'waiting_ci', 'merging', 'postmerge'].includes(status);
const isTestPath = value => /(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)|(?:^|[.-])(?:test|spec)\.[^/]+$/i.test(value);
const preparationEvidence = (spec, service, plan, { allowConfiguredCheckFallback = false } = {}) => {
  const related = new Set([spec.id]);
  const pending = [spec.id], byId = new Map(plan.map(item => [item.id, item]));
  while (pending.length) {
    const id = pending.pop(), current = byId.get(id);
    for (const candidate of plan) if (!related.has(candidate.id) &&
      (candidate.dependsOn.includes(id) || current.dependsOn.includes(candidate.id))) {
      related.add(candidate.id); pending.push(candidate.id);
    }
  }
  const plannedTestOwners = plan.filter(item => item.id !== spec.id && related.has(item.id)).flatMap(item => {
    const paths = (item.execution?.ownedPaths ?? []).filter(isTestPath);
    return paths.length ? [{ ticket: item.id, paths }] : [];
  });
  const recognizedTestPaths = (spec.execution?.ownedPaths ?? []).filter(isTestPath);
  const hasFocusedPathOwner = recognizedTestPaths.length > 0 || plannedTestOwners.length > 0;
  const useConfiguredCheckOwners = !spec.execution || (allowConfiguredCheckFallback && !hasFocusedPathOwner);
  return {
    focusedTestOwnership: {
      ticket: spec.id,
      authorizedPaths: spec.execution?.ownedPaths ?? [],
      recognizedTestPaths,
      plannedTestOwners,
      // Older brief plans predate structured ownership. Keep their established
      // serial repository workflow usable, with the service's trusted checks
      // recorded as the validation owner for this compatibility path. Explicit
      // structured ticket sets also retain their configured checks as owners
      // when their existing ownership does not name a test path.
      ...(useConfiguredCheckOwners ? { configuredCheckOwners: service.checks.map(({ name, argv }) => ({ name, argv: structuredClone(argv) })) } : {}),
      required: true
    },
    nativeEnvironment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      nodeExecutable: process.execPath,
      workingDirectory: 'prepared ticket workspace',
      setup: structuredClone(service.setup ?? []),
      checks: structuredClone(service.checks)
    }
  };
};
const prepareTicketSpecs = (tickets, services, options) => {
  const prepared = tickets.map(spec => ({ spec, preparation: preparationEvidence(spec, services[spec.service], tickets, options) }));
  const missingTestOwners = prepared.filter(({ preparation }) =>
    preparation.focusedTestOwnership.recognizedTestPaths.length === 0 &&
    preparation.focusedTestOwnership.plannedTestOwners.length === 0 &&
    (preparation.focusedTestOwnership.configuredCheckOwners?.length ?? 0) === 0
  ).map(({ spec }) => spec.id);
  if (missingTestOwners.length) throw new Blocker('plan_test_owner', 'Every planned work item requires a focused test owner in its owned paths or a related planned dependency', { tickets: missingTestOwners });
  return prepared;
};
const ownershipOverlaps = (a, b) => !a || !b || a.some(x => b.some(y => {
  x = x.replace(/\/$/, '').toLowerCase(); y = y.replace(/\/$/, '').toLowerCase();
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}));

export class Controller {
  constructor(store, projectId, providers = {}) {
    this.store = store; this.id = projectId; this.config = store.get(projectId).config;
    this.publicContract = publicProjectContract(this.config);
    this.root = path.join(store.directory, 'projects', projectId);
    this.workspace = providers.workspace ?? new GitWorkspace(this.root);
    if (!providers.runtime && this.config.runtime.kind !== 'codex') throw new Blocker('runtime_unavailable', 'Requested runtime adapter is not installed');
    this.runtime = providers.runtime ?? new CodexRuntime(this.config.runtime, this.root);
    this.verifier = providers.verifier ?? new VerificationRunner(this.root);
    this.deliveryFactory = providers.delivery ?? (service => service.delivery.kind === 'local' ? new LocalDelivery(this.workspace) : new GitHubDelivery(this.workspace));
    this.active = new Map(); this.resources = new Set();
    this.onPublication = providers.onPublication;
    if (this.runtime.version !== 1 || !this.runtime.capabilities?.freshSession || !['plan', 'implement', 'review'].every(role => this.runtime.capabilities.roles.includes(role))) throw new Blocker('runtime_capability', 'Runtime must implement version 1 jobs and fresh plan/implementation/review sessions');
    if (this.config.runtime.authentication === 'subscription' && !this.runtime.capabilities.subscription) throw new Blocker('runtime_capability', 'Project policy requires a subscription-backed runtime');
  }
  producerResources(lane) {
    if (lane === 'project:preflight') return []; // Auth/catalog only; no repository producer.
    const ticket = lane.startsWith('ticket:') ? this.current(lane.slice(7)) : null;
    const services = ticket ? [this.config.services[ticket.spec.service]] : Object.values(this.config.services);
    return services.map(service => GitWorkspace.prototype.key(service));
  }
  async producer(lane, work, signal) {
    const parent = producerContext();
    if (parent?.store === this.store && parent.project === this.id) return work();
    const ownedLease = this.controllerLease ? null : this.store.lease(`controller:${this.id}`);
    const lease = this.controllerLease ?? ownedLease;
    try {
      if (this.store.get(this.id).processProtocol !== 1) throw new Blocker('producer_legacy', 'Legacy project has no pre-spawn producer authority; automatic restart refused');
      const scopeId = this.store.beginProducer(this.id, lane, lease, this.producerResources(lane));
      return await withProducer({ store: this.store, project: this.id, scopeId }, async () => {
        const result = await work();
        if (signal?.aborted) throw new Blocker('producer_unresolved', 'Cancelled producer outcome remains fenced', { scopeId });
        // This caller has finished its normal state/event projection. Record the
        // producer outcome and close its scope atomically; terminal alone never
        // closes it, and any error/persistence failure leaves it held.
        if (!producerContext().lifecycle.scopeClosed) this.store.update(this.id, () => {}, 'producer.completed', { scopeId, lane }, scopeId);
        return result;
      });
    } finally { ownedLease?.(); }
  }
  step(id, signal) {
    const ticket = this.current(id), lane = `ticket:${id}`;
    return this.producer(lane, () => this.produceStep(id, signal), signal);
  }
  plan(signal) { return this.producer('project:plan', () => this.producePlan(signal), signal); }
  acceptance(signal) {
    this.store.assertProducerScopesClear(this.id);
    return this.producer('project:acceptance', () => this.produceAcceptance(signal), signal);
  }
  recoverInterruptedImplementation(request, signal) {
    return this.producer(`ticket:${request.ticketId}`,
      () => this.produceInterruptedImplementation(request, signal), signal);
  }
  checkpointInterruptedCandidateVerification(request, signal) {
    return this.producer(`ticket:${request.ticketId}`,
      () => this.produceInterruptedCandidateVerification(request, signal), signal);
  }
  assertPublicContract() {
    for (const config of [this.config, this.store.get(this.id).config]) {
      let current;
      try { current = publicProjectContract(config); }
      catch { throw new Blocker('public_contract_drift', 'Approved public contract is missing, invalid or changed'); }
      if (current?.sha256 !== this.publicContract?.sha256 || current?.text !== this.publicContract?.text) throw new Blocker('public_contract_drift', 'Approved public contract changed before dispatch');
    }
  }
  async callAgent(...args) {
    this.assertPublicContract();
    return this.producer('project:agent', () => this.produceAgent(...args), args[4]);
  }
  current(id) { return this.store.get(this.id).tickets.find(t => t.spec.id === id); }
  change(id, fn, type = 'ticket.transition', detail = {}) {
    return this.store.update(this.id, state => { const ticket = state.tickets.find(t => t.spec.id === id); if (!ticket) throw new Blocker('not_found', `Ticket ${id} unavailable`); fn(ticket); }, type, { ticket: id, ...detail });
  }
  transition(id, status, fields = {}) { this.change(id, t => { Object.assign(t, fields); t.status = status; }, 'ticket.transition', { status }); }
  transitionCandidate(id, status, fields, operationId) {
    return this.store.update(this.id, state => {
      const ticket = state.tickets.find(item => item.spec.id === id);
      if (!ticket) throw new Blocker('not_found', `Ticket ${id} unavailable`);
      Object.assign(ticket, fields, { candidateCheckpointId: operationId, status });
    }, 'ticket.transition', { ticket: id, status }, null, operationId);
  }
  checkpointJournal(ticket, purpose, { jobId = ticket.activeJob ?? null, recoveryId = null } = {}) {
    const context = producerContext();
    if (!context || context.store !== this.store || context.project !== this.id || !context.scopeId) {
      throw new Blocker('candidate_checkpoint_identity', 'Candidate checkpoint requires the active ticket producer scope');
    }
    return { store: this.store, projectId: this.id, scopeId: context.scopeId, purpose, jobId, recoveryId, policyDigest: digest(this.config) };
  }
  async ensureTicketPreparation() {
    const state = this.store.get(this.id);
    if (!state.tickets.length || state.tickets.every(ticket => ticket.preparation)) return;
    const specs = state.tickets.map(ticket => ticket.spec);
    validateTickets(specs, this.config.services);
    const prepared = prepareTicketSpecs(specs, this.config.services, { allowConfiguredCheckFallback: this.config.tickets !== undefined });
    const preparationById = new Map(prepared.map(item => [item.spec.id, item.preparation]));
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.root, 'ticket-plan.json'), JSON.stringify(prepared.map(({ spec, preparation }) => ({ ...spec, preparation })), null, 2), { mode: 0o600 });
    this.store.update(this.id, current => {
      for (const ticket of current.tickets) if (!ticket.preparation) ticket.preparation = preparationById.get(ticket.spec.id);
    }, 'tickets.prepared', { count: prepared.length });
  }
  async assertActive(signal) {
    if (signal?.aborted || this.store.get(this.id).paused) throw new Blocker('paused', 'Controller paused at a safe boundary');
  }
  async run(signal, { wait = true } = {}) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const release = this.store.lease(`controller:${this.id}`);
    this.controllerLease = release;
    try {
      const state = this.store.get(this.id);
      if (state.paused) return state;
      if (state.status === 'completed') { this.store.assertProducerScopesClear(this.id); return state; }
      if (state.processProtocol !== 1) throw new Blocker('producer_legacy', 'Legacy project has no pre-spawn producer authority; automatic restart refused');
      await reconcileProcesses(this.root, signal, { refuseLegacy: true, store: this.store, project: this.id });
      await this.producer('project:preflight', () => this.runtime.preflight(signal), signal);
      await this.ensureTicketPreparation();
      // Parent-death supervision ends interrupted jobs. No in-memory promise is
      // treated as an outcome; re-enter a persisted phase with fresh evidence.
      const holds = new Map(this.store.producerHolds(this.id, release.owner).map(scope => [scope.lane, scope.id]));
      this.store.update(this.id, s => {
        s.status = 'running';
        for (const t of s.tickets) {
          const scopeId = holds.get(`ticket:${t.spec.id}`);
          if (scopeId) {
            // A projected phase (even shipped) is not authority for dependent
            // work until its producer closes. Preserve the prior projection.
            t.producerHold ??= { scopeId, status: t.status, blocker: structuredClone(t.blocker ?? null) };
            t.status = 'blocked';
            t.blocker = { code: 'producer_unresolved', message: 'Prior ticket producer outcome remains fenced', detail: { scopeId } };
            continue;
          }
          if (t.status === 'implementing') t.status = 'recovering';
          if (t.status === 'reviewing') t.status = 'verifying';
        }
      }, 'project.running');
      while (!this.store.get(this.id).tickets.length) {
        await this.assertActive(signal);
        const pending = this.store.get(this.id);
        if (pending.planRetryAt > Date.now()) {
          if (!wait) return pending;
          await sleep(1000, signal); continue;
        }
        if (!await this.plan(signal) && !wait) return this.store.get(this.id);
      }
      while (!signal?.aborted) {
        const state = this.store.get(this.id);
        if (state.paused) { await Promise.allSettled([...this.active.values()]); return this.store.get(this.id); }
        this.propagate();
        const latest = this.store.get(this.id);
        const halted = new Set(latest.tickets.filter(t => t.status === 'blocked' && (!t.spec.execution || t.mergeSha || t.blocker?.code === 'producer_unresolved')).map(t => this.workspace.key(this.config.services[t.spec.service])));
        for (const ticket of latest.tickets) {
          if (this.active.size >= this.config.limits.maxParallel) break;
          const resource = this.workspace.key(this.config.services[ticket.spec.service]);
          if (this.active.has(ticket.spec.id) || halted.has(resource) || ['shipped', 'blocked', 'dependency_blocked'].includes(ticket.status)) continue;
          const conflict = [...this.active.keys()].some(id => {
            const other = this.current(id);
            return this.workspace.key(this.config.services[other.spec.service]) === resource &&
              ((!ticket.spec.execution || !other.spec.execution) ||
               (deliveryPhase(ticket.status) && deliveryPhase(other.status)) ||
               ownershipOverlaps(ticket.spec.execution.ownedPaths, other.spec.execution.ownedPaths));
          });
          if (conflict) continue;
          if (ticket.status === 'waiting_capacity' && ticket.retryAt > Date.now() || ticket.pollAt > Date.now()) continue;
          if (!ticket.spec.dependsOn.every(id => latest.tickets.find(t => t.spec.id === id)?.status === 'shipped')) continue;
          let releaseResource;
          // Isolated structured tickets may work concurrently. Repository
          // publication remains serialized, including exact-head reconciliation.
          const leaseKey = !ticket.spec.execution || deliveryPhase(ticket.status) ? `repository:${resource}` : `ticket:${resource}:${ticket.spec.id}`;
          try { releaseResource = this.store.lease(leaseKey); }
          catch (e) { if (e.code === 'lease_busy') continue; throw e; }
          const promise = this.step(ticket.spec.id, signal).catch(error => {
            if (error.code !== 'producer_unresolved') throw error;
            this.transition(ticket.spec.id, 'blocked', { blocker: { code: error.code, message: error.message, detail: error.detail } });
          }).finally(() => {
            this.active.delete(ticket.spec.id); releaseResource();
          });
          this.active.set(ticket.spec.id, promise);
        }
        if (this.active.size) { await Promise.race([...this.active.values()]); continue; }
        const final = this.store.get(this.id);
        if (final.tickets.length && final.tickets.every(t => t.status === 'shipped')) {
          await this.acceptance(signal); return this.store.get(this.id);
        }
        const pending = final.tickets.filter(t => !['shipped', 'blocked', 'dependency_blocked'].includes(t.status));
        const actionable = pending.filter(t => !halted.has(this.workspace.key(this.config.services[t.spec.service])) && !t.spec.dependsOn.some(d => ['blocked', 'dependency_blocked'].includes(final.tickets.find(x => x.spec.id === d)?.status)));
        if (!actionable.length) {
          this.store.update(this.id, s => { s.status = 'blocked'; }, 'project.blocked'); return this.store.get(this.id);
        }
        this.store.update(this.id, s => { s.status = s.tickets.some(t => t.status === 'waiting_capacity') ? 'waiting_capacity' : 'waiting'; });
        if (!wait) return this.store.get(this.id);
        await sleep(1000, signal);
      }
      await Promise.allSettled([...this.active.values()]);
      this.store.pause(this.id); return this.store.get(this.id);
    } catch (e) {
      await Promise.allSettled([...this.active.values()]);
      if (e.code === 'paused' || signal?.aborted) this.store.pause(this.id);
      else this.store.update(this.id, s => { s.status = 'blocked'; s.blocker = { code: e.code ?? 'controller_error', message: e.message, detail: e.detail }; }, 'project.blocked', { code: e.code ?? 'controller_error', message: e.message });
      return this.store.get(this.id);
    } finally { this.controllerLease = null; release(); }
  }
  propagate() {
    this.store.update(this.id, s => {
      let changed;
      do {
        changed = false;
        for (const t of s.tickets) if (!['shipped', 'blocked', 'dependency_blocked'].includes(t.status) && t.spec.dependsOn.some(d => ['blocked', 'dependency_blocked'].includes(s.tickets.find(x => x.spec.id === d)?.status))) {
          t.status = 'dependency_blocked'; t.blocker = { code: 'dependency', message: 'A required predecessor did not ship' }; changed = true;
          this.store.emit(this.id, 'ticket.blocked', { ticket: t.spec.id, code: 'dependency' });
        }
      } while (changed);
    });
  }
  async produceAgent(role, workspace, directory, instructions, signal, onStarted = () => {}, provenance = {}) {
    // Recheck the pinned bytes before spending a call, including repairs and
    // fresh reviews. Never fall back to a changed or missing contract on resume.
    this.assertPublicContract();
    const contract = this.publicContract;
    if (contract) instructions += `\n\nImmutable public project contract (read-only context):\nSHA-256: ${contract.sha256}\nUTF-8 bytes: ${contract.bytes}\nThis defines project requirements; only the current ticket authorizes changes. It does not grant additional ownership, permissions, commands or budget.\n${contract.text}\nEnd immutable public project contract.\n`;
    const jobId = randomUUID();
    const job = { version: 1, id: jobId, role, workspace, directory: path.join(this.root, 'jobs', 'physical', jobId), provenance, instructions, ...(contract ? { publicContract: { sha256: contract.sha256, bytes: contract.bytes } } : {}), timeoutSeconds: this.config.limits.agentTimeoutSeconds, backoffSeconds: this.config.limits.rateLimitBackoffSeconds };
    this.store.update(this.id, s => {
      if (s.agentCalls >= this.config.limits.maxAgentCalls) throw new Blocker('budget', 'Project agent-call budget exhausted');
      this.store.reserveProducerCall(producerContext().scopeId, job.id);
      s.agentCalls++;
      onStarted(s, job);
    }, 'job.started', { role, jobId: job.id, ...(contract ? { publicContract: job.publicContract } : {}) });
    const evidence = await beginJobEvidence(job, { projectId: this.id, scopeId: producerContext().scopeId, runtime: this.runtime instanceof CodexRuntime ? 'codex' : 'version-1-adapter', ticketId: null, attempt: null, continuationId: null, source: null, ...provenance });
    let outcome, observedUsage, observedSession, reqModel = null, reqReasoning = null, repModel = null, repReasoning = null;
    try { outcome = await withProducerJob(job.id, () => this.runtime.execute({ ...job, signal, onEvent: event => {
      if (event.usage) observedUsage = event.usage;
      if (event.sessionRef) observedSession = event.sessionRef;
      if (event.requestedModel !== undefined) reqModel = event.requestedModel;
      if (event.requestedReasoning !== undefined) reqReasoning = event.requestedReasoning;
      if (event.reportedModel !== undefined) repModel = event.reportedModel;
      if (event.reportedReasoning !== undefined) repReasoning = event.reportedReasoning;
      if (['runtime.configured', 'thread.started', 'turn.completed'].includes(event.type)) this.store.update(this.id, s => {
        if (role === 'implement' && event.sessionRef) for (const t of s.tickets) if (t.activeJob === job.id) {
          t.implementationSessions = [...new Set([...(t.implementationSessions ?? []), event.sessionRef])];
        }
      }, 'job.event', { jobId: job.id, role, sessionRef: event.sessionRef, eventType: event.type, usage: event.usage, requestedModel: reqModel, requestedReasoning: reqReasoning, reportedModel: repModel, reportedReasoning: repReasoning });
    } })); } catch (error) {
      const receipt = error?.detail?.receipt;
      const terminal = await finishJobEvidence(evidence, { error, sessionRef: observedSession, models: { requestedModel: reqModel, requestedReasoning: reqReasoning, reportedModel: repModel, reportedReasoning: repReasoning } });
      this.store.update(this.id, () => {}, 'job.finished', { jobId: job.id, role, evidence: terminal, outcome: 'failed', code: error.code ?? 'runtime_error', sessionRef: observedSession, usage: observedUsage, requestedModel: reqModel, requestedReasoning: reqReasoning, reportedModel: repModel, reportedReasoning: repReasoning,
        ...(receipt ? { receipt: { startedAt: receipt.startedAt, endedAt: receipt.endedAt, exitCode: receipt.exitCode, stopped: receipt.stopped, timedOut: receipt.timedOut } } : {}) });
      throw error;
    }
    const finalReqModel = outcome?.requestedModel !== undefined ? outcome.requestedModel : reqModel;
    const finalReqReasoning = outcome?.requestedReasoning !== undefined ? outcome.requestedReasoning : reqReasoning;
    const finalRepModel = outcome?.reportedModel !== undefined ? outcome.reportedModel : repModel;
    const finalRepReasoning = outcome?.reportedReasoning !== undefined ? outcome.reportedReasoning : repReasoning;
    const terminal = await finishJobEvidence(evidence, { outcome, models: { requestedModel: finalReqModel, requestedReasoning: finalReqReasoning, reportedModel: finalRepModel, reportedReasoning: finalRepReasoning } });
    this.store.update(this.id, () => {}, 'job.finished', { jobId: job.id, role, evidence: terminal, outcome: outcome.outcome, sessionRef: outcome.sessionRef, usage: outcome.usage, requestedModel: finalReqModel, requestedReasoning: finalReqReasoning, reportedModel: finalRepModel, reportedReasoning: finalRepReasoning });
    if (!['completed', 'waiting_capacity'].includes(outcome?.outcome)) throw new Blocker('runtime_result', 'Runtime returned unsupported job outcome');
    if (outcome.outcome === 'completed' && typeof outcome.sessionRef !== 'string') throw new Blocker('runtime_result', 'Completed job has no provider session identity');
    return { ...outcome, jobId: job.id, evidence };
  }
  async producePlan(signal) {
    const state = this.store.get(this.id);
    const attempt = state.planningAttempt + 1;
    this.store.update(this.id, s => { s.planningAttempt = attempt; });
    const paths = {};
    for (const [name, service] of Object.entries(this.config.services)) {
      await this.deliveryFactory(service).preflight(service);
      const directory = path.join(this.root, 'planning', String(attempt), name);
      paths[name] = await this.workspace.prepare(service, directory, `squire-plan-${attempt}`, signal);
    }
    const workspace = Object.values(paths)[0].directory;
    const instructions = `Prepare complete, reviewable software outcomes. Read applicable AGENTS.md and inspect the named service workspaces, without editing files.\nGoal: ${this.publicContract ? 'See the immutable public project contract below.' : this.config.goal}\nServices: ${JSON.stringify(paths)}\nChoose work item boundaries from coherent outcomes, explicit file ownership and dependency interfaces. Do not impose a fixed ticket count, file count or one-file rule. Every work item must have a useful outcome, explicit acceptance criteria, dependency IDs and a focused regression test owner/path within its owned paths or through a named planned dependency. Use the existing test conventions and report a missing ownership prerequisite instead of assuming authority to edit a test path. The controller attaches each work item's native platform, architecture, Node executable/version, ticket workspace working directory, setup commands and configured checks before implementation dispatch; use those commands as the reproducible environment and do not invent replacements. Use dependencies for cross-service integration. Do not add repositories, permissions, check commands, deployments or unrelated cleanup. Existing required checks and policy are authoritative. No separate planning ticket is needed. Return the required JSON schema.`;
    const result = await this.callAgent('plan', workspace, path.join(this.root, 'planning', String(attempt), 'job'), instructions, signal, undefined, { attempt, source: Object.fromEntries(Object.entries(paths).map(([name, value]) => [name, { baseSha: value.baseSha }])) });
    if (result.outcome === 'waiting_capacity') {
      this.store.update(this.id, s => { s.status = 'waiting_capacity'; s.planRetryAt = result.retryAt; }, 'project.waiting_capacity');
      return false;
    }
    const tickets = validateTickets(result.result?.tickets, this.config.services);
    for (const value of Object.values(paths)) {
      const identity = await this.workspace.identity(value.directory, signal);
      if (identity.dirty || identity.headSha !== value.baseSha) throw new Blocker('planner_mutation', 'Planning modified a workspace or its HEAD');
    }
    const prepared = prepareTicketSpecs(tickets, this.config.services);
    await writeFile(path.join(this.root, 'ticket-plan.json'), JSON.stringify(prepared.map(({ spec, preparation }) => ({ ...spec, preparation })), null, 2), { mode: 0o600 });
    this.store.update(this.id, s => { s.tickets = prepared.map(({ spec, preparation }) => ({ spec, preparation, status: 'queued', attempts: 0, repairs: 0, rebases: 0 })); s.plan = { sessionRef: result.sessionRef, jobId: result.jobId }; s.status = 'running'; }, 'project.planned', { count: tickets.length });
    return true;
  }
  async repair(id, reason) {
    let t = this.current(id);
    if (reason?.verdict === 'fail' && t.review?.verdict === 'fail' && t.review.headSha === t.headSha) {
      this.change(id, ticket => { ticket.lastFailedReview = structuredClone(ticket.review); });
      t = this.current(id);
    }
    if (t.repairs >= repairCeiling(t, this.config.limits.maxRepairs)) throw new Blocker('repair_budget', 'Automatic repair budget exhausted', { reason });
    this.transition(id, 'repairing', { repairReason: reason, verification: null, review: null, pollAt: 0 });
  }
  async refresh(id, signal) {
    const t = this.current(id), service = this.config.services[t.spec.service];
    if (t.rebases >= this.config.limits.maxRebases) throw new Blocker('rebase_budget', 'Base changed too often; rebase budget exhausted');
    try {
      const identity = await this.workspace.refresh(t, service, signal);
      this.transition(id, 'verifying', { ...identity, rebases: t.rebases + 1, verification: null, review: null, ciDeadline: null, pollAt: 0 });
    } catch (error) {
      if (error.code !== 'rebase_conflict') throw error;
      if (t.repairs >= repairCeiling(t, this.config.limits.maxRepairs)) throw new Blocker('repair_budget', 'Conflict repair budget exhausted');
      const generation = t.generation + 1, directory = path.join(this.root, 'workspaces', `${id}-${generation}`);
      const prepared = await this.workspace.conflictWorkspace(t, service, directory, signal);
      await this.verifier.setup(directory, service.setup, `conflict-${id}-${generation}`, signal);
      this.transition(id, 'repairing', { workspace: directory, generation, baseSha: prepared.baseSha, headSha: null, treeSha: null,
        rebases: t.rebases + 1, previousWorkspaces: [...(t.previousWorkspaces ?? []), t.workspace], verification: null, review: null, ciDeadline: null, pollAt: 0,
        repairReason: { code: 'rebase_conflict', message: 'Resolve staged conflicts while incorporating the new base requirements. Do not commit.', priorWorkspace: t.workspace, patchFile: prepared.patchFile } });
    }
  }
  async produceStep(id, signal) {
    let t = this.current(id);
    const service = this.config.services[t.spec.service], delivery = this.deliveryFactory(service);
    try {
      await this.assertActive(signal);
      await this.ensureTicketPreparation();
      t = this.current(id);
      if (t.status === 'waiting_capacity') {
        this.transition(id, t.resumeStatus ?? 'repairing', { retryAt: 0 }); return;
      }
      if (t.status === 'queued') {
        await delivery.preflight(service);
        const generation = (t.generation ?? 0) + 1;
        const directory = path.join(this.root, 'workspaces', `${id}-${generation}`);
        const branch = `squire/${this.id}-${digest(this.config).slice(0, 8)}/${id}`;
        this.transition(id, 'preparing', { workspace: directory, generation, branch, projectId: this.id });
        const value = await this.workspace.prepare(service, directory, branch, signal);
        await this.verifier.setup(directory, service.setup, `${id}-${generation}`, signal);
        this.transition(id, 'prepared', { baseSha: value.baseSha }); return;
      }
      if (t.status === 'preparing') { // Partial clone is retained, next generation is isolated.
        this.transition(id, 'queued'); return;
      }
      if (t.status === 'recovering') {
        const identity = await this.workspace.identity(t.workspace, signal);
        if (identity.headSha !== t.beforeAgentHead) throw new Blocker('agent_changed_history', 'Interrupted agent changed Git history');
        if (identity.dirty) {
          const candidate = await this.workspace.checkpoint(t, service, signal, this.checkpointJournal(t, 'automatic_recovery'));
          this.transitionCandidate(id, 'verifying', { ...candidate, recovered: true, verification: null, review: null }, candidate.operationId);
        } else this.transition(id, 'prepared');
        return;
      }
      if (t.status === 'recovering_candidate') {
        await this.finishInterruptedCandidateVerification(id, t.interruptedCandidateVerification.recoveryId, signal); return;
      }
      if (t.status === 'prepared' || t.status === 'repairing' || t.status === 'continuing') {
        const continuing = t.status === 'continuing';
        if (t.status === 'repairing' && t.repairs >= repairCeiling(t, this.config.limits.maxRepairs)) throw new Blocker('repair_budget', 'Automatic repair budget exhausted', { repairCeiling: repairCeiling(t, this.config.limits.maxRepairs) });
        const attemptCeiling = t.correctionAdmission?.ceilings?.implementAttempts ?? t.spec.execution?.maxAttempts;
        if (!continuing && t.spec.execution && t.attempts >= attemptCeiling) throw new Blocker('slice_budget', 'Execution slice attempt limit reached; replan the unresolved outcome', { stopWhen: t.spec.execution.stopWhen, attemptCeiling });
        const before = await this.workspace.identity(t.workspace, signal);
        if (before.dirty && t.status === 'prepared' && !t.capacity) throw new Blocker('dirty_workspace', 'Trusted setup changed source before implementation');
        if (continuing && (before.headSha !== t.headSha || before.treeSha !== t.treeSha || before.dirty)) throw new Blocker('continuation_identity_mismatch', 'Recovered partial candidate changed or became dirty before its continuation', before);
        const attempt = continuing ? t.attempts : t.attempts + 1, repairing = t.status === 'repairing';
        const reason = repairing || continuing ? `\n${continuing ? 'Continue the same logical implementation attempt' : 'Repair these verified failures/findings'} within this ticket: ${JSON.stringify(t.repairReason)}\nPreserve existing useful work. Every edit will receive fresh tests and review.` : '';
        const instructions = `Implement the following authorized ticket in this workspace. Read applicable AGENTS.md. Do the work and meaningful tests; do not merely propose a plan.\n${ticketPrompt(t)}\nBase: ${t.baseSha}.\nProtected paths: ${JSON.stringify(service.protectedPaths)}.\nDo not commit, rewrite Git history, publish, merge, access credentials or modify controller policy/evidence. Squire owns those actions. Stay within the ticket. Your final message should summarize the concrete change and validation.${reason}`;
        const jobDirectory = continuing ? `${attempt}-continuation-1-implement` : `${attempt}-implement`;
        const outcome = await this.callAgent('implement', t.workspace, path.join(this.root, 'jobs', id, jobDirectory), instructions, signal, (s, job) => {
          const ticket = s.tickets.find(x => x.spec.id === id);
          Object.assign(ticket, { status: 'implementing', attempts: continuing ? ticket.attempts : attempt, beforeAgentHead: before.headSha, activeJob: job.id, repairs: ticket.repairs + (repairing ? 1 : 0), verification: null, review: null });
          if (continuing) Object.assign(ticket.interruptedContinuation, { status: 'running', startedAt: Date.now(), jobId: job.id, logicalAttempt: ticket.attempts });
        }, { ticketId: id, attempt, continuationId: continuing ? t.interruptedContinuation.continuationId : null, source: { headSha: before.headSha, treeSha: before.treeSha, dirty: before.dirty, baseSha: t.baseSha } });
        if (outcome.outcome === 'waiting_capacity') {
          this.transition(id, 'waiting_capacity', { retryAt: outcome.retryAt, resumeStatus: continuing ? 'continuing' : repairing ? 'repairing' : 'prepared', capacity: outcome.detail });
          if (continuing) this.change(id, ticket => { ticket.interruptedContinuation.status = 'waiting_capacity'; });
          if (repairing) this.change(id, ticket => { ticket.repairs--; });
          return;
        }
        let candidate;
        try { candidate = await this.workspace.checkpoint(this.current(id), service, signal,
          this.checkpointJournal(this.current(id), 'implementation', { jobId: outcome.jobId })); }
        catch (error) {
          if (producerContext()?.lifecycle?.persistenceFailed) throw error;
          await recordCandidateDisposition(outcome.evidence, { outcome: error.code === 'no_candidate' ? 'no_change' : 'failed' });
          throw error;
        }
        await recordCandidateDisposition(outcome.evidence, { outcome: 'candidate', headSha: candidate.headSha, treeSha: candidate.treeSha }, candidate);
        const implementation = { sessionRef: outcome.sessionRef, jobId: outcome.jobId, usage: outcome.usage,
          ...(continuing ? { continuationId: t.interruptedContinuation.continuationId, logicalAttempt: attempt } : {}) };
        const continuationRecord = continuing ? structuredClone(this.current(id).interruptedContinuation) : undefined;
        if (continuationRecord) Object.assign(continuationRecord, { status: 'completed', completedAt: Date.now(), jobId: outcome.jobId, sessionRef: outcome.sessionRef, completedHeadSha: candidate.headSha, completedTreeSha: candidate.treeSha });
        this.transitionCandidate(id, 'verifying', { ...candidate, implementation,
          ...(continuationRecord ? { interruptedContinuation: continuationRecord } : {}), activeJob: null }, candidate.operationId); return;
      }
      if (t.status === 'verifying') {
        await this.workspace.assertCandidate(t, signal);
        const checks = await this.verifier.run(t.workspace, service.checks, `${id}-${t.headSha}`, signal);
        await this.workspace.assertCandidate(t, signal);
        this.change(id, ticket => { ticket.verification = { ...checks, headSha: t.headSha, treeSha: t.treeSha, policyDigest: digest(service.checks) }; });
        if (!checks.passed) await this.repair(id, checks); else this.transition(id, 'review_ready');
        return;
      }
      if (t.status === 'review_ready') {
        const candidate = await this.workspace.assertCandidate(t, signal);
        if (candidate.normalized) {
          this.transition(id, 'verifying', { verification: null, review: null }); return;
        }
        const attempt = (t.reviewAttempts ?? 0) + 1;
        this.transition(id, 'reviewing', { reviewAttempts: attempt });
        const requiredExecution = effectiveExecution(t);
        const instructions = `Independently review the exact candidate at HEAD ${t.headSha} against base ${t.baseSha}. You are a fresh reviewer, not the implementer. Read applicable AGENTS.md, inspect the complete diff including tests, and assess acceptance/integration/error handling. Do not edit any file.\n${ticketPrompt(t)}\nController verification passed: ${JSON.stringify(t.verification.results.map(r => r.name))}.\nReturn headSha exactly ${t.headSha}, verdict pass only if no actionable findings, concise summary, and findings with priority/file/line/message. ${requiredExecution ? `For passing review, return checklist with exactly one {id,verdict:"pass",evidence} per required criterion: ${JSON.stringify(requiredExecution.checklist.map(item => item.id))}. Evidence must identify the actual test/assertion or observed artifact establishing the criterion at this candidate; do not infer GUI validation from mocks. ` : ''}Do not invent hypothetical blockers.`;
        const outcome = await this.callAgent('review', t.workspace, path.join(this.root, 'jobs', id, `${t.headSha}-review-${attempt}`), instructions, signal, undefined, { ticketId: id, attempt, source: { headSha: t.headSha, treeSha: t.treeSha, baseSha: t.baseSha } });
        await this.workspace.assertCandidate(t, signal);
        if (outcome.outcome === 'waiting_capacity') { this.transition(id, 'waiting_capacity', { retryAt: outcome.retryAt, resumeStatus: 'review_ready' }); return; }
        if (outcome.sessionRef === t.implementation?.sessionRef || t.implementationSessions?.includes(outcome.sessionRef)) throw new Blocker('review_not_fresh', 'Review reused an implementation session');
        const review = validateReview(outcome.result, t.headSha, requiredExecution);
        this.change(id, ticket => { ticket.review = { ...review, sessionRef: outcome.sessionRef, jobId: outcome.jobId }; });
        if (review.verdict === 'fail') await this.repair(id, review); else this.transition(id, 'publishing');
        return;
      }
      if (['publishing', 'waiting_ci', 'merging'].includes(t.status)) {
        const candidate = await this.workspace.assertCandidate(t, signal);
        if (candidate.normalized) {
          this.transition(id, 'verifying', { verification: null, review: null }); return;
        }
        if (!t.verification?.passed || t.verification.headSha !== t.headSha || t.verification.treeSha !== t.treeSha || t.verification.policyDigest !== digest(service.checks) || t.review?.verdict !== 'pass' || t.review.headSha !== t.headSha) throw new Blocker('missing_evidence', 'Exact candidate verification and fresh review are required');
        // Reconcile delivery BEFORE rebasing an already merged head on restart.
        if (t.publication) {
          const observed = await delivery.inspect(t, service);
          if (observed.state === 'merged') { this.transition(id, 'postmerge', observed); return; }
        }
        const base = await this.workspace.remoteHead(service, signal);
        if (service.delivery.kind === 'local' && base === t.headSha) { this.transition(id, 'postmerge', { mergeSha: t.headSha }); return; }
        if (base !== t.baseSha) { await this.refresh(id, signal); return; }
        if (t.status === 'publishing') {
          const publication = await delivery.publish(t, service, signal);
          this.transition(id, 'waiting_ci', { publication, ciDeadline: Date.now() + this.config.limits.ciTimeoutSeconds * 1000, networkFailures: 0 });
          this.store.update(this.id, () => {}, 'delivery.published', { ticket: id, ...publication });
          await this.onPublication?.(publication); return;
        }
        if (t.status === 'waiting_ci') {
          const gate = await delivery.inspect(t, service);
          if (gate.state === 'pending') {
            if (Date.now() >= t.ciDeadline) throw new Blocker('ci_timeout', 'CI deadline exhausted', gate);
            this.change(id, ticket => { ticket.pollAt = Date.now() + 15000; }); return;
          }
          if (gate.state === 'failed') { await this.repair(id, gate); return; }
          if (gate.state === 'base_moved') { await this.refresh(id, signal); return; }
          if (gate.state !== 'ready') throw new Blocker('delivery_result', 'Unexpected delivery gate result', gate);
          this.transition(id, 'merging', { pollAt: 0 }); return;
        }
        await this.assertActive(signal);
        const merged = await delivery.merge(t, service, signal);
        if (merged.state === 'base_moved') { await this.refresh(id, signal); return; }
        if (merged.state === 'pending') { this.transition(id, 'waiting_ci', { pollAt: Date.now() + 15000 }); return; }
        if (!merged.mergeSha) throw new Blocker('merge_identity', 'Delivery did not establish a merge commit', merged);
        this.transition(id, 'postmerge', merged); return;
      }
      if (t.status === 'postmerge') {
        const directory = path.join(this.root, 'delivered', `${id}-${t.mergeSha}`);
        const identity = await this.workspace.mergeWorkspace(service, t.mergeSha, directory, signal);
        if (identity.treeSha !== t.treeSha) throw new Blocker('merge_identity', 'Delivered tree differs from reviewed candidate');
        await this.verifier.setup(directory, service.setup, `delivered-${id}`, signal);
        const checks = await this.verifier.run(directory, service.checks, `delivered-${id}-${t.mergeSha}`, signal);
        const after = await this.workspace.identity(directory, signal);
        if (!checks.passed || after.dirty || after.headSha !== t.mergeSha) throw new Blocker('postmerge_failed', 'Postmerge verification failed; repository lane halted', checks);
        this.transition(id, 'shipped', { postmerge: { ...checks, headSha: t.mergeSha, treeSha: identity.treeSha },
          ...(t.spec.execution ? { checklistEvidence: { headSha: t.mergeSha, reviewedHeadSha: t.review.headSha, contractDigest: digest(t.spec.execution), items: t.review.checklist, verification: t.verification.results, postmerge: checks.results,
            ...(t.correctionAdmission ? { correctionAdmissionId: t.correctionAdmission.admissionId, correctionDigest: digest({ outcome: t.correctionAdmission.outcome, instructions: t.correctionAdmission.instructions, checklist: t.correctionAdmission.checklist }), correctionChecklist: t.correctionAdmission.checklist } : {}) } } : {}),
          shippedAt: Date.now() }); return;
      }
      throw new Blocker('invalid_state', `Unsupported ticket state ${t.status}`);
    } catch (e) {
      if (e.storeTransactionFailed || e.code === 'producer_unresolved' || producerContext()?.lifecycle?.persistenceFailed) throw e;
      if (e.code === 'paused' || signal?.aborted) return;
      const current = this.current(id);
      if (e.code === 'runtime_failed' && current.status === 'reviewing' && (current.runtimeRetries ?? 0) < this.config.limits.maxRepairs) {
        this.transition(id, 'review_ready', { runtimeRetries: (current.runtimeRetries ?? 0) + 1, activeJob: null }); return;
      }
      if (e.code === 'runtime_failed' && current.repairs < repairCeiling(current, this.config.limits.maxRepairs)) {
        this.transition(id, 'repairing', { repairReason: { code: e.code, message: e.message, detail: e.detail }, activeJob: null }); return;
      }
      if (e.code === 'github_unavailable' && ['publishing', 'waiting_ci', 'merging'].includes(current.status) && (current.networkFailures ?? 0) < 3) {
        this.change(id, ticket => { ticket.networkFailures = (ticket.networkFailures ?? 0) + 1; ticket.pollAt = Date.now() + 15000 * ticket.networkFailures; }); return;
      }
      const blocker = { code: e.code ?? 'unexpected_error', message: e.message, detail: e.detail };
      if (e.code === 'runtime_failed') blocker.role = current.status === 'implementing' ? 'implement' : current.status === 'reviewing' ? 'review' : 'unknown';
      this.transition(id, 'blocked', { blocker, activeJob: null });
    }
  }
  async produceInterruptedImplementation(request, signal) {
    const authorization = this.store.authorizeInterruptedRecovery(this.config, request);
    try {
      const ticket = this.current(request.ticketId), service = this.config.services[ticket.spec.service];
      const before = await this.workspace.identity(ticket.workspace, signal);
      if (before.headSha !== ticket.beforeAgentHead || !before.dirty ||
          (ticket.headSha != null && (before.headSha !== ticket.headSha || before.treeSha !== ticket.treeSha))) {
        throw new Blocker('partial_recovery_identity_mismatch', 'Workspace must contain dirty partial work on the exact pre-implementation head', before);
      }
      const candidate = await this.workspace.checkpoint(ticket, service, signal,
        this.checkpointJournal(ticket, 'partial_recovery', { recoveryId: authorization.recoveryId }));
      this.store.completeInterruptedRecovery(this.id, request.ticketId, authorization.recoveryId, candidate, before, candidate.operationId);
      const recovered = this.current(request.ticketId);
      return { recovered: true, project: this.id, ticket: request.ticketId, recoveryId: authorization.recoveryId,
        status: recovered.status, workspace: recovered.workspace, baseSha: recovered.baseSha,
        beforeAgentHead: recovered.beforeAgentHead, headSha: recovered.headSha, treeSha: recovered.treeSha,
        files: candidate.files };
    } catch (error) {
      if (error.storeTransactionFailed || producerContext()?.lifecycle?.persistenceFailed) throw error;
      this.store.failInterruptedRecovery(this.id, request.ticketId, authorization.recoveryId, error);
      throw error;
    }
  }
  async finishInterruptedCandidateVerification(ticketId, recoveryId, signal) {
    const ticket = this.current(ticketId), record = ticket?.interruptedCandidateVerification;
    if (!ticket || ticket.status !== 'recovering_candidate' || record?.recoveryId !== recoveryId || record.status !== 'authorized') {
      throw new Blocker('interrupted_candidate_state_mismatch', 'Interrupted-candidate checkpoint authorization is missing or already settled');
    }
    try {
      const service = this.config.services[ticket.spec.service], before = await this.workspace.identity(ticket.workspace, signal);
      if (before.headSha !== record.evidence.beforeAgentHead || before.treeSha !== record.evidence.priorCandidate.treeSha || !before.dirty) {
        throw new Blocker('interrupted_candidate_identity_mismatch', 'Workspace must retain dirty partial work on the exact pre-agent head and tree', before);
      }
      const candidate = await this.workspace.checkpoint(ticket, service, signal,
        this.checkpointJournal(ticket, 'interrupted_candidate_verification', { recoveryId }));
      this.store.completeInterruptedCandidateVerification(this.id, ticket.spec.id, recoveryId, candidate, before, candidate.operationId);
      const checked = this.current(ticketId);
      return { checkpointed: true, project: this.id, ticket: ticket.spec.id, recoveryId, status: checked.status,
        workspace: checked.workspace, baseSha: checked.baseSha, priorHeadSha: before.headSha, priorTreeSha: before.treeSha,
        headSha: checked.headSha, treeSha: checked.treeSha, files: candidate.files, implementationCompleted: false };
    } catch (error) {
      if (error.storeTransactionFailed || producerContext()?.lifecycle?.persistenceFailed) throw error;
      this.store.failInterruptedCandidateVerification(this.id, ticket.spec.id, recoveryId, error);
      throw error;
    }
  }
  async produceInterruptedCandidateVerification(request, signal) {
    const authorization = this.store.authorizeInterruptedCandidateVerification(this.config, request);
    return this.finishInterruptedCandidateVerification(request.ticketId, authorization.recoveryId, signal);
  }
  async produceAcceptance(signal) {
    for (const [name, service] of Object.entries(this.config.services)) {
      await this.assertActive(signal);
      const saved = this.store.get(this.id).acceptance[name];
      const headSha = await this.workspace.remoteHead(service, signal);
      if (saved?.status === 'passed' && saved.headSha === headSha) continue;
      const directory = path.join(this.root, 'acceptance', `${name}-${headSha}`);
      await this.workspace.mergeWorkspace(service, headSha, directory, signal);
      await this.verifier.setup(directory, service.setup, `acceptance-${name}`, signal);
      const checks = await this.verifier.run(directory, [...service.checks, ...(service.acceptance ?? [])], `acceptance-${name}-${headSha}`, signal);
      const identity = await this.workspace.identity(directory, signal);
      const passed = checks.passed && !identity.dirty && identity.headSha === headSha;
      this.store.update(this.id, s => { s.acceptance[name] = { ...checks, status: passed ? 'passed' : 'failed', headSha }; }, 'project.acceptance', { service: name, passed, headSha });
      if (!passed) throw new Blocker('project_acceptance', `Integrated acceptance failed for ${name}`, checks);
    }
    for (const [name, service] of Object.entries(this.config.services)) {
      if (await this.workspace.remoteHead(service, signal) !== this.store.get(this.id).acceptance[name].headSha) throw new Blocker('acceptance_base_moved', `Service ${name} changed during integrated acceptance; retry with fresh evidence`);
    }
    this.store.update(this.id, s => { s.status = 'completed'; s.completedAt = Date.now(); s.blocker = null; }, 'project.completed', {}, producerContext().scopeId);
  }
}
