# Docker Sandboxes viability spike

- **Ticket:** AIDEV-214
- **Status:** Core POC complete — **viable for the Squire MVP architecture**
- **Date:** 2026-09-01

## Purpose

Evaluate Docker Sandboxes (`sbx`) as the per-ticket isolation boundary for Squire. The target topology is one persistent microVM per ticket containing the ticket repository and five independent top-level Pi sessions: Orchestrator, Plan, Implement, Review, and Test.

This is a feasibility checkpoint, not the final architecture decision.

## Current environment

- Docker Sandboxes CLI: `v0.39.0`
- Windows Hypervisor Platform: enabled
- `sbx diagnose`: virtualization supported (`WHvCapabilityCodeHypervisorPresent is true`)
- Sandbox daemon: installed and healthy
- Test sandbox: `squire-aidev-214-spike`
- Test sandbox state after POC: stopped and retained for downstream implementation work
- Host bridge directory: a dedicated ticket-specific temporary directory (exact local path intentionally omitted)
- In-sandbox repository: `/ticket/workspace`
- In-sandbox session root: `/ticket/sessions`
- In-sandbox evidence root: `/ticket/evidence`

The global `sbx` network policy was initialized as `allow-all`, matching the MVP requirement for normal outbound network access.

### Primary workspace correction

Docker Sandboxes v0.39.0 rejects a read-only primary workspace with `ERROR: primary workspace must be read/write (remove ':ro' or ':readonly')`. The required bridge is therefore dedicated per ticket and read-write, but otherwise empty. It contains no repository, credentials, home data, or unrelated host state. Its contents are untrusted, are not used by agents for repository work or trusted artifact publication, and are deleted during ticket cleanup. Repository state remains under `/ticket`, and controller-mediated `sbx cp` remains the trusted export path.

## Validated successfully

### MicroVM and filesystem isolation

- Created a shell sandbox with 4 CPUs and 8 GiB memory.
- The designated host bridge directory was visible at its matching absolute path.
- A sentinel elsewhere under the host temporary directory was not visible.
- The host Squire checkout was not visible (exact local path intentionally omitted).
- Listing the host user-profile mount returned no unrelated host files (the local profile path is intentionally omitted).
- The repository was cloned from GitHub entirely inside the microVM at `/ticket/workspace`.
- The cloned commit was `85c7ef7cc21d93f2a106c1e7a3e64df4ccc77084`.
- Files under `/ticket` survived sandbox stop/start, confirming persistent VM storage.

### Network and nested Docker

- Normal outbound HTTPS access succeeded against GitHub.
- The sandbox had its own Docker Engine:
  - Client: `29.7.2`
  - Server: `29.7.2`
  - Docker root: `/var/lib/docker`
  - Sandbox engine initially had zero containers and images.
- The host Docker checkout and daemon were not mounted into the sandbox.
- Built `squire/aidev-214-sandbox-poc:latest` with the private daemon and ran it successfully.
- The test container returned exactly `SQUIRE_PRIVATE_DOCKER_READY`.
- Nested-Docker evidence is stored at `/ticket/evidence/nested-docker.json`.

### Pi installation and RPC

- Installed `@earendil-works/pi-coding-agent@0.84.4` inside the sandbox.
- Started Pi in RPC mode from `/ticket/workspace`.
- A real model call using `openai-codex/gpt-5.6-luna` returned exactly `SQUIRE_SBX_RPC_READY`.
- Pi persisted the session at:
  `/ticket/sessions/codex/2026-09-01T07-24-14-292Z_01a05bda-b254-7192-96e0-9c43b7faf5f7.jsonl`
- Resuming that exact session path preserved session ID `01a05bda-b254-7192-96e0-9c43b7faf5f7` and returned exactly `SQUIRE_SBX_RPC_RESUMED`.
- The resumed history contained both user/assistant exchanges.

### Five independent sessions

Five Pi RPC processes were launched concurrently inside the same ticket microVM. Each received a unique session ID, session directory, and successful model response:

