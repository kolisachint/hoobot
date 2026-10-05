---
name: git-worktrees
description: Work on a git repo without blocking anyone else — one isolated worktree per task or PR, so several bots (or a bot and a person) can have branches open on the same repository at once. Use before starting any multi-file change on a repo that already has other work in flight, when asked to work on a branch or PR "in parallel" or "isolated", when a second checkout would collide, or when a task needs a PR opened while another is still being reviewed. Also use to inspect or test someone else's PR without disturbing the branch you are on.
---

# Git worktrees

Two checkouts of one repo can share the `.git` directory: `git worktree add`
gives each task its own directory and branch, and they do not collide. That is
what lets the bot work on a PR while the user works on another, and lets two
tasks touch the same repo in parallel.

## Never do this

- **Do not `git checkout` a branch that is checked out elsewhere.** Git refuses,
  and forcing it makes one of the two directories silently wrong.
- **Do not create a second full clone** to avoid that. It duplicates history
  and the two drift.
- **Do not work on `main`.** If `main` is checked out in the primary checkout,
  make a branch from it in a worktree instead.
- **Do not put worktrees inside the repo.** A nested worktree shows up as
  untracked noise in the parent, and tools walk into it.

## Where worktrees live

Keep them **beside** the repo, not inside it, and name them after the branch:

```sh
REPO=/path/to/repo
WT_ROOT="${HOO_WORKTREE_ROOT:-$(dirname "$REPO")}"   # the parent directory
```

`<parent>/<repo>-<branch>` is fine too, but it must be outside the repo or
listed in `.gitignore`. Beside the repo needs neither.

## The workflow

```sh
# HOO_PATHS resolves a path on this machine and this version. Define it once,
# before anything that uses it.
HOO_PATHS() { bash "${HOO_SKILLS:-${HOO_WORKDIR:-$HOME/.hoobot/runtime/shared/workspace}/.cortexcode/skills}"/bot-slack/scripts/paths.sh "$@"; }

BR=fix/resilience

# 1. Refresh what you branch from. Never branch from a stale main.
git fetch origin --quiet

# 2. Make the worktree. The helper fetches for you, refuses a name that is
#    already checked out elsewhere, and warns about a missing node_modules.
bash "$(HOO_PATHS worktree)" new "$BR"

# 3. Work there. It is a full checkout: edit, test, commit, push.
WT="$(bash "$(HOO_PATHS worktree)" path "$BR")"
cd "$WT" && bun run check

# 4. Push and open the PR from the worktree.
git push -u origin "$BR"
gh pr create --base main --head "$BR" --title "..." --body-file ...
```

After the PR merges, take the worktree down with the helper — it refuses a
dirty one, and deletes a merged branch only when it really is merged:

```sh
bash "$(HOO_PATHS worktree)" remove "$BR"
```

`git worktree remove` only exists from git 2.17 (2017). The helper falls back
to doing it by hand on older git, and says so when it does.

## The helper

Use it for the fiddly parts, which are the parts that go wrong. It defaults
the repo to the one holding your current directory, so it works on any repo.

```sh
# Create a worktree for a branch, from an up-to-date main.
bash "$(HOO_PATHS worktree)" new fix/resilience

# Where is the worktree for a branch? (exits 1 if there isn't one)
bash "$(HOO_PATHS worktree)" path feat/subagent-reliability

# List every worktree, and which branch each holds.
bash "$(HOO_PATHS worktree)" list

# A crash-loop of leftovers is the usual failure. Clean up merged branches.
bash "$(HOO_PATHS worktree)" prune
```

`HOO_WORKTREE_ROOT` overrides where they are created; the default is the
parent of the repo.

## Checking someone else's PR without disturbing yourself

The point of the skill: review and test a PR **without** leaving your branch.

```sh
BR=feat/subagent-reliability
WT="$(bash "$(HOO_PATHS worktree)" path "$BR")" || exit 1

git -C "$WT" fetch origin
git -C "$WT" checkout -q "$BR"
git -C "$WT" reset --hard "origin/$BR"     # match the PR exactly
cd "$WT" && bun run check                   # test what they actually pushed
```

Never do this from the primary checkout: it is the fastest way to lose
uncommitted work.

## When the branch moves under you

`main` moves while a PR is open, and the PR goes `CONFLICTING`. Rebase onto
the new main **in the worktree**, never in the primary checkout:

```sh
git -C "$WT" fetch origin --quiet
git -C "$WT" rebase origin/main
# resolve conflicts, then:
git -C "$WT" add <resolved> && GIT_EDITOR=true git -C "$WT" rebase --continue
git -C "$WT" push --force-with-lease
```

`--force-with-lease`, never `--force`: it refuses to overwrite the branch if
someone else pushed to it while you were working.

Check the result before pushing:

```sh
gh pr checks <n>          # both jobs pass
gh pr view <n> --json mergeable,mergeStateStatus   # MERGEABLE / CLEAN
```

`CONFLICTING` means main moved. `DIRTY` means a check failed. Fix the first by
rebasing, the second by pushing a fix — do not merge around either.

## Rules that matter

- **One branch, one worktree.** `git worktree list` is the truth about what is
  checked out where; read it before creating anything.
- **`prune` when in doubt.** A worktree whose directory was deleted by hand
  lingers as a stale entry and blocks re-creating that branch.
- **Re-run the checks after a rebase.** A green CI run is for one commit; after
  a rebase the tree is different, so the old green says nothing.
- **`node_modules` is per worktree.** A new worktree has none. `bun install`
  (or the project's equivalent) before running the suite, or the tests fail for
  reasons that have nothing to do with your change.
- **Never `git worktree remove --force`** with uncommitted changes in it. That
  is data loss, and `--force` is exactly what makes people reach for it.