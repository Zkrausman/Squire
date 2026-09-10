# Personal MVP Scope Audit

- **Date:** 2026-09-10
- **Audited revision:** `origin/main` at `ab4761f532b33f9c9597aa122a2740d853aa0750`
- **Decision:** Approved scope reset; see [Squire Personal MVP](../personal-mvp.md)

## Finding

The committed repository is not proportionate to a single-user personal MVP and still cannot execute one ticket-to-PR run.

At the audited revision it contains:

- 257 tracked files;
- 15,129 production source lines;
- 8,016 test lines;
- 708 contract lines;
- no executable `squire` CLI composition root;
- no complete committed Linear → Docker Sandbox → four Pi phases → GitHub PR path.

Six infrastructure files contain 10,046 lines, 66.4% of production code:

| File | Lines | Disposition |
|---|---:|---|
| `src/pi/pi-agent-directory.ts` | 4,854 | Replace with small run-directory setup |
| `src/git/workspace-service.ts` | 2,149 | Retain basic Git operations only |
| `src/pi/wiki-footer.ts` | 1,066 | Remove from MVP composition |
| `src/plan/plan-extension.ts` | 836 | Retain structured Plan result only |
| `src/git/paths.ts` | 587 | Retain basic containment checks only |
| `src/pi/pi-runner.ts` | 554 | Retain launch/resume/timeout only |

The code optimized for adversarial runtime custody, filesystem races, distributed recovery, retention, and UI polish before delivering the product path.

## Trust-model contradiction

The accepted architecture states that sessions within one ticket intentionally share a trust boundary and that Docker Sandbox provides host isolation. Later work attempted to isolate same-ticket phases from each other with runtime custody, inode/mount evidence, cgroups, capabilities, append-only sessions, and a privileged launcher. This reversed the original boundary without a product requirement.

For the personal MVP:

- trust the owner and local controller;
- trust same-ticket phases relative to one another;
- isolate the ticket from the host using Docker Sandbox;
- keep delivery credentials on the host;
- fail visibly and recreate the sandbox after corruption.

## Hot-path disposition

| Ticket | Finding | Decision |
|---|---|---|
| AIDEV-254 | Bespoke privileged Linux custody runtime | Cancel |
| AIDEV-239 | Same-ticket runtime/session custody | Cancel; fold basic hygiene into AIDEV-255 |
| AIDEV-251 | Hostile thenable/native SQLite authority hardening | Cancel as blocker |
| AIDEV-224 | Essential intake/state purpose, disproportionate implementation | Cancel current scope; replace with minimal state in AIDEV-255 |
| AIDEV-253 | Exactly-once distributed PR compensation | Cancel; stop for owner on ambiguity |
| AIDEV-225 | Essential publication purpose, disproportionate reconciliation | Cancel current scope; retain thin publisher in AIDEV-255 |

The prior path was three hardening chains rather than a vertical slice:

```text
AIDEV-239 → AIDEV-254   custody
AIDEV-224 → AIDEV-251   SQLite authority
AIDEV-225 → AIDEV-253   publication compensation
```

## Retain

- deterministic workflow transitions;
- separate Plan, Implement, Review, and Test Pi processes;
- Review/Test freshness at the current Git HEAD;
- Pi RPC/session basics;
- one ticket-private sandbox/workspace;
- basic Git bundle verification;
- host-only Linear/GitHub credentials;
- deterministic branch and create-or-find PR;
- human-only merge.

## Defer

- AI Orchestrator;
- mandatory Herdr UI;
- automated approval;
- SQLite and migrations;
- multiple-controller leases;
- crash-perfect reconciliation;
- automatic remote compensation;
- hostile same-ticket phase defenses;
- custom custody daemon/launcher/protocol/images;
- retention and component-level disposal evidence;
- GitHub App onboarding automation.

## Preserved abandoned work

AIDEV-254's uncommitted work was archived before shutdown in retained sandbox `squire-aidev-254`:

- Manifest: `/ticket/artifacts/interventions/personal-mvp-scope-reset/manifest.json`
- Manifest SHA-256: `8d82469f1a20f2e2394311987722c1747031d5cff42d6cf6390df7b5515a586c`
- Tracked patch SHA-256: `3fdc531572bdae9cf15f1922310d5df499c2469de15dbd64b32d8c2ffc409c98`
- Untracked archive SHA-256: `bcb145ed62732f5d92d0ca032eb35dee4d7485f1af258812e81e0cb279d9d24e`

No AIDEV-254 implementation was accepted or committed.

## Replacement milestone

[AIDEV-255](https://linear.app/geltagentictrading/issue/AIDEV-255/deliver-one-personal-ticket-end-to-end-with-squire-run) is the sole first-run implementation milestone. Expansion follows only after a real ticket completes end to end.