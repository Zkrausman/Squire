import { EventEmitter } from "node:events";
import { LfJsonlDecoder, ProtocolError } from "./lf-jsonl-decoder.js";
import type { PiProcess } from "./pi-process.js";

export interface RpcResponse { id?: string; type: "response"; command: string; success: boolean; data?: unknown; error?: string }
export interface PiState { model: { provider: string; id: string } | null; sessionFile: string; sessionId: string; isStreaming?: boolean }
export interface RpcClientOptions { commandTimeoutMs?: number; maxLineBytes?: number; maxBufferBytes?: number; maxStderrBytes?: number; maxRenderedBytes?: number }
interface Pending { resolve(value: RpcResponse): void; reject(error: Error): void; timer: NodeJS.Timeout }

export class PiRpcClient extends EventEmitter {
  readonly #decoder: LfJsonlDecoder; readonly #pending = new Map<string, Pending>(); readonly #timeout: number; readonly #maxStderr: number; readonly #maxRendered: number;
  #sequence = 0; #stderr = ""; #rendered = 0; #closed = false;
  constructor(readonly process: PiProcess, options: RpcClientOptions = {}) {
    super(); this.#timeout = options.commandTimeoutMs ?? 5_000; this.#maxStderr = options.maxStderrBytes ?? 256 * 1024; this.#maxRendered = options.maxRenderedBytes ?? 2 * 1024 * 1024;
    this.#decoder = new LfJsonlDecoder(options.maxLineBytes, options.maxBufferBytes);
    process.stdout.on("data", chunk => this.#consume(chunk)); process.stdout.on("end", () => { try { for (const line of this.#decoder.end()) this.#line(line); } catch (e) { this.#fail(asError(e)); } });
    process.stderr.on("data", chunk => { this.#stderr += chunk.toString(); if (Buffer.byteLength(this.#stderr) > this.#maxStderr) this.#fail(new ProtocolError("stderr limit exceeded")); else this.emit("stderr", chunk.toString()); });
    process.on("exit", (code, signal) => { this.#closed = true; this.#fail(new ProtocolError(`Pi exited unexpectedly: ${code ?? signal ?? "unknown"}`)); this.emit("process_exit", { code, signal }); });
  }
  get stderr(): string { return this.#stderr; }
  async command(command: Record<string, unknown>, timeoutMs = this.#timeout): Promise<RpcResponse> {
    if (this.#closed) throw new ProtocolError("Pi process is closed");
    const id = `squire-${String(++this.#sequence).padStart(8, "0")}`;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new ProtocolError(`RPC command timed out: ${String(command["type"])}`)); }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.process.stdin.write(`${JSON.stringify({ id, ...command })}\n`); } catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(asError(error)); }
    });
  }
  async getState(): Promise<PiState> { const response = await this.command({ type: "get_state" }); if (!response.success || !isState(response.data)) throw new ProtocolError("malformed get_state response"); return response.data; }
  async prompt(message: string): Promise<void> { const response = await this.command({ type: "prompt", message }); if (!response.success) throw new ProtocolError(response.error ?? "prompt rejected"); this.emit("prompt_accepted"); }
  waitForSettled(timeoutMs = this.#timeout): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(new ProtocolError("agent_settled timed out")); }, timeoutMs); const settled = () => { cleanup(); resolve(); }; const failed = (error: Error) => { cleanup(); reject(error); }; const cleanup = () => { clearTimeout(timer); this.off("agent_settled", settled); this.off("protocol_error", failed); }; this.once("agent_settled", settled); this.once("protocol_error", failed); }); }
  #consume(chunk: Buffer | string): void { try { for (const line of this.#decoder.push(chunk)) this.#line(line); } catch (error) { this.#fail(asError(error)); } }
  #line(line: string): void {
    if (!line) return; let record: Record<string, unknown>; try { record = JSON.parse(line) as Record<string, unknown>; } catch { throw new ProtocolError("malformed JSON on Pi stdout"); }
    this.#rendered += Buffer.byteLength(line); if (this.#rendered > this.#maxRendered) throw new ProtocolError("rendered output limit exceeded");
    if (record["type"] === "response") { const id = record["id"]; if (typeof id !== "string" || !this.#pending.has(id)) throw new ProtocolError("uncorrelated RPC response"); const pending = this.#pending.get(id)!; clearTimeout(pending.timer); this.#pending.delete(id); pending.resolve(record as unknown as RpcResponse); return; }
    if (record["type"] === "agent_settled") this.emit("agent_settled");
    if (record["type"] === "extension_ui_request") this.emit("extension_ui", record);
    this.emit("event", record);
  }
  #fail(error: Error): void { for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.#pending.clear(); this.emit("protocol_error", error); }
}
function isState(value: unknown): value is PiState { if (!value || typeof value !== "object") return false; const v = value as Record<string, unknown>; const model = v["model"] as Record<string, unknown> | null; return typeof v["sessionFile"] === "string" && typeof v["sessionId"] === "string" && (model === null || (typeof model === "object" && typeof model["provider"] === "string" && typeof model["id"] === "string")); }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
