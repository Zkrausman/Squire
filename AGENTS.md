# Squire repository guidance

Start with the [README](README.md) for the current project boundaries and local test setup. Check the [roadmap](docs/roadmap/README.md) for delivery status and holds.

## Task guides

- [Scoped delivery](.agents/skills/squire-scoped-delivery/SKILL.md) covers native project preparation, scope failures, and classifying observed delivery outcomes.
- [Offline candidate review](.agents/skills/squire-offline-review/SKILL.md) covers explicit review packages and caller-selected decision records.

## Verification

Use Node 24 and the README's test setup. The [package test script](package.json) lists the files selected by `npm test`.

- [Controller CI](.github/workflows/ci.yml) defines the targeted suites, `npm test`, and the final `git diff --exit-code` check.
- [Desktop codegen source acceptance](.github/workflows/desktop-codegen.yml) runs `node --test --test-isolation=none test/desktop-codegen.test.mjs`.

Check the selected fixtures before running them. Offline tests can use temporary files and bounded local helper subprocesses. Report what each check established and keep source acceptance distinct from native qualification, installation, and actual use.
