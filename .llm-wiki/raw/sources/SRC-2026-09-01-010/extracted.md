# JSON Extract

- **Schema Version:** 1
- **Run Id:** run_AIDEV-216-manual-001
- **Session Id:** 29aa904e-ab22-4f65-a1d6-dc94d49cfd6d
- **Reviewed Head:** a669673937be073847ffcfb028f3a50281f02d46
- **Status:** remediation_required
- **Summary:** The frozen branch passes contracts and 54 tests, and the new provisional allocation closes the original pre-settlement double-spawn race. R3-001 is not fully closed: lease expiry immediately after a side effect settles but before #step returns loses the result needed for cleanup, allowing an untracked live process or a permanently wedged launching generation.
## Findings

### R4-001

  - **Id:** R4-001
  - **Severity:** critical
  - **Blocking:** true
  - **Summary:** Post-step lease renewal failure loses successful spawn and generation-claim side effects
  - **Details:** PiRunner.#step awaits an operation, then renews the lease before returning its result. If that renewal detects expiry, launch() never receives the settled result. An independent fake-clock factory created a process, advanced past the lease, and returned it: launch rejected, but its outer process variable remained undefined, the process stayed live with no runner handle, and the persisted allocation remained spawning. A second probe let the fenced generation-claim CAS commit, advanced past the lease before it returned, and observed launch reject with no process while the exact registered session remained processGeneration 2/processState launching; every later launch rejected it as still live. The supplied tests cover operations stalled before settlement, not this successful-settlement/post-renewal boundary, so their 12/12 result does not establish cleanup or restart safety.
  - **Path:** src/pi/pi-runner.ts
  - **Line:** 231
  - **Recommendation:** Do not hide a completed side effect behind a post-operation renewal that can throw before the caller owns its result. For spawn, expose or assign the returned process before renewal and unconditionally terminate it if ownership is then lost. Persist owner/token and reserved/spawning/spawned intent for resumed generations as well as first sessions, so a committed pre-spawn generation claim remains safely reclaimable and an uncertain spawn fails closed. Add fake-clock tests for expiry immediately after every operation settles, asserting zero untracked live processes, no unrecoverable launching state, correct allocation cleanup, stale-owner rejection, and bounded retry behavior.

- **Completed At:** 2026-09-01T22:59:23Z