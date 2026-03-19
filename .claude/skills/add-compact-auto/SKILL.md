---
name: add-compact-auto
description: Add automatic context compaction. Uses a two-layer strategy (pre-flight + post-run) to compact when cached tokens exceed AUTO_COMPACT_TOKENS (default 200K). Requires add-compact to be applied first.
---

# Add Auto-Compact

Extends `add-compact` with automatic threshold-based compaction using a **two-layer strategy**:

1. **Pre-flight compact** — before processing a new message, checks if the previous run's cached tokens exceeded the threshold. If so, compacts first so the new message runs on a clean context.
2. **Post-run compact** — after a successful run, if the current run's cached tokens exceeded the threshold, compacts immediately (catches single-message spikes).

Token counts are persisted in `lastCachedTokens` (module-level, keyed by `chatJid`) so the pre-flight check has data from the previous invocation.

**Requires:** `add-compact` must be applied first (`src/session-commands.ts` must exist).

## Phase 1 — Pre-flight

```bash
test -f src/session-commands.ts && echo "add-compact: OK" || echo "ERROR: apply add-compact first"
grep -n "AUTO_COMPACT" src/index.ts 2>/dev/null && echo "Already applied" || echo "Not applied"
```

Stop if `add-compact` is not applied. Skip to Phase 3 if already applied.

## Phase 2 — Apply

Edit `src/index.ts` with four changes:

### Change 1 — Add threshold constant and persistence map (near the other thresholds)

Find the block with `TOKEN_FLUSH_THRESHOLD` and `ESTIMATED_CONTEXT_WINDOW` and add after it:

```ts
const AUTO_COMPACT_THRESHOLD = parseInt(
  process.env.AUTO_COMPACT_TOKENS ?? '200000',
  10,
);
// Persists cached token count from the last run per group, so the NEXT
// invocation can compact BEFORE running if the previous run was expensive.
const lastCachedTokens: Record<string, number> = {};
```

### Change 2 — Pre-flight compact before the agent runs

In `processGroupMessages`, just before `await channel.setTyping?.(chatJid, true)`, add:

```ts
// Pre-flight compact: if the previous run for this group exceeded the
// threshold, compact before processing the new message so the expensive
// call doesn't happen with a bloated context.
const prevCached = lastCachedTokens[chatJid] ?? 0;
if (prevCached > AUTO_COMPACT_THRESHOLD) {
  logger.info(
    { group: group.name, prevCached, threshold: AUTO_COMPACT_THRESHOLD },
    'Pre-flight auto-compact triggered',
  );
  await runAgent(group, '/compact', chatJid, undefined, async () => {});
  lastCachedTokens[chatJid] = 0;
}
```

### Change 3 — Capture usage inside the runAgent callback

The callback already handles streaming output. Add a `lastUsage` variable before the `runAgent` call:

```ts
let lastUsage: import('./cost-tracker.js').UsageData | undefined;
```

Inside the callback, after `resetIdleTimer()` and before the `flushTriggered` block, add:

```ts
if (result.usage) lastUsage = result.usage;
```

### Change 4 — Post-run compact after the runAgent call

After the budget alert block, replace or add the auto-compact section:

```ts
// Persist cached token count for the pre-flight check on the next message.
// Also compact immediately if over threshold (catches single-message spikes).
if (!hadError) {
  const cachedTokens =
    (lastUsage?.cache_read_input_tokens ?? 0) +
    (lastUsage?.cache_creation_input_tokens ?? 0);
  lastCachedTokens[chatJid] = cachedTokens;
  if (cachedTokens > AUTO_COMPACT_THRESHOLD) {
    logger.info(
      { group: group.name, cachedTokens, threshold: AUTO_COMPACT_THRESHOLD },
      'Post-run auto-compact triggered',
    );
    await runAgent(group, '/compact', chatJid, undefined, async () => {});
    lastCachedTokens[chatJid] = 0;
  }
}
```

## Phase 3 — Validate and deploy

```bash
npm run build
npm test
systemctl --user restart nanoclaw
```

Verify in logs after the next message:
```bash
tail -f ~/nanoclaw/logs/nanoclaw.log | grep -i compact
```

## Configuration

Override the default threshold via `.env` or systemd override:
```
AUTO_COMPACT_TOKENS=150000   # compact earlier
AUTO_COMPACT_TOKENS=300000   # compact later
```

After changing, restart the service.

## How it works

- **Pre-flight**: at the start of each `processGroupMessages`, if `lastCachedTokens[chatJid]` exceeds the threshold (set by the previous run), `/compact` runs before the user's message is processed. This prevents the next call from being expensive.
- **Post-run**: after a successful run, the current cached token count is saved to `lastCachedTokens[chatJid]`. If it exceeds the threshold, `/compact` also runs immediately (handles single-message context spikes), and `lastCachedTokens[chatJid]` is reset to 0.
- Token counts come from real API usage (`output.usage.cache_read_input_tokens` + `cache_creation_input_tokens`), not estimates.
- Both compact calls are silent (no message sent to the user).
- The `flushTriggered` memory flush (pre-existing) and auto-compact are independent; both can run, but compact resets the session so flush may not be needed afterward.

## Uninstall

Revert the four code changes in `src/index.ts` and rebuild.
