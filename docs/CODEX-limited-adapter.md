# Codex limited foreground adapter

Squire runtime uses Codex exclusively. Gemini is reserved for Lore research and
review. Historical AGY trials, artifacts, and quarantines remain unchanged. The
native AGY runner and old preparation entrypoint reject before dispatch. The
coding acceptance entrypoint now accepts only `Q218C_OPERATION_V1` Codex configs.

`prepareCodexArgv` is pure data preparation for CLI version 0.160.0. It requires
explicit caller model, reasoning effort, operator receipt and matching supported
model/effort tuple. It has no production model, effort, executable or hash default.
The argv is `exec --json --ephemeral --sandbox read-only --model <model> -c
model_reasoning_effort="<effort>" -`, with executable supplied separately and
`shell:false`. No output-last-message file, output schema, resume, bypass or
fallback route is selected. Ephemeral mode suppresses rollouts; it does not
establish absence of other files or host state.

The private collector validates all JSONL bytes through the content-free
`decodeCodexJsonl` metadata API, then extracts source privately. The restricted
Squire v1 profile requires one `turn.started`, exactly one completed
`agent_message` before exactly one `turn.completed`, and no later events. This
is a conservative admission subset, not a universal Codex producer guarantee.
Ambiguous, missing/non-string, failed, conflicting, malformed and trailing events
fail closed. Empty text reaches the unchanged 100-byte minimum and eligible
local rejection retention. Accepted source remains bounded to 65,536 UTF-8 bytes.
Raw message/error text is absent from metadata, records and public diagnostics.
Reasoning counters remain separate from thinking; totals, model identity and
inference time are never inferred. Missing counters remain UNKNOWN; zero remains
zero.

The foreground core owns a prompt copy and writes it once after spawn, observes
write completion and backpressure drain, then ends stdin and observes completion.
Early exit, close, EPIPE/write/end errors fail closed. Pending stdin remains under
the original deadline and cancellation control. Signal attempts and observed
exit are separate; closure of streams never proves descendant cleanup.

Preparation is explicit and disabled by default:

```
node acceptance/prepare-bounded-codegen.mjs --prepare-codex <fresh-prepared-dir> <published-source-commit> <private-inputs.json>
```

The private inputs contain fresh job/scope, executable identity/version, explicit
model/effort, operator authorization and effective permission profile. Config and
manifest files are created without replacement at mode 0600. Runtime identities,
account evidence, credentials and captured bodies must not be copied into public
source, PRs, CI or wiki. No credentials are read by this preparation code.

`requireCodexAdmission` binds an operator receipt, config digest, fresh job/scope
and the disclosed FIX17 paths. Fresh private preflight must independently attest
subscription allowance, effective OpenAI subscription provider, no API/paid
fallback, the admitted tuple, executable/version, supported output contract and
actual approval mode. Removing environment keys is not proof of those facts.
Credits Off is an AGY/Lore control and is absent from Codex admission. No signing
keys or PKI are added. These are supplied evidence assertions, not authentication
or runtime qualification established by pure validation.

The current 9,640-byte public prompt, all 17 fixture/oracle definitions, Node
program executor, source staging, 120-second generation budget, 85-second fixture
aggregate and 250-second outer observation target are reused. Successful
generation alone is insufficient: syntax and all 17 fixture oracles must pass.
Fresh source/config/runtime/prompt pins and retention READY precede any admitted
native attempt. There is no retry, provider fallback, automatic permission grant
or credential/security change.

Fake tests exercise collector, profile, stdin, core, physical staging ports and
configuration/admission. They launch no provider or generated program and prove
no native integration. Real Codex execution remains unadmitted until the exact
owner-selected model/effort and remaining readiness evidence are established.
Existing direct-child-only, responsive-event-loop, no descendant/crash recovery,
no max_steps enforcement and no workspace reuse limitations remain.
