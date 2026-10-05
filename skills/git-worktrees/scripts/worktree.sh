#!/usr/bin/env bash
# One git worktree per task, so several can work on one repo at once.
#
# The problem this solves: two checkouts of a repo share one .git directory, so
# you cannot `git checkout` a branch that is already checked out elsewhere, and
# a second full clone duplicates history just to avoid that. `git worktree`
# gives each task its own directory and branch, and they do not collide.
#
# Worktrees live BESIDE the repo, never inside it: a nested worktree is
# untracked noise in the parent, and tools walk into it. Override the location
# with HOO_WORKTREE_ROOT.
#
#   worktree.sh new <branch> [base]   create one from an up-to-date base
#   worktree.sh path <branch>         print its directory (exit 1 if none)
#   worktree.sh list                  every worktree and the branch it holds
#   worktree.sh prune                 drop entries whose directory is gone
#   worktree.sh remove <branch>       take one down (refuses dirty worktrees)
#
# It never forces anything: a dirty worktree or a branch checked out elsewhere
# is reported, not overridden.
#
#   HOO_REPO           the repo (default: the one containing $PWD)
#   HOO_WORKTREE_ROOT  where worktrees go (default: the repo's parent)
set -uo pipefail

# Where the repo is: HOO_REPO, else the first checkout found from the current
# directory. Deriving it means the skill works on any repo, not just this one.
_repo() {
  if [ -n "${HOO_REPO:-}" ]; then printf '%s' "$HOO_REPO"; return 0; fi
  local top
  top="$(git -C "${1:-$PWD}" rev-parse --show-toplevel 2>/dev/null)" || return 1
  printf '%s' "$top"
}
# Worktrees go beside the repo unless told otherwise, so they are never nested
# inside it (untracked noise in the parent, and tools walk into them).
_root() {
  if [ -n "${HOO_WORKTREE_ROOT:-}" ]; then printf '%s' "$HOO_WORKTREE_ROOT"; return 0; fi
  printf '%s' "$(dirname "$(_repo "${1:-$PWD}")")"
}

die() { echo "worktree: $*" >&2; exit 1; }
warn() { echo "worktree: $*" >&2; }

HOO_REPO="$(_repo)" || die "not inside a git repository (run it in the repo, or set HOO_REPO)"
HOO_WORKTREE_ROOT="$(_root)"
[ -e "$HOO_REPO/.git" ] || die "not a git repo: $HOO_REPO (set HOO_REPO)"

# The directory a branch's worktree lives in. Branch names contain slashes,
# which are not legal in a flat directory name, so they become dashes.
wt_dir() {
  printf '%s/%s-%s' "$HOO_WORKTREE_ROOT" "$(basename "$HOO_REPO")" "$(printf '%s' "$1" | tr '/' '-')"
}

# A branch's existing worktree directory, or exit 1. This is the one to use
# before touching someone's branch: it reads git's own record rather than
# guessing a path.
wt_path() {
  local branch="$1" line="" path="" br=0 found=""
  # Read git's own record. The blank line between records is not relied upon:
  # command substitution strips trailing newlines, so the last record would
  # never be terminated and would silently never match.
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) path="${line#worktree }" ;;
      "branch refs/heads/$branch") br=1; found="$path" ;;
      detached) br=0 ;;
    esac
  done <<EOF
$(git -C "$HOO_REPO" worktree list --porcelain 2>/dev/null)
EOF
  [ -n "$found" ] || return 1
  printf '%s' "$found"
}

