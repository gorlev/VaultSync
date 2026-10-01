# vaultsync

A small Node 24 command for one Obsidian vault and one private GitHub repository.
It includes attachments and shared `.obsidian` configuration. Git is the history;
there is no telemetry, hosted sync backend, or history UI.

**Disable Obsidian Sync for this vault before enabling vaultsync.** Back up the
vault first. GitHub privacy is access control, not end-to-end encryption.
Encrypted-vault workflows are outside this tool's scope.

## Install the command

Prerequisites: Node **24**, Git, and GitHub CLI (`gh`). Set your Git identity:

```sh
git config --global user.name "Your name"
git config --global user.email "you@example.com"
gh auth login
gh auth setup-git
```

Clone the public **VaultSync application source** into a directory outside your
Obsidian vault. The example below uses `~/.local/share/vaultsync`; you can choose
another installation directory. This source repository is separate from the
private repository that will hold your vault's notes and attachments.

For a new installation, run these commands from any directory:

```sh
VAULTSYNC_INSTALL_DIR="$HOME/.local/share/vaultsync"
mkdir -p "$(dirname "$VAULTSYNC_INSTALL_DIR")" "$HOME/.local/bin"
git clone https://github.com/gorlev/VaultSync.git "$VAULTSYNC_INSTALL_DIR"
cd "$VAULTSYNC_INSTALL_DIR"
npm ci --ignore-scripts
ln -s "$VAULTSYNC_INSTALL_DIR/src/cli.js" "$HOME/.local/bin/vaultsync"
export PATH="$HOME/.local/bin:$PATH"
vaultsync --help
```

`git clone` needs a destination that is absent or empty. If you already have a
working installation, skip the clone and command-link steps. Do not clone over
existing files. If a `vaultsync` command already exists, inspect it with
`ls -l "$HOME/.local/bin/vaultsync"`; a link to this same installation needs no
replacement. Do not overwrite another executable. No global npm linking or
prefix configuration is required.

To update an installation originally created with `git clone`, stop its daemon,
then run:

```sh
cd "$HOME/.local/share/vaultsync" # Use your installation directory if different.
git pull --ff-only
npm ci --ignore-scripts
vaultsync --help
```

Restart the daemon after the update. If you previously installed by copying files,
that directory may not be a Git checkout; these `git pull` steps do not apply to it.

Add that PATH setting to your shell profile. The service uses absolute Node and
command paths; re-run `install` after moving the installation or upgrading Node.
Dependencies are pinned to chokidar 5.0.0 and simple-git 4.0.2 in the lockfile.
Do not install another Node major version for this command.

## First machine

Create an **empty private** repository; do not initialize it with a README or license:

```sh
gh repo create OWNER/REPO --private
vaultsync init --vault "/absolute/path/My Vault" --repo OWNER/REPO
vaultsync run --vault "/absolute/path/My Vault"
```

`init` requires explicit vault and repository inputs. It verifies GitHub's
`private` field with `gh api`, rejects a different origin, multiple origin URLs,
separate push URLs, and URL rewrites. It accepts direct HTTPS or GitHub SSH URLs
for an existing origin. A new repository uses HTTPS. An existing repository must
be rooted exactly at the vault, with `main` checked out and no unfinished manual
Git operation. It never silently connects an enclosing repository.

`init` creates a local snapshot commit and external configuration; it does not
push or install a daemon. `run` watches until Ctrl-C. Confirm `status` after the
first push, then install the background service:

```sh
vaultsync status --vault "/absolute/path/My Vault"
vaultsync install --vault "/absolute/path/My Vault"
```

Do not run the foreground daemon alongside the service. There is one exclusive
process lock per canonical vault path. A duplicate exits without disturbing the
owner. Stale locks from dead processes are reclaimed; malformed locks or stale
reclamation claims require inspection rather than guessing.

## Second machine

**Clone before opening the vault in Obsidian.** Do not initialize a separate,
nonempty Git history and expect unrelated histories to merge automatically.

```sh
gh auth login
gh auth setup-git
git clone --branch main https://github.com/OWNER/REPO.git "/absolute/path/My Vault"
vaultsync init --vault "/absolute/path/My Vault" --repo OWNER/REPO
vaultsync run --vault "/absolute/path/My Vault"
# Check status, stop foreground run, then:
vaultsync install --vault "/absolute/path/My Vault"
```

Open the cloned folder as an Obsidian vault. Attachments, plugins and shared
configuration travel with it; window/workspace state does not.

## Credentials

