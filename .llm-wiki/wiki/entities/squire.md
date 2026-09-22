# Squire

Squire is a trusted TypeScript controller for one owner-approved immutable ticket contract, one writable Implement candidate and one fresh independent read-only Verify session. It publishes only the exact verified head through a GitHub App, preserves required exact-head CI, and leaves merge to the owner.

The durable authority model is [Contract → Implement → Verify](../concepts/contract-implement-verify-workflow.md). Failure is terminal and immutable; historical state remains inspectable but cannot be executed or promoted. Model profiles and current-run telemetry cover only Implement and Verify. The separately packaged `squire-observer` is an optional observation aid only; it does not extend controller workflow authority.
