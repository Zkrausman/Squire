# Codex limited foreground adapter

Squire runtime uses Codex exclusively. Gemini is reserved for Lore research and
review. Historical AGY trials, artifacts, and quarantines remain unchanged. The
native AGY runner and old preparation entrypoint reject before dispatch. The
coding acceptance entrypoint now accepts only `Q218C_OPERATION_V1` Codex configs.

`prepareCodexArgv` is pure data preparation for CLI version 0.160.0. It requires
an explicit model, reasoning effort, operator receipt, matching supported
model/effort tuple and a closed permission object with exactly `sandbox:
"read-only"`, `approval_mode: "on-request"` or `"never"`, and
`output_contract: "CODEX_JSONL_SINGLE_AGENT_V1"`. Missing, extra, accessor,
proxy or unsupported permission fields reject without a default or mode
normalization. The emitted argv begins
`--ask-for-approval <declared-mode> exec --json --ephemeral --sandbox
<declared-sandbox> --model <model> -c model_reasoning_effort="<effort>" -`,
with the executable supplied separately and `shell:false`. These flags bind
declared launch intent; they do not prove effective enforcement. No
output-last-message file, resume, bypass or fallback route is selected.
Ephemeral mode suppresses rollouts; it does not establish absence of other files
or host state.

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
model/effort, operator authorization and permission profile. Config and manifest
files are created without replacement at mode 0600. Missing or invalid profiles
reject before dispatch. After any source change, prepare a fresh config and
manifest so source pins and emitted intent describe that source. Runtime
identities, account evidence, credentials and captured bodies must not be copied
into public source, PRs, CI or wiki. No credentials are read by this preparation
code.

`requireCodexAdmission` binds an operator receipt, config digest, fresh job/scope
and the disclosed FIX17 paths. Fresh private preflight must independently attest
subscription allowance, effective OpenAI subscription provider, no API/paid
fallback, the admitted tuple, executable/version, supported output contract and
effective sandbox and approval mode, matching the declared profile. This intent
binding does not explain the historical requested-on-request/reported-Never
mismatch. Removing environment keys is not proof of preflight facts.
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
no native integration.

## Completed bounded operation

After PR172, one separately operator-admitted `ndjson-log-summarizer v5` operation
requested `gpt-6-luna` with `xhigh` reasoning. The generation child exited 0 after
96,454 ms with drained streams, and 14,124 source bytes were persisted. One syntax
check passed and all 17 frozen fixtures passed, including expected negative exits
2, 3 and 4. There were 19 direct-child invocations: one generation, one syntax
check and 17 fixture executions, without retry or fallback.

The reported model and inference time remain UNKNOWN. The runner's
`task_outcome_evaluated=false` remains distinct from the campaign's observed
fixture conformance. Existing source-contract `runtime_admitted=false` markers
remain unchanged; the actual operation was separately `operator_admitted=true`.
The sanitized outcome capsule is 10,690 bytes, SHA-256
`71467753fe60533fd6ff0efef19d7fa9286f22aa751118f2496067f92aae3614`.
Independent review confirmed retained-record accuracy and privacy, without
reproducing native preflight. The [published closeout](https://github.com/Zkrausman/lore/pull/108)
preserves the historical attempts and this operation's limits.

This is one frozen-task result, not general software quality, standing runtime
authority or a reusable model default. Each new operation needs its own fresh
source/config/runtime/prompt bindings, authorization and independently matched
effective preflight. A source change requires fresh preparation; it does not
repair historical witnesses.
Direct-child-only, responsive-event-loop, no descendant/crash recovery, no
max_steps enforcement and no workspace reuse limitations remain.
