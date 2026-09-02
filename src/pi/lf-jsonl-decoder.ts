import { StringDecoder } from "node:string_decoder";

export class ProtocolError extends Error { constructor(message: string) { super(message); this.name = "ProtocolError"; } }

export class LfJsonlDecoder {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  constructor(readonly maxLineBytes = 1024 * 1024, readonly maxBufferBytes = 2 * 1024 * 1024) {}
  push(chunk: Buffer | string): string[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    if (Buffer.byteLength(this.#buffer, "utf8") > this.maxBufferBytes) throw new ProtocolError("JSONL buffer limit exceeded");
    return this.#drain(false);
  }
  end(): string[] { this.#buffer += this.#decoder.end(); return this.#drain(true); }
  #drain(eof: boolean): string[] {
    const lines: string[] = [];
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) break;
      let line = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#assertLine(line); lines.push(line);
    }
    if (eof && this.#buffer.length > 0) { let line = this.#buffer; this.#buffer = ""; if (line.endsWith("\r")) line = line.slice(0, -1); this.#assertLine(line); lines.push(line); }
    return lines;
  }
  #assertLine(line: string): void { if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) throw new ProtocolError("JSONL line limit exceeded"); }
}
