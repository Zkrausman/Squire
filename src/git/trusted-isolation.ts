/**
 * Opaque proof supplied by the AIDEV-223 sandbox composition. AIDEV-222
 * deliberately has no constructor or probe that can mint this value: the
 * composition must establish the actual ticket filesystem boundary (including
 * same-device bind/swap resistance) before Git can perform a side effect.
 *
 * Test adapters may use a narrowly scoped cast, but production code must pass
 * the capability issued by the sandbox/isolation layer.
 */
declare const trustedFilesystemIsolationBrand: unique symbol;

export interface TrustedFilesystemIsolationCapability {
  readonly [trustedFilesystemIsolationBrand]: "aidev-223-trusted-filesystem";
  /** Re-proves that the supplied ticket root is still inside the trusted boundary. */
  assertTicketRoot(ticketRoot: string, signal?: AbortSignal): Promise<void>;
}

export function assertTrustedFilesystemIsolationCapability(value: unknown): asserts value is TrustedFilesystemIsolationCapability {
  if (!value || typeof value !== "object" || typeof (value as { assertTicketRoot?: unknown }).assertTicketRoot !== "function") {
    throw new Error("AIDEV-223 trusted filesystem isolation capability is required");
  }
}
