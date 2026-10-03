# Prepare work before implementation

Planning should produce complete work items with clear outcomes, explicit owned paths, dependencies, acceptance criteria, and a focused regression test owner. The test can belong to the same item as the behavior or to a separately owned item connected by a dependency. Keep that choice tied to the repository's existing boundaries; there is no required ticket count, file count, or one-file rule.

For generated plans and structured tickets supplied explicitly in project configuration, Squire validates ownership and dependencies before implementation dispatch. Newly generated structured work items must have a focused test path in their own authorized paths or in a related planned owner connected through dependencies. A generated work item without such an owner is rejected before implementation dispatch. This supports a combined behavior-and-test item or a separate test item without imposing a ticket count, file count, or one-file rule.

Legacy tickets without structured execution ownership, whether brief-generated or supplied explicitly, remain runnable through the established serialized repository workflow. Explicit structured ticket sets also preserve existing compatibility when their ownership does not name a test path: preparation visibly records the service's configured trusted checks as validation ownership. This fallback grants no additional edit authority, does not apply to newly generated structured plans, and never removes configured checks or fresh review. A new explicit task should include its focused tests or a named dependency whenever those tests require edits.

Squire records preparation evidence for each accepted item before dispatching implementation:

- **Focused test ownership** names the ticket, its authorized paths, paths recognized as test locations, and related planned test owners with their paths. Test work must stay within those paths or an explicitly planned test-owner dependency.
- **Native environment** records the host platform and architecture, Node executable and version, ticket-workspace working directory, configured setup commands, and trusted check commands. The setup and check commands retain their configured arguments and execute in the prepared ticket workspace. Use them on the native host to reproduce validation; do not invent replacement checks.

The preparation record accompanies the ticket plan and implementation handoff. It does not change the execution contract, validation authority, independent review, or delivery gates.
