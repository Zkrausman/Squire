---
type: source
title: Concurrent directory identity race
status: insight
category: bugfix
created: 2026-09-06
updated: 2026-09-06
slug: directory-identity-race-concurrent-intake
---

# Concurrent directory identity race

Directory metadata is not a stable identity proof under concurrent initialization. In [[sources/aidev-224-single-ticket-intake-ledger]], concurrent artifact publication can legitimately update directory ctime, mtime, and size while the directory inode remains unchanged. `inspectResource` therefore uses stable device/inode/type/mode/link metadata for directories while retaining exact stat checks for files; this avoids false races without weakening replacement detection. Regression coverage is in `test/git-paths.test.ts`.

*Category: bugfix*

---
*Captured: 2026-09-06*

## Related

_Add links to related pages._
