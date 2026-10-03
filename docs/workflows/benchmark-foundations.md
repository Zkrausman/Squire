# Task preparation and benchmark reporting foundations

These are direct engineering foundations derived from the v0.2 development candidate. They do not establish a measured model-performance improvement or a promoted release. Existing release evidence remains unchanged.

## Preparation before dispatch

The controller records preparation for explicit and generated ticket sets. Generated structured plans require a focused regression path owned by the work item or a related planned owner connected through dependencies. Existing explicit structured ticket sets and legacy brief tickets can retain their configured trusted checks as validation ownership. This compatibility fallback is visible in preparation evidence and grants no additional edit authority. Ownership validation, prerequisites, fresh review, and delivery gates remain authoritative.

See [preparation.md](preparation.md) for the native environment and trusted command evidence attached before implementation.

## Public/private task descriptors

`benchmarks/contracts/task.mjs` separates a public goal, enumerated seed files, native environment identity, fixed budgets, acceptance and owned paths from private grader/reference locations. `materializeTask()` copies only regular allowlisted public files into a new workspace outside the case inputs. It rejects symlinks, multiply linked input files, unsafe paths, overlapping roots and existing destinations. Its public descriptor excludes private locations. This separates inputs; it is not an OS security boundary against arbitrary filesystem access.

`toSquireTicket()` and `toSquireProject()` adapt a validated descriptor through the existing ticket/project contracts. Project adaptation preserves subscription authentication and clamps session/job ceilings to the descriptor budget. Trusted checks and private evaluation remain operator responsibilities.

The tests create inert synthetic markers in temporary directories to verify separation. No benchmark grader, reference answer, private fixture, scored runner or experiment artifact is included in these foundations.

## Behavior and trace reporting

`src/benchmark-report.mjs` summarizes unique native job IDs, sessions by role, known input/cached/noncached/output/reasoning tokens, pending sessions, unknown final usage, timeouts, rework and elapsed time. Repeated identical usage receipts count once; conflicting usage is unknown. Cached input is part of input and reasoning output is part of output. Missing usage is never estimated as zero.

`calibrationReport()` keeps externally supplied new-behavior and preservation observations separate, requires a successful process receipt with no timeout, cancellation or output limit, and labels the report unscored with no model-performance measurement. It does not supply or execute a grader, reference implementation or model trial. Operators must obtain observations from trusted checks; candidate claims are not evidence.

The controller now records the native job ID at reservation and emits a failed terminal receipt when runtime execution throws, retaining observed usage and timeout metadata before rethrowing the original blocker. These changes make interrupted-job accounting explicit without claiming delivery success.
