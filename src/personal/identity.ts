import { createHash } from "node:crypto";

export function deterministicFeatureBranch(repository: string, ticketId: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("repository must be owner/name");
  if (!/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(ticketId)) throw new Error("invalid Linear ticket identifier");
  const repositoryId = createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 8);
  return `squire/${ticketId.toLowerCase()}-${repositoryId}`;
}

/** Validate a configured Git revision before it crosses an execFile boundary. */
export function validateSourceRef(value: unknown, label = "source ref"): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1_024 || value.startsWith("-") || /\s|[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} must be a safe Git ref`);
  }
  return value;
}
