import path from "node:path";
import { canonicalJson, parseBoundedJson } from "./bounded-json.js";
import { decodeCohortDocument, validateCohortDocument, type CohortRequest, type CohortRun, type EvidenceSource, type EvidenceImport, type TrustRoots, type SquireManifest, type DispositionManifest } from "./cohort-schema.js";
import { disposition, verifyEvidence, validateTrustRoots, type Disposition, type VerifiedImport } from "./disposition-evidence.js";
import { readPrivateArtifact, publishCohort, sha256 } from "./private-artifact-store.js";
import { ACCOUNTING_FIELDS, backfillSession, measure, sumAccounting, unknownAccounting, type Accounting, type Measure } from "./historical-telemetry.js";
import { validateRunTelemetry, type RunTelemetry } from "./telemetry-store.js";
import { decimalText, decimalUnits, TOKEN_FIELDS, recordedCostUnits } from "./telemetry-stream.js";

export interface CohortOptions { dataDirectory: string; repository: string; controllerTelemetryRoot: string; }
export interface SourceReceipt { identity: string; sha256: string; observed: boolean; status: "supported" | "unknown"; reason: "available" | "unavailable_or_invalid"; }
export interface CohortSession {
  sessionId: string; phase: string; profile: string; outcome: string;
  authority: "pi-0.84.4-controller-json-v1" | "provisional-pi-0.84.4-session-v3" | "unknown";
  sourceDigest: string; accounting: Accounting; endedAt: string | null;
  classification: "report" | "infrastructure" | "code" | "none" | "unknown";
  classificationEvidence: string[];
}
export interface NormalizedRun {
  descriptor: Omit<CohortRun, "sessions" | "telemetry" | "disposition" | "squire">;
  accounting: Accounting; sessions: CohortSession[]; inventoryComplete: boolean;
  completion: "completed" | "failed" | "interrupted" | "unknown";
  reservedAt: string | null; endedAt: string | null; disposition: Disposition;
  squire: SquireManifest | null; squireDigest: string | null;
  sources: SourceReceipt[]; diagnostics: string[];
}
export interface TicketScore {
  ticket: string; repository: string; period: "pre" | "post"; gateClass: string;
  strata: CohortRun["strata"][]; runIds: string[]; evidenceRefs: string[];
  inventoryComplete: boolean; merge: "merged" | "unmerged" | "unknown";
  mergedAt: string | null; reopened: boolean | null; completion: string;
  enteredImplement: boolean | null; firstPass: boolean | null;
  exactHeadCi: "passed" | "failed" | "unknown"; freshRuns: number;
  remediationAttempts: Measure<number>; wallMs: number | null;
  unmergedAttempts: { runs: number; accounting: Accounting }; unknownDispositionAttempts: { runs: number; accounting: Accounting };
  accounting: Accounting; afterMergeAccounting: Accounting;
  reportWaste: Accounting; infrastructureWaste: Accounting; unknownWaste: Accounting;
}
export interface ScoreMetrics {
  tickets: number; mergedTickets: number; unmergedTickets: number; unknownMergeTickets: number;
  firstPassAcceptance: { numerator: number; denominator: number; unknownDenominator: number; unknownNumerator: number; complete: boolean };
  exactHeadCi: { passed: number; failed: number; unknown: number };
  completion: { completed: number; other: number; unknown: number };
  reopened: { yes: number; no: number; unknown: number };
  freshRuns: { merged: number; unmerged: number; unknown: number; perMergedTicket: Ratio<number> };
  unmergedAttempts: { runs: number; accounting: Accounting }; unknownDispositionAttempts: { runs: number; accounting: Accounting };
  remediationAttempts: Measure<number>; costPerMergedTicket: Ratio<string>; wallMsPerMergedTicket: Ratio<number>;
  activeMsPerMergedTicket: Ratio<number>; unmergedAccounting: Accounting; unknownMergeAccounting: Accounting;
  reportWaste: Accounting; infrastructureWaste: Accounting; unknownWaste: Accounting;
}
/** Exact ratio, not a rounded floating-point dollar estimate. */
export interface Ratio<T> { numerator: T; denominator: number; complete: boolean; }
export interface CohortScorecard {
  schemaVersion: 1; ruleVersion: 1; cohortId: string; requestDigest: string; trustRootsDigest: string;
  optimizationMergeSha: string; interpretation: "descriptive_only_no_causal_claims";
  caveats: string[]; runs: NormalizedRun[]; tickets: TicketScore[];
  accounting: Accounting; sources: SourceReceipt[];
  reconciliation: { runs: Measure<number>; tickets: Measure<number>; sources: Measure<number> };
  groups: { gateClass: string; strata: CohortRun["strata"][]; period: "pre" | "post"; metrics: ScoreMetrics; accounting: Accounting }[];
  comparisons: { preGroup: number; postGroup: number; strataDiffer: boolean; deltas: Record<string, { numerator: string; denominator: number } | null> }[];
  phaseProfileOutcome: { phase: string; profile: string; outcome: string; authority: string; accounting: Accounting }[];
  baseline: { sourceDigest: string; authority: "provisional_operator_extraction"; fields: { field: string; expected: string | null; observed: string; variance: string | null; complete: boolean; reason: string }[] } | null;
}
function assert(v: unknown): asserts v { if (!v) throw new Error("conflicting or invalid cohort bindings"); }
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function safeNumber(n: number): number { assert(Number.isSafeInteger(n)); return n; }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function sumMeasure(rows: Measure<number>[]): Measure<number> {
  return measure(safeNumber(rows.reduce((s, r) => s + r.known, 0)), rows.reduce((s, r) => s + r.expected, 0), rows.reduce((s, r) => s + r.observed, 0), rows.reduce((s, r) => s + r.supported, 0), rows.reduce((s, r) => s + r.excluded, 0));
}
function gateClass(r: CohortRun | NormalizedRun["descriptor"]): string {
  return canonicalJson({ repository: r.repository, requiredCheckSet: { identity: r.requiredCheckSet.identity, names: [...r.requiredCheckSet.names].sort() }, ticketClass: r.strata.ticketClass, review: r.strata.reviewGate, test: r.strata.testGate, publication: r.strata.publicationGate });
}
function canonicalRequest(request: CohortRequest): CohortRequest {
  const v = structuredClone(validateCohortDocument<CohortRequest>("request", request));
  v.runs.sort((a, b) => compareText(a.runId, b.runId));
  for (const r of v.runs) {
    r.sessions.sort((a, b) => compareText(a.sessionId, b.sessionId)); r.requiredCheckSet.names.sort(); r.strata.profiles.sort();
  }
  v.baseline?.runIds.sort();
  return v;
}
/** Explicit bounded assembly. Only this host API performs I/O; no providers,
 * models, workflow transitions, repository writes, or network clients exist here. */