The default is the system Git credential helper. `gh auth setup-git`, a suitable
OS credential helper, or SSH keys with an available agent can provide credentials.
Background Git is noninteractive: authentication failure leaves local commits
intact and retries on the next scheduled cycle. The service must have access to
the same credential helper/SSH agent as the current user.

For an optional token bridge, create a file **outside the vault**, owned by the
current user, with mode 600. Use a fine-grained token permitted to read/write
repository contents in the selected private repository. Create/edit the file
without placing the token on a shell command line:

```sh
mkdir -p "$HOME/.config/vaultsync"
chmod 700 "$HOME/.config/vaultsync"
touch "$HOME/.config/vaultsync/github.env"
chmod 600 "$HOME/.config/vaultsync/github.env"
# Edit the file locally and add: GITHUB_TOKEN=your_token
vaultsync init --vault "/absolute/path/My Vault" --repo OWNER/REPO \
  --env-file "$HOME/.config/vaultsync/github.env"
```

This is a restricted dotenv format: one `GITHUB_TOKEN=value` assignment, optionally
single- or double-quoted. It does not execute shell syntax or interpolate values.
`gh` receives the token through its environment only during private-repository
verification. Git requests it over the credential helper's stdin/stdout protocol,
only for HTTPS `github.com`. The helper rejects other hosts and never stores it.
No token goes in Git URLs, arguments, commits or logs. Token bridge mode replaces
other credential helpers for this process; HTTPS is required for it to be useful.
To return to the system helper, run `init` again without `--env-file`.

`.env` and `.env.*` files at any depth, `.trash/`, and `.obsidian/workspace*` are
excluded. Newly excluded tracked files are removed from subsequent snapshots
without deleting their local copies. **Old Git history is not purged**; a secret
previously committed must be revoked and handled separately. Ordinary vault
files are included even if another custom `.gitignore` pattern excludes them:
this command snapshots the entire eligible vault, rather than using `git add .`.

## Timing and status

- Eligible file changes, including atomic editor saves, reset a trailing **30-second** debounce.
- Startup and every **five minutes** fetch and integrate `origin/main` by rebase.
- If edits are pending, commit their snapshot after debounce before integration.
- Fetch/integrate again immediately before a normal push. A device that wins the
  remaining race causes a rejected push; the next cycle fetches/rebases/retries.
- Offline and authentication errors retain all local commits. No force-pushes.
- Operations are serialized. Commit subjects are `vaultsync: <hostname> <ISO timestamp>`.

```sh
vaultsync status --vault "/absolute/path/My Vault"
```

Status reports daemon liveness, `lastPush`, `lastPull`, pending file paths, the
latest error, discovered conflict copies, a pending recovery journal, and the
external state directory. Unsuccessful/never-attempted operations are **`never`**;
failures do not advance success timestamps. A pull timestamp means a successful
fetch/integration, including an already-integrated or empty remote. It does not
mean a subsequent push succeeded. Conflicts are discovered from actual filenames,
so old copies remain visible until reconciled and removed.

## Conflicts and preservation

Rebase happens in a temporary **worktree of an isolated local bare repository**,
with read-only access to the live object database. Its own `info/attributes`
disables filters, line-ending conversion and working-tree encoding for byte
preservation. The live vault is not checked out or reset during rebase.

Before integration, a local `refs/vaultsync/recovery/...` preserves the complete
pre-pull commit, including multiple unpushed commits. The completed candidate
also receives `refs/vaultsync/integrated/...` after its objects are imported.
These recovery refs are local only; normal pushes send `main` only.

For a content conflict:

- The complete **local pre-pull tip** remains at its original path.
- The complete **incoming remote tip** becomes `name.conflict-YYYY-MM-DD.md`.
- Date uses the device's local timezone. Existing names get `-2`, `-3`, etc.
- Attachments/configuration retain their extension, e.g. `photo.conflict-2026-10-01.png`.
- Edit/delete conflicts retain whichever complete content exists. Deletion intent
  is recorded in the path-only log and remains visible in Git history.
- Rename conflicts preserve the local and remote destinations/versions. Clean
  rename/edit integrations can move the edited content to the renamed path.

Resolution reads explicit saved local and remote commit objects. It never uses
rebase's reversed “ours/theirs” meanings. NUL-delimited Git output and literal
paths support spaces, Unicode, tabs, newlines and leading dashes.

To reconcile: compare the original and conflict copy, put the desired final
content into the original, then delete the copy. The daemon commits that change
after debounce. For attachments, inspect both files with the appropriate app.
Conflict copies remain ordinary shared files until you remove them.