| Session | Session ID | Expected response |
|---|---|---|
| Orchestrator | `01a05bdb-1eb8-7b09-a5cf-86cbc76fd4a6` | `SQUIRE_ORCHESTRATOR_READY` |
| Plan | `01a05bdb-1e26-7788-96d5-a1b083b673fd` | `SQUIRE_PLAN_READY` |
| Implement | `01a05bdb-1ded-7e45-94b7-52944a8767d9` | `SQUIRE_IMPLEMENT_READY` |
| Review | `01a05bdb-1e1d-79c1-a353-7a93effe6566` | `SQUIRE_REVIEW_READY` |
| Test | `01a05bdb-1d7c-7cbe-9048-e96e6cafd2a5` | `SQUIRE_TEST_READY` |

Host-side command output was retained in ticket-specific temporary evidence storage; the local path is intentionally omitted.

### Herdr attachment and manual steering

- Created a Herdr tab with exactly one root pane.
- Herdr launched Pi inside the microVM through `sbx exec -it`.
- The session used the correct in-sandbox path `/ticket/sessions/herdr-auth`.
- A manual/Herdr prompt returned exactly `SQUIRE_HERDR_SBX_AUTH_READY`.
- Herdr observed the session transition through working to done.
- The operator can focus the tab and type directly into the in-sandbox Pi session.
- Windows launch commands must disable MSYS argument conversion so `/ticket/...` paths are not rewritten.

### Controller-mediated Git branch export

- Created branch `poc/aidev-214-controller-export` inside `/ticket/workspace`.
- Committed `squire-poc-export-evidence.txt` as commit `3fc271bef426bf2403d0256eff64c7c29d3bfe28`.
- Created an immutable Git bundle at `/ticket/artifacts/aidev-214-controller-export.bundle`.
- Exported it with controller-side `sbx cp`; the agent did not receive access to the host checkout.
- Cloned and verified the bundle in a disposable host directory.
- `git fsck --full --strict` passed and the exported file contained exactly `SQUIRE_CONTROLLER_EXPORT_READY`.
- Controller verification was retained in ticket-specific temporary evidence storage; the local path is intentionally omitted.

## Architecture constraints confirmed by the POC

1. **Do not use default direct workspace mode for repository code.** It mounts the selected host directory read-write.
2. **Do not rely on stock `--clone` mode for the strict Squire boundary.** Docker documents that the host source remains visible read-only at `/run/sandbox/source`.
3. Use a dedicated ticket-specific, read-write but otherwise empty bridge with no repository, credentials, home data, or unrelated host state; treat and delete its contents as untrusted. Keep repository work under persistent microVM storage at `/ticket/workspace`.
4. Use Pi RPC and per-phase session directories as the authoritative orchestration seam; Herdr is the interactive presentation and manual-steering seam.
5. Export delivery branches through a controller-mediated artifact operation such as Git bundle plus `sbx cp`. The trusted controller or Delivery GitHub App can publish the verified branch without mounting the host checkout into the sandbox.
6. Set `MSYS_NO_PATHCONV=1` and `MSYS2_ARG_CONV_EXCL=*` for Windows controller commands carrying Linux sandbox paths.

## Deferred implementation work

- Select the production model-credential mechanism. Proxy-managed Google credentials did not work with Pi during this spike; temporary ticket-private Pi OAuth proved model viability but is not the final secret design.
- Implement Delivery and Reviewer GitHub App authentication, branch publication, PR creation, and approval.
- Add retry/restart handling for the observed case where `sbx exec` emitted no stdout after a deliberately killed Pi process.
- Automate sandbox setup, evidence export, resource limits, and deterministic teardown.
- Replace temporary launch scripts with the Squire controller and versioned sandbox template/kit.

These are downstream implementation concerns and do not change the selected isolation or session topology.

## Assessment

Docker Sandboxes is confirmed as a viable foundation for the Squire MVP. It provides a stronger ticket boundary than ordinary containers, a persistent internal Git workspace, a private Docker daemon, five independently controllable Pi sessions, manual Herdr steering, and a safe controller-mediated branch export path. AIDEV-214 can use this result to finalize the architecture while credential brokering, GitHub App delivery, and operational hardening proceed in downstream tickets.
