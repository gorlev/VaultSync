# Validation record — 1 October 2026

- Node 24.13.0; pinned chokidar 5.0.0 and simple-git 4.0.2.
- `npm ci --ignore-scripts`: succeeded from the dependency lockfile; npm reported no vulnerabilities.
- `npm test`: **23 passed, 0 failed**, no skips. Full result: [TEST-RESULTS.txt](TEST-RESULTS.txt).
- `npm run check` and syntax checks for every source module: passed.
- Source hashes: [SOURCE-SHA256.json](SOURCE-SHA256.json).

The suite uses temporary vaults and local bare remotes. It verifies trailing
30-second debounce, atomic editor saves, ignored changes, startup/five-minute
pulls, deferred integration of dirty vaults, offline commits/retries, rejected
pushes and a concurrent-device race after the second pull. It checks complete
local/incoming bytes for Markdown, binary attachments and Obsidian configuration,
multiple unpushed commits, repeated same-day copies, edit/delete and rename cases,
Unicode/spaces/tabs/newlines/leading dashes, changes before and during application,
real SIGKILL/restart recovery, duplicate daemons, manual rebase refusal, unsupported
structures, timestamps/conflict discovery, private-repository verification
boundaries, protected external credentials, symlinked CLI invocation, and secret
non-disclosure even under ambient dependency DEBUG settings.

**Live macOS launchd passed** against the finished source. The test used a
filesystem-isolated runtime, a disposable vault with spaces in its path and a local
bare remote. `plutil`, bootstrap/enable/kickstart, `launchctl print`, startup remote
integration, an actual production 30-second watched commit/push, status timestamps,
bootout and service-definition removal all passed. The temporary service, vault
and state were removed. Machine-readable evidence: [VALIDATION.json](VALIDATION.json).

Not performed:

- A live Linux/systemd user-service run (templates and command dispatch were tested;
  Linux checks are documented in README).
- A live private GitHub repository or real token; private-repository verification
  was tested with an injected verifier, and the token bridge used a dummy token.
- Cross-filesystem/power-loss recovery, macOS protected-folder permissions on the
  user's actual vault, or arbitrary editor writes through displaced open descriptors.
- Mobile-client execution. README gives manual Working Copy/MGit flows and states
  that desktop conflict automation does not run there.

No existing user vault was initialized or connected to GitHub. No persistent
vaultsync service was left installed. The implementation tests ran before publication of this source repository.
Publishing the utility source does not enable synchronization of a user vault.
