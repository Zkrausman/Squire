import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { validateOwnerPiIdentity, type OwnerPiIdentity } from "./runtime-parity.js";
import type { Ticket } from "./types.js";

const SHA = /^[a-f0-9]{64}$/u;
const ID = /^[a-f0-9-]{36}$/u;
export interface QueueAttestation {
  readonly schema: 1;
  readonly ownerPid: number;
  readonly manifestSha256: string;
  readonly queueId: string;
  readonly nonce: string;
  readonly approved: readonly { readonly ticketId: string; readonly contractSha256: string; readonly contract: Ticket }[];
}
export function validateQueueAttestation(value: unknown, manifestSha256: string, identity: OwnerPiIdentity, tickets: readonly string[]): QueueAttestation {
  validateOwnerPiIdentity(identity);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("owner queue attestation missing");
  const a = value as Record<string, unknown>;
  if (Object.keys(a).sort().join() !== "approved,manifestSha256,nonce,ownerPid,queueId,schema" || a["schema"] !== 1
    || a["ownerPid"] !== identity.pid || a["manifestSha256"] !== manifestSha256 || !SHA.test(String(a["manifestSha256"]))
    || !ID.test(String(a["queueId"])) || !ID.test(String(a["nonce"])) || !Array.isArray(a["approved"])
    || a["approved"].length !== tickets.length) throw Error("owner queue attestation identity mismatch");
  for (const [i, entry] of a["approved"].entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw Error("owner queue ticket attestation missing");
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join() !== "contract,contractSha256,ticketId" || item["ticketId"] !== tickets[i]
      || !SHA.test(String(item["contractSha256"])) || !item["contract"] || typeof item["contract"] !== "object" || Array.isArray(item["contract"])) throw Error("owner queue ticket contract mismatch");
    const contract = item["contract"] as Record<string, unknown>;
    if (contract["id"] !== tickets[i] || typeof contract["title"] !== "string" || typeof contract["description"] !== "string"
      || contract["title"].length > 512 || contract["description"].length > 16_384
      || !Object.keys(contract).every(k => ["id", "title", "description", "url"].includes(k))
      || (contract["url"] !== undefined && (typeof contract["url"] !== "string" || contract["url"].length > 512))
      || createHash("sha256").update(JSON.stringify(contract)).digest("hex") !== item["contractSha256"]) throw Error("owner queue contract bytes/digest mismatch");
  }
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 64 * 1024) throw Error("owner queue attestation unbounded");
  return structuredClone(value) as QueueAttestation;
}
/** Only called from a Pi slash-command after each explicit UI approval. */
export async function launchAttestedQueue(executable: string, args: readonly string[], cwd: string, identity: OwnerPiIdentity, attestation: QueueAttestation): Promise<number> {
  validateOwnerPiIdentity(identity);
  if (!path.isAbsolute(executable) || !path.isAbsolute(cwd) || identity.pid !== process.pid || attestation.ownerPid !== identity.pid) throw Error("Pi queue bridge identity invalid");
  const ownerBytes = Buffer.from(JSON.stringify(identity)), approvedBytes = Buffer.from(JSON.stringify(attestation));
  if (ownerBytes.length > 1024 * 1024 || approvedBytes.length > 64 * 1024) throw Error("Pi queue bridge payload unbounded");
  const child = spawn(executable, [...args], { cwd, shell: false, windowsHide: true,
    env: { ...process.env, SQUIRE_OWNER_PI_CHANNEL: "fd3-v1", SQUIRE_QUEUE_ATTESTATION_CHANNEL: "fd4-v1" },
    stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"] });
  if (!child.stdio[3] || !child.stdio[4]) { child.kill(); throw Error("Pi queue private pipes unavailable"); }
  (child.stdio[3] as Writable).end(ownerBytes);
  (child.stdio[4] as Writable).end(approvedBytes);
  return await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
}
/** FD4 has meaning only beside the independently verified live Pi parent on FD3. */
export async function receiveQueueAttestation(manifestSha256: string, identity: OwnerPiIdentity, tickets: readonly string[], fd = 4): Promise<QueueAttestation> {
  if (process.env["SQUIRE_QUEUE_ATTESTATION_CHANNEL"] !== "fd4-v1" || process.ppid !== identity.pid) throw Error("owner Pi queue attestation channel required");
  const stream = createReadStream("", { fd, autoClose: false });
  const timer = setTimeout(() => stream.destroy(Error("queue attestation channel timed out")), 5_000);
  const parts: Buffer[] = []; let total = 0;
  try {
    for await (const part of stream) { total += part.length; if (total > 64 * 1024) throw Error("queue attestation channel exceeds bound"); parts.push(part); }
  } finally { clearTimeout(timer); stream.destroy(); }
  return validateQueueAttestation(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))), manifestSha256, identity, tickets);
}
