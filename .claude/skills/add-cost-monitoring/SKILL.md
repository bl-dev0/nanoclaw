# Skill: add-cost-monitoring

Implements an API cost monitoring system for NanoClaw.
Captures token usage from each Agent SDK response, persists it in SQLite,
exposes an MCP tool so the agent can report costs, and sends automatic alerts
via Telegram when 80% of the monthly budget is exceeded.

---

## Implementation steps

Execute the following steps in order. Do not skip any. Before modifying
any existing file, read it completely to understand its current structure.

---

### Step 0 — Install dependencies

`better-sqlite3` is required for both `cost-tracker.ts` and the MCP server. Install it now if it is not already present:

```bash
cd ~/nanoclaw
node -e "require('better-sqlite3')" 2>/dev/null && echo "better-sqlite3 OK" || npm install better-sqlite3 && npm install --save-dev @types/better-sqlite3
```

Verify FTS5 is available (needed by the memory skill, but good to confirm the binary is healthy):

```bash
node -e "const db = require('better-sqlite3')(':memory:'); db.exec('CREATE VIRTUAL TABLE t USING fts5(c)'); console.log('better-sqlite3 OK');"
```

If this fails, rebuild the native addon:

```bash
npm rebuild better-sqlite3
```

---

### Step 1 — Create the `api_usage` SQLite table

Run this bash command to add the table to the existing database:

```bash
sqlite3 ~/nanoclaw/store/messages.db << 'EOF'
CREATE TABLE IF NOT EXISTS api_usage (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp           TEXT NOT NULL,
  group_jid           TEXT,
  model               TEXT NOT NULL,
  input_tokens        INTEGER DEFAULT 0,
  output_tokens       INTEGER DEFAULT 0,
  cache_write_tokens  INTEGER DEFAULT 0,
  cache_read_tokens   INTEGER DEFAULT 0,
  estimated_cost_usd  REAL DEFAULT 0,
  metadata            TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_usage_timestamp ON api_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_api_usage_group     ON api_usage(group_jid);
EOF
```

Verify the table exists:

```bash
sqlite3 ~/nanoclaw/store/messages.db ".tables" | grep api_usage
```

---

### Step 2 — Create `src/cost-tracker.ts`

Create the file `src/cost-tracker.ts` with the following exact content:

```typescript
import Database from 'better-sqlite3';

// ─── Per-token pricing (USD per individual token, not per million) ──────────
// Source: https://anthropic.com/pricing — update if prices change
const PRICING: Record<string, {
  input: number; output: number; cacheWrite: number; cacheRead: number;
}> = {
  'claude-sonnet-4-20250514': {
    input:      3.00 / 1_000_000,
    output:    15.00 / 1_000_000,
    cacheWrite: 3.75 / 1_000_000,
    cacheRead:  0.30 / 1_000_000,
  },
  'claude-opus-4-20250514': {
    input:      15.00 / 1_000_000,
    output:     75.00 / 1_000_000,
    cacheWrite: 18.75 / 1_000_000,
    cacheRead:   1.50 / 1_000_000,
  },
  'claude-haiku-4-5-20251001': {
    input:      0.80 / 1_000_000,
    output:      4.00 / 1_000_000,
    cacheWrite:  1.00 / 1_000_000,
    cacheRead:   0.08 / 1_000_000,
  },
};

const DEFAULT_PRICING = PRICING['claude-sonnet-4-20250514'];

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UsageData {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ─── Cost calculation ───────────────────────────────────────────────────────

export function calculateCost(model: string, usage: UsageData): number {
  const p = PRICING[model] ?? DEFAULT_PRICING;
  return (
    (usage.input_tokens                      ?? 0) * p.input +
    (usage.output_tokens                     ?? 0) * p.output +
    (usage.cache_creation_input_tokens       ?? 0) * p.cacheWrite +
    (usage.cache_read_input_tokens           ?? 0) * p.cacheRead
  );
}

// ─── Write ──────────────────────────────────────────────────────────────────

export function logUsage(
  db: Database.Database,
  groupJid: string,
  model: string,
  usage: UsageData,
  metadata?: object
): void {
  const cost = calculateCost(model, usage);
  db.prepare(`
    INSERT INTO api_usage
      (timestamp, group_jid, model,
       input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
       estimated_cost_usd, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    groupJid,
    model,
    usage.input_tokens                      ?? 0,
    usage.output_tokens                     ?? 0,
    usage.cache_creation_input_tokens       ?? 0,
    usage.cache_read_input_tokens           ?? 0,
    cost,
    metadata ? JSON.stringify(metadata) : null
  );
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export function getMonthlyCostReport(db: Database.Database) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const since = monthStart.toISOString();

  const { total } = db.prepare(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
     FROM api_usage WHERE timestamp >= ?`
  ).get(since) as { total: number };

  const byGroup = db.prepare(
    `SELECT group_jid, SUM(estimated_cost_usd) as cost, COUNT(*) as messages
     FROM api_usage WHERE timestamp >= ?
     GROUP BY group_jid ORDER BY cost DESC`
  ).all(since) as { group_jid: string; cost: number; messages: number }[];

  const byDay = db.prepare(
    `SELECT strftime('%Y-%m-%d', timestamp) as date, SUM(estimated_cost_usd) as cost
     FROM api_usage WHERE timestamp >= ?
     GROUP BY date ORDER BY date DESC LIMIT 30`
  ).all(since) as { date: string; cost: number }[];

  const tokens = db.prepare(
    `SELECT
       COALESCE(SUM(input_tokens),       0) as input,
       COALESCE(SUM(output_tokens),      0) as output,
       COALESCE(SUM(cache_write_tokens), 0) as cache_write,
       COALESCE(SUM(cache_read_tokens),  0) as cache_read
     FROM api_usage WHERE timestamp >= ?`
  ).get(since) as { input: number; output: number; cache_write: number; cache_read: number };

  return { total_usd: total, by_group: byGroup, by_day: byDay, token_breakdown: tokens };
}

export function getDailyCost(db: Database.Database): number {
  const today = new Date().toISOString().slice(0, 10);
  const { total } = db.prepare(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
     FROM api_usage WHERE timestamp LIKE ?`
  ).get(`${today}%`) as { total: number };
  return total;
}

