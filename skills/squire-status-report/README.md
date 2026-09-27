# Squire status-report skill — source package

`SKILL.md` is the portable source for owner-requested, read-only hot-path status reports. This directory in the Squire repository is **not** a Pi-discovered skill location by itself. A PR or merge does not install, activate, or run it; Squire's own Plan/Implement sessions explicitly disable skills.

After separate owner approval to activate, place this directory under a Pi-discovered location such as `~/.pi/agent/skills/squire-status-report/` (user-wide) or a trusted project's `.agents/skills/squire-status-report/`. In a fresh Pi session, verify it appears in skill discovery and invoke `/skill:squire-status-report` for a status request. If editing during a live session, use `/reload` before testing. Do not overwrite an existing skill without inspecting it. The skill reports from read-only evidence and never authorizes ticket transitions, merges, installation, or broker actions.
