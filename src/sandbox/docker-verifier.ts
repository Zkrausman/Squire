import { canonicalJson, sha256Bytes } from "./identity.js";

export interface RootlessDockerObservation {
  readonly socket: "/ticket/docker/run/docker.sock";
  readonly uid: number;
  readonly rootless: true;
  readonly daemonRoot: "/ticket/docker/data";
  readonly operations: readonly ["build", "run", "remove", "volume", "network"];
  readonly objects: readonly { readonly kind: "image" | "container" | "volume" | "network"; readonly id: string; readonly nonce: string }[];
  readonly stopStartObjectDigest: string;
  readonly privilegedEscapeBlocked: true;
  readonly rootfulSocketAbsent: true;
  readonly hostSocketAbsent: true;
}
export class RootlessDockerVerificationError extends Error {
  constructor(message: string) { super(message); this.name = "RootlessDockerVerificationError"; }
}
export function verifyRootlessDocker(observed: RootlessDockerObservation, expectedUid = 1001): string {
  if (!observed || typeof observed !== "object" || expectedUid !== 1001 || Object.keys(observed).sort().join("\0") !== ["daemonRoot", "hostSocketAbsent", "objects", "operations", "privilegedEscapeBlocked", "rootfulSocketAbsent", "rootless", "socket", "stopStartObjectDigest", "uid"].sort().join("\0") || !Array.isArray(observed.objects) || observed.objects.length === 0 || observed.objects.length > 10_000 || observed.socket !== "/ticket/docker/run/docker.sock" || observed.uid !== expectedUid || observed.rootless !== true || observed.daemonRoot !== "/ticket/docker/data" || observed.privilegedEscapeBlocked !== true || observed.rootfulSocketAbsent !== true || observed.hostSocketAbsent !== true || JSON.stringify(observed.operations) !== JSON.stringify(["build", "run", "remove", "volume", "network"]) || observed.objects.some(item => !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join("\0") !== ["id", "kind", "nonce"].join("\0") || !["image", "container", "volume", "network"].includes(item.kind) || typeof item.id !== "string" || typeof item.nonce !== "string" || item.id.length === 0 || item.nonce.length === 0 || item.id.length > 256 || item.nonce.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.id) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.nonce)) || new Set(observed.objects.map(item => `${item.kind}:${item.id}`)).size !== observed.objects.length || new Set(observed.objects.map(item => item.nonce)).size !== observed.objects.length) throw new RootlessDockerVerificationError("rootless private Docker observation is incomplete");
  if (!/^[0-9a-f]{64}$/u.test(observed.stopStartObjectDigest)) throw new RootlessDockerVerificationError("rootless Docker persistence digest is invalid");
  const expected = sha256Bytes(Buffer.from(canonicalJson({ objects: observed.objects }), "utf8"));
  if (expected !== observed.stopStartObjectDigest) throw new RootlessDockerVerificationError("rootless Docker persistence digest does not match object inventory");
  return observed.stopStartObjectDigest;
}