export async function assembleCohort(input: CohortRequest, rootsInput: TrustRoots, options: CohortOptions): Promise<CohortScorecard> {
  const request = canonicalRequest(input), roots = validateTrustRoots(rootsInput);
  const sources = new Map<string, SourceReceipt>(), sourceBindings = new Map<string, string>(), sessionIds = new Set<string>(), responseIds = new Set<string>();
  let totalBytes = 0, reads = 0;
  const read = async (source: EvidenceSource): Promise<Buffer | undefined> => {
    // Source identities cannot silently bind different artifacts. Paths never
    // leave the private request; receipts contain only typed identities/digests.
    const binding = canonicalJson({ path: path.resolve(source.path), sha256: source.sha256 });
    assert(!sourceBindings.has(source.identity) || sourceBindings.get(source.identity) === binding);
    sourceBindings.set(source.identity, binding); assert(++reads <= 2048 && totalBytes <= 256 * 1024 * 1024);
    try {
      const relative = path.relative(path.resolve(options.dataDirectory), path.resolve(source.path));
      assert(relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
      const bytes = await readPrivateArtifact(source.path, options.repository, Math.min(64 * 1024 * 1024, 256 * 1024 * 1024 - totalBytes)); totalBytes += bytes.length;
      assert(sha256(bytes) === source.sha256);
      if (!sources.has(source.identity)) sources.set(source.identity, { identity: source.identity, sha256: source.sha256, observed: true, status: "supported", reason: "available" }); return bytes;
    } catch {
      sources.set(source.identity, { identity: source.identity, sha256: source.sha256, observed: false, status: "unknown", reason: "unavailable_or_invalid" }); return undefined;
    }
  };
  const unsupported = (source: EvidenceSource) => {
    const receipt = sources.get(source.identity)!;
    sources.set(source.identity, { ...receipt, status: "unknown", reason: "unavailable_or_invalid" });
  };
  const importEvidence = async <T extends DispositionManifest | SquireManifest>(kind: T["kind"], ref: EvidenceImport | null, run: CohortRun): Promise<VerifiedImport<T>> => {
    if (!ref) return { status: "unknown", diagnostic: "missing_evidence" };
    const bytes = await read(ref.manifest), envelope = ref.envelope ? await read(ref.envelope) : undefined;
    const result = verifyEvidence<T>(kind, bytes, envelope, roots, run);
    if (result.status === "unknown") { unsupported(ref.manifest); if (ref.envelope) unsupported(ref.envelope); }
    return result;
  };
  assert(new Set(request.runs.map(r => r.runId)).size === request.runs.length);
  const normalized: NormalizedRun[] = [];
  for (const r of request.runs) {
    assert(!r.telemetry || r.sessions.length === 0); // Never double-count a session via two authorities.
    const sessions: CohortSession[] = [], diagnostics: string[] = [], runSources: EvidenceSource[] = [];
    let telemetry: RunTelemetry | undefined;
    if (r.telemetry) {
      runSources.push(r.telemetry);
      // Controller authority requires the established exact-run location, not
      // merely an operator file containing an authority-looking string.
      assert(path.resolve(r.telemetry.path) === path.resolve(options.controllerTelemetryRoot, r.runId, "summary.json"));
      const bytes = await read(r.telemetry);
      try {
        const value = bytes && parseBoundedJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), { maxBytes: 2 * 1024 * 1024, safeIntegers: true });
        validateRunTelemetry(value, r.runId); telemetry = value;
        for (const s of value.sessions) {
          const a = unknownAccounting();
          for (const f of TOKEN_FIELDS) a[f] = measure(s.usage.tokens[f] ?? 0, 1, s.usage.tokens[f] === null ? 0 : 1, s.usage.tokens[f] === null ? 0 : 1);
          a.recordedCost = measure(s.usage.recordedCost ?? "0", 1, s.usage.recordedCost === null ? 0 : 1, s.usage.recordedCost === null ? 0 : 1);
          a.durationMs = measure(s.durationMs ?? 0, 1, s.durationMs === null ? 0 : 1, s.durationMs === null ? 0 : 1);
          a.messages = measure(s.usage.messages, 1, 1, s.streamDigest === null ? 0 : 1);
          sessions.push({ sessionId: s.sessionId, phase: s.phase, profile: `${s.profile.provider}/${s.profile.model}/${s.profile.thinking}`, outcome: s.outcome, authority: value.authority, sourceDigest: r.telemetry.sha256, accounting: a, endedAt: s.endedAt, classification: "unknown", classificationEvidence: [] });
        }
      } catch { diagnostics.push("invalid_controller_telemetry"); unsupported(r.telemetry); }
    } else {
      for (const source of r.sessions) {
        runSources.push(source.source);
        const bytes = await read(source.source), result = bytes ? backfillSession(bytes, source) : undefined;
        if (!result || result.diagnostic) diagnostics.push(result?.diagnostic ?? "unavailable_source");
        if (result?.diagnostic === "invalid_source") unsupported(source.source);
        for (const identity of result?.recordIdentities ?? []) { assert(!responseIds.has(identity)); responseIds.add(identity); }
        sessions.push({ sessionId: source.sessionId, phase: source.phase, profile: `${source.profile.provider}/${source.profile.model}/${source.profile.thinking}`, outcome: "unknown", authority: result?.authority ?? "unknown", sourceDigest: source.source.sha256, accounting: result?.accounting ?? unknownAccounting(), endedAt: null, classification: "unknown", classificationEvidence: [] });
      }
    }
    for (const session of sessions) { assert(r.strata.profiles.includes(session.profile)); assert(!sessionIds.has(session.sessionId)); sessionIds.add(session.sessionId); }
    assert(sessionIds.size <= 2048);
    const imported = await importEvidence<DispositionManifest>("disposition", r.disposition, r);
    const sq = await importEvidence<SquireManifest>("squire", r.squire, r);
    const squire = sq.status === "verified" ? sq.manifest : null;
    const disp = disposition(imported);
    if (sq.status === "unknown") diagnostics.push(`squire_${sq.diagnostic}`);
    if (disp.diagnostic) diagnostics.push(`disposition_${disp.diagnostic}`);
    if (squire && telemetry) assert(squire.completion === "unknown" || squire.completion === telemetry.outcome);
    for (const ref of [r.disposition, r.squire]) if (ref) { runSources.push(ref.manifest); if (ref.envelope) runSources.push(ref.envelope); }
    for (const classification of squire?.classifications ?? []) {
      const session = sessions.find(s => s.sessionId === classification.sessionId);
      if (session && classification.evidenceRefs.includes(session.sourceDigest)) { session.classification = classification.kind; session.classificationEvidence = [sq.status === "verified" ? sq.digest : "", ...classification.evidenceRefs]; }
      else diagnostics.push("unbound_classification");
    }
    const sessionInventoryMatches = squire !== null && canonicalJson([...squire.accountedSessions].sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)) === canonicalJson(sessions.map(s => ({ sessionId: s.sessionId, sourceDigest: s.sourceDigest })).sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
    if (squire?.inventoryComplete && !sessionInventoryMatches) diagnostics.push("inventory_binding_mismatch");
    const inventoryComplete = telemetry?.inventoryComplete ?? (squire?.inventoryComplete === true && sessionInventoryMatches);
    const accounting = sumAccounting([...sessions.map(s => s.accounting), ...(!inventoryComplete || !sessions.length ? [unknownAccounting()] : [])]);
    const { sessions: _sessions, telemetry: _telemetry, disposition: _disposition, squire: _squire, ...descriptor } = r;
    normalized.push({ descriptor, accounting, sessions, inventoryComplete, completion: telemetry?.outcome ?? squire?.completion ?? "unknown", reservedAt: squire?.reservedAt ?? telemetry?.startedAt ?? null, endedAt: telemetry?.endedAt ?? squire?.endedAt ?? null, disposition: disp, squire, squireDigest: sq.status === "verified" ? sq.digest : null, sources: unique(runSources.map(s => s.identity)).sort().map(id => sources.get(id)!), diagnostics: unique(diagnostics).sort() });
  }
  const tickets = unique(normalized.map(r => `${r.descriptor.repository}#${r.descriptor.ticket}`)).sort().map(key => scoreTicket(normalized.filter(r => `${r.descriptor.repository}#${r.descriptor.ticket}` === key)));
  const groupMap = new Map<string, TicketScore[]>();
  for (const t of tickets) { const key = canonicalJson({ gateClass: t.gateClass, strata: t.strata, period: t.period }); groupMap.set(key, [...(groupMap.get(key) ?? []), t]); }
  const groups = [...groupMap.entries()].sort(([a], [b]) => compareText(a, b)).map(([, ts]) => ({ gateClass: ts[0]!.gateClass, strata: ts[0]!.strata, period: ts[0]!.period, metrics: scoreMetrics(ts), accounting: sumAccounting(ts.map(t => t.accounting)) }));
  const phaseMap = new Map<string, { phase: string; profile: string; outcome: string; authority: string; rows: Accounting[] }>();
  const addPhase = (identity: { phase: string; profile: string; outcome: string; authority: string }, accounting: Accounting) => {
    const key = canonicalJson(identity);
    const group = phaseMap.get(key) ?? { ...identity, rows: [] }; group.rows.push(accounting); phaseMap.set(key, group);
  };
  for (const r of normalized) {
    for (const s of r.sessions) addPhase({ phase: s.phase, profile: s.profile, outcome: s.outcome, authority: s.authority }, s.accounting);
    if (!r.inventoryComplete || !r.sessions.length) addPhase({ phase: "unknown", profile: "unknown", outcome: "unknown", authority: "unknown" }, unknownAccounting());
  }
  const baseline = request.baseline ? await reconcileBaseline(request, normalized, await read(request.baseline.source)) : null;
  const receipts = [...sources.values()].sort((a, b) => compareText(a.identity, b.identity));
  return { schemaVersion: 1, ruleVersion: 1, cohortId: request.cohortId, requestDigest: sha256(canonicalJson(request)), trustRootsDigest: sha256(canonicalJson(roots)), optimizationMergeSha: request.optimizationMergeSha, interpretation: "descriptive_only_no_causal_claims", caveats: ["explicit_inventory_only", "small_samples_descriptive", "unlike_strata_not_pooled", "historical_usage_is_provisional", "missing_values_are_unknown", "ratios_are_exact_numerator_denominator"], runs: normalized, tickets, accounting: sumAccounting(normalized.map(r => r.accounting)), sources: receipts,
    comparisons: compareGroups(groups),
    reconciliation: { runs: measure(normalized.length, request.runs.length, normalized.length, normalized.filter(r => r.inventoryComplete).length), tickets: measure(tickets.length, tickets.length, tickets.length, tickets.filter(t => t.inventoryComplete).length), sources: measure(receipts.length, receipts.length, receipts.filter(r => r.observed).length, receipts.filter(r => r.status === "supported").length) }, groups,
    phaseProfileOutcome: [...phaseMap.entries()].sort(([a], [b]) => compareText(a, b)).map(([, group]) => ({ phase: group.phase, profile: group.profile, outcome: group.outcome, authority: group.authority, accounting: sumAccounting(group.rows) })), baseline };
}
function scoreTicket(runs: NormalizedRun[]): TicketScore {
  const first = runs[0]!;
  assert(runs.every(r => r.descriptor.period === first.descriptor.period && gateClass(r.descriptor) === gateClass(first.descriptor)));
  const ordered = [...runs].sort((a, b) => compareText(a.reservedAt ?? "z", b.reservedAt ?? "z") || compareText(a.descriptor.runId, b.descriptor.runId));
  const runIds = runs.map(r => r.descriptor.runId).sort();
  const inventoryComplete = runs.every(r => r.inventoryComplete && r.squire?.inventoryComplete && canonicalJson([...r.squire.reservedRunIds].sort()) === canonicalJson(runIds));
  const merged = runs.filter(r => r.disposition.merge === "merged");
  assert(unique(merged.map(r => `${r.disposition.mergeSha}/${r.disposition.mergedAt}`)).length <= 1);
  const mergedAt = merged[0]?.disposition.mergedAt ?? null;
  if (mergedAt) assert(runs.every(r => !r.reservedAt || r.reservedAt <= mergedAt || r.disposition.merge !== "merged"));
  const merge = merged.length ? "merged" : runs.every(r => r.disposition.merge === "unmerged") ? "unmerged" : "unknown";
  const included = runs.filter(r => !mergedAt || !r.reservedAt || r.reservedAt <= mergedAt);
  const includedAccounting = sumAccounting(included.map(r => {
    if (!mergedAt) return r.accounting;
    const crossing = r.sessions.some(s => s.endedAt && s.endedAt > mergedAt);
    if (r.endedAt && r.endedAt <= mergedAt && !crossing) return r.accounting;
    // Retain supported costs without inventing the unavailable time cutoff.
    return sumAccounting([unknownAccounting(), ...r.sessions.filter(s => !s.endedAt || s.endedAt <= mergedAt).map(s => s.accounting)]);
  }));
  if (!inventoryComplete) for (const f of ACCOUNTING_FIELDS) { includedAccounting[f].expected++; includedAccounting[f].unknown++; includedAccounting[f].complete = false; }
  const after = runs.flatMap(r => mergedAt ? r.sessions.filter(s => (r.reservedAt && r.reservedAt > mergedAt) || (s.endedAt && s.endedAt > mergedAt)).map(s => s.accounting) : []);
  const entry = ordered.find(r => r.squire?.enteredImplement === true), candidate = entry?.squire?.firstCandidate;
  const enteredImplement = entry ? true : runs.every(r => r.squire?.enteredImplement === false) ? false : null;
  let firstPass: boolean | null = null;
  if (inventoryComplete && enteredImplement && candidate && runs.every(r => r.reservedAt !== null && r.squire?.enteredImplement != null)) {
    if (candidate.implementOrdinal === 1) {
      if (candidate.reviewAttempt !== 1 || candidate.testAttempt !== 1 || candidate.review === "failed" || candidate.test === "failed") firstPass = false;
      else if (candidate.sha === entry!.descriptor.candidateSha && candidate.review === "passed" && candidate.test === "passed" && entry!.disposition.ci !== "unknown") firstPass = entry!.disposition.ci === "passed";
    }
  }
  const end = mergedAt ? Date.parse(mergedAt) : null, start = ordered[0]?.reservedAt;
  const wallMs = inventoryComplete && runs.every(r => r.reservedAt !== null) && end !== null && start && end >= Date.parse(start) ? end - Date.parse(start) : null;
  const zero = (): Accounting => {
    const a = unknownAccounting();
    for (const field of ACCOUNTING_FIELDS) Object.assign(a, { [field]: measure(field === "recordedCost" ? "0" : 0, 1, 1, 1) });
    return a;
  };
  const waste = (kind: CohortSession["classification"]) => sumAccounting(runs.flatMap(r => [
    ...r.sessions.map(s => s.classification === kind ? s.accounting : s.classification === "unknown" ? unknownAccounting() : zero()),
    ...(!r.inventoryComplete || !r.sessions.length ? [unknownAccounting()] : []),
  ]));
  const reopened = runs.some(r => r.disposition.reopened === true) ? true : runs.every(r => r.disposition.reopened === false) ? false : null;
  const strata = unique(runs.map(r => canonicalJson(r.descriptor.strata))).sort().map(s => JSON.parse(s) as CohortRun["strata"]);
  const last = merged[0] ?? ordered.at(-1)!;
  return { ticket: first.descriptor.ticket, repository: first.descriptor.repository, period: first.descriptor.period, gateClass: gateClass(first.descriptor), strata, runIds, evidenceRefs: unique(runs.flatMap(r => [...r.sources.map(s => s.sha256), ...(r.squireDigest ? [r.squireDigest] : [])])).sort(), inventoryComplete, merge, mergedAt, reopened, completion: last.completion, enteredImplement, firstPass, exactHeadCi: last.disposition.ci, freshRuns: runs.length,
    remediationAttempts: sumMeasure(runs.map(r => measure(r.squire?.remediationAttempts ?? 0, 1, r.squire?.remediationAttempts == null ? 0 : 1, r.squire?.remediationAttempts == null ? 0 : 1))), wallMs, unmergedAttempts: { runs: runs.filter(r => r.disposition.merge === "unmerged").length, accounting: sumAccounting(runs.filter(r => r.disposition.merge === "unmerged").map(r => r.accounting)) }, unknownDispositionAttempts: { runs: runs.filter(r => r.disposition.merge === "unknown").length, accounting: sumAccounting(runs.filter(r => r.disposition.merge === "unknown").map(r => r.accounting)) }, accounting: includedAccounting, afterMergeAccounting: sumAccounting(after), reportWaste: waste("report"), infrastructureWaste: waste("infrastructure"), unknownWaste: waste("unknown") };
}
function scoreMetrics(tickets: TicketScore[]): ScoreMetrics {
  const merged = tickets.filter(t => t.merge === "merged"), unmerged = tickets.filter(t => t.merge === "unmerged"), unknown = tickets.filter(t => t.merge === "unknown");
  const costs = sumAccounting(merged.map(t => t.accounting));
  const first = tickets.filter(t => t.enteredImplement === true), missingEntry = tickets.filter(t => t.enteredImplement === null).length, missingFirst = first.filter(t => t.firstPass === null).length;
  const fresh = (ts: TicketScore[]) => ts.reduce((s, t) => s + t.freshRuns, 0);
  const ratio = <T>(n: T, complete: boolean): Ratio<T> => ({ numerator: n, denominator: merged.length, complete: complete && merged.length > 0 });
  return { tickets: tickets.length, mergedTickets: merged.length, unmergedTickets: unmerged.length, unknownMergeTickets: unknown.length,
    firstPassAcceptance: { numerator: first.filter(t => t.firstPass === true).length, denominator: first.length, unknownDenominator: missingEntry, unknownNumerator: missingFirst, complete: first.length > 0 && !missingEntry && !missingFirst },
    exactHeadCi: { passed: tickets.filter(t => t.exactHeadCi === "passed").length, failed: tickets.filter(t => t.exactHeadCi === "failed").length, unknown: tickets.filter(t => t.exactHeadCi === "unknown").length },
    completion: { completed: tickets.filter(t => t.completion === "completed").length, other: tickets.filter(t => ["failed", "interrupted"].includes(t.completion)).length, unknown: tickets.filter(t => t.completion === "unknown").length },
    reopened: { yes: tickets.filter(t => t.reopened === true).length, no: tickets.filter(t => t.reopened === false).length, unknown: tickets.filter(t => t.reopened === null).length },
    freshRuns: { merged: fresh(merged), unmerged: fresh(unmerged), unknown: fresh(unknown), perMergedTicket: ratio(fresh(merged), merged.every(t => t.inventoryComplete)) },
    unmergedAttempts: { runs: tickets.reduce((s, t) => s + t.unmergedAttempts.runs, 0), accounting: sumAccounting(tickets.map(t => t.unmergedAttempts.accounting)) }, unknownDispositionAttempts: { runs: tickets.reduce((s, t) => s + t.unknownDispositionAttempts.runs, 0), accounting: sumAccounting(tickets.map(t => t.unknownDispositionAttempts.accounting)) },
    remediationAttempts: sumMeasure(tickets.map(t => t.remediationAttempts)), costPerMergedTicket: ratio(costs.recordedCost.known, costs.recordedCost.complete), wallMsPerMergedTicket: ratio(safeNumber(merged.reduce((s, t) => s + (t.wallMs ?? 0), 0)), merged.every(t => t.wallMs !== null)), activeMsPerMergedTicket: ratio(costs.durationMs.known, costs.durationMs.complete), unmergedAccounting: sumAccounting(unmerged.map(t => t.accounting)), unknownMergeAccounting: sumAccounting(unknown.map(t => t.accounting)), reportWaste: sumAccounting(tickets.map(t => t.reportWaste)), infrastructureWaste: sumAccounting(tickets.map(t => t.infrastructureWaste)), unknownWaste: sumAccounting(tickets.map(t => t.unknownWaste)) };
}
/** Pairwise same-gate comparisons retain both complete stratum identities. No
 * global pooling, significance estimate, or causal interpretation is produced. */
