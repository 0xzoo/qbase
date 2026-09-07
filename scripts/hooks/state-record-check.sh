#!/bin/bash
# Stop hook: keep docs/STATE.md (the master record) current.
# Companions: docs/STATE-LOG.md (session log), STATE-SHIPPED.md, STATE-DECISIONS.md.
#
# Blocks the end of a turn ONCE when tracked source changed after STATE.md
# was last modified. On the retry (stop_hook_active=true) it lets the turn
# end. STATE.md lives only in the MAIN checkout (docs/ is git-ignored), so
# worktrees resolve it through the common git dir.
#
# Disable: /hooks in Claude Code, or remove the entry in .claude/settings.json.

set -u
INPUT="$(cat 2>/dev/null || true)"

# Already nudged this turn → allow.
case "$INPUT" in
  *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;;
esac

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
COMMON="$(git rev-parse --git-common-dir 2>/dev/null)" || exit 0
MAIN_ROOT="$(cd "$(dirname "$COMMON")" 2>/dev/null && pwd)"
STATE="$MAIN_ROOT/docs/STATE.md"
[ -f "$STATE" ] || exit 0

state_mtime=$(stat -f %m "$STATE" 2>/dev/null || stat -c %Y "$STATE" 2>/dev/null || echo 0)

# Newest change among tracked source: uncommitted files (mtime) or HEAD commit time.
newest=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    worker/*|src/*|migrations/*|scripts/*|AGENTS.md|wrangler.jsonc|package.json) ;;
    *) continue ;;
  esac
  [ -e "$f" ] || continue
  m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
  [ "$m" -gt "$newest" ] && newest=$m
done < <(git status --porcelain --untracked-files=all 2>/dev/null | cut -c4- | sed 's/.* -> //')

head_time=$(git log -1 --format=%ct 2>/dev/null || echo 0)
if [ "$head_time" -gt "$newest" ]; then
  # Only count HEAD if it touched source paths.
  if git show --name-only --format= HEAD 2>/dev/null | grep -qE '^(worker|src|migrations|scripts)/|^AGENTS\.md$|^wrangler\.jsonc$'; then
    newest=$head_time
  fi
fi

if [ "$newest" -gt "$state_mtime" ]; then
  cat <<JSON
{"decision":"block","reason":"docs/STATE.md (master record) is older than the latest code change. Update the changed rows in $STATE and append a line to docs/STATE-LOG.md (plus STATE-SHIPPED.md for a deploy or fixed loose end, STATE-DECISIONS.md for a decision), or touch STATE.md if nothing state-relevant changed. Then stop again."}
JSON
  exit 0
fi
exit 0
