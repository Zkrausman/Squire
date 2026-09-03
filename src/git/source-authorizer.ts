import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isUnsafeNetworkAddress, assertCredentialFreeHttpsCloneUrl, assertRepositoryPart } from "./identity.js";
import type { GitRepositoryIdentity } from "./domain.js";
import type { GitSourceAuthorization, RepositorySourceAuthorizer } from "./workspace-service.js";

/**
 * A production source policy must be explicit. The policy is intentionally
 * small: repository identity and the complete HTTPS origin are allowlisted,
 * literal private destinations are rejected, and every resolved address must
 * also be public. Git is separately invoked with redirects disabled.
 */
export interface RepositorySourceApprovalPolicy {
  readonly allowedOrigins: readonly string[];
  readonly allowedRepositories: readonly string[];
  readonly resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
}

export class RepositorySourceAuthorizationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositorySourceAuthorizationError";
  }
}

/** Closed production authorizer. It never derives approval from URL shape. */
export class AllowlistedRepositorySourceAuthorizer implements RepositorySourceAuthorizer {
  readonly #origins: ReadonlySet<string>;
  readonly #repositories: ReadonlySet<string>;
  readonly #resolveAddresses: (hostname: string) => Promise<readonly string[]>;

  constructor(policy: RepositorySourceApprovalPolicy) {
    if (!Array.isArray(policy.allowedOrigins) || policy.allowedOrigins.length === 0) throw new RepositorySourceAuthorizationError("an explicit HTTPS source origin allowlist is required");
    const origins = policy.allowedOrigins.map(origin => canonicalOrigin(origin));
    this.#origins = new Set(origins);
    if (!Array.isArray(policy.allowedRepositories) || policy.allowedRepositories.length === 0) throw new RepositorySourceAuthorizationError("an explicit repository identity allowlist is required");
    this.#repositories = new Set(policy.allowedRepositories.map(value => {
      if (typeof value !== "string") throw new RepositorySourceAuthorizationError("source repository allowlist entry is malformed");
      const separator = value.indexOf("/");
      if (separator <= 0 || separator !== value.lastIndexOf("/")) throw new RepositorySourceAuthorizationError("source repository allowlist entry is malformed");
      try { assertRepositoryPart(value.slice(0, separator), "owner"); assertRepositoryPart(value.slice(separator + 1), "name"); }
      catch (error) { throw new RepositorySourceAuthorizationError("source repository allowlist entry is malformed", { cause: error }); }
      return value;
    }));
    this.#resolveAddresses = policy.resolveAddresses ?? (async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(address => address.address));
  }

  async authorize(repository: GitRepositoryIdentity): Promise<GitSourceAuthorization> {
    const approved = assertCredentialFreeHttpsCloneUrl(repository.cloneUrl, repository.owner, repository.name);
    const origin = approved.url.origin;
    if (!this.#origins.has(origin)) throw new RepositorySourceAuthorizationError("repository source origin is not approved");
    if (!this.#repositories.has(`${repository.owner}/${repository.name}`)) throw new RepositorySourceAuthorizationError("repository source identity is not approved");
    if (isUnsafeNetworkAddress(approved.url.hostname)) throw new RepositorySourceAuthorizationError("repository source resolves to a private or local address");
    let addresses: readonly string[];
    try { addresses = await this.#resolveAddresses(approved.url.hostname); }
    catch (error) { throw new RepositorySourceAuthorizationError("repository source DNS resolution failed", { cause: error } as ErrorOptions); }
    if (addresses.length === 0 || addresses.some(address => typeof address !== "string" || isIP(address) === 0 || isUnsafeNetworkAddress(address))) throw new RepositorySourceAuthorizationError("repository source DNS result contains a private or local address");
    return { cloneUrl: repository.cloneUrl };
  }
}

/** Explicitly rejecting default. Tests and production composition must inject
 * an authorizer rather than receiving approval from URL syntax alone. */
export class RejectingRepositorySourceAuthorizer implements RepositorySourceAuthorizer {
  async authorize(_repository: GitRepositoryIdentity): Promise<GitSourceAuthorization> {
    throw new RepositorySourceAuthorizationError("an explicit approved repository source authorizer is required");
  }
}

function canonicalOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new RepositorySourceAuthorizationError("source origin allowlist entry is not a URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port && parsed.port !== "443") throw new RepositorySourceAuthorizationError("source origin allowlist entry must be a credential-free HTTPS origin");
  if (isUnsafeNetworkAddress(parsed.hostname)) throw new RepositorySourceAuthorizationError("source origin allowlist may not contain a private or local address");
  return parsed.origin;
}
