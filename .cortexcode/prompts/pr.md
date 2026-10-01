---
description: Commit everything to a branch, push it, and open (or update) a PR to main
argument-hint: "[patch|minor|major] [branch-name]"
---
Get every change in this repo into a pull request against `main`.

Arguments: `$ARGUMENTS`
- `patch`, `minor` or `major` → bump the version so the merge releases (CI tags, creates the GitHub release and publishes to npm).
- Any other word → use it as the branch name.
- None → no version bump, branch name derived from the changes.

Do these steps in order. Stop and report if any step fails; do not work around a failure.

1. **Look first.** Run `git fetch origin --prune`, `git status --porcelain --untracked-files=all`, `git branch --show-current`, and `git diff --stat HEAD`. If there are no changes and no unpushed commits (`git log origin/main..HEAD`), say "nothing to PR" and stop.

2. **Branch.**
   - If on `main` or a detached HEAD: pick a branch name. Use the argument if one was given; otherwise derive `<type>/<short-slug>` from the changes (type is `feat`, `fix`, `docs`, `chore`, `ci`). If that branch exists locally, `git switch` to it. If it exists only on origin, `git switch --track origin/<name>`. Otherwise `git switch -c <name>`. Uncommitted changes carry over.
   - If already on a feature branch: stay on it.
   - Never commit to `main`.

3. **Secret check.** List what would be staged: `git add -A --dry-run`. Abort if any path is `.env` (other than `.env.example`), `*.pem`, `*.key`, `id_rsa*`, or anything under `workspace/` or `.cortexcode/` other than `.cortexcode/prompts/` and `.cortexcode/plans/`. Also scan `git diff HEAD` for strings that look like tokens (`npm_`, `ghp_`, `gho_`, `sk-`, `tvly-`, Discord bot tokens, `-----BEGIN`). If you find one, stop and show the file and line.

4. **Version bump (only for patch/minor/major).** Read the current `version` from `package.json` and the latest released version (`npm view hoo-discord-bot version`; a 404 means it has never been published). If the version in `package.json` is already newer than npm's and newer than `origin/main:package.json`, keep it; do not bump twice. Otherwise run `npm version <bump> --no-git-tag-version`. Do not create a tag: CI does that after the merge.

5. **Checks.** Run `bun install --frozen-lockfile` and `bun run check`. If they fail, report the failure and stop. Do not commit broken code.

6. **Commit.** `git add -A`. If something is staged, commit with a Conventional Commits message written from the actual diff: subject ≤ 72 chars, plus a body listing the main changes. If a version was bumped, add a `Release: vX.Y.Z` line to the body. If nothing is staged (only unpushed commits), skip the commit.

7. **Push.** `git push -u origin <branch>`. Never force-push unless the user asked.

8. **PR.** `gh pr view --json url,state` on the branch:
   - No PR yet: `gh pr create --base main --head <branch> --title "<subject>" --body "<summary>"`. The body summarises the changes and says either `Release: vX.Y.Z (merging publishes to npm + GitHub release)` or `No release (version unchanged)`.
   - Open PR: it is updated by the push. Print its URL.
   - Merged or closed PR for this branch: tell the user and stop. Do not reuse a merged branch.

9. **Report.** Print the branch, the commit, the PR URL, the release version (or "none"), and `gh pr checks` (they may still be pending; do not wait). Remind the user to run `/postmerge` after merging.