export function getProjectedMonthlyCost(db: Database.Database): number {
  const { avg } = db.prepare(`
    SELECT COALESCE(AVG(daily_cost), 0) as avg
    FROM (
      SELECT strftime('%Y-%m-%d', timestamp) as day,
             SUM(estimated_cost_usd) as daily_cost
      FROM api_usage
      WHERE timestamp >= date('now', '-7 days')
      GROUP BY day
    )
  `).get() as { avg: number };
  return avg * 30;
}
```

---

### Step 3 — Create `src/cost-mcp-server.ts`

Create the file `src/cost-mcp-server.ts`:

```typescript
#!/usr/bin/env node
/**
 * MCP server for API cost monitoring.
 * Runs on the host, communicates with the container via stdio.
 * Exposes one tool: get_cost_report
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import {
  getMonthlyCostReport,
  getDailyCost,
  getProjectedMonthlyCost,
} from './cost-tracker.js';

const DB_PATH          = process.env.DB_PATH          ?? './store/messages.db';
const MONTHLY_BUDGET   = parseFloat(process.env.MONTHLY_BUDGET_USD ?? '25');

const server = new Server(
  { name: 'cost-monitoring', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_cost_report',
      description:
        'Returns API cost breakdown for the current month: total spent, ' +
        'breakdown by group, daily costs, token counts, and projected end-of-month cost. ' +
        'Use this when the user asks about API spending, cost, or usage.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'get_cost_report') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const db = new Database(DB_PATH, { readonly: true });
  try {
    const report    = getMonthlyCostReport(db);
    const today     = getDailyCost(db);
    const projected = getProjectedMonthlyCost(db);
    const budgetPct = (report.total_usd / MONTHLY_BUDGET) * 100;
    const remaining = MONTHLY_BUDGET - report.total_usd;
    const month     = new Date().toISOString().slice(0, 7);

    const lines: string[] = [];

    if (budgetPct >= 95) {
      lines.push(`🚨 CRITICAL ALERT: ${budgetPct.toFixed(0)}% of budget consumed`);
    } else if (budgetPct >= 80) {
      lines.push(`⚠️ WARNING: ${budgetPct.toFixed(0)}% of budget consumed`);
    }

    lines.push(`📊 API Cost — ${month}`);
    lines.push(``);
    lines.push(`Month total: $${report.total_usd.toFixed(3)} / $${MONTHLY_BUDGET}  (${budgetPct.toFixed(1)}%)`);
    lines.push(`Remaining:   $${remaining.toFixed(3)}`);
    lines.push(`Today:       $${today.toFixed(4)}`);
    lines.push(`Projected:   $${projected.toFixed(2)}/mo (based on last 7 days)`);
    lines.push(``);

    if (report.by_group.length > 0) {
      lines.push(`By group:`);
      for (const g of report.by_group) {
        lines.push(`  • ${g.group_jid}: $${g.cost.toFixed(4)}  (${g.messages} msgs)`);
      }
      lines.push(``);
    }

    const t = report.token_breakdown;
    lines.push(`Tokens this month:`);
    lines.push(`  Input:       ${fmt(t.input)}K`);
    lines.push(`  Output:      ${fmt(t.output)}K`);
    lines.push(`  Cache read:  ${fmt(t.cache_read)}K  (90% discount)`);
    lines.push(`  Cache write: ${fmt(t.cache_write)}K`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } finally {
    db.close();
  }
});

function fmt(n: number): string {
  return ((n ?? 0) / 1000).toFixed(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

### Step 4 — Logging hook in `container-runner.ts`

Read `src/container-runner.ts` completely. Locate where Agent SDK responses
are processed by looking for:
- The function that runs the agent (may be called `runAgent`, `runContainer`,
  `executeAgent`, or similar)
- The `for await` loop iterating over SDK events
- Any reference to `type: 'message'`, `usage`, `input_tokens`, or
  `output_tokens` in the response flow

Once located, add the import at the top of the file:

```typescript
import { logUsage } from './cost-tracker.js';
```

And inside the event loop, add the hook where usage data appears.
The exact pattern depends on the SDK version. Look for one of these:

**Pattern A** — `message` type events:
```typescript
if (event.type === 'message' && event.message?.usage) {
  logUsage(db, groupJid, event.message.model ?? 'claude-sonnet-4-20250514', event.message.usage);
}
```

**Pattern B** — final result with usage:
```typescript
if (result?.usage) {
  logUsage(db, groupJid, result.model ?? 'claude-sonnet-4-20250514', result.usage);
}
```

**Pattern C** — stream with `finalMessage`:
```typescript
if (stream.finalMessage?.usage) {
  logUsage(db, groupJid, stream.finalMessage.model ?? 'claude-sonnet-4-20250514', stream.finalMessage.usage);
}
```

Use whichever pattern matches the actual code structure. If usage data appears
at multiple points (e.g., intermediate messages and the final message), use
**only the final message** to avoid double-counting.

Make sure the `db` variable (better-sqlite3 instance) is in scope where you
add the hook. If not, pass it as a parameter or open it locally.

---

### Step 5 — Modify `container/agent-runner/src/index.ts`

Read the full file. Locate:
1. The `mcpServers` object (where github, google-calendar, etc. are registered)
2. The `allowedTools` array (where `mcp__github__*` patterns are listed)

Add to the `mcpServers` object:

```typescript
'cost-monitoring': {
  command: 'node',
  args: [`${process.env.HOME}/nanoclaw/dist/cost-mcp-server.js`],
  env: {
    DB_PATH: `${process.env.HOME}/nanoclaw/store/messages.db`,
    MONTHLY_BUDGET_USD: process.env.MONTHLY_BUDGET_USD ?? '25',
  },
},
```

Add to the `allowedTools` array:

```typescript
'mcp__cost-monitoring__get_cost_report',
```

---

### Step 6 — Alert logic in `src/index.ts`

Read `src/index.ts` completely. Locate:
- The function or point where NanoClaw sends proactive messages to the main chat
  (the same function that scheduled tasks use to send notifications)
- The main message processing loop

Add the import at the top:

```typescript
import { getMonthlyCostReport } from './cost-tracker.js';
```

Add this function in the module (outside the main loop):

```typescript
const MONTHLY_BUDGET_USD  = 25;
const ALERT_WARN_PCT      = 0.80;
const ALERT_CRITICAL_PCT  = 0.95;

// In-memory tracking to avoid spamming (resets on process restart)
const budgetAlertsToday = new Set<string>();
let budgetAlertDate     = new Date().toISOString().slice(0, 10);

async function checkBudgetAlert(
  db: Database.Database,
  sendMessage: (text: string) => Promise<void>
): Promise<void> {
  // Reset flags if the day changed
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetAlertDate) {
    budgetAlertsToday.clear();
    budgetAlertDate = today;
  }

  const report = getMonthlyCostReport(db);
  const pct    = report.total_usd / MONTHLY_BUDGET_USD;

  if (pct >= ALERT_CRITICAL_PCT && !budgetAlertsToday.has('critical')) {
    budgetAlertsToday.add('critical');
    await sendMessage(
      `🚨 *CRITICAL ALERT — API Budget*\n` +
      `${(pct * 100).toFixed(0)}% consumed: ` +
      `$${report.total_usd.toFixed(2)} of $${MONTHLY_BUDGET_USD}\n` +
      `$${(MONTHLY_BUDGET_USD - report.total_usd).toFixed(2)} remaining. ` +
      `Consider reducing scheduled tasks.`
    );
  } else if (pct >= ALERT_WARN_PCT && !budgetAlertsToday.has('warning')) {
    budgetAlertsToday.add('warning');
    await sendMessage(
      `⚠️ *API Budget Warning*\n` +
      `${(pct * 100).toFixed(0)}% consumed this month: ` +
      `$${report.total_usd.toFixed(2)} of $${MONTHLY_BUDGET_USD}`
    );
  }
}
```

Call `checkBudgetAlert(db, sendToMain)` **after each agent response** that
logged usage. Use the same `sendToMain` function (or equivalent) that
scheduled tasks use to send proactive messages to the main Telegram chat.

---

### Step 7 — Compile TypeScript

```bash
cd ~/nanoclaw
npm run build
```

If the command fails, try:

```bash
npx tsc --noEmit  # Type-check only
npx tsc           # Compile
```

Fix any type errors before continuing. Most likely errors:
- `db` not in scope at the hook location → pass it as a parameter
- `usage` type not recognized → add `as any` temporarily if the SDK doesn't export the type

---

### Step 8 — Rebuild Docker image

```bash
docker build -t nanoclaw-agent:latest \
  -f ~/nanoclaw/container/Dockerfile \
  ~/nanoclaw/container/
```

Wait for it to complete without errors.

---

### Step 9 — Clear cache and restart

```bash
# Clear session cache to force container recreation
rm -rf ~/nanoclaw/data/sessions/*/agent-runner-src

