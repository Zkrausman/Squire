# Bounded single-JavaScript task preparation

This additive path prepares a caller-defined public-text request for one Node 24
ES module at `workspace/src/task.mjs`. It is separate from the frozen Q218 task
and its 17-fixture oracle. Source/fake tests establish wiring only; this new
profile has no actual native acceptance or standing execution authority.

A request has exactly five string fields: `schema` must be
`SQUIRE2_SINGLE_JS_REQUEST_V1`, `task_id` is 1–64 lowercase letters/digits/underscore/
hyphen starting with a letter or digit, `task_prompt` is 100–31,981 UTF-8 bytes,
`runtime_target` is `node24-esm`, and `output_target` is `src/task.mjs`.
The input file is at most 65,536 bytes. Duplicate decoded keys, unknown fields,
prototype keys, malformed UTF-8, BOM/NUL and unpaired surrogates reject. Prompt
text is never evaluated or imported by the controller.

```
node acceptance/prepare-single-js-task.mjs --prepare-codex <fresh-prepared-dir> <published-source-commit> <request.json> <private-inputs.json>
```

Preparation binds the exact 787-byte channel prefix, task text, source pins,
private executable/version, explicit supported model/effort tuple, permissions
and operator receipt. It creates only a fresh prepared directory and its
no-overwrite `prompt.utf8`, `config.json` and `operation-manifest.json` at mode
0600 after retention READY. The preparation receipt says
`PREPARED_NOT_EXECUTABLE` and `runtime_admitted=false`; nothing launches.
The returned prompt view is a fresh owned copy, not an immutable typed array.

Activation requires a separate `single_js_admitted=true` admission bound to the
exact config hash/job/scope/operator receipt, with a fresh private preflight
using the existing Codex schema. The effective caller-provided read-only sandbox
and `never` or `on-request` approval mode govern; no example selects a new mode
or changes settings. Subscription allowance and effective provider require real
evidence; deleting environment keys alone proves neither.

The explicit activation entrypoint is
`node acceptance/single-js-entrypoint.mjs --run-admitted <config.json> <admission.json>`.
Default/dry invocation is inert. Source presence does not authorize invocation.
An admitted operation attempts at most one 120-second generation and one
5-second `node --check`, under a 140-second outer observation target, without
retry or fallback. Syntax uses a minimal environment excluding ambient Node
preload options. Limits require a responsive parent event loop; signal attempts
are separate from observed direct-child exit, and descendants remain untracked.

`CANDIDATE_READY` means source payload/staging and syntax checks passed. It never
means the generated program was executed or functionally correct.
`task_correctness=NOT_EVALUATED` and `task_outcome_evaluated=false` are permanent
for this profile. The fixed standard-library-only task instruction is cooperative:
staging checks format/identity and `--check` checks syntax; neither resolves or
rejects external package imports. There is no dependency installation or program
execution path. Source hashes and mode 0400 are cooperative observations, not
hostile containment, immutable custody or same-user tamper protection.

Saved `SQUIRE2_SINGLE_JS_RESULT_V1` results have a separate safe offline projection
`squire2.single_js_summary.v1`; `bin/squire-report.mjs` recognizes it without
inventing a fixture denominator. A valid generic report exits 1 because functional
acceptance is not evaluated; invalid input exits 2. The native operation can exit
0 for candidate readiness without claiming functional PASS. No automatic apply,
commit, push, workspace recycling or crash recovery is supplied. Artifact review
and explicit delivery packaging remain separate.