cmd_new() {
  local branch="${1:-}" base="${2:-origin/main}"
  [ -n "$branch" ] || die "usage: worktree.sh new <branch> [base]"
  case "$branch" in
    -*) die "a branch name cannot start with a dash: $branch" ;;
    *..*|*/|*/.lock) die "not a usable branch name: $branch" ;;
  esac

  local dir; dir="$(wt_dir "$branch")"

  # Refuse rather than clobber: a second `new` for a live branch is a mistake,
  # and the cost of guessing wrong here is someone's uncommitted work.
  if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    die "$dir already exists and is not empty. Use 'path $branch' or remove it first."
  fi
  if existing="$(wt_path "$branch")"; then
    die "branch $branch is already checked out at $existing"
  fi

  # Branch from a fresh base. A worktree off a stale main is a conflict later.
  git -C "$HOO_REPO" fetch origin --quiet || die "fetch failed"

  local create=(-b "$branch")
  # An existing local branch means "check it out here", not "make a new one".
  if git -C "$HOO_REPO" show-ref --verify --quiet "refs/heads/$branch"; then
    create=("$branch")
  fi
  git -C "$HOO_REPO" worktree add "${create[@]}" "$dir" "$base" \
    || die "worktree add failed for $branch"

  echo "$dir"
  # A fresh worktree has no node_modules; say so before the tests fail for a
  # reason that has nothing to do with the change.
  [ -f "$dir/package.json" ] && [ ! -d "$dir/node_modules" ] && \
    echo "worktree: no node_modules — run 'bun install' there before the suite" >&2
  return 0
}

cmd_path() {
  local branch="${1:-}" p
  [ -n "$branch" ] || die "usage: worktree.sh path <branch>"
  p="$(wt_path "$branch")" || die "no worktree for $branch (try: worktree.sh list)"
  printf '%s\n' "$p"
}

cmd_list() {
  git -C "$HOO_REPO" worktree list
}

cmd_prune() {
  # Only entries whose directory is gone. `git worktree prune` on its own is
  # safe for the repo's own records, but pruning a live worktree's lock is not,
  # so the state is reported either way.
  echo "worktrees before:"
  git -C "$HOO_REPO" worktree list
  git -C "$HOO_REPO" worktree prune
  echo "worktrees after:"
  git -C "$HOO_REPO" worktree list
}

cmd_remove() {
  local branch="${1:-}" dir
  [ -n "$branch" ] || die "usage: worktree.sh remove <branch>"
  # `die` inside $( ) exits only the subshell, so its failure cannot be trusted
  # to stop this function: an empty $dir would reach git as "" and produce a
  # usage error instead of the real message. Check the path explicitly.
  dir="$(wt_path "$branch")" || die "no worktree for $branch (try: worktree.sh list)"
  [ -n "$dir" ] && [ -d "$dir" ] || die "worktree for $branch is gone; run: worktree.sh prune"

  # Refuse a dirty worktree. Removing one is how uncommitted work is lost, and
  # --force is exactly what makes people reach for it.
  if [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
    die "$dir has uncommitted changes. Commit, stash, or remove them by hand."
  fi

  # `worktree remove` only exists from git 2.17 (2017). This machine has 2.15,
  # so fall back to the manual sequence: drop the administrative files, then the
  # directory. `prune` afterwards clears the stale record.
  if git -C "$HOO_REPO" worktree remove "$dir" 2>/dev/null; then
    :
  elif git -C "$HOO_REPO" worktree remove --help >/dev/null 2>&1; then
    die "git refused to remove $dir; is another process using it?"
  else
    warn "this git has no 'worktree remove' (pre-2.17); removing by hand"
    rm -rf "$HOO_REPO/.git/worktrees/$(basename "$dir")"
    rm -rf "$dir" || die "could not delete $dir"
  fi

  # A merged branch goes quietly; an unmerged one is kept, and said about.
  if git -C "$HOO_REPO" branch --merged origin/main --format='%(refname:short)' 2>/dev/null | grep -qx "$branch"; then
    git -C "$HOO_REPO" branch -d "$branch" >/dev/null 2>&1 && echo "removed merged branch $branch"
  else
    echo "kept branch $branch (not merged into origin/main)"
  fi
  echo "$dir"
}

case "${1:-}" in
  new) shift; cmd_new "$@" ;;
  path) shift; cmd_path "$@" ;;
  list) shift; cmd_list "$@" ;;
  prune) shift; cmd_prune "$@" ;;
  remove) shift; cmd_remove "$@" ;;
  -h|--help|help|"")
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$1' (try --help)" ;;
esac