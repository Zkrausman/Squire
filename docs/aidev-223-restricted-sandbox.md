# AIDEV-223 restricted ticket sandbox

A run gets one deterministic Docker Sandboxes v0.39.0 microVM. The host controller owns the immutable run/spec/release identities, lifecycle CAS/leases, private transfer staging, credentials, attestations, and the terminal fence. The five Pi roles are independent top-level guest allocations, not agent shells.

## Trust boundary

The versioned template separates numeric `squirectl` (controller worker) from unprivileged `squireagent` (roles). Roles have no sudo, setuid/capability escape, controller sockets, host Docker socket, SSH agent, shared skills/MCP mount, delivery credentials, or ambient environment. Their only Docker endpoint is rootless and ticket-private at `/ticket/docker/run/docker.sock`; all daemon state is under `/ticket/docker`.

`/ticket/bridge` is one deterministic, empty, quota-backed, untrusted passthrough. Its controller metadata is outside the mount. It is never used for repository import, artifact export, or trusted evidence. `SandboxTransferService` requires `SandboxLifecycleService.withTransfer()` reservations and uses digest- and length-bound private staging plus a fresh controller `sbx cp` operation.

AIDEV-222 remains the owner of Git repository/worktree/config/bundle semantics; AIDEV-228 remains the owner of Pi materialization. `composeSandboxFilesystemAuthority` only composes AIDEV-222's descriptor-backed authority after measured guest proof and live descriptor identity checks. The narrow `WorkflowStoreRpcServer` is wired through the reverse host/guest mediator and exposes only bound `read`/`assertRunStartAllowed` calls; it never exposes CAS, SQL, filesystem, or lease authority. AIDEV-217 receives immutable role attachment descriptors and owns tabs/topology.

## Fail-closed release policy

`SandboxReleaseResolver` accepts only an independently promoted, signed release whose binary, help output, OCI template, helper bytes, runtime compatibility, resource tuple, bridge quota, network profile, provenance, and host-only evidence match. `latest`, mutable tags, local image IDs, unverified disk/free-space observations, unsupported disk tuples, and missing host evidence cannot resolve.

The checked-in `sandbox/template/v1` is build input, not an acceptance waiver. `scripts/build-sandbox-template.mjs` requires an operator-supplied qualified immutable base digest, emits a create-once context, and records the shipped `squirectl` runtime/helper bytes. `scripts/promote-sandbox-release.mjs` additionally requires an exact OCI digest/config/helper identity, observed `sbx` bytes/version/help, a passing host result covering every probe, and host-only HMAC/Ed25519 signing. `scripts/verify-sandbox-release.mjs` rechecks the signed manifest and referenced evidence. No Pi or `@zosmaai/pi-llm-wiki` repository pin is introduced: the immutable run selection records Pi `0.84.4` and pi-llm-wiki `0.11.8` in runtime resolution.

If v0.39.0 cannot prove a disk quota tuple, it must be represented as `unsupported` and remains blocked. A free-space or `statfs` observation is not enforcement.

## Lifecycle and teardown

`SandboxLifecycleService` persists spec and operation intent before side effects, uses exact name/ID/template/VM/bridge identity, and exposes create/start/stop/reconcile/retain/remove. Unknown output, identity substitution, timeout, or partial cleanup blocks. `SandboxTeardownCoordinator` first writes the shared run drain, reaps exact role/guest/host children, acquires the existing terminal fence, disposes Git and Pi components under that fence, removes the exact VM/bridge/scoped secrets, verifies retained evidence, and calls `completeRunTeardown` only at the end. It never uses prune or wildcard removal.

## Host-only acceptance

The trusted executable worker is `scripts/acceptance/sandbox-host-worker.mjs` (with `sandbox-v039.mjs` as a compatibility entrypoint). It authenticates the promoted release, observes the exact v0.39.0 binary, creates one deterministic sandbox and empty bridge, invokes all 13 host probes itself, writes request-bound raw packets, publishes only authenticated host-only pass evidence, and performs exact stop/remove/quarantine cleanup. It does not accept `--observer` or pre-manufactured observation packets. Missing host APIs, guest-only claims, free-space observations, manual screenshots, and unverified output remain failures. Windows uses local-volume canonical paths, ACL/reparse-point checks, and explicit PowerShell/Node argv; it does not claim POSIX modes, ownership, `/proc`, or inode guarantees.

The operator supplies the base and OCI identities once per promotion, never a mutable tag. The base must already contain the pinned `dockerd-rootless.sh`, `rootlesskit`, `newuidmap`, `newgidmap`, `dockerd`, `getcap`, Node, and systemd inputs; the Dockerfile fails closed if any is absent or substituted:

```text
node scripts/build-sandbox-template.mjs --base-image registry.example/project/base --base-digest sha256:<64> --output /absolute/template-build.json --context /absolute/empty-context
# Build the returned context with the exact argv-only Docker invocation below, then record
# the exact RepoDigest/config/helper identity in /absolute/template-identity.json.
/usr/bin/docker build --file /absolute/empty-context/Dockerfile --tag registry.example/project/squire-template:build-v1 /absolute/empty-context
node scripts/promote-sandbox-release.mjs --template-build /absolute/template-build.json --template-identity /absolute/template-identity.json --template-reference registry.example/project/squire-template@sha256:<64> --sbx-path /absolute/sbx --platform linux --architecture amd64 --release-id release-v039-linux-amd64 --network-policy /absolute/network-policy.json --resources /absolute/resources.json --bridge-quota-bytes 104857600 --request /absolute/host-request.json --conformance-result /absolute/host-result.json --repository-root /ticket/workspace --build-reference artifacts/build/provenance.json --sbom-reference artifacts/build/sbom.json --key-id host-release-key --hmac-key-file /absolute/host-key --output /ticket/workspace/sandbox/releases/release-v039-linux-amd64.json
```

Run the worker on a disposable trusted Windows host with a private empty state root, a private network-policy input, host-held signing material, and an evidence directory beneath the repository. The exact PowerShell/Node sequence is:

```powershell
$env:Path = "$env:SystemRoot\System32"
node scripts/acceptance/sandbox-host-worker.mjs `
  --release C:\squire\workspace\sandbox\releases\release-v039-windows-amd64.json `
  --output C:\squire\workspace\artifacts\acceptance\host-result.json `
  --request C:\squire\workspace\artifacts\acceptance\host-request.json `
  --run-id run_aidev223win01 `
  --sandbox-name squire-v1-<derived-26-base32> `
  --ticket-id AIDEV-223 `
  --state-root C:\squire\disposable\aidev223win01 `
  --repository-root C:\squire\workspace `
  --evidence-root C:\squire\workspace\evidence\acceptance-v039 `
  --network-policy C:\squire\disposable\network-policy.json `
  --docker-path 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' `
  --hmac-key-file C:\squire\keys\host-release.key
```

The signed release must bind `C:\Users\zkrau\AppData\Local\DockerSandboxes\bin\sbx.exe` and its SHA-256. The worker runs `sbx`, Docker, and Herdr only as absolute argv-only executables with `MSYS_NO_PATHCONV=1` and `MSYS2_ARG_CONV_EXCL=*`; it never fabricates external host probes.

`npm run typecheck`, `npm run validate:all`, and `npm test` are repository checks only. Host acceptance is not satisfied by a manually bootstrapped sandbox or by an unavailable worker capability; absent authenticated evidence leaves the release blocked.
