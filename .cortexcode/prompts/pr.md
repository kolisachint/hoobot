---
description: Commit everything to a branch, push it, and open (or update) a PR to main
argument-hint: "[patch|minor|major] [branch-name]"
---
Get every change in this repo into a pull request against `main`.

Arguments: `$ARGUMENTS`
- `patch`, `minor` or `major` → label the PR `npm:patch` / `npm:minor` / `npm:major`. On merge, CI bumps `package.json`, commits `chore(release): vX.Y.Z` to `main`, tags it, creates the GitHub release and publishes to npm.
- Any other word → use it as the branch name.
- None → no release label (an existing one is left as is), branch name derived from the changes.

Never edit `version` in `package.json` yourself and never create tags: the label is the only release signal.

Do these steps in order. Stop and report if any step fails; do not work around a failure.

1. **Look first.** Run `git fetch origin --prune`, `git status --porcelain --untracked-files=all`, `git branch --show-current`, and `git diff --stat HEAD`. If there are no changes and no unpushed commits (`git log origin/main..HEAD`), say "nothing to PR" and stop.

2. **Branch.**
   - If on `main` or a detached HEAD: pick a branch name. Use the argument if one was given; otherwise derive `<type>/<short-slug>` from the changes (type is `feat`, `fix`, `docs`, `chore`, `ci`). If that branch exists locally, `git switch` to it. If it exists only on origin, `git switch --track origin/<name>`. Otherwise `git switch -c <name>`. Uncommitted changes carry over.
   - If already on a feature branch: stay on it.
   - Never commit to `main`.

3. **Secret check.** List what would be staged: `git add -A --dry-run`. Abort if any path is `.env` (other than `.env.example`), `*.pem`, `*.key`, `id_rsa*`, or anything under `workspace/` or `.cortexcode/` other than `.cortexcode/prompts/` and `.cortexcode/plans/`. Also scan `git diff HEAD` for strings that look like tokens (`npm_`, `ghp_`, `gho_`, `sk-`, `tvly-`, Discord bot tokens, `-----BEGIN`). If you find one, stop and show the file and line.

4. **Version untouched.** If `git diff origin/main -- package.json` changes the `version` field, stop and tell the user to revert it: CI owns the version.

5. **Checks.** Run `bun install --frozen-lockfile` and `bun run check`. If they fail, report the failure and stop. Do not commit broken code.

6. **Commit.** `git add -A`. If something is staged, commit with a Conventional Commits message written from the actual diff: subject ≤ 72 chars, plus a body listing the main changes. If nothing is staged (only unpushed commits), skip the commit.

7. **Push.** `git push -u origin <branch>`. Never force-push unless the user asked.

8. **PR.** `gh pr view --json number,url,state,labels` on the branch:
   - No PR yet: `gh pr create --base main --head <branch> --title "<subject>" --body "<summary>"`. The body summarises the changes and ends with `Release: npm:<bump> (merging publishes to npm + GitHub release)` or `No release (no npm:* label)`.
   - Open PR: it is updated by the push. Print its URL.
   - Merged or closed PR for this branch: tell the user and stop. Do not reuse a merged branch.

9. **Release label (only for patch/minor/major).**
   - Make sure the labels exist (safe to repeat):
     `gh label create npm:patch --color 0E8A16 --description "Release: patch bump on merge" --force`
     `gh label create npm:minor --color FBCA04 --description "Release: minor bump on merge" --force`
     `gh label create npm:major --color D93F0B --description "Release: major bump on merge" --force`
   - Remove any other `npm:*` label from the PR (`gh pr edit <n> --remove-label npm:<other>`), then `gh pr edit <n> --add-label npm:<bump>`. A PR carries at most one `npm:*` label.
   - Preview the version: the current `version` on `origin/main` and the latest on npm (`npm view @kolisachint/hoobot version`; a 404 means never published). Work out what the bump will give from `origin/main`'s version and show it as "expected vX.Y.Z".

10. **Report.** Print the branch, the commit, the PR URL, the release label and expected version (or "no release"), and `gh pr checks` (they may still be pending; do not wait). Remind the user to run `/postmerge` after merging.
