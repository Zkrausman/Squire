# Readiness evidence

The controller rewrite has passed the offline suite on Windows, including real Git commits, dependent delivery, automatic conflict repair and exact postmerge checks. Runtime/delivery regressions separately prove subscription catalog selection, explicit model pin rejection, repository alias lease identity, protected root handling and synthetic merge CI identity.

All 38 offline tests passed on Ubuntu and Windows CI at implementation commit `a6b89b4160bfd9c8dc9ef3a46f918044237957a1`.

The real ChatGPT subscription probe passed on September 29, 2026. It authenticated, discovered available models, ran a shell command successfully, and wrote `readiness.txt` with verified exact contents inside the native elevated Windows workspace sandbox. Session: `01a0ef12-52b3-7fa2-b1b8-d45698cfbaa4`. The ignored `.squire/subscription-smoke-20857996-f6d3-4271-a5cd-6158710b873a/readiness.json` retains the receipt.

The previous `helper_sandbox_lock_failed` host failure was resolved by the owner taking ownership of `C:\Users\zkrau\.codex\.sandbox-bin` with Windows `takeown`. No sandbox bypass or full-access fallback was added. Run the Squire controller under the owner's normal host account so it can use that account's Codex login; invoking the controller itself inside another agent's restricted sandbox may prevent authentication access.

The user will choose the first real project. No application delivery trial or production deployment has been started by this rewrite. That project must exercise real model implementation, fresh review, GitHub checks, merges and integrated acceptance; fixture success does not establish model effectiveness.
