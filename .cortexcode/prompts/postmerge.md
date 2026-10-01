---
description: After a PR merges, check the GitHub release and npm publish, then switch back to main
argument-hint: "[pr-number]"
---
Check that the merged PR released correctly, then return to `main`.

Argument: `$ARGUMENTS` (optional PR number; default: the PR for the current branch).

Do these steps in order. If any check fails, stay on the current branch, report what failed and how to fix it, and stop.

1. **Find the PR.** Run `gh pr view $ARGUMENTS --json number,state,headRefName,mergeCommit,mergedAt,url`.
   - If the state is not `MERGED`: report the state (and `gh pr checks`) and stop. Tell the user to merge first.
   - Note `MERGE_SHA = mergeCommit.oid` and `BRANCH = headRefName`.

2. **Expected version.** Run `git fetch origin --prune --tags`. Set `VERSION` from `git show origin/main:package.json` (the `version` field), `NAME` from its `name` field, and `TAG=v$VERSION`. Also read the version at the merge's first parent (`git show $MERGE_SHA^1:package.json`). If the two match, the PR did not bump the version: report "no release in this PR (version $VERSION unchanged)" and go to step 5.

3. **Wait for the release workflow.**
   - Find the run: `gh run list --workflow release.yml --commit $MERGE_SHA --json databaseId,status,conclusion,url`. If no run shows up yet, retry every 10 s for up to 2 min.
   - `gh run watch <id> --exit-status`.
   - If it failed, show `gh run view <id> --log-failed` (the last relevant lines), explain the likely cause (e.g. `NPM_TOKEN` is not an automation token or has expired, Actions lacks write permission, the version was already published), and stop. The release workflow can be re-run safely: `gh run rerun <id>` or `gh workflow run release.yml`.

4. **Check the release.** All of these must pass:
   - Tag: `git ls-remote --exit-code --tags origin refs/tags/$TAG`.
   - GitHub release: `gh release view $TAG --json url,tagName,isDraft` exists and is not a draft.
   - npm: `npm view $NAME@$VERSION version` prints `$VERSION`. The registry can lag, so retry every 10 s, up to 6 times, before failing.
   - `npm view $NAME dist-tags.latest` is `$VERSION` (warn only, do not fail).

5. **Back to main** (only when everything above passed):
   - `git status --porcelain`. If there are uncommitted changes, do not switch: report them and stop.
   - `git switch main && git pull --ff-only origin main`.
   - Delete the merged local branch: `git branch -d $BRANCH`. If git refuses because the PR was squash-merged, confirm the PR state is `MERGED` and then use `git branch -D $BRANCH`. Never delete `main`.
   - `git remote prune origin`.

6. **Report** as a short table: PR, merge commit, tag, GitHub release URL, npm URL (`https://www.npmjs.com/package/$NAME/v/$VERSION`), workflow run URL, current branch.
