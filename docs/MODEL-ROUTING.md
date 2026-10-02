# Model routing by role

`runtime.roles` accepts `plan`, `implement` and `review` overrides with `model` and `reasoning`. Each role inherits unspecified fields from runtime defaults. Preflight checks all role pins against the subscription account's live catalog; unavailable explicit models/efforts block rather than silently substituting. Job receipts record actual CLI arguments.

Example for the catalog exposed by this trial account:

```json
{"roles":{"implement":{"model":"gpt-6-luna","reasoning":"max"},"plan":{"model":"gpt-6.1-sol","reasoning":"medium"},"review":{"model":"gpt-6.1-sol","reasoning":"medium"}}}
```

To change an existing project's model routing after explicit owner authorization, pause it and wait for its controller/jobs to settle. Then run `node bin/squire.mjs configure-runtime project.json routing.json`. The routing file may only contain `model`, `reasoning` and `roles`; command/authentication/runtime kind remain unchanged. The guarded durable transaction records a policy-change event, preserves all budgets/counters/candidates/receipts, and invalidates pending review evidence. It atomically replaces the project JSON file after persisting policy. If that file write fails, stop and restore it from the durable project's canonical config before resuming; do not modify counters or bypass configuration hashes.

Resume with `node bin/squire.mjs resume project.json`, then `node bin/squire.mjs run project.json`. All other authority changes still require a new project policy. This feature continues to use ChatGPT subscription authentication with paid API credentials removed.
