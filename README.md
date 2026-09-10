# Squire

Squire is a personal AI delivery tool intended to take one software ticket through **Plan → Implement → Review → Test**, open a pull request, and leave the merge to its human owner.

## Current MVP

The approved first milestone is deliberately small:

```bash
squire run AIDEV-123
```

One trusted local controller will fetch the ticket, create one Docker Sandbox, run four independent Pi phase processes, require Review and Test to pass the current Git HEAD, and create or reuse one pull request. Docker Sandbox is the host isolation boundary; same-ticket phases share that trust boundary. Ambiguous failures stop for the owner rather than invoking production-scale recovery or compensation.

See the authoritative [Personal MVP plan](docs/personal-mvp.md) and [scope audit](docs/audits/2026-09-personal-mvp-scope-audit.md). The older [requirements](docs/mvp-requirements.md), [architecture](docs/mvp-architecture.md), and [ticket path](docs/mvp-ticket-path.md) are retained as historical design context where they conflict with the approved personal MVP.

> Squire is under active development and is not yet ready for production use.