Unsupported symlinks, submodules, special files, non-UTF-8 Git paths, ambiguous
conflict structures and file/directory transitions stop integration and report
an error. Case/Unicode filename collisions are conservatively refused on macOS.
The live vault is preserved for manual reconciliation. Use regular UTF-8-named
files, and avoid case-only naming differences between operating systems.

## Recovery and edits during integration

The engine compares the live snapshot before applying the candidate. If the vault
or HEAD changed, it leaves newer edits in place and retries after debounce.
Application writes a durable external journal and complete before/after recovery
copies **before** replacing or deleting files. Each touched file is compared again.
Replacements temporarily move the original to a unique sibling transaction file,
then create the destination exclusively, so a newly recreated editor file is not
overwritten. Transaction siblings are excluded from watching and Git snapshots.
The original is retained externally before the sibling is removed. Cross-filesystem
state directories do not require moving vault files onto the state filesystem.

On restart, an unfinished journal is recovered before watching. If HEAD already
advanced, the engine finishes the index update. Otherwise it restores known
transaction changes while preserving distinguishable newer user edits. Recovery
copies and manifests remain outside the vault; no automatic garbage collection
removes them. A changed HEAD requiring manual inspection leaves the journal intact.

This is per-file recovery, not an atomic filesystem snapshot of the whole vault.
There can be short-lived missing paths while a replacement is installed. An
editor writing through an already-open old file descriptor cannot be coordinated
by a watcher; the displaced inode/recovery copies provide a recovery trail.
Close Obsidian during manual recovery. Do not run manual Git writes while the
daemon is active: the daemon checks for rebase/merge/cherry-pick/revert/index locks,
but another process does not participate in its private operation lock.

External state locations:

