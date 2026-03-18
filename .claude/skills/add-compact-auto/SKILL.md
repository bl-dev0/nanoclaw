---
name: add-compact-auto
description: Add automatic context compaction. After each successful agent response, checks real token usage. If cached tokens exceed AUTO_COMPACT_TOKENS (default 200K), silently runs /compact before the next response. Requires add-compact to be applied first.
---

# Add Auto-Compact

Extends `add-compact` with automatic threshold-based compaction. After each successful
agent run, captures the real token counts from `output.usage`. If the cached context
exceeds the threshold, runs `/compact` silently — no user action required.

**Requires:** `add-compact` must be applied first (`src/session-commands.ts` must exist).

## Phase 1 — Pre-flight

```bash
test -f src/session-commands.ts && echo "add-compact: OK" || echo "ERROR: apply add-compact first"
grep -n "AUTO_COMPACT" src/index.ts 2>/dev/null && echo "Already applied" || echo "Not applied"
```

Stop if `add-compact` is not applied. Skip to Phase 3 if already applied.

## Phase 2 — Apply

Edit `src/index.ts` with two changes:

### Change 1 — Add threshold constant (near the other thresholds)

Find the block with `TOKEN_FLUSH_THRESHOLD` and `ESTIMATED_CONTEXT_WINDOW` and add after it:

```ts
const AUTO_COMPACT_THRESHOLD = parseInt(
  process.env.AUTO_COMPACT_TOKENS ?? '200000',
  10,
);
```

### Change 2 — Capture usage and trigger compact after successful run

In `processGroupMessages`, find the `runAgent` call that processes user messages.
It looks like:

```ts
const output = await runAgent(group, prompt, chatJid, async (result) => {
```

The callback already handles streaming output. Add a `lastUsage` variable before it
and capture `result.usage` inside the callback. Then after the `runAgent` call completes,
add the auto-compact check.

**Before the `runAgent` call**, add:
```ts
let lastUsage: import('./cost-tracker.js').UsageData | undefined;
```

**Inside the callback**, after `resetIdleTimer()` and before the `flushTriggered` block, add:
```ts
if (result.usage) lastUsage = result.usage;
```

**After the `runAgent` call** (after `await channel.setTyping?.(chatJid, false)`
and the error handling block), add:

```ts
// Auto-compact: if cached context exceeds threshold, compact silently
if (!hadError) {
  const cachedTokens =
    (lastUsage?.cache_read_input_tokens ?? 0) +
    (lastUsage?.cache_creation_input_tokens ?? 0);
  if (cachedTokens > AUTO_COMPACT_THRESHOLD) {
    logger.info(
      { group: group.name, cachedTokens, threshold: AUTO_COMPACT_THRESHOLD },
      'Auto-compact triggered',
    );
    await runAgent(group, '/compact', chatJid, async () => {});
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

- Token counts come from real API usage (`output.usage.cache_read_input_tokens` +
  `cache_creation_input_tokens`), not estimates.
- Compaction runs **after** the response is already sent to the user — no latency impact.
- The `/compact` call is silent (no message sent to the user).
- If compaction fails, the error is logged but does not affect the user response.
- The `flushTriggered` memory flush (pre-existing) and auto-compact are independent;
  both can run, but compact resets the session so flush may not be needed afterward.

## Uninstall

Revert the three code changes in `src/index.ts` and rebuild.
