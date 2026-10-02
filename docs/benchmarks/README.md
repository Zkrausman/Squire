# Squire benchmark briefs

The tldraw document contains three standalone product-input pages:

1. Scribble Blackjack Shooter v2 — intentionally ambiguous game concept; agent chooses mechanics and decomposition.
2. Local Job Queue v1 — client/API/workers, CSV results, concurrency and recovery.
3. Local Log Explorer v1 — mixed log ingestion, exact queries/timelines, saved state, export and large-file responsiveness.

These are the final three options. StickyCanvas has been retired from this suite; historical briefs and results remain in Git and trial evidence.

For each fresh benchmark run, provide only the selected page as product input. Pin the page version and hash, environment, models and budgets separately. Agents choose architecture and task breakdown. Keep independent grading fixtures and previous solutions outside their input. Preserve all attempts, failures, interventions and unknown usage. Functional acceptance and creative quality are separate measurements. Model changes and framework changes are separate comparisons.

Freeze these versions for repeated runs. Requirement changes require a new version; never rewrite an old result's input. This is a benchmark-input commit, not a new runtime release or a completed benchmark run.

`briefs.json` is a readable export of the saved canvas text/shape positions, for review and reproducible selected-page extraction. The tldraw document is the visual source. Do not pass all three pages or this runner guidance when benchmarking one product.
