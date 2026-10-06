# EmbeddingGemma 2 integration: Squire and Pith

Status: **research proposal; not implemented or benchmarked**. Public-source review: 6 October 2026. This document does not authorize model downloads, installation, inference, host probes, new data retention, runtime changes or benchmark execution. The existing [roadmap execution and baseline gates](../roadmap/README.md#current-foundations-and-evidence-limits) remain in force.

## 1. Decision

| Use | Decision | Reason |
| --- | --- | --- |
| Squire: optional local code/wiki retrieval | **Conditional go for a separately authorized, bounded experiment** | Concept-to-code search is plausible. A ticket-local utility can preserve isolation and lexical fallback, but the proposed sandbox/wiki architecture and retrieval benefit are not yet demonstrated. |
| Squire: default production dependency | **No-go now** | New-model runtime maturity, actual boundary readiness, task quality and end-to-end cost are unverified. Reliable delivery does not need a vector service. |
| Pith: synchronous learned output selection with negligible/sub-ms overhead | **No-go** | Published encoder times do not support that budget; novel output still needs encoding. Existing output-fidelity defects must be resolved before another destructive selector is enabled. |
| Pith: opt-in offline discovery or non-mutating shadow analysis | **Conditional go for a separately authorized experiment** | Explicit public/synthetic samples can test whether semantic grouping beats current command-family discovery without delaying or changing normal output. Existing telemetry does not retain an output corpus. |

**Recommended first Linux runtime candidate:** direct llama.cpp, text-only Q8_0, pinned to a build containing the new architecture; b11454 is a verified **prerelease** containing that support. Use a local pre-provisioned model file. Keep the encoder within the same ticket's Docker Sandbox as its consumers; expose a small local retrieval CLI, with one bounded resident worker only while needed. This is a candidate to validate, not a production-ready or measured deployment.

Use Transformers 5.19.0 with SentenceTransformers 6.1.0 and text-only FP32 CPU inference as a proposed reference/parity route. The latter version is a verified release, not an established minimum. Do not add multimodal encoders, a hosted endpoint, a shared host vector database, an autonomous query agent or a new workflow phase to the first experiment.

## 2. Model identity and compatibility

### Verified model contract

Google launched [EmbeddingGemma 2](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/) on 6 October 2026. It is built on Gemma 4, distinct from the earlier EmbeddingGemma 300M. The [base card](https://huggingface.co/google/embeddinggemma-2) describes 740M total parameters: approximately 270M text, 170M optional vision and 300M optional audio. Text/code and media share a 768-dimensional space and an 8,192-token context. Recommended leading-dimension slices are 512, 256 and 128; re-normalize after slicing and use matching query/corpus dimensions. FP16 can produce NaNs or silently degraded vectors; use FP32 or supported BF16 for the reference path. Quantized runtimes need their own parity checks.

The card declares Apache 2.0 but also includes a deployment statement referring to the Gemma Prohibited Use Policy. Preserve both facts in provisioning review rather than asserting unrestricted use or importing the predecessor's license assumptions. The observed [base revision](https://huggingface.co/google/embeddinggemma-2/commit/914f7f89142e33e77833254d9c9b90c3cef7303b) is `914f7f89142e33e77833254d9c9b90c3cef7303b`; freeze the actual accepted license/card, artifact revision and hashes before a future trial.

For text inputs, freeze the [official retrieval formatting](https://ai.google.dev/gemma/docs/embeddinggemma/inference-embeddinggemma-with-sentence-transformers):

| Purpose | Input template |
| --- | --- |
| Document-search query | `task: search result \| query: {query}` |
| Code-search query | `task: code retrieval \| query: {query}` |
| Corpus chunk | `title: {title or filename} \| text: {content}`; use `none` if untitled |
| Offline clustering | `task: clustering \| query: {content}` on each item |

Apply each prefix exactly once. A library's built-in document prompt can already supply the untitled prefix. The official [model-loading example](https://ai.google.dev/gemma/docs/embeddinggemma/multimodal-embeddinggemma-with-sentence-transformers) uses mean pooling with `include_prompt=True`, then normalization; CLS or last-token pooling is not interchangeable. Explicitly disable both unused encoders with `config_kwargs={"vision_config": None, "audio_config": None}` for the reference text-only load. Default initialization loads all modalities. Keeping the full source checkpoint on disk is different from loading only its text modules.

The launch-day [LiteRT embedding guide](https://developers.google.com/edge/litert-lm/embedding_models) shows a different query-prefix scheme. Resolve this against the base model and reference-quality results before choosing that route. Never silently mix template families within an index.

Vendor code-retrieval scores motivate a trial, not adoption: the [new card](https://huggingface.co/google/embeddinggemma-2) reports code MTEB 78.68 versus 68.76 and multilingual MTEB 61.36 versus 61.15. These are full-precision vendor evaluations, not Squire retrieval or Pith fidelity measurements. The gain is task-dependent; multimodal capability alone is not a reason to replace a good text baseline.

### Runtime options, as checked on launch day

| Route | Evidence | Decision for a first Linux CPU experiment |
| --- | --- | --- |
| Direct llama.cpp | [PR #30054](https://github.com/ggml-org/llama.cpp/pull/30054) merged support as `4fbc76dec51d0add466f0210855c0596589b60d4`; [b11454](https://github.com/ggml-org/llama.cpp/releases/tag/b11454) contains it, confirmed by [ancestry](https://github.com/ggml-org/llama.cpp/compare/4fbc76dec51d0add466f0210855c0596589b60d4...b11454). | Preferred small native candidate. Pin the exact build and validate embeddings. A same-day prerelease is not established production quality; older installed builds/bindings may lack this architecture. |
| Transformers + SentenceTransformers | [Transformers 5.19.0](https://github.com/huggingface/transformers/releases/tag/v5.19.0) introduces EmbeddingGemma 2; [SentenceTransformers 6.1.0](https://github.com/huggingface/sentence-transformers/releases/tag/v6.1.0) is the inspected release. | Reference/parity fallback using explicit text-only FP32 CPU loading. Larger dependency/load surface; no per-command Python/model startup in Pith. |
| LiteRT-LM | [0.18.0 embedding API/server documentation](https://developers.google.com/edge/litert-lm/embedding_models) and a [text-only 270M package](https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm) exist. | Credible alternative, especially for quantized CPU deployment. Verify platform, prefixes and parity before changing the initial choice. Published speed is not target-host speed. |
| Ollama | [v0.40.0](https://github.com/ollama/ollama/releases/tag/v0.40.0) adds this model through MLX; its [llama.cpp pin](https://github.com/ollama/ollama/blob/v0.40.0/LLAMA_CPP_VERSION) is b11351, predating the addition. [MLX runner source](https://github.com/ollama/ollama/blob/v0.40.0/mlxrunner/server.go) includes a CPU fallback. | A supported model-specific CPU-only target path remains unverified here. This is **not** a claim that Ollama CPU execution is categorically unsupported. Registry availability alone is insufficient; do not choose it solely for convenience. |
| ONNX Runtime / ONNX-backed wrappers | Generic [execution providers](https://onnxruntime.ai/docs/execution-providers/) exist, but a precise v2 export and end-to-end tokenizer/mask/pooling/projection contract were not verified in this review. | Defer. A generic ONNX backend switch or a predecessor export does not prove correct v2 support. |

The llama.cpp support PR points to [`ggml-org/embeddinggemma-2-GGUF`](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF). Prefer its text component at Q8_0 and omit media projectors; resolve and hash the exact file during separately authorized provisioning. For concrete package-size evidence, the independent converter's [Unsloth file listing](https://huggingface.co/unsloth/embeddinggemma-2-GGUF/tree/main) lists a 310 MB Q8_0 text file, 558 MB BF16 text file, and separate `mmproj` files. Those are download sizes, not process-memory limits or proof of equal quality between conversions. Do not choose an F16-labelled artifact merely because it is listed.

llama.cpp documents [x86 CPU and accelerated backends](https://github.com/ggml-org/llama.cpp/blob/master/README.md). Match the binary's instruction-set requirements to the actual target CPU; a native build from a newer machine may assume unsupported instructions. Backend availability does not establish that every new-model kernel is verified on every device. GPU access, driver compatibility, free RAM and sandbox acceleration remain future readiness checks.

Provisioning and serving must be separate. For a future SentenceTransformers reference run, load an approved local directory with [`local_files_only=True` and `trust_remote_code=False`](https://sbert.net/docs/package_reference/sentence_transformer/model.html), explicit CPU placement and a pinned dependency set. [`HF_HUB_OFFLINE=1`](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables) suppresses Hub metadata requests as well as downloads; telemetry controls are separate. These settings do not sandbox arbitrary network calls. Enforce offline runtime policy independently, and fail locally when an artifact is missing. Avoid convenience commands that fetch weights or media components when a query arrives.

## 3. Capacity and performance: evidence versus estimates

### Weight arithmetic only

The following uses rounded parameter counts and decimal units, before metadata or quantization overhead. It is **not measured RAM**, a minimum requirement, or a claim about a particular artifact.

| Active parameters | FP32 weights | BF16 weights | Ideal 8-bit weights | Ideal 4-bit weights |
| --- | ---: | ---: | ---: | ---: |
| 270M text | 1.08 GB | 540 MB | 270 MB | 135 MB |
| 440M text + vision | 1.76 GB | 880 MB | 440 MB | 220 MB |
| 570M text + audio | 2.28 GB | 1.14 GB | 570 MB | 285 MB |
| 740M full | 2.96 GB | 1.48 GB | 740 MB | 370 MB |

Real peak usage adds tokenizers and runtime libraries, scratch/activation buffers, batches and context length, loading copies, graph caches, index metadata, VM/container overhead and possibly duplicate host/device allocations. Quantization scales and mixed-precision tensors add storage. Mmap size, resident pages and file cache are different quantities. A 310 MB model file does not justify a 310 MB process limit.

No verified universal minimum or comfortable peak-RAM requirement is established for this deployment. Measure available headroom alongside builds and other services. Budget the whole host and sandbox, not only the encoder; begin with one worker and bounded batches rather than one model process per phase, and admit the workload only after its measured peak fits the resource budget.

Index arithmetic is much smaller: 10,000 FP32 vectors require 30.72 MB at 768 dimensions, 10.24 MB at 256, or 5.12 MB at 128, excluding chunk text, metadata and allocator/index overhead. MRL reduces storage and scoring work. It does **not** avoid the transformer pass or make 128d encoding six times faster than 768d encoding.

### Published measurements, with their conditions

The [LiteRT text-only card](https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm) describes an INT4-per-channel QAT package of 165 MB. Its reported text measurements use the **128-token signature**, average **five iterations**, and take memory from the **second load using caches**:

| Published device/backend | Mean text latency | Reported CPU memory |
| --- | ---: | ---: |
| Linux ARM, described as 2.3 & 2.8 GHz / CPU | 105 ms | 310 MB |
| Linux RTX 4090 / GPU | 7.6 ms | 528 MB |
| Raspberry Pi 5 16 GB / CPU | 161 ms | 282 MB |

Linux/IoT memory uses `rusage::ru_maxrss` and excludes accelerator memory. These are not first-load peaks, p95/p99, 8K-input timings, x86 CPU measurements or application end-to-end results. The ARM CPU description is incomplete. No model-specific cold-start or target-host latency was established here. These conditions must accompany the figures whenever they are reused.

Inference for architecture decisions: even the cited GPU mean is above a strict sub-millisecond budget, so these results provide no evidence for fresh synchronous sub-ms log encoding. A warm service avoids repeat loading; caches avoid work only on genuine hits. Novel logs, timestamps and identifiers still create misses. Throughput, queueing and tail latency must be measured separately.

## 4. Squire: current implementation and target boundary

The source audit is pinned to [Squire `fe140023`](https://github.com/Zkrausman/Squire/commit/fe14002370f773600d73659a0bf43548fa79dea2). Current main creates managed local Git clones through [`GitWorkspace`](https://github.com/Zkrausman/Squire/blob/fe14002370f773600d73659a0bf43548fa79dea2/src/workspace.mjs), and exposes Plan, Implement and Review in [`AgentJob`](https://github.com/Zkrausman/Squire/blob/fe14002370f773600d73659a0bf43548fa79dea2/src/ports.d.ts). Tests run through controller-owned verification. The [`Codex runtime`](https://github.com/Zkrausman/Squire/blob/fe14002370f773600d73659a0bf43548fa79dea2/src/runtime-codex.mjs) uses fresh sessions and role-specific launch policies; those flags do not establish a Docker host boundary. There is no implemented `.llm-wiki` retrieval/index service, Test/Retro agent role or embedding configuration in the inspected tree and [`validator`](https://github.com/Zkrausman/Squire/blob/fe14002370f773600d73659a0bf43548fa79dea2/src/contracts.mjs).

**Target, not shipped behavior:** one ticket worktree and ticket-local `.llm-wiki` in a Docker Sandbox shared by Plan → Implement → Review → Test → Retro. The host controller continues owning admission, candidate identity, required verification and delivery. Retrieval is an optional tool within that boundary, not a replacement AgentRuntime or controller.

Proposed data path:

1. Controller admits explicit sanitized ticket inputs and an immutable public model bundle.
2. Inside the ticket sandbox, trusted ingestion creates bounded source snapshots and a private derived index outside the candidate worktree.
3. A local CLI queries lexical retrieval and, when eligible, the bounded text-only worker. It returns cited excerpts and a receipt.
4. Consumers verify source hashes; controller verification, fresh review, ownership and delivery gates remain authoritative.
5. Ticket retirement removes ephemeral retrieval state under the declared retention policy.

No host-wide Ollama endpoint, shared mutable corpus, cross-ticket query cache, host Docker socket or remote embedding fallback is part of this proposal. Immutable public model bytes may be provisioned from the same digest without sharing private vectors or queries. If serving HTTP is needed later, bind only inside the ticket boundary, cap requests and expose no host/public port; a name such as `localhost` alone is not an isolation guarantee.

Local embedding inference does not make the surrounding Codex-backed coding workflow offline. Retrieved excerpts supplied to an agent become part of its context and remain subject to the existing authorized provider and export policy. Admit sources for that destination as well as for local indexing; do not equate offline vector generation with a promise that source text never leaves the machine.

Docker's [architecture documentation](https://docs.docker.com/ai/sandboxes/architecture/) matters here: local Sandboxes use microVMs and their own Docker state, persist across stops, and may mount a shared skills store. Local stdio MCP servers registered through its gateway execute on the **host**, including those packaged with host Docker. Therefore a “local MCP embedder” is not automatically inside the desired boundary; prefer an in-sandbox utility.

Docker's [isolation documentation](https://docs.docker.com/ai/sandboxes/security/isolation/) also states that clone mode exposes the source repository read-only, including ignored/untracked files such as `.env`. Direct mounts can expose unsafe hard links; in-VM root is available. Materialize a sanitized input view rather than assuming clone mode or read-only access hides secrets. A retrieval allowlist constrains this utility, not every process able to read the shared sandbox. Per-phase namespaces are provenance controls, **not hard confidentiality boundaries**. Hidden evaluators, credentials and private references must remain outside that boundary.

The same documentation says SSH-agent forwarding is enabled by default: keeping a key on the host does not prevent sandbox processes requesting authentication or signatures. Disable forwarding and unnecessary credential-proxy/provider permissions for the offline retrieval fixture. For an eventual coding workflow, enumerate separately authorized forwarded identities and provider capabilities at admission; do not inherit them silently or claim that phase labels restrict them.

Current [Linux prerequisites](https://docs.docker.com/ai/sandboxes/install/) include Ubuntu 24.04+, supported 64-bit hardware and working local KVM; VM hosts need nested virtualization. This review did not inspect or change any host. Installation and boundary readiness require separate authorization and evidence.

### Corpus, lifecycle and contamination policy

Default deny. Admit only explicitly allowed regular text files in this ticket's source/wiki view. `ownedPaths` and `contextPaths` can inform scope but do not grant unrestricted neighboring-file access. Repository prose cannot expand trusted admission.

Exclude Git internals/history, other tickets, controller state, credentials, `.env` variants, private keys, personal/cloud configuration, dumps, logs/transcripts, dependency/vendor/build/cache output, binary/media/archive files, evaluator/reference/holdout material and retrieval artifacts. Tracked files and `.gitignore` are not secret classifications; JSON/YAML can contain secrets. Separately admit sanitized examples when useful. Scan before both lexical and vector indexing; quarantine suspicious files without echoing values. Detection is defense in depth, not proof of absence.

Use link-aware bounded materialization: reject traversal, symlinks, unsafe hard links, submodule crossings, changing files and oversized inputs. Do not execute repository hooks/parsers while indexing. Cap files, bytes, tokens, chunks and total work in trusted configuration. Store the index outside the candidate worktree so checkpointing cannot accidentally commit it or dirty exact-candidate checks.

Vectors, queries and retained excerpts are sensitive derived data, not anonymization. Do not sync/export them by default. Define pause, expiry, cancellation and ticket-retirement retention; delete ephemeral chunk/vector/query/service state when due. Approved versioned wiki sources may be admitted afresh for another ticket, but no later ticket adopts a mutable cache. Deleting a sandbox does not erase previously exported files or host mounts; do not promise physical erasure of backups/SSDs. Preserve separately approved minimal audit receipts under existing evidence-retention rules.

### Immutable index and query contract

Set `index_id = SHA256(canonical manifest)`. The manifest binds:

- Repository, ticket/attempt, sandbox generation, phase and allowed-view digest.
- Base and candidate commit/tree; exact file manifest. Implementation snapshots also bind dirty-overlay bytes and deletions, because HEAD alone does not identify a changing worktree.
- Safe source paths, content hashes, encoding, provenance/classification, chunk IDs, exact payload hashes and line/byte spans.
- Model repository/revision and weight/tokenizer hashes; variant, runtime build, precision/quantization, prompt templates, pooling, dimensions and normalization.
- Chunker/parser versions, token/overlap limits, lexical scoring, fusion/tie-break rules, result/token caps, exclusion policy and truncation behavior.

Build from stable bytes and finalize atomically. Reuse vectors only when content and the complete embedding configuration match within the same ticket; give changed phase views new identities. Never mix old/new model vectors merely because both have 768 dimensions.

A query carries its expected index, phase/view, task type and bounded query text. Return the actual identities, retrieval mode, ordered chunk IDs, exact paths/spans/hashes, separate lexical/vector ranks or scores, timing and explicit incomplete/fallback/truncation state. Re-read and verify source hashes before consuming excerpts. On stale content, rebuild within the admitted budget or use lexical search over the same permitted current snapshot; do not silently return obsolete citations.

Start with exact dot-product/cosine search over normalized vectors and stable score/path/span/chunk-ID tie-breaking. A small worktree does not need ANN infrastructure. Begin at 256d, retain a 768d reference, and validate 128d only if storage pressure justifies it. Freeze a simple rank-fusion policy instead of inventing a learned reranker. Identical configuration does not guarantee cross-hardware floating-point identity; retain ordered result receipts for replay.

### Phase-specific use

| Phase | Admitted evidence | Guardrail |
| --- | --- | --- |
| Plan | Base source and reviewed wiki snapshot | If planning precedes ticket creation, give project planning its own admitted scope/generation. No other ticket's conversations or index. |
| Implement | Current allowed source, reviewed wiki and public tests | Refresh changed snapshots. Retrieved instructions cannot grant commands, credentials, file ownership or budget. |
| Review | Exact frozen candidate plus approved prior sources | Fresh session, complete diff and required checks remain mandatory. Implementation dialogue, self-assessment and earlier verdicts are not independent corroboration. Candidate-authored wiki changes remain untrusted diff content. |
| Test | Authorized source/docs for locating tests | Retrieval cannot select away checks, rewrite acceptance, certify success or expose private grading inputs. Executable receipts establish verification. |
| Retro | Explicitly admitted post-outcome view and sanitized failure categories | Wiki/skill proposals need normal review before later admission. No automatic promotion or hidden-grade feedback loop. |

These are proposed five-phase rules, not additional roles already accepted by current configuration. Sharing one sandbox preserves the chosen host boundary but cannot keep mutually hostile phases confidential from one another.

### Retrieval value and deterministic fallback

Prefer exact path/symbol/error/flag search first. Semantic expansion is most promising for different-wording questions about invariants, architecture decisions and distributed concepts. It cannot prove absence, enumerate every call site or replace full-diff review. Use manageable symbol/section chunks, deduplicate overlaps and return a small bounded cited context; the 8K model limit is not a recommendation for giant chunks.

Disabled, missing model/index, invalid dimensions or nonfinite vectors, timeout, overload, stale state, cancellation and unsupported runtime must produce typed local failure and deterministic lexical behavior within the same corpus/exclusion policy. Never broaden scope, download at query time or contact an external endpoint. If the admitted snapshot itself is unavailable, return an honest blocked/incomplete result rather than search elsewhere. Lexical fallback must remain independently usable; no model process is necessary when the feature is off.

## 5. Pith: keep inference off the default output path

The inspected [Pith main](https://github.com/Zkrausman/pith/commit/7929199d6afe8872f85d093cdab3b5ae39e4384c) is `7929199d`. The [direct runner](https://github.com/Zkrausman/pith/blob/7929199d6afe8872f85d093cdab3b5ae39e4384c/pkg/runner/runner.go) buffers stdout/stderr to completion, concatenates them, parses, applies Middle-Out, prints and records telemetry. Embedding at this point delays returned output. Capture memory is not bounded by a later line-count trigger, and concatenation loses stream identity/interleaving.

Middle-Out already keeps head/tail plus keyword hot zones and neighboring lines. Its [defaults](https://github.com/Zkrausman/pith/blob/7929199d6afe8872f85d093cdab3b5ae39e4384c/pkg/config/config.go) are MaxLines 500, HeadLines 100, TailLines 100. MaxLines triggers truncation; it is not a strict final cap, and truncation cannot recover evidence already discarded by a parser. Compare against this actual behavior and cheap lexical/block ranking, not a straw-man head/tail-only baseline. A test named `semantic_test.go` does not establish learned inference.

The runner's `DurationMs` stops just after `cmd.Run()`, before conversion, parsing, truncation, printing and telemetry, and excludes prior CLI/config/database initialization. Integer milliseconds and that boundary cannot validate sub-ms wrapper overhead. The README's zero-overhead positioning is not a measured SLO.

Similarity is not a calibrated measure of severity, correctness or information entropy. An uncommon stack frame or identifier can matter despite a low score; success/failure sentences can be semantically close. The current parser interface also lacks the user's debugging query. A universal “important output” query is not an established solution.

If later justified, prefer extractive ranking of contiguous diagnostic blocks with headers, test names, expected/actual values, locations and causal context. Preserve exact source text, order, offsets and truthful omission markers. Embeddings may select extra context from eligible material; they must not decide whether authoritative failures exist. Ambiguous or oversized records require conservative fallback, not silent model-limit truncation.

### Fallback parity is necessary but not fidelity

The [output-fidelity regression roadmap](https://github.com/Zkrausman/pith/blob/7929199d6afe8872f85d093cdab3b5ae39e4384c/docs/output-fidelity-regressions.md) documents still-unimplemented contracts around raw bypass, child exit status, streams, critical evidence, inventories/omissions and unsupported parser inputs. Current `pith raw` is not a verified lossless recovery path above the truncation threshold.

Two gates must remain separate:

1. **Operational parity:** feature-off, missing runtime, timeout, overload, invalid response, cancellation and no-wait cache miss reproduce the pinned deterministic baseline's bytes/status. No network fallback, installation, command re-execution or unbounded background inference queue.
2. **Output safety:** baseline parity does not repair existing defects. Before any content-changing semantic mode, execute the relevant fidelity contracts. Preserve original numeric exit status and stdout/stderr semantics separately from transformation status. Nonzero exits, warnings/failures, incomplete or upstream-truncated output, final test totals, diffs, authoritative inventories and exact machine-readable formats need protected/lossless handling before parsers and ranking. Unknown formats need conservative preservation; keyword matching cannot prove that all critical evidence survived.

Keep Pi's [existing guard policy](https://github.com/Zkrausman/pith/blob/7929199d6afe8872f85d093cdab3b5ae39e4384c/pkg/pi/pioptimize.go) and redaction. Bound input bytes/tokens, chunks, queue, concurrency, deadlines, memory and cache; validate IDs, completeness, dimensions and finite vectors. Timeouts must cancel or contain work, with a circuit breaker for repeated failures. Keep the captured source until selection settles so fallback never reruns the command.

### Best first fit: explicit offline discovery

[`pith discover`](https://github.com/Zkrausman/pith/blob/7929199d6afe8872f85d093cdab3b5ae39e4384c/main.go) currently groups passthrough command metadata by family/harness and ranks aggregate raw-token opportunity. The displayed 70% savings estimate is an assumption, not measured potential-parser savings. `is_passthrough` can coexist with subsequent Middle-Out truncation; family totals do not establish safe compression eligibility.

The [telemetry implementation](https://github.com/Zkrausman/pith/blob/7929199d6afe8872f85d093cdab3b5ae39e4384c/pkg/telemetry/telemetry.go) deliberately clears original/compressed output on record, import/export and historical-store opening. The [privacy contract](https://github.com/Zkrausman/pith/blob/7929199d6afe8872f85d093cdab3b5ae39e4384c/PRIVACY.md) makes diagnostic output logging separately opt-in, redacted and bounded; tail samples are not a complete corpus.

Therefore either cluster safe command-family metadata, acknowledging that it cannot reveal absent log structure, or use explicit synthetic/public logs or separately authorized bounded/redacted samples. Return representative exact blocks and proposed parser families for human review. Do not silently enable capture, scrape old private logs, auto-install parsers or promote a cluster into runtime policy.

Keep new observations metadata-only and fixed-schema by default: version/mode, bounded reason codes, counts, timing buckets and queue drops. Samples and vectors need their own local retention/deletion policy and remain outside normal sync/export. Redaction is heuristic. If asynchronous capture is ever authorized, use a bounded nonblocking queue and drop optional samples on overload; do not wait for a flush/spool before returning output. A goroutine in a short-lived CLI is not reliable background processing, and off-path CPU/RAM/I/O contention can still slow normal commands.

## 6. Smallest future MVP and decision gates

The smallest useful experiment is **one text-only Squire retrieval utility over one explicitly admitted public/synthetic source snapshot**, with lexical-only output kept as the default. Pith starts with a separate offline sample-analysis invocation that cannot change command output. No multimodal support, shared daemon across tickets, hosted service, new production telemetry or automatic corpus expansion.

| Step | Scope after separate authorization | Required outcome before continuing |
| --- | --- | --- |
| A. Contract-only fixture | Synthetic manifests, fixed fake vectors and lexical fixtures; no model | Scope/path/secret markers, phase contamination, stale snapshot, malformed vector, timeout and deterministic fallback cases pass; index never enters candidate commits. This fixture is proposed, not supplied/executed here. |
| B. One offline runtime check | Approved dependencies/weights, pinned revision/build, text-only CPU load inside the selected boundary | Correct prefixes/pooling/normalization and finite output; 256d versus 768d reference parity; no unexpected downloads, egress, media load or host exposure. Missing artifacts fail locally. Record actual resource use. |
| C. Retrieval-quality trial | One bounded code/docs/wiki corpus; a frozen labelled query set spanning concept queries, exact symbols, no-answer cases and misleading near-matches | Compare lexical, lexical/block ranking, vector and fixed hybrid retrieval at equal context budget. Report Recall@k plus MRR/nDCG, citation correctness and failure cases. Keep the simpler baseline unless a reproducible material benefit survives a separate held-out set. |
| D. Optional Pith shadow trial | Explicit public/synthetic log fixtures only, no live capture or changed normal output | Compare shipped/repaired deterministic selection, lexical blocks and embeddings at equal retained budget. Report diagnosis/completion usefulness and every protected-evidence regression. No token-savings-only promotion. |
| E. Production decision | Separate reviewed integration proposal after earlier evidence | Retain existing execution/comparison holds and larger-baseline prerequisites for any Squire delivery-effectiveness campaign. A small retrieval fixture is not independently graded application delivery. |

Before an execution trial, freeze the exact corpus, budgets, primary quality metric, meaningful improvement threshold and stopping rule. Start with a small auditable set of natural-language concept queries and exact-match controls; expand only if the result is promising. Report uncertainty, unsuccessful cases and all setup/index/query costs. Do not tune and report on the same held-out questions.

**Privacy/isolation gate:** no disallowed path, cross-ticket content, private evaluator input, secret marker or unauthorized query/content egress in the synthetic negative corpus; embedding/index/query execution is offline, while model/dependency provisioning and any authorized agent-provider transmission are separate policies. Verify actual mount/MCP/service placement, policy enforcement, cleanup and receipt disclosure. A clean secret scan is not a proof of universal secrecy.

**Correctness gate:** exact-candidate citations resolve; changed/missing files cannot masquerade as current; failure is explicit. For Pith, require 100% preservation of protected evidence in the deterministic acceptance corpus, exact exit/stream assertions and baseline-exact operational fallback. Include quiet nonzero exits, stderr-only warnings, late/multiline failures, success text containing failure words, inventories, malformed/structured output, huge lines, Unicode, trailing newlines, upstream truncation, OOM and queue overflow. These finite tests do not prove all possible output safe.

**Latency/resource gate:** use high-resolution monotonic timings around the complete invocation and its phases. Report cold-start-to-ready, first and warm query p50/p95/p99, sample counts, 128/512/1024-token workloads, batch throughput, index build/update, peak RSS/PSS, whole-container/VM memory, accelerator memory if any and contention with normal builds/commands. Separate filesystem/model cache hits from misses. Freeze an acceptable Squire query/index budget before measuring; no latency was measured for this proposal.

For Pith's strict negligible/sub-ms requirement, the proposed default-path threshold is **less than 1 ms p99 additional end-to-end latency on the actual target**, including novel uncached eligible output and overload/fallback, with bounded memory and no unbounded waiting. This is an acceptance threshold, not a forecast. Use matched fixture measurements rather than subtracting unrelated medians. A mode that misses it stays off the default path; an opt-in synchronous view would need an explicitly relaxed budget. Offline analysis must have no inference dependency on output delivery and must pass contention checks.

**Stop/rollback:** retain lexical/deterministic behavior if quality gain is unclear, a privacy/fidelity gate fails, or full resource costs exceed the agreed budget. Remove optional worker/index state under the approved retention policy and preserve minimal permitted evidence. Do not repair a failed experiment by broadening data access, relaxing verification, hiding unsuccessful results or reclassifying measured delay as negligible.

## 7. What this investigation establishes

- The model and several launch-day runtime integrations exist; direct native text-only inference is a plausible Linux route. Exact target compatibility and production maturity remain unverified.
- Local retrieval can fit the requested shared ticket boundary if input materialization, service placement, provenance and lifecycle are explicit. Current Squire does not yet implement that target architecture.
- Semantic retrieval may help concept discovery, while exact/lexical tools and controller-owned verification remain indispensable.
- There is no evidence that fresh embeddings meet Pith's default-path sub-ms requirement. Offline discovery is the lower-risk first question, and its data must be supplied or separately authorized.
- No target-host probe, model download, installation, inference, benchmark or product runtime change was performed for this report. Public vendor measurements are attributed; all arithmetic, inference, proposed contracts and unexecuted gates are labelled as such.

Research retrieval note: some newly published model pages were intermittently unavailable through direct page retrieval. Official-domain indexed source text and live read-only GitHub release/source/ancestry metadata were cross-checked. Version and capability statements are a launch-day snapshot, not a promise that later releases retain identical behavior.
