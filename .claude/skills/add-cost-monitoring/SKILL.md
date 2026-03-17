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

### Step 0 — Ask for monthly budget

**Ask the user:** "What is your monthly API budget in USD? (e.g., 25)"

Wait for their answer. Then save it to the environment in two places:

**`.env` file** — append or update the variable:
```bash
grep -q '^MONTHLY_BUDGET_USD=' ~/nanoclaw/.env \
  && sed -i 's/^MONTHLY_BUDGET_USD=.*/MONTHLY_BUDGET_USD=<VALUE>/' ~/nanoclaw/.env \
  || echo 'MONTHLY_BUDGET_USD=<VALUE>' >> ~/nanoclaw/.env
```

**Systemd unit override** (Linux VPS) — the service does not inherit `.env`
automatically, so the variable must also be set in the unit:
```bash
systemctl --user cat nanoclaw 2>/dev/null | grep -q MONTHLY_BUDGET_USD \
  && echo "Already set in unit — update it manually with: systemctl --user edit nanoclaw" \
  || systemctl --user edit nanoclaw --force
```
If the file opens, add under `[Service]`:
```ini
Environment=MONTHLY_BUDGET_USD=<VALUE>
```

> Replace `<VALUE>` with the number the user provided.
> To change the budget later, use the `/set-monthly-budget` skill.

---

### Step 1 — Install host dependencies

`better-sqlite3` is required on the **host** for `cost-tracker.ts` and the
host-side alert logic. Install it if not already present:

```bash
cd ~/nanoclaw
node -e "require('better-sqlite3')" 2>/dev/null && echo "better-sqlite3 OK" || npm install better-sqlite3 && npm install --save-dev @types/better-sqlite3
```

---

### Step 2 — Create the `api_usage` SQLite table

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

Verify:
```bash
sqlite3 ~/nanoclaw/store/messages.db ".tables" | grep api_usage
```

---

### Step 3 — Create `src/cost-tracker.ts`

Create the file `src/cost-tracker.ts`:

```typescript
import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from './config.js';

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

export interface UsageData {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function calculateCost(model: string, usage: UsageData): number {
  const p = PRICING[model] ?? DEFAULT_PRICING;
  return (
    (usage.input_tokens                      ?? 0) * p.input +
    (usage.output_tokens                     ?? 0) * p.output +
    (usage.cache_creation_input_tokens       ?? 0) * p.cacheWrite +
    (usage.cache_read_input_tokens           ?? 0) * p.cacheRead
  );
}

export function logUsage(
  db: Database.Database,
  groupJid: string,
  model: string,
  usage: UsageData,
  metadata?: object,
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
    metadata ? JSON.stringify(metadata) : null,
  );
}

// Convenience wrapper: opens its own connection to the default DB path
export function logUsageToDb(
  groupJid: string,
  model: string,
  usage: UsageData,
  metadata?: object,
): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  const db = new Database(dbPath);
  try {
    logUsage(db, groupJid, model, usage, metadata);
  } finally {
    db.close();
  }
}

export function getMonthlyCostReport(db: Database.Database) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const since = monthStart.toISOString();

  const { total } = db.prepare(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
     FROM api_usage WHERE timestamp >= ?`,
  ).get(since) as { total: number };

  const byGroup = db.prepare(
    `SELECT group_jid, SUM(estimated_cost_usd) as cost, COUNT(*) as messages
     FROM api_usage WHERE timestamp >= ?
     GROUP BY group_jid ORDER BY cost DESC`,
  ).all(since) as { group_jid: string; cost: number; messages: number }[];

  const byDay = db.prepare(
    `SELECT strftime('%Y-%m-%d', timestamp) as date, SUM(estimated_cost_usd) as cost
     FROM api_usage WHERE timestamp >= ?
     GROUP BY date ORDER BY date DESC LIMIT 30`,
  ).all(since) as { date: string; cost: number }[];

  const tokens = db.prepare(
    `SELECT
       COALESCE(SUM(input_tokens),       0) as input,
       COALESCE(SUM(output_tokens),      0) as output,
       COALESCE(SUM(cache_write_tokens), 0) as cache_write,
       COALESCE(SUM(cache_read_tokens),  0) as cache_read
     FROM api_usage WHERE timestamp >= ?`,
  ).get(since) as { input: number; output: number; cache_write: number; cache_read: number };

  return { total_usd: total, by_group: byGroup, by_day: byDay, token_breakdown: tokens };
}

