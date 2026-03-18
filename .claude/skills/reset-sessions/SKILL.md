---
name: reset-sessions
description: Install a nightly cron job that resets Claude Code session IDs and cleans old conversation history to prevent context bloat and high API costs.
---

# Reset Sessions (Nightly Context Cleaner)

Installs `scripts/session-reset.sh` and a cron job that runs it nightly at 04:00.

The script:
- Clears all session IDs from the DB so each day starts a fresh Claude Code session
- Deletes `.jsonl` conversation history files older than 7 days
- Deletes empty `session-env` subdirectories
- Logs every run to `logs/session-reset.log`

---

## Step 1 — Create the script

Write `scripts/session-reset.sh` with the content below, then make it executable.

```bash
chmod +x ~/nanoclaw/scripts/session-reset.sh
```

Script content:

```bash
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

echo "Done."
```

---

## Step 2 — Install the cron job

Check if the cron entry already exists:

```bash
crontab -l 2>/dev/null | grep session-reset
```

If it does not exist, add it:

```bash
(crontab -l 2>/dev/null; echo "0 4 * * * $HOME/nanoclaw/scripts/session-reset.sh") | crontab -
```

Verify it was added:

```bash
crontab -l | grep session-reset
```

---

## Step 3 — Run once now

Execute the script immediately so the user sees it working:

```bash
~/nanoclaw/scripts/session-reset.sh
tail -20 ~/nanoclaw/logs/session-reset.log
```

---

## Step 4 — Confirm

Show the user:
- Cron schedule installed (next run at 04:00)
- Output of the first run
- `HISTORY_DAYS` setting (default: 7 — override by setting env var in cron line if needed)

---

## Uninstall

To remove the cron job:

```bash
crontab -l | grep -v session-reset | crontab -
```

To also remove the script:

```bash
rm ~/nanoclaw/scripts/session-reset.sh
```
