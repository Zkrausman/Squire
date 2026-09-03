import { EventEmitter } from "node:events";
import { LfJsonlDecoder, ProtocolError } from "./lf-jsonl-decoder.js";
import type { PiProcess } from "./pi-process.js";
import { isPiThinkingLevel, type PiThinkingLevel } from "./pi-configuration.js";

export interface RpcResponse { id?: string; type: "response"; command: string; success: boolean; data?: unknown; error?: string }
export interface PiState { model: { provider: string; id: string } | null; sessionFile: string; sessionId: string; thinkingLevel: PiThinkingLevel; isStreaming?: boolean }
export interface RpcClientOptions { commandTimeoutMs?: number; maxLineBytes?: number; maxBufferBytes?: number; maxStderrBytes?: number; maxRenderedBytes?: number }
type SupportedCommand = "get_state" | "get_entries" | "prompt" | "clear_queue" | "abort_retry" | "abort";
interface Pending { command: SupportedCommand; resolve(value: RpcResponse): void; reject(error: Error): void; timer: NodeJS.Timeout }

export class PiRpcClient extends EventEmitter {
  readonly #decoder: LfJsonlDecoder; readonly #pending = new Map<string, Pending>(); readonly #timeout: number; readonly #maxStderr: number; readonly #maxRendered: number;
  #sequence = 0; #stderr = ""; #rendered = 0; #closed = false; #failure: Error | undefined;
  constructor(readonly process: PiProcess, options: RpcClientOptions = {}) {
    super(); this.#timeout = options.commandTimeoutMs ?? 5_000; this.#maxStderr = options.maxStderrBytes ?? 256 * 1024; this.#maxRendered = options.maxRenderedBytes ?? 2 * 1024 * 1024;
    this.#decoder = new LfJsonlDecoder(options.maxLineBytes, options.maxBufferBytes);
    process.stdout.on("data", chunk => this.#consume(chunk)); process.stdout.on("end", () => { try { for (const line of this.#decoder.end()) this.#line(line); } catch (e) { this.#fail(asError(e)); } });
    process.stderr.on("data", chunk => { this.#stderr += chunk.toString(); if (Buffer.byteLength(this.#stderr) > this.#maxStderr) this.#fail(new ProtocolError("stderr limit exceeded")); else this.emit("stderr", chunk.toString()); });
    process.on("exit", (code, signal) => { this.#closed = true; this.#fail(new ProtocolError(`Pi exited unexpectedly: ${code ?? signal ?? "unknown"}`)); this.emit("process_exit", { code, signal }); });
  }
  get stderr(): string { return this.#stderr; }
  get failure(): Error | undefined { return this.#failure; }
  async command(command: Record<string, unknown>, timeoutMs = this.#timeout): Promise<RpcResponse> {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new ProtocolError("Pi process is closed");
    const commandType = command["type"];
    if (!isSupportedCommand(commandType)) throw new ProtocolError("unsupported RPC command");
    const id = `squire-${String(++this.#sequence).padStart(8, "0")}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new ProtocolError(`RPC command timed out: ${commandType}`)), timeoutMs);
      this.#pending.set(id, { command: commandType, resolve, reject, timer });
      try { if (!this.process.stdin.write(`${JSON.stringify({ id, ...command })}\n`)) throw new ProtocolError("Pi stdin rejected RPC write"); } catch (error) { this.#fail(asError(error)); }
    });
  }
  async getState(): Promise<PiState> { const response = await this.command({ type: "get_state" }); if (!response.success || !isState(response.data)) throw new ProtocolError("malformed get_state response"); return response.data; }
  async prompt(message: string): Promise<void> { const response = await this.command({ type: "prompt", message }); if (!response.success) throw new ProtocolError(response.error ?? "prompt rejected"); this.emit("prompt_accepted"); }
  waitForSettled(timeoutMs = this.#timeout): Promise<void> { if (this.#failure) return Promise.reject(this.#failure); return new Promise((resolve, reject) => { const timer = setTimeout(() => this.#fail(new ProtocolError("agent_settled timed out")), timeoutMs); const settled = () => { cleanup(); resolve(); }; const failed = (error: Error) => { cleanup(); reject(error); }; const cleanup = () => { clearTimeout(timer); this.off("agent_settled", settled); this.off("protocol_error", failed); }; this.once("agent_settled", settled); this.once("protocol_error", failed); }); }
  #consume(chunk: Buffer | string): void { if (this.#closed) return; try { for (const line of this.#decoder.push(chunk)) this.#line(line); } catch (error) { this.#fail(asError(error)); } }
  #line(line: string): void {
    if (!line) return; let record: Record<string, unknown>; try { record = JSON.parse(line) as Record<string, unknown>; } catch { throw new ProtocolError("malformed JSON on Pi stdout"); }
    this.#rendered += Buffer.byteLength(line); if (this.#rendered > this.#maxRendered) throw new ProtocolError("rendered output limit exceeded");
    if (record["type"] === "response") {
      const id = record["id"];
      if (typeof id !== "string" || !this.#pending.has(id)) throw new ProtocolError("uncorrelated RPC response");
      const pending = this.#pending.get(id)!;
      const response = validateResponse(record, pending.command);
      clearTimeout(pending.timer); this.#pending.delete(id); pending.resolve(response); return;
    }
    if (record["type"] === "agent_settled") this.emit("agent_settled");
    if (record["type"] === "extension_ui_request") this.emit("extension_ui", record);
    this.emit("event", record);
  }
  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.emit("protocol_error", error);
    if (this.process.exitCode === null) this.process.kill("SIGTERM");
  }
}
function validateResponse(record: Record<string, unknown>, expectedCommand: SupportedCommand): RpcResponse {
  const allowed = new Set(["id", "type", "command", "success", "data", "error"]);
  if (Object.keys(record).some(key => !allowed.has(key))) throw new ProtocolError("RPC response contains unknown fields");
  if (record["type"] !== "response" || record["command"] !== expectedCommand || typeof record["success"] !== "boolean") throw new ProtocolError("malformed or mismatched RPC response");
  const hasData = Object.hasOwn(record, "data"); const hasError = Object.hasOwn(record, "error");
  if (record["success"] === false) {
    if (!hasError || typeof record["error"] !== "string" || record["error"].length === 0 || hasData) throw new ProtocolError("malformed failed RPC response");
  } else {
    if (hasError) throw new ProtocolError("successful RPC response must not contain error");
    if (expectedCommand === "get_state" && (!hasData || !isState(record["data"]))) throw new ProtocolError("malformed get_state response");
    if (expectedCommand === "get_entries" && (!hasData || !isEntries(record["data"]))) throw new ProtocolError("malformed get_entries response");
    if (expectedCommand === "clear_queue" && (!hasData || !isClearQueue(record["data"]))) throw new ProtocolError("malformed clear_queue response");
    if (["prompt", "abort_retry", "abort"].includes(expectedCommand) && hasData) throw new ProtocolError("RPC response contains forbidden data");
  }
  return record as unknown as RpcResponse;
}
function isSupportedCommand(value: unknown): value is SupportedCommand { return typeof value === "string" && ["get_state", "get_entries", "prompt", "clear_queue", "abort_retry", "abort"].includes(value); }
function isEntries(value: unknown): boolean { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const v = value as Record<string, unknown>; return Object.keys(v).every(key => key === "entries" || key === "leafId") && Array.isArray(v["entries"]) && (v["leafId"] === null || typeof v["leafId"] === "string"); }
function isClearQueue(value: unknown): boolean { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const v = value as Record<string, unknown>; return Object.keys(v).every(key => key === "steering" || key === "followUp") && Array.isArray(v["steering"]) && v["steering"].every(item => typeof item === "string") && Array.isArray(v["followUp"]) && v["followUp"].every(item => typeof item === "string"); }
function isState(value: unknown): value is PiState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const model = v["model"] as Record<string, unknown> | null;
  const thinking = v["thinkingLevel"];
  return typeof v["sessionFile"] === "string"
    && typeof v["sessionId"] === "string"
    && isPiThinkingLevel(thinking)
    && (model === null || (typeof model === "object" && typeof model["provider"] === "string" && typeof model["id"] === "string"));
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
