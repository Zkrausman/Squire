import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ActiveRunConflictError, IntakeValidationError, type SingleTicketIntakeRequest } from "./domain.js";
import type { SingleTicketIntakeService } from "./single-ticket-intake.js";
import { SqliteIntakeStore, WebhookConflictError, type WebhookClaim } from "../sqlite/sqlite-intake-store.js";

export interface LinearWebhookHeaders { readonly deliveryId: string; readonly signature: string; readonly timestamp: string; }
export interface LinearWebhookVerifier { verify(raw: Uint8Array, signature: string, timestamp: string): boolean | Promise<boolean>; }
export class HmacLinearWebhookVerifier implements LinearWebhookVerifier {
  readonly #secret: Buffer;
  constructor(secret: string | Uint8Array) { if (!secret || Buffer.from(secret).length < 1 || Buffer.from(secret).length > 1_024) throw new IntakeValidationError("webhook secret is invalid"); this.#secret = Buffer.from(secret); }
  verify(raw: Uint8Array, signature: string, timestamp: string): boolean {
    const expected = createHmac("sha256", this.#secret).update(raw).digest();
    const candidate = parseSignature(signature);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
}
export interface WebhookDispatchResult { readonly accepted: boolean; readonly duplicate: boolean; readonly deliveryId: string; readonly runId?: string; readonly status: "applied" | "ignored" | "failed" | "blocked" | "duplicate"; }
export interface LinearWebhookHandlerOptions {
  readonly verifier: LinearWebhookVerifier;
  readonly store: SqliteIntakeStore;
  readonly intake?: SingleTicketIntakeService;
  readonly requestForIssue?: (issueId: string, identifier: string | undefined, deliveryId: string) => SingleTicketIntakeRequest;
  readonly cancellation?: { cancel(input: { readonly issueId: string; readonly commandId: string }): Promise<unknown> };
  readonly clock?: { now(): number };
  readonly replayWindowMs?: number;
  readonly maxPayloadBytes?: number;
  readonly owner?: string;
}

/** Transport-neutral webhook boundary. It accepts raw bytes, not parsed body
 * objects, and never acts as a webhook HTTP server. */
export class LinearWebhookHandler {
  readonly #options: LinearWebhookHandlerOptions;
  constructor(options: LinearWebhookHandlerOptions) {
    if (!options.verifier || !options.store || (!options.intake && !options.cancellation)) throw new IntakeValidationError("webhook verifier, durable receipt store, and a dispatch port are required");
    if (options.intake && !options.requestForIssue) throw new IntakeValidationError("webhook intake requires an authoritative request factory");
    if (options.replayWindowMs !== undefined && (!Number.isSafeInteger(options.replayWindowMs) || options.replayWindowMs < 1 || options.replayWindowMs > 86_400_000) || options.maxPayloadBytes !== undefined && (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes < 1 || options.maxPayloadBytes > 16 * 1024 * 1024)) throw new IntakeValidationError("webhook bounds are invalid");
    this.#options = options;
  }
  async handle(raw: Uint8Array, headers: LinearWebhookHeaders | Record<string, string>): Promise<WebhookDispatchResult> {
    const max = this.#options.maxPayloadBytes ?? 512 * 1024;
    if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > max) throw new IntakeValidationError("webhook payload is outside its bound");
    const normalized = validateHeaders(headers);
    const now = this.#options.clock?.now() ?? Date.now();
    const timestamp = parseTimestamp(normalized.timestamp);
    const comparisonNow = now < 100_000_000_000 ? now * 1_000 : now;
    const window = this.#options.replayWindowMs ?? 5 * 60_000;
    if (Math.abs(comparisonNow - timestamp) > window) throw new IntakeValidationError("webhook timestamp is outside the replay window");
    // Authentication happens before JSON parsing and before any receipt/ledger
    // mutation.  A verifier may implement its own key rotation policy.
    if (!await this.#options.verifier.verify(raw, normalized.signature, normalized.timestamp)) throw new IntakeValidationError("webhook signature verification failed");
    const event = parseEvent(raw);
    const digest = createHash("sha256").update(raw).digest("hex");
    const claim = this.#options.store.claimWebhook("linear", normalized.deliveryId, digest, event.eventType, event.issueId, this.#options.owner ?? `webhook-${normalized.deliveryId}`, now, window);
    if (claim.duplicate) return { accepted: claim.status === "applied", duplicate: true, deliveryId: normalized.deliveryId, ...(claim.runId ? { runId: claim.runId } : {}), status: "duplicate" };
    try {
      if (event.action === "cancel") {
        if (!this.#options.cancellation) { this.#options.store.finishWebhook(claim, "ignored"); return { accepted: false, duplicate: false, deliveryId: normalized.deliveryId, status: "ignored" }; }
        const result = await this.#options.cancellation.cancel({ issueId: event.issueId, commandId: `webhook:${normalized.deliveryId}` });
        const runId = result && typeof result === "object" && "runId" in result && typeof (result as { runId?: unknown }).runId === "string" ? (result as { runId: string }).runId : undefined;
        this.#options.store.finishWebhook(claim, "applied", runId);
        return { accepted: true, duplicate: false, deliveryId: normalized.deliveryId, ...(runId ? { runId } : {}), status: "applied" };
      }
      if (!this.#options.intake) { this.#options.store.finishWebhook(claim, "ignored"); return { accepted: false, duplicate: false, deliveryId: normalized.deliveryId, status: "ignored" }; }
      const request = this.#options.requestForIssue?.(event.issueId, event.identifier, normalized.deliveryId);
      if (!request) throw new IntakeValidationError("webhook intake request factory is not configured");
      try {
        const result = await this.#options.intake.accept(request);
        this.#options.store.finishWebhook(claim, "applied", result.runId);
        return { accepted: true, duplicate: false, deliveryId: normalized.deliveryId, runId: result.runId, status: "applied" };
      } catch (error) {
        if (error instanceof ActiveRunConflictError) {
          const existing = this.#options.store.findActiveRun(event.issueId) ?? this.#options.store.findPendingIntake(event.issueId)?.snapshot;
          if (existing) { this.#options.store.finishWebhook(claim, "applied", existing.runId); return { accepted: true, duplicate: false, deliveryId: normalized.deliveryId, runId: existing.runId, status: "applied" }; }
        }
        throw error;
      }
    } catch (error) {
      const blocked = error instanceof WebhookConflictError;
      const status = blocked ? "blocked" : "failed";
      let errorId: string | undefined;
      if (!blocked) {
        try { const detail = (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f\r\n]/gu, " ").slice(0, 512) || "webhook dispatch failed"; errorId = this.#options.store.recordOperatorError({ code: "webhook_dispatch_failed", message: detail, component: "linear-webhook", retryable: true, operatorActionRequired: true, evidence: [], now: new Date(now).toISOString() }).errorId; } catch { /* receipt failure remains authoritative */ }
      }
      this.#options.store.finishWebhook(claim, status, claim.runId, errorId);
      throw error;
    }
  }
  receive(raw: Uint8Array, headers: LinearWebhookHeaders | Record<string, string>): Promise<WebhookDispatchResult> { return this.handle(raw, headers); }
}
export const LinearWebhookService = LinearWebhookHandler;

function validateHeaders(headers: LinearWebhookHeaders | Record<string, string>): LinearWebhookHeaders {
  const value = headers as Record<string, string>;
  const lookup = (names: readonly string[]): string | undefined => { for (const name of names) { const found = value[name] ?? Object.entries(value).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]; if (found !== undefined) return found; } return undefined; };
  const normalized = { deliveryId: lookup(["deliveryId", "linear-delivery", "x-linear-delivery", "x-delivery-id"]), signature: lookup(["signature", "linear-signature", "x-linear-signature"]), timestamp: lookup(["timestamp", "linear-timestamp", "x-linear-timestamp"]) };
  if (typeof normalized.deliveryId !== "string" || typeof normalized.signature !== "string" || typeof normalized.timestamp !== "string" || normalized.deliveryId.length < 1 || normalized.deliveryId.length > 256 || normalized.signature.length < 1 || normalized.signature.length > 512 || normalized.timestamp.length > 64 || /[\u0000-\u001f\u007f\r\n]/u.test(normalized.deliveryId) || /[\u0000-\u001f\u007f\r\n]/u.test(normalized.signature)) throw new IntakeValidationError("webhook headers are invalid");
  return normalized as LinearWebhookHeaders;
}
function parseTimestamp(value: string): number { const numeric = Number(value); const timestamp = numeric < 10_000_000_000 ? numeric * 1_000 : numeric; if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new IntakeValidationError("webhook timestamp is invalid"); return timestamp; }
function parseSignature(value: string): Buffer { const normalized = value.startsWith("sha256=") ? value.slice(7) : value; if (/^[0-9a-f]{64}$/iu.test(normalized)) return Buffer.from(normalized, "hex"); if (/^[A-Za-z0-9+/]{43}={0,1}$/u.test(normalized)) return Buffer.from(normalized, "base64"); return Buffer.alloc(0); }
interface ParsedEvent { readonly eventType: string; readonly action: "create" | "update" | "cancel"; readonly issueId: string; readonly identifier?: string; }
function parseEvent(raw: Uint8Array): ParsedEvent {
  let parsed: unknown; try { parsed = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { throw new IntakeValidationError("webhook payload is not JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new IntakeValidationError("webhook payload must be an object");
  const value = parsed as Record<string, unknown>;
  if (Array.isArray(value["issues"]) || Array.isArray(value["issueIds"]) || Array.isArray(value["data"])) throw new IntakeValidationError("webhook must contain exactly one issue");
  const actionValue = value["action"] ?? value["type"];
  const action: ParsedEvent["action"] = actionValue === "cancel" || actionValue === "issue.cancel" ? "cancel" : actionValue === "create" || actionValue === "issue.create" ? "create" : actionValue === "update" || actionValue === "issue.update" ? "update" : (() => { throw new IntakeValidationError("unsupported Linear webhook action"); })();
  const data = value["data"] && typeof value["data"] === "object" && !Array.isArray(value["data"]) ? value["data"] as Record<string, unknown> : value["issue"] && typeof value["issue"] === "object" && !Array.isArray(value["issue"]) ? value["issue"] as Record<string, unknown> : value;
  const issueId = data["id"];
  if (typeof issueId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(issueId)) throw new IntakeValidationError("webhook must contain exactly one issue UUID");
  const identifier = data["identifier"]; if (identifier !== undefined && (typeof identifier !== "string" || identifier.length > 200)) throw new IntakeValidationError("webhook identifier is invalid");
  return { eventType: typeof value["type"] === "string" ? (value["type"] as string).slice(0, 128) : `issue.${action}`, action, issueId, ...(typeof identifier === "string" ? { identifier } : {}) };
}