function compareGroups(groups: CohortScorecard["groups"]): CohortScorecard["comparisons"] {
  const out: CohortScorecard["comparisons"] = [];
  const delta = (pre: Ratio<string | number>, post: Ratio<string | number>) => {
    if (!pre.complete || !post.complete || !pre.denominator || !post.denominator) return null;
    const units = decimalUnits(String(post.numerator)) * BigInt(pre.denominator) - decimalUnits(String(pre.numerator)) * BigInt(post.denominator);
    return { numerator: units < 0n ? `-${decimalText(-units)}` : decimalText(units), denominator: safeNumber(pre.denominator * post.denominator) };
  };
  const ratios = (g: CohortScorecard["groups"][number]): Record<string, Ratio<string | number>> => {
    const m = g.metrics, a = g.accounting;
    return {
      firstPassAcceptance: { numerator: m.firstPassAcceptance.numerator, denominator: m.firstPassAcceptance.denominator, complete: m.firstPassAcceptance.complete },
      exactHeadCi: { numerator: m.exactHeadCi.passed, denominator: m.tickets, complete: m.exactHeadCi.unknown === 0 },
      merge: { numerator: m.mergedTickets, denominator: m.tickets, complete: m.unknownMergeTickets === 0 },
      reopen: { numerator: m.reopened.yes, denominator: m.tickets, complete: m.reopened.unknown === 0 },
      costPerMergedTicket: m.costPerMergedTicket, wallMsPerMergedTicket: m.wallMsPerMergedTicket, activeMsPerMergedTicket: m.activeMsPerMergedTicket,
      freshRunsPerMergedTicket: m.freshRuns.perMergedTicket,
      remediationAttemptsPerTicket: { numerator: m.remediationAttempts.known, denominator: m.tickets, complete: m.remediationAttempts.complete },
      reportWasteCostPerTicket: { numerator: m.reportWaste.recordedCost.known, denominator: m.tickets, complete: m.reportWaste.recordedCost.complete },
      reportWasteMsPerTicket: { numerator: m.reportWaste.durationMs.known, denominator: m.tickets, complete: m.reportWaste.durationMs.complete },
      infrastructureWasteCostPerTicket: { numerator: m.infrastructureWaste.recordedCost.known, denominator: m.tickets, complete: m.infrastructureWaste.recordedCost.complete },
      infrastructureWasteMsPerTicket: { numerator: m.infrastructureWaste.durationMs.known, denominator: m.tickets, complete: m.infrastructureWaste.durationMs.complete },
      costAccountingCompleteness: { numerator: a.recordedCost.supported, denominator: a.recordedCost.expected, complete: true },
    };
  };
  for (let i = 0; i < groups.length; i++) for (let j = 0; j < groups.length; j++) {
    const pre = groups[i]!, post = groups[j]!;
    if (pre.period !== "pre" || post.period !== "post" || pre.gateClass !== post.gateClass) continue;
    assert(out.length < 1024);
    const p = ratios(pre), q = ratios(post);
    out.push({ preGroup: i, postGroup: j, strataDiffer: canonicalJson(pre.strata) !== canonicalJson(post.strata), deltas: Object.fromEntries(Object.keys(p).map(k => [k, delta(p[k]!, q[k]!)])) });
  }
  return out;
}
async function reconcileBaseline(request: CohortRequest, runs: NormalizedRun[], bytes: Buffer | undefined): Promise<NonNullable<CohortScorecard["baseline"]>> {
  const baseline = request.baseline!; assert(baseline.runIds.every(id => runs.some(r => r.descriptor.runId === id && r.descriptor.period === "pre")));
  const accounting = sumAccounting(runs.filter(r => baseline.runIds.includes(r.descriptor.runId)).map(r => r.accounting));
  let value: unknown;
  try { value = bytes && parseBoundedJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), { maxBytes: 2 * 1024 * 1024, canonicalNumbers: true }); } catch { value = undefined; }
  const fields = Object.entries(baseline.fields).sort(([a], [b]) => compareText(a, b)).map(([field, pointer]) => {
    let expected: string | null = null;
    try {
      let v = value;
      for (const key of pointer.slice(1).split("/")) {
        const decoded = key.replace(/~1/gu, "/").replace(/~0/gu, "~");
        assert(v !== null && typeof v === "object" && Object.hasOwn(v, decoded)); v = (v as Record<string, unknown>)[decoded];
      }
      if (field === "recordedCost") { expected = typeof v === "string" ? decimalText(decimalUnits(v)) : decimalText(recordedCostUnits(v)); }
      else { assert(typeof v === "number" && Number.isSafeInteger(v) && v >= 0); expected = String(v); }
    } catch { expected = null; }
    const m = accounting[field as keyof Accounting], observed = String(m.known);
    const e = expected === null ? null : decimalUnits(expected), o = decimalUnits(observed);
    const variance = e === null ? null : o >= e ? decimalText(o - e) : `-${decimalText(e - o)}`;
    return { field, expected, observed, variance, complete: m.complete && expected !== null, reason: expected === null ? "baseline_field_unavailable" : !m.complete ? "incomplete_or_unsupported_sources" : variance === "0" ? "matched" : "structured_usage_differs_from_operator_extraction" };
  });
  return { sourceDigest: baseline.source.sha256, authority: "provisional_operator_extraction", fields };
}
export async function runCohort(requestFile: string, trustRootsFile: string, options: CohortOptions): Promise<{ schemaVersion: 1; artifactDigest: string; manifestDigest: string; path: string }> {
  const requestBytes = await readPrivateArtifact(requestFile, options.repository, 2 * 1024 * 1024), rootBytes = await readPrivateArtifact(trustRootsFile, options.repository, 2 * 1024 * 1024);
  const request = decodeCohortDocument<CohortRequest>("request", requestBytes), roots = decodeCohortDocument<TrustRoots>("trustRoots", rootBytes);
  const artifact = await assembleCohort(request, roots, options), artifactBytes = canonicalJson(artifact), artifactDigest = sha256(artifactBytes);
  const manifest = { schemaVersion: 1, artifactDigest, requestDigest: artifact.requestDigest, trustRootsDigest: artifact.trustRootsDigest, requestBytesDigest: sha256(requestBytes), trustRootsBytesDigest: sha256(rootBytes), sources: artifact.sources };
  const manifestDigest = sha256(canonicalJson(manifest));
  validateCohortDocument("scorecard", artifact);
  const bytes = Buffer.from(canonicalJson({ schemaVersion: 1, manifest, manifestDigest, artifact }));
  const file = await publishCohort(options.dataDirectory, options.repository, sha256(canonicalJson({ requestDigest: artifact.requestDigest, trustRootsDigest: artifact.trustRootsDigest, requestBytesDigest: manifest.requestBytesDigest, trustRootsBytesDigest: manifest.trustRootsBytesDigest })), bytes);
  return { schemaVersion: 1, artifactDigest, manifestDigest, path: file };
}
