#!/usr/bin/env bash
# Nightly session reset — clears stale Claude Code sessions and old history
set -euo pipefail

NANOCLAW_DIR="${NANOCLAW_DIR:-$HOME/nanoclaw}"
DB="$NANOCLAW_DIR/store/messages.db"
SESSIONS_DIR="$NANOCLAW_DIR/data/sessions"
LOG="$NANOCLAW_DIR/logs/session-reset.log"
HISTORY_DAYS="${HISTORY_DAYS:-7}"

mkdir -p "$(dirname "$LOG")"
exec >> "$LOG" 2>&1

echo ""
echo "=== $(date '+%Y-%m-%d %H:%M:%S') ==="

# 1. Clear session IDs from DB
if [ -f "$DB" ]; then
  ROWS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sessions;" 2>/dev/null || echo 0)
  sqlite3 "$DB" "DELETE FROM sessions;" 2>/dev/null || true
  echo "Cleared $ROWS session(s) from DB"
else
  echo "DB not found: $DB"
fi

# 2. Delete old .jsonl conversation history
DELETED=0
while IFS= read -r -d '' f; do
  rm -f "$f"
  DELETED=$((DELETED + 1))
done < <(find "$SESSIONS_DIR" -name "*.jsonl" -mtime +"$HISTORY_DAYS" -print0 2>/dev/null)
echo "Deleted $DELETED .jsonl file(s) older than ${HISTORY_DAYS} days"

# 3. Remove empty session-env subdirectories
find "$SESSIONS_DIR" -type d -name "session-env" -exec \
  find {} -mindepth 1 -maxdepth 1 -type d -empty -delete \; 2>/dev/null || true
echo "Cleaned empty session-env dirs"

# 4. Restart nanoclaw so in-memory session IDs are cleared
systemctl --user restart nanoclaw 2>/dev/null && echo "Restarted nanoclaw" || echo "Warning: could not restart nanoclaw"

echo "Done."
