# Sequential ticket-to-PR queue (AIDEV-311)

**Unreleased candidate. Do not install or launch a production queue before independent review and hosted checks.**

After a reviewed build is installed, load `dist/src/personal/queue-pi-bridge.js` as a trusted Pi extension. In the owner-facing Pi session, run:

```
/squire-queue AIDEV-101 AIDEV-102 --config C:/absolute/private/squire.json
```

The owner must confirm each displayed Linear contract and the final ordered list/source/config. The slash command captures live Pi identity and hands the approvals to `squire queue start` over private descriptors. A detached worker snapshots the source commit, records its UUID under `<dataDirectory>/queues/<uuid>`, and launches the existing controller for each ticket in order. The next ticket starts only after the preceding run returns a completed state with a published PR. A failed or ambiguous run blocks the queue, preserving the run's worktree, evidence, PRs and logs. No automatic retry, merge, CI-gated merge, source advancement, or installation occurs.

```
node dist/src/personal/cli.js queue status <uuid> --config C:/absolute/private/squire.json
node dist/src/personal/cli.js queue cancel <uuid> --config C:/absolute/private/squire.json
# If the original config is unavailable or invalid, read the exact private queue root:
node dist/src/personal/cli.js queue status <uuid> --root C:/absolute/private/data/queues/<uuid>
```

Cancellation is a request, not proof that the active run stopped. Check status and the individual Squire run before proceeding. `owner.lock` prevents restarting an ambiguous worker in the same queue. A worker lost after claiming the queue is not automatically recovered; inspect the individual run and logs, then ask the owner for a new decision. The starter persists an initial `queued` state before launching. A worker that can claim that state but rejects preflight persists `blocked`; if the private handoff is missing or the worker never starts, `queued` is **not** proof of liveness. Launch timeout or failed acknowledgement is ambiguous: **do not retry**. A queue is complete at PR publication only, not at merge or CI success. Install and merge are separate owner decisions.
