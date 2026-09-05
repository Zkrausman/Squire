# AIDEV-223 restricted ticket sandbox

A run gets one deterministic Docker Sandboxes v0.39.0 microVM. The host controller owns the immutable run/spec/release identities, lifecycle CAS/leases, private transfer staging, credentials, attestations, and the terminal fence. The five Pi roles are independent top-level guest allocations, not agent shells.

## Trust boundary

The versioned template separates numeric `squirectl` (controller worker) from unprivileged `squireagent` (roles). Roles have no sudo, setuid/capability escape, controller sockets, host Docker socket, SSH agent, shared skills/MCP mount, delivery credentials, or ambient environment. Their only Docker endpoint is rootless and ticket-private at `/ticket/docker/run/docker.sock`; all daemon state is under `/ticket/docker`.

`/ticket/bridge` is one deterministic, empty, quota-backed, untrusted passthrough. Its controller metadata is outside the mount. It is never used for repository import, artifact export, or trusted evidence. `SandboxTransferService` uses digest- and length-bound private staging plus a fresh controller `sbx cp` operation.

AIDEV-222 remains the owner of Git repository/worktree/config/bundle semantics; AIDEV-228 remains the owner of Pi materialization. `composeSandboxFilesystemAuthority` only composes AIDEV-222's descriptor-backed authority after measured guest proof and live descriptor identity checks. AIDEV-217 receives immutable role attachment descriptors and owns tabs/topology.

## Fail-closed release policy

`SandboxReleaseResolver` accepts only an independently promoted, signed release whose binary, help output, OCI template, helper bytes, runtime compatibility, resource tuple, bridge quota, network profile, provenance, and host-only evidence match. `latest`, mutable tags, local image IDs, unverified disk/free-space observations, unsupported disk tuples, and missing host evidence cannot resolve.

The checked-in `sandbox/template/v1` is build input, not an acceptance waiver. `scripts/build-sandbox-template.mjs` requires an operator-supplied qualified immutable base digest. `scripts/verify-sandbox-release.mjs` rejects blocked/unvalidated manifests. No Pi or `@zosmaai/pi-llm-wiki` repository pin is introduced: the immutable run selection records Pi `0.84.4` and pi-llm-wiki `0.11.8` in runtime resolution.

If v0.39.0 cannot prove a disk quota tuple, it must be represented as `unsupported` and remains blocked. A free-space or `statfs` observation is not enforcement.

## Lifecycle and teardown

`SandboxLifecycleService` persists spec and operation intent before side effects, uses exact name/ID/template/VM/bridge identity, and exposes create/start/stop/reconcile/retain/remove. Unknown output, identity substitution, timeout, or partial cleanup blocks. `SandboxTeardownCoordinator` first writes the shared run drain, reaps exact role/guest/host children, acquires the existing terminal fence, disposes Git and Pi components under that fence, removes the exact VM/bridge/scoped secrets, verifies retained evidence, and calls `completeRunTeardown` only at the end. It never uses prune or wildcard removal.

## Host-only acceptance

The role sandbox cannot prove host daemon, quota, network-log, sibling, process-topology, Herdr, or exact-removal facts. `scripts/acceptance/sandbox-v039.mjs` performs only immutable binary/help checks and writes strict request/result artifacts; destructive probes remain an explicit trusted external orchestrator responsibility. It fails rather than treating unavailable probes, manual screenshots, or guest output as proof.

Deterministic checks:

```text
npm run typecheck
npm run validate:all
npm test
node scripts/acceptance/sandbox-v039.mjs --release RELEASE.json --request REQUEST.json --output RESULT.json --run-id RUN_ID --sandbox-name squire-v1-<26-base32>
```

The last command must run on the target host with a validated release and a trusted cleanup/orchestration worker. Its absence is a release blocker, not a skipped pass.
