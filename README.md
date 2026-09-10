# Squire

Squire is a personal AI delivery tool intended to take one software ticket through **Plan → Implement → Review → Test**, open a pull request, and leave the merge to its human owner.

## Current MVP

The approved first milestone is deliberately small:

```bash
squire run AIDEV-123
```

One trusted local controller will fetch the ticket, create one Docker Sandbox, run four independent Pi phase processes, require Review and Test to pass the current Git HEAD, and create or reuse one pull request. Docker Sandbox is the host isolation boundary; same-ticket phases share that trust boundary. Ambiguous failures stop for the owner rather than invoking production-scale recovery or compensation.

See the authoritative [Personal MVP plan](docs/personal-mvp.md) and [scope audit](docs/audits/2026-09-personal-mvp-scope-audit.md). The older [requirements](docs/mvp-requirements.md), [architecture](docs/mvp-architecture.md), and [ticket path](docs/mvp-ticket-path.md) are retained as historical design context where they conflict with the approved personal MVP.

## Developer preview

```bash
npm ci
npm run build
cp squire.config.example.json squire.config.json
# Edit repository paths, sandbox template, and github.tokenCommand; then set LINEAR_API_KEY.
npm run squire -- run AIDEV-123
```

The configured Docker Sandbox template must provide Git, Node.js, and Pi at `sandbox.piExecutable`. `sandbox.piAuthFile` is an explicitly provisioned, ticket-usable model credential copied into the sandbox; it must not be a GitHub or Linear delivery credential. `github.tokenCommand` names a trusted host helper that prints one short-lived GitHub App installation token. Squire supplies that token only to host-side Git/`gh` publication commands and never passes it into the sandbox.

> Squire is under active development. The controller-level flow is automated, but a real sandbox/template end-to-end acceptance run is still required.