# Restart the service
systemctl --user restart nanoclaw
sleep 3
systemctl --user status nanoclaw
```

---

### Step 10 — Verification

**10.1 Verify empty table (expected at start):**
```bash
sqlite3 ~/nanoclaw/store/messages.db \
  "SELECT COUNT(*) FROM api_usage;"
# Should return: 0
```

**10.2 Send a test message from Telegram and verify logging:**
```bash
# Wait 10 seconds after the message, then:
sqlite3 ~/nanoclaw/store/messages.db \
  "SELECT timestamp, group_jid, model, input_tokens, output_tokens,
          ROUND(estimated_cost_usd, 6) as cost_usd
   FROM api_usage ORDER BY id DESC LIMIT 3;"
```

If the table is still empty after the message, the hook in `container-runner.ts`
is not capturing usage. Revisit Step 4 — the capture point may be elsewhere
in the code. Use:
```bash
grep -rn "usage\|input_tokens\|output_tokens" ~/nanoclaw/src/ --include="*.ts" \
  | grep -v "cost-tracker\|cost-mcp"
```
to locate where the existing code already processes SDK usage data.

**10.3 Verify MCP tool from Telegram:**
```
@AssistantName, how much have I spent on the API this month?
```
The agent should invoke `get_cost_report` and respond with the breakdown.

---

## Summary of modified files

| File | Change type |
|---|---|
| `store/messages.db` | New `api_usage` table + indexes |
| `src/cost-tracker.ts` | **New** — cost calculation and queries |
| `src/cost-mcp-server.ts` | **New** — MCP tool `get_cost_report` |
| `src/container-runner.ts` | Add import + logging hook |
| `container/agent-runner/src/index.ts` | Add MCP server + allowedTool |
| `src/index.ts` | Add import + `checkBudgetAlert` function |

---

## Important notes

- The MCP server (`cost-mcp-server.ts`) runs on the **host**, not inside the
  Docker container. It communicates via stdio just like the other MCP servers.
- The `api_usage` table uses the same `store/messages.db` database as the
  rest of NanoClaw — no new database needed.
- The monthly budget defaults to $25. Set `MONTHLY_BUDGET_USD` in your `.env`
  and systemd unit override to use a different value. Keep the MCP server env var (Step 5)
  and the constant in `src/index.ts` (Step 6) in sync.
- If `better-sqlite3` is not available on the host (only in the container),
  install it: `npm install better-sqlite3 @types/better-sqlite3`
