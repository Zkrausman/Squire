# Squire

Squire is an AI delivery platform designed to take one software ticket through a controlled **Plan → Implement → Review → Test** workflow and produce a merge-ready pull request for a human to merge.

The project is currently building its MVP. The foundation includes strict workflow contracts, durable orchestration state, isolated top-level Pi sessions, and run-scoped model and wiki configuration.

## What’s coming

The remaining MVP work will connect those foundations into a complete delivery path:

- a ticket-private Git repository and worktree;
- a persistent Docker Sandbox for each ticket;
- ticket intake, scheduling, and crash recovery;
- verified bundle export, branch publication, and pull-request creation;
- approval policy with a human-only merge boundary;
- an end-to-end workflow validation; and
- an epic closeout cycle for final testing and a knowledge/process retrospective.

See [the MVP requirements](docs/mvp-requirements.md), [architecture](docs/mvp-architecture.md), and [ticket path](docs/mvp-ticket-path.md) for the current design.

> Squire is under active development and is not yet ready for production use.
