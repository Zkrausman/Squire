# Squire Wiki

Welcome to the Squire wiki. Squire is designed to be the foundational "assistant" tool across the entire repository estate.

## Core Philosophy
1. **Generic**: Squire should not hardcode business logic or repository-specific bash commands in its compiled binary.
2. **Config-Driven**: All logic should live in `squire.json` within the target repository.
3. **Pith-Compatible**: Squire must always check for the `pith` token optimizer. If present, it must wrap its internal execution so that the AI agents consuming Squire outputs receive highly optimized, compressed syntax strings rather than raw terminal stdout.

## Common Integrations

### 1. Agent Worktrees (`squire prep`)
Autonomous agents use Squire to generate isolated `git worktree` instances before mutating files.

### 2. Estate-Wide Versioning (`squire brief` / `version`)
Squire is mandated by the Global **Squire-Friendly Architectural Standard**. All projects must define a `version` or `brief` command in their `squire.json` to allow estate-wide release tracking and compliance validation.