export function getDailyCost(db: Database.Database): number {
  const today = new Date().toISOString().slice(0, 10);
  const { total } = db.prepare(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
     FROM api_usage WHERE timestamp LIKE ?`,
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

### Step 4 — Create `src/cost-mcp-server.ts`

> **Critical:** Do NOT import from `./cost-tracker.js` or any other host
> module here. The MCP server is bundled into a self-contained file for the
> container (Step 8), and importing host modules like `cost-tracker.ts` would
> pull in the entire host dependency chain (`config.ts` → `logger.ts` →
> `pino` → `pino-pretty`), which are not available in the container and cause
> silent startup failures. All SQL queries must be inlined directly.

```typescript
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';

const DB_PATH        = process.env.DB_PATH        ?? './store/messages.db';
const MONTHLY_BUDGET = parseFloat(process.env.MONTHLY_BUDGET_USD ?? '25');

// SQL queries inlined — do NOT import from cost-tracker.ts (see note above)
function getMonthlyCostReport(db: Database.Database) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const since = monthStart.toISOString();

  const { total } = db.prepare(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total FROM api_usage WHERE timestamp >= ?`,
  ).get(since) as { total: number };

  const byGroup = db.prepare(
    `SELECT group_jid, SUM(estimated_cost_usd) as cost, COUNT(*) as messages
     FROM api_usage WHERE timestamp >= ? GROUP BY group_jid ORDER BY cost DESC`,
  ).all(since) as { group_jid: string; cost: number; messages: number }[];

  const byDay = db.prepare(
    `SELECT strftime('%Y-%m-%d', timestamp) as date, SUM(estimated_cost_usd) as cost
     FROM api_usage WHERE timestamp >= ? GROUP BY date ORDER BY date DESC LIMIT 30`,
  ).all(since) as { date: string; cost: number }[];

  const tokens = db.prepare(
    `SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output,
            COALESCE(SUM(cache_write_tokens),0) as cache_write, COALESCE(SUM(cache_read_tokens),0) as cache_read
     FROM api_usage WHERE timestamp >= ?`,
  ).get(since) as { input: number; output: number; cache_write: number; cache_read: number };

  return { total_usd: total, by_group: byGroup, by_day: byDay, token_breakdown: tokens };
}

function getDailyCost(db: Database.Database): number {
  const today = new Date().toISOString().slice(0, 10);
  const { total } = db.prepare(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total FROM api_usage WHERE timestamp LIKE ?`,
  ).get(`${today}%`) as { total: number };
  return total;
}

function getProjectedMonthlyCost(db: Database.Database): number {
  const { avg } = db.prepare(`
    SELECT COALESCE(AVG(daily_cost), 0) as avg FROM (
      SELECT strftime('%Y-%m-%d', timestamp) as day, SUM(estimated_cost_usd) as daily_cost
      FROM api_usage WHERE timestamp >= date('now', '-7 days') GROUP BY day
    )
  `).get() as { avg: number };
  return avg * 30;
}

const server = new Server(
  { name: 'cost-monitoring', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// Deep analysis: per-group cache efficiency, heaviest calls, 14-day trend
function getCostAnalysis(db: Database.Database) {
  const byGroup = db.prepare(`
    SELECT
      group_jid,
      COUNT(*) as messages,
      ROUND(AVG(input_tokens), 0) as avg_input,
      ROUND(AVG(output_tokens), 0) as avg_output,
      ROUND(AVG(cache_read_tokens), 0) as avg_cache_read,
      ROUND(AVG(cache_write_tokens), 0) as avg_cache_write,
      ROUND(AVG(estimated_cost_usd), 6) as avg_cost_per_msg,
      SUM(estimated_cost_usd) as total_cost,
      ROUND(
        SUM(CAST(cache_read_tokens AS REAL))
        / NULLIF(SUM(CAST(input_tokens + cache_read_tokens + cache_write_tokens AS REAL)), 0)
        * 100
      , 1) as cache_hit_pct
    FROM api_usage
    WHERE timestamp >= date('now', '-30 days')
    GROUP BY group_jid
    ORDER BY total_cost DESC
  `).all() as {
    group_jid: string; messages: number; avg_input: number; avg_output: number;
    avg_cache_read: number; avg_cache_write: number; avg_cost_per_msg: number;
    total_cost: number; cache_hit_pct: number;
  }[];

  const heaviest = db.prepare(`
    SELECT strftime('%Y-%m-%d %H:%M', timestamp) as ts,
      group_jid, input_tokens, cache_read_tokens, output_tokens, estimated_cost_usd
    FROM api_usage
    WHERE timestamp >= date('now', '-7 days')
    ORDER BY (input_tokens + cache_read_tokens) DESC
    LIMIT 10
  `).all() as {
    ts: string; group_jid: string; input_tokens: number;
    cache_read_tokens: number; output_tokens: number; estimated_cost_usd: number;
  }[];

  const trend = db.prepare(`
    SELECT strftime('%Y-%m-%d', timestamp) as date,
      SUM(estimated_cost_usd) as cost, SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens, COUNT(*) as messages
    FROM api_usage
    WHERE timestamp >= date('now', '-14 days')
    GROUP BY date ORDER BY date DESC
  `).all() as {
    date: string; cost: number; input_tokens: number;
    output_tokens: number; messages: number;
  }[];

  return { byGroup, heaviest, trend };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_cost_report',
      description:
        'Returns API cost breakdown for the current month: total spent, ' +
        'breakdown by group, daily costs, token counts, and projected end-of-month cost. ' +
        'Use this when the user asks about API spending, cost, or usage.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_cost_analysis',
      description:
        'Deep cost analysis: per-group cache efficiency, average tokens per message, ' +
        'heaviest individual API calls (last 7 days), 14-day trend, and optimization signals. ' +
        'Use this when the user asks WHERE the spending comes from, wants to reduce costs, ' +
        'or wants to understand which groups or files are consuming the most tokens.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'get_cost_report' && request.params.name !== 'get_cost_analysis') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  if (request.params.name === 'get_cost_analysis') {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const { byGroup, heaviest, trend } = getCostAnalysis(db);
      const lines: string[] = [];
      lines.push(`📊 Deep Cost Analysis`);
      lines.push(``);

      lines.push(`=== Token Efficiency per Group (last 30 days) ===`);
      if (byGroup.length === 0) {
        lines.push(`  No data yet.`);
      } else {
        for (const g of byGroup) {
          const cacheFlag = g.cache_hit_pct !== null && g.cache_hit_pct < 30
            ? ` ⚠️ LOW CACHE` : g.cache_hit_pct >= 70 ? ` ✅` : ``;
          lines.push(
            `  • ${g.group_jid}:` +
            ` ${g.messages} msgs | avg_input: ${fmt(g.avg_input)}K/msg |` +
            ` cache_hit: ${g.cache_hit_pct ?? 0}%${cacheFlag} |` +
            ` avg_cost: $${(g.avg_cost_per_msg ?? 0).toFixed(5)}/msg |` +
            ` total: $${(g.total_cost ?? 0).toFixed(4)}`
          );
        }
      }
      lines.push(``);

      lines.push(`=== Optimization Signals ===`);
      let hasSignals = false;
      for (const g of byGroup) {
        if (g.cache_hit_pct !== null && g.cache_hit_pct < 30) {
          lines.push(
            `  ⚠️ ${g.group_jid}: cache hit ${g.cache_hit_pct}% — ` +
            `CLAUDE.md or system prompt may be changing between messages, ` +
            `preventing cache reuse. Check if CLAUDE.md has dynamic content.`
          );
          hasSignals = true;
        }
        if (g.avg_input > 50000) {
          lines.push(
            `  ⚠️ ${g.group_jid}: avg ${fmt(g.avg_input)}K input tokens/msg — ` +
            `large static context. Consider trimming CLAUDE.md, summarizing ` +
            `memory files, or removing rarely-used sections.`
          );
          hasSignals = true;
        }
        if (g.avg_output > 8000) {
          lines.push(
            `  ⚠️ ${g.group_jid}: avg ${fmt(g.avg_output)}K output tokens/msg — ` +
            `very verbose responses. Consider adding brevity instructions to CLAUDE.md.`
          );
          hasSignals = true;
        }
      }
      if (!hasSignals) lines.push(`  ✅ No major inefficiencies detected from the data.`);
      lines.push(``);

      lines.push(`=== Heaviest Individual Calls (last 7 days) ===`);
      if (heaviest.length === 0) {
        lines.push(`  No data in last 7 days.`);
      } else {
        for (const h of heaviest) {
          const total = h.input_tokens + h.cache_read_tokens;
          lines.push(
            `  • ${h.ts} ${h.group_jid}:` +
            ` ${fmt(h.input_tokens)}K input + ${fmt(h.cache_read_tokens)}K cached` +
            ` = ${fmt(total)}K context | $${h.estimated_cost_usd.toFixed(5)}`
          );
        }
      }
      lines.push(``);

      lines.push(`=== 14-Day Cost Trend ===`);
      if (trend.length === 0) {
        lines.push(`  No data yet.`);
      } else {
        for (const d of trend) {
          lines.push(`  ${d.date}: $${d.cost.toFixed(4)} (${d.messages} msgs, ${fmt(d.input_tokens)}K input)`);
        }
      }
      lines.push(``);

      lines.push(`=== File Analysis — Run These Commands ===`);
      lines.push(`Run the following to identify large context files contributing to token costs:`);
      lines.push(``);
      lines.push(`# Size of main CLAUDE.md (system prompt sent every message)`);
      lines.push(`wc -c /workspace/CLAUDE.md 2>/dev/null || echo "no CLAUDE.md"`);
      lines.push(``);
      lines.push(`# All markdown files sorted by size`);
      lines.push(`find /workspace -name "*.md" -not -path "*/.claude/*" | xargs wc -c 2>/dev/null | sort -rn | head -20`);
      lines.push(``);
      lines.push(`# Memory files`);
      lines.push(`ls -lh /workspace/extra/memory/ 2>/dev/null || echo "no memory dir"`);
      lines.push(``);
      lines.push(`After running these, cross-reference: 1KB of markdown ≈ 250 tokens ≈ $0.00075/msg at Sonnet rates. A 20KB CLAUDE.md = ~5K tokens per message.`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } finally {
      db.close();
    }
  }

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
    const fmt = (n: number) => ((n ?? 0) / 1000).toFixed(1);
    lines.push(`Tokens this month:`);
    lines.push(`  Input:       ${fmt(t.input)}K`);
    lines.push(`  Output:      ${fmt(t.output)}K`);
    lines.push(`  Cache read:  ${fmt(t.cache_read)}K  (90% discount)`);
    lines.push(`  Cache write: ${fmt(t.cache_write)}K`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } finally {
    db.close();
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

### Step 5 — Add `better-sqlite3` to the agent-runner container

Read `container/agent-runner/package.json`. Add `better-sqlite3` to `dependencies`:

```json
"better-sqlite3": "^11.9.1",
```

> **Why:** The MCP server runs inside the Docker container. The container's
> base image has a different glibc version than the host, so the host-compiled
> `better-sqlite3.node` binary cannot be used inside the container (you get
> `GLIBC_X.XX not found`). Adding it here causes Docker to compile the native
> addon inside the container during image build, against the correct glibc.

---

### Step 6 — Bind-mounts and logging hook in `container-runner.ts`

Read `src/container-runner.ts` completely.

**6a — Add bind-mounts for the MCP bundle and store directory**

Find the memory MCP binary mount (search for `memory-mcp-server.js`) and add
immediately after it:

```typescript
// Cost monitoring MCP: bundle mounted at /app/dist/ so Node.js finds
// /app/node_modules/better-sqlite3 (compiled for the container's glibc).
const costMcpBundle = path.join(process.cwd(), 'dist', 'cost-mcp-bundle.js');
if (fs.existsSync(costMcpBundle)) {
  mounts.push({
    hostPath: costMcpBundle,
    containerPath: '/app/dist/cost-mcp-server.js',
    readonly: true,
  });
}

// Cost monitoring DB: store directory read-only so the MCP can query it
const storeDir = path.join(process.cwd(), 'store');
if (fs.existsSync(storeDir)) {
  mounts.push({
    hostPath: storeDir,
    containerPath: '/workspace/store',
    readonly: true,
  });
}
```

> **Why `/app/dist/` and not `/usr/local/lib/`:** Node.js ESM module
> resolution for bare specifiers (like `better-sqlite3`) starts from the
> importing file's directory and walks up. Mounting at `/app/dist/` means
> resolution reaches `/app/node_modules/` where the container-compiled
> `better-sqlite3` lives. From `/usr/local/lib/` the resolution never reaches
> `/app/node_modules/` and the import fails.

**6b — Add the usage logging hook**

Add the import at the top of `container-runner.ts`:

```typescript
import { logUsageToDb, UsageData } from './cost-tracker.js';
```

Locate where the container output is parsed — look for `OUTPUT_START_MARKER`,
`parsed.usage`, or `output_tokens` in the streaming output handler. Add the
hook where usage data first appears on a successful output:

```typescript
if (parsed.usage && parsed.result) {
  logUsageToDb(
    input.chatJid,
    parsed.model ?? 'claude-sonnet-4-20250514',
    parsed.usage,
  );
}
```

Use only the final message to avoid double-counting.

---

### Step 7 — Modify `container/agent-runner/src/index.ts`

Read the full file. Locate the `mcpServers` object and `allowedTools` array.

Add to `mcpServers`, guarded by `fs.existsSync` (same pattern as the memory
MCP — search for `memory-mcp-server.js` in the file to see the pattern):

```typescript
...(fs.existsSync('/app/dist/cost-mcp-server.js') ? {
  'cost-monitoring': {
    command: 'node',
    args: ['/app/dist/cost-mcp-server.js'],
    env: {
      DB_PATH: '/workspace/store/messages.db',
      MONTHLY_BUDGET_USD: process.env.MONTHLY_BUDGET_USD ?? '25',
    },
  },
} : {}),
```

Add to `allowedTools`:

```typescript
'mcp__cost-monitoring__get_cost_report',
'mcp__cost-monitoring__get_cost_analysis',
```

---

### Step 8 — Update `package.json` build script and compile

Read `package.json`. Update the `build` script to also generate the
self-contained MCP bundle after the TypeScript compile:

```json
"build": "tsc && npx esbuild src/cost-mcp-server.ts --bundle --platform=node --format=esm --external:better-sqlite3 --external:'@modelcontextprotocol/*' --outfile=dist/cost-mcp-bundle.js",
```

Then build:

```bash
cd ~/nanoclaw && npm run build
```

Verify the bundle was created:

```bash
ls -lh ~/nanoclaw/dist/cost-mcp-bundle.js
# Should be ~5kb (only SQL + MCP logic, no host deps)
```

> If the bundle is larger than ~20kb, the esbuild command is accidentally
> including host modules. Check that all non-container deps are in `--external`.

---

### Step 9 — Alert logic in `src/index.ts`

Read `src/index.ts` completely. Locate the function that sends proactive
messages to the main chat (used by scheduled tasks).

Add the import at the top:

```typescript
import { getMonthlyCostReport } from './cost-tracker.js';
```

Add this function in the module (outside the main loop):

```typescript
const MONTHLY_BUDGET_USD  = parseFloat(process.env.MONTHLY_BUDGET_USD ?? '25');
const ALERT_WARN_PCT      = 0.80;
const ALERT_CRITICAL_PCT  = 0.95;

const budgetAlertsToday = new Set<string>();
let budgetAlertDate     = new Date().toISOString().slice(0, 10);

async function checkBudgetAlert(
  db: Database.Database,
  sendMessage: (text: string) => Promise<void>
): Promise<void> {
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

Call `checkBudgetAlert(db, sendToMain)` after each agent response that logged
usage. Use the same `sendToMain` (or equivalent) that scheduled tasks use.

---

### Step 10 — Rebuild Docker image

The Docker image must be rebuilt because `better-sqlite3` was added to the
agent-runner dependencies (Step 5). It needs to be compiled inside the
container against the container's glibc — you cannot mount the host-compiled
binary since the container may have a different glibc version.

```bash
docker build -t nanoclaw-agent:latest \
  -f ~/nanoclaw/container/Dockerfile \
  ~/nanoclaw/container/
```

---

### Step 11 — Clear cache and restart

```bash
rm -rf ~/nanoclaw/data/sessions/*/agent-runner-src
systemctl --user restart nanoclaw
sleep 3
systemctl --user status nanoclaw
```

---

### Step 12 — Verification

**12.1 Verify the MCP bundle works inside the container:**
```bash
printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_cost_report","arguments":{}}}\n' \
  | docker run --rm -i \
    --entrypoint node \
    -v ~/nanoclaw/dist/cost-mcp-bundle.js:/app/dist/cost-mcp-server.js:ro \
    -v ~/nanoclaw/store:/workspace/store:ro \
    -e DB_PATH=/workspace/store/messages.db \
    nanoclaw-agent:latest \
    /app/dist/cost-mcp-server.js 2>&1
# Should return a JSON response with cost data (or zeros if no data yet)
```

**12.2 Verify usage is being logged (send a message, then check):**
```bash
sqlite3 ~/nanoclaw/store/messages.db \
  "SELECT timestamp, group_jid, model, input_tokens, output_tokens,
          ROUND(estimated_cost_usd, 6) as cost_usd
   FROM api_usage ORDER BY id DESC LIMIT 3;"
```

**12.3 Ask the agent from Telegram:**
```
@AssistantName, how much have I spent on the API this month?
```
The agent should invoke `get_cost_report` and respond with the breakdown.

---

## Summary of modified files

| File | Change type |
|---|---|
| `store/messages.db` | New `api_usage` table + indexes |
| `src/cost-tracker.ts` | **New** — cost calculation, queries, host-side logging |
| `src/cost-mcp-server.ts` | **New** — self-contained MCP tool (SQL inlined, no host imports) |
| `src/container-runner.ts` | Add import + logging hook + bind-mounts for bundle and store dir |
| `container/agent-runner/package.json` | Add `better-sqlite3` dependency |
| `container/agent-runner/src/index.ts` | Add MCP server registration + allowedTool |
| `package.json` | Add esbuild bundle step to `build` script |
| `src/index.ts` | Add import + `checkBudgetAlert` function |

---

## Important notes

- **The MCP server runs inside the container** as a subprocess spawned via
  stdio. It does NOT run on the host.

- **`cost-mcp-server.ts` must not import from `cost-tracker.ts`** or any
  other host module. The host codebase imports `pino`/`pino-pretty` via the
  logger chain, which are not available in the container. The MCP server is
  bundled with esbuild into `dist/cost-mcp-bundle.js` (~5kb) with only
  `better-sqlite3` and `@modelcontextprotocol/sdk` as external dependencies.

- **`better-sqlite3` must be compiled inside the container** (Step 5 + 10).
  The host and container may have different glibc versions. Mounting the
  host-compiled `.node` binary into the container causes `GLIBC_X.XX not
  found` errors. Adding it to `container/agent-runner/package.json` and
  rebuilding the image compiles it correctly.

- **Bundle mounted at `/app/dist/`**, not `/usr/local/lib/`. Node.js ESM
  resolution walks up from the file's directory — from `/app/dist/` it reaches
  `/app/node_modules/` where `better-sqlite3` lives. From `/usr/local/lib/`
  it never finds `/app/node_modules/`.

- The `api_usage` table uses the same `store/messages.db` as the rest of
  NanoClaw — no new database needed.

- To change the budget after installation, use the `/set-monthly-budget` skill.
