# A3 oracle assurance: entry identity and declared inputs

## Decision

Source-only assessment of Squire [`87eefbc11cf54eda7816f1bd9479d2fcc12ed4cb`](https://github.com/Zkrausman/Squire/commit/87eefbc11cf54eda7816f1bd9479d2fcc12ed4cb), 15 October 2026. No oracle, probe, inference or proposed acceptance test was executed for this assessment.

Keep the shipped A3 guarantee narrow: frozen entry-definition identity plus current candidate-bound configured-command observations. It does not establish immutable oracle dependencies. This limitation is already stated in [criterion evidence](../criterion-evidence.md); the material missing facility is a retained, enforced binding for explicitly declared oracle inputs. The next useful correction is an opt-in bounded input manifest with an honest assurance label. Implementation remains proposed, not authorized by this brief.

## What current evidence establishes

| Boundary | Source-backed guarantee and limit |
| --- | --- |
| Frozen definition | [`assertCriterionDefinitions`](https://github.com/Zkrausman/Squire/blob/87eefbc11cf54eda7816f1bd9479d2fcc12ed4cb/src/criterion-evidence.mjs#L33) binds permitted inline Node argv to `digest(check)` or checks the raw SHA-256 of the named external entry file. It does not recursively inspect imports or files read by that code. |
| External entry | The same function requires an exact absolute path outside the managed project root. [`trustedBytes`](https://github.com/Zkrausman/Squire/blob/87eefbc11cf54eda7816f1bd9479d2fcc12ed4cb/src/criterion-evidence.mjs#L15) rejects nonregular, multiply linked and oversized files and checks metadata around its read. This checks entry bytes at verification boundaries; execution later opens the path again. It is not atomic loaded-byte attestation or hostile same-user isolation. |
| Observed result | [`VerificationRunner`](https://github.com/Zkrausman/Squire/blob/87eefbc11cf54eda7816f1bd9479d2fcc12ed4cb/src/verification.mjs#L11) retains command-definition/resolved-argv digests, output and process-result facts. [`freezeBinding`](https://github.com/Zkrausman/Squire/blob/87eefbc11cf54eda7816f1bd9479d2fcc12ed4cb/src/check-evidence.mjs#L33) binds project, ticket, candidate/tree, contract, check policy and producer identity. These are not a dependency manifest. |
| Criterion consumption | [`resolveCriterionEvidence`](https://github.com/Zkrausman/Squire/blob/87eefbc11cf54eda7816f1bd9479d2fcc12ed4cb/src/criterion-evidence.mjs#L59) rechecks definitions and current immutable observations, refusing failed or incompatible evidence. Successful mapped observations do not independently establish the oracle's correctness or all executable inputs. |

Ticket dependency edges are scheduling/ownership evidence, not a Node import graph. The supported [`checkOwnership` shape](https://github.com/Zkrausman/Squire/blob/87eefbc11cf54eda7816f1bd9479d2fcc12ed4cb/src/contracts.mjs#L65) contains only check name, kind, path and SHA-256; it has no oracle-input inventory.

## Why entry identity is insufficient

Node 24 documentation describes relative CommonJS loads from the calling file, package lookup and additional `NODE_PATH` search locations. ESM supports package resolution and dynamic imports. Thus a frozen external `oracle.cjs` can still load a separately changed `helper.cjs`; entry identity alone does not bind that helper. This is a static counterexample, not an executed defect or evidence that a candidate can write the owner's helper. [CommonJS resolution](https://nodejs.org/docs/latest-v24.x/api/modules.html#file-modules), [global search paths](https://nodejs.org/docs/latest-v24.x/api/modules.html#loading-from-the-global-folders), [ESM imports](https://nodejs.org/docs/latest-v24.x/api/esm.html#import-expressions).

Node also interprets `NODE_OPTIONS` and supports startup modules through `--require` and `--import`. Squire's [check invocation](https://github.com/Zkrausman/Squire/blob/87eefbc11cf54eda7816f1bd9479d2fcc12ed4cb/src/verification.mjs#L17) removes listed credential variables; its [supervisor environment](https://github.com/Zkrausman/Squire/blob/87eefbc11cf54eda7816f1bd9479d2fcc12ed4cb/src/process.mjs#L238) otherwise merges ambient environment with request overrides. The [request payload](https://github.com/Zkrausman/Squire/blob/87eefbc11cf54eda7816f1bd9479d2fcc12ed4cb/src/process.mjs#L177) records those explicit overrides, not a complete effective-environment attestation. No claim is made that such variables were set in any historical run. [Node 24 startup and environment options](https://nodejs.org/docs/latest-v24.x/api/cli.html#node_optionsoptions).

The referenced Node 24 documentation rendered as v24.22.0 during this assessment; these documentation reads are not execution evidence for an installed minor version. A lockfile, candidate Git tree or resolved argv path alone does not prove the bytes of every loaded oracle dependency. Candidate artifacts intentionally inspected as the object under test must remain distinct from trusted code/data that determines the verdict.

## Smallest useful implementation admission

Propose one opt-in, versioned owner contract for a bounded list of independently controlled oracle files, including resolution metadata where relevant. Freeze canonical paths and raw digests, cap file count and total bytes, bind the manifest digest into contract/check evidence, and revalidate listed inputs before admission and when resolving candidate/delivered observations. Preserve current gates and deny/unknown outcomes. Keep legacy entry-only behavior and receipts explicitly entry-only; do not rewrite historical acceptance.

Label the stronger result **declared inputs verified**, never **complete dependency closure verified**. Owner review must justify the inventory and identify unresolved dynamic loads, external data, runtime and loader/environment assumptions. A missing stronger profile blocks a stronger claim; neither filename scanning nor one observed import trace proves completeness. Loader-environment enforcement and hostile-code isolation need their own admitted scope. Do not collect or publish raw environment values.

## Proposed acceptance tests — not run

1. Freeze an entry and a declared helper; change only the helper. Entry-only evidence must not claim to detect it, while the new manifest profile refuses the mismatch before worker admission or criterion acceptance.
2. Change manifest membership, a relevant resolution file or a listed digest; invalidate candidate/delivered bindings and require fresh evidence. Wrong-head, omitted or altered manifest references cannot pass.
3. Reject missing, denied, aliased, nonregular, multiply linked, oversized and changed-during-read inputs without a weaker retry. Retain existing source/evidence protection and version-1 behavior.
4. Exercise an unlisted dynamic dependency and loader/environment variation. A declared-file match must still carry the stated limitation; no test may relabel it complete closure or imply atomic loaded-byte attestation.

Parent admission should freeze that profile's schema, bounds, file ownership and compatibility policy before implementation. This brief changes no runtime behavior, security setting, process-settlement claim, benchmark hold or Herdr acceptance boundary.