- macOS: `~/Library/Application Support/vaultsync/<vault-id>/`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/vaultsync/<vault-id>/`

Configuration, status, JSONL path/error logs, locks, temporary integration worktrees,
and recovery copies live there. Logs contain timestamps, paths and sanitized errors,
never note contents. Recovery copies necessarily contain vault bytes and are private
local data (state directory mode 700; manifests/copies mode 600).

Inspect without resetting the live vault:

```sh
git -C "/absolute/path/My Vault" for-each-ref refs/vaultsync/recovery refs/vaultsync/integrated
git -C "/absolute/path/My Vault" show RECOVERY_REF:path/to/note.md > "/safe/external/location/recovered.md"
git -C "/absolute/path/My Vault" reflog main
```

For a pending journal, inspect its `dir`, `ops`, and corresponding `N.before`,
`N.after`, `N.displaced`/rollback files. Make a separate backup before intervention.
Copy recovered content back as a normal edit after stopping the service. Never
blindly delete a pending journal or transaction sibling. Completed/rolled-back
manifests explain which copies belong together. Orphan temporary worktrees/bare
repositories after a hard crash can be removed from the external state directory
only after journal recovery and after confirming no daemon uses them. Recovery refs
and copies are intentionally retained; prune reviewed entries manually when safe.

## Services

```sh
vaultsync install --vault "/absolute/path/My Vault"
vaultsync uninstall --vault "/absolute/path/My Vault"
```

These manage only the current user's service for this vault. Uninstall stops and
removes the service definition; vault files, Git history and external recovery data
remain intact. SIGTERM/Ctrl-C stop the watcher and drain serialized work before
releasing the lock. A hard termination is handled by the recovery journal.

On macOS, `install` writes a per-vault plist into `~/Library/LaunchAgents`, lints it,
and bootstraps/enables/starts it in `gui/<uid>`. It runs while that user is logged in:

```sh
launchctl print gui/$(id -u)/dev.vaultsync.VAULT_ID
```

The ID is the final component of `status.stateDirectory`. Service stdout/stderr
are in that external state directory. Install the runtime outside protected
Documents/Desktop folders. If the vault is in a macOS privacy-protected location,
check its access permissions and service logs; foreground terminal access does
not establish that a background process has access. Keep your backups until the
actual background service has successfully synchronized your chosen vault.

On Linux, the service is `vaultsync-VAULT_ID.service` in `~/.config/systemd/user`:

```sh
systemd-analyze --user verify "$HOME/.config/systemd/user/vaultsync-VAULT_ID.service"
systemctl --user status vaultsync-VAULT_ID.service
systemctl --user show vaultsync-VAULT_ID.service -p ActiveState -p MainPID
journalctl --user -u vaultsync-VAULT_ID.service --since today
systemctl --user restart vaultsync-VAULT_ID.service
```

Verify startup, an edit after 30 seconds, remote HEAD and status timestamps on your
Linux machine. User services ordinarily depend on a logged-in user session; use
`loginctl enable-linger "$USER"` only if you want it running outside login sessions
and your system policy permits it. Verify the credential helper/SSH agent in that
context. Uninstall calls `disable --now` and reloads the user manager.

Templates in `services/` document the generated units. Prefer `install`, which
escapes XML and systemd argument/specifier syntax and captures absolute paths.

## History and manual Git

Stop the daemon before manual Git operations. Outside the automation:

```sh
cd "/absolute/path/My Vault"
git status
git add --all
git commit -m "Manual vault update"
git pull --rebase origin main
# Resolve conflicts manually, then git add FILE; git rebase --continue
git push origin main
git log --oneline --graph --decorate --all
```

The installed ignore rules protect newly added workspace/trash/env files in this
manual flow. `git add --all` respects additional user ignore rules, unlike the
daemon's entire-eligible-vault snapshots. For an unfinished manual rebase, complete
it or run `git rebase --abort` after reviewing your backups, then restart vaultsync.
Never use force-push as part of synchronization.

## Mobile: Working Copy (iOS) and MGit (Android)

Desktop conflict automation **does not run inside mobile clients**. Connect the
same private repository using each app's own credentials, then clone `main` before
editing. Mobile storage access/sharing must make the same working copy available
to your editor; an unrelated Obsidian local folder is not automatically synchronized
by cloning into a Git app. Confirm your app/OS's folder-linking/export support.

**Working Copy:** open the repository's changes/status screen, stage changed vault
files, and create a commit with a descriptive message. Fetch and pull incoming
`main` changes before pushing; select rebase if the client supports the flow you
intend, otherwise reconcile its merge manually. Review every reported conflict,
keep both complete versions when uncertain, commit the resolution, then push.
Push/folder integration features can depend on the app's entitlement/version.

**MGit:** select the cloned repository, review Status, stage/add changed files,
and Commit. Fetch/Pull `origin/main`, resolve any conflicts manually and commit
that resolution, then Push. If your installed version cannot rebase, use its merge
flow and reconcile before pushing; do not reset away local edits or force-push.
Pull again before subsequent editing sessions. Commit and push before switching
devices. Desktop vaultsync can integrate ordinary mobile-created commits, but it
cannot recover edits that the mobile app has discarded.

## Validation and limits

```sh
npm ci --ignore-scripts
npm test
npm run check
# Explicit macOS-only live service smoke test (temporary service is removed):
node test/validate-launchd.js
```

Tests use temporary vaults/local bare remotes, never a real vault or GitHub token.
They cover controlled-clock 30-second debounce and five-minute scheduling, atomic
saves, ignored changes, startup dirty-vault handling, offline retry, rejected and
concurrent pushes, multiple unpushed commits, byte-exact text/binary/configuration
conflicts, same-day suffixes, deletion/rename cases, unusual filenames, edits during
rebase/application, real SIGKILL recovery, duplicate daemons, manual rebase refusal,
unsupported structures, credential protocol/secret leakage, and status accuracy.

See `VALIDATION.json` for this Mac's live launchd smoke result, and
`VALIDATION.md` for the final test record. Linux unit rendering/command dispatch
are tested; a live Linux/systemd session and a real private GitHub repository have
**not** been validated here. Cross-filesystem recovery and editor file-descriptor
races are not independently exercised on this Mac.

GitHub's normal file-size limits apply (individual files over 100 MiB are blocked).
Git LFS, custom clean/smudge conversions, sparse checkout, submodules, symlinks,
encrypted-vault workflows and a history UI are unsupported. The daemon stores raw
attachment bytes in ordinary Git. Large vaults cost memory/I/O: snapshot and
integration validation read eligible file bytes. Failed integrations may retain
large recovery data; monitor disk space.

References: [Chokidar](https://github.com/paulmillr/chokidar),
[simple-git](https://github.com/steveukx/git-js),
[Git rebase](https://git-scm.com/docs/git-rebase),
[Git credentials](https://git-scm.com/docs/gitcredentials),
[private repository creation](https://cli.github.com/manual/gh_repo_create),
[GitHub file limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github),
[Working Copy manual](https://workingcopy.app/manual/),
[MGit project](https://github.com/maks/MGit).
