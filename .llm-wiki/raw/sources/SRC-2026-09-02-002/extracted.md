# JSON Extract

- **Schema Version:** 1
- **Run Id:** run_AIDEV-216-manual-001
- **Session Id:** 29aa904e-ab22-4f65-a1d6-dc94d49cfd6d
- **Reviewed Head:** 0a4cb2a3c03b6538951c562b4d5d293d9f6b8c84
- **Status:** remediation_required
- **Summary:** The frozen branch passes contracts and 83 tests. R5-001 is closed for pre-registration processes, repeated termination failure, stale ownership, same-role exclusion, and termination_failed restart recovery, but remains blocking after registration/live persistence clears the allocation: the durable live session identity is not actionable through the explicit recovery seam on a restarted runner.
## Findings

### R6-001

  - **Id:** R6-001
  - **Severity:** critical
  - **Blocking:** true
  - **Summary:** Restart recovery ignores a noncooperative process after registration clears its allocation
  - **Details:** When lease loss occurs immediately after atomic first-session registration, the allocation has been cleared and SessionRegistration durably contains processState live plus the exact processIdentity. If bounded SIGTERM/SIGKILL cannot observe exit, #retainUnresolvedAllocation accepts that session as durable but does not create termination_failed allocation state. The original runner retains the live handle, but a restarted runner's reconcileProcessAllocation returns immediately whenever processAllocations[role] is absent, never invokes ProcessIdentityResolver, and never retries termination. The independent probe observed reconcile resolve without action, the process remain live, and same-role launch remain permanently blocked. The same gap applies after resumed live-generation persistence clears its allocation.
  - **Path:** src/pi/pi-runner.ts
  - **Line:** 44
  - **Recommendation:** Make post-registration and post-live-persistence termination failure durably actionable. Either atomically recreate an exact owner/token/generation termination_failed allocation when the matching session generation and processIdentity remain current, or persist equivalent termination ownership on the session. reconcileProcessAllocation must inspect and resolve both provisional allocations and registered live/launching termination failures, retry bounded termination, refuse unknown identity status, and only mark failed/exited after observed exit. Add first-session registration and resumed-live fake-clock tests across a new runner for repeated failed termination, stale-owner non-clobber, same-role exclusion, resolver mismatch/unknown, eventual observed exit, and successful exact-session retry.

- **Completed At:** 2026-09-02T01:19:43Z