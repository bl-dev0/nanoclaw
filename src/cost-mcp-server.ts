#!/usr/bin/env node
/**
 * MCP server para monitorización de costes de API.
 * Corre en el host, se comunica con el contenedor via stdio.
 * Expone una herramienta: get_cost_report
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';

// SQL queries inlined to avoid importing cost-tracker.ts (which pulls in
// the host logger chain and causes failures when run inside the container).

function getMonthlyCostReport(db: Database.Database) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const since = monthStart.toISOString();

  const { total } = db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total FROM api_usage WHERE timestamp >= ?`,
    )
    .get(since) as { total: number };

  const byGroup = db
    .prepare(
      `SELECT group_jid, SUM(estimated_cost_usd) as cost, COUNT(*) as messages
     FROM api_usage WHERE timestamp >= ? GROUP BY group_jid ORDER BY cost DESC`,
    )
    .all(since) as { group_jid: string; cost: number; messages: number }[];

  const byDay = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', timestamp) as date, SUM(estimated_cost_usd) as cost
     FROM api_usage WHERE timestamp >= ? GROUP BY date ORDER BY date DESC LIMIT 30`,
    )
    .all(since) as { date: string; cost: number }[];

  const tokens = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output,
            COALESCE(SUM(cache_write_tokens),0) as cache_write, COALESCE(SUM(cache_read_tokens),0) as cache_read
     FROM api_usage WHERE timestamp >= ?`,
    )
    .get(since) as {
    input: number;
    output: number;
    cache_write: number;
    cache_read: number;
  };

  return {
    total_usd: total,
    by_group: byGroup,
    by_day: byDay,
    token_breakdown: tokens,
  };
}

function getDailyCost(db: Database.Database): number {
  const today = new Date().toISOString().slice(0, 10);
  const { total } = db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total FROM api_usage WHERE timestamp LIKE ?`,
    )
    .get(`${today}%`) as { total: number };
  return total;
}

function getProjectedMonthlyCost(db: Database.Database): number {
  const { avg } = db
    .prepare(
      `SELECT COALESCE(AVG(daily_cost), 0) as avg FROM (
       SELECT strftime('%Y-%m-%d', timestamp) as day, SUM(estimated_cost_usd) as daily_cost
       FROM api_usage WHERE timestamp >= date('now', '-7 days') GROUP BY day
     )`,
    )
    .get() as { avg: number };
  return avg * 30;
}

const DB_PATH = process.env.DB_PATH ?? './store/messages.db';
const MONTHLY_BUDGET = parseFloat(process.env.MONTHLY_BUDGET_USD ?? '25');

function getCostAnalysis(db: Database.Database) {
  // Per-group efficiency: cache hit rate, avg tokens per message, avg cost
  const byGroup = db
    .prepare(
      `SELECT
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
       ORDER BY total_cost DESC`,
    )
    .all() as {
    group_jid: string;
    messages: number;
    avg_input: number;
    avg_output: number;
    avg_cache_read: number;
    avg_cache_write: number;
    avg_cost_per_msg: number;
    total_cost: number;
    cache_hit_pct: number;
  }[];

  // Top 10 heaviest individual calls (last 7 days) by total context size
  const heaviest = db
    .prepare(
      `SELECT
         strftime('%Y-%m-%d %H:%M', timestamp) as ts,
         group_jid,
         input_tokens,
         cache_read_tokens,
         output_tokens,
         estimated_cost_usd
       FROM api_usage
       WHERE timestamp >= date('now', '-7 days')
       ORDER BY (input_tokens + cache_read_tokens) DESC
       LIMIT 10`,
    )
    .all() as {
    ts: string;
    group_jid: string;
    input_tokens: number;
    cache_read_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  }[];

  // 14-day daily trend
  const trend = db
    .prepare(
      `SELECT
         strftime('%Y-%m-%d', timestamp) as date,
         SUM(estimated_cost_usd) as cost,
         SUM(input_tokens) as input_tokens,
         SUM(output_tokens) as output_tokens,
         COUNT(*) as messages
       FROM api_usage
       WHERE timestamp >= date('now', '-14 days')
       GROUP BY date
       ORDER BY date DESC`,
    )
    .all() as {
    date: string;
    cost: number;
    input_tokens: number;
    output_tokens: number;
    messages: number;
  }[];

  return { byGroup, heaviest, trend };
}

const server = new Server(
  { name: 'cost-monitoring', version: '1.0.0' },
  { capabilities: { tools: {} } },
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
    {
      name: 'get_cost_analysis',
      description:
        'Deep cost analysis: per-group cache efficiency, average tokens per message, ' +
        'heaviest individual API calls (last 7 days), 14-day trend, and optimization signals. ' +
        'Use this when the user asks WHERE the spending comes from, wants to reduce costs, ' +
        'or wants to understand which groups or files are consuming the most tokens.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: { params: { name: string } }) => {
    if (
      request.params.name !== 'get_cost_report' &&
      request.params.name !== 'get_cost_analysis'
    ) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    if (request.params.name === 'get_cost_analysis') {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        const { byGroup, heaviest, trend } = getCostAnalysis(db);
        const lines: string[] = [];

        lines.push(`📊 Deep Cost Analysis`);
        lines.push(``);

        // Per-group efficiency
        lines.push(`=== Token Efficiency per Group (last 30 days) ===`);
        if (byGroup.length === 0) {
          lines.push(`  No data yet.`);
        } else {
          for (const g of byGroup) {
            const cacheFlag =
              g.cache_hit_pct !== null && g.cache_hit_pct < 30
                ? ` ⚠️ LOW CACHE`
                : g.cache_hit_pct >= 70
                  ? ` ✅`
                  : ``;
            lines.push(
              `  • ${g.group_jid}:` +
                ` ${g.messages} msgs |` +
                ` avg_input: ${fmt(g.avg_input)}K/msg |` +
                ` cache_hit: ${g.cache_hit_pct ?? 0}%${cacheFlag} |` +
                ` avg_cost: $${(g.avg_cost_per_msg ?? 0).toFixed(5)}/msg |` +
                ` total: $${(g.total_cost ?? 0).toFixed(4)}`,
            );
          }
        }
        lines.push(``);

        // Optimization signals derived from data
        lines.push(`=== Optimization Signals ===`);
        let hasSignals = false;
        for (const g of byGroup) {
          if (g.cache_hit_pct !== null && g.cache_hit_pct < 30) {
            lines.push(
              `  ⚠️ ${g.group_jid}: cache hit ${g.cache_hit_pct}% — ` +
                `CLAUDE.md or system prompt may be changing between messages, ` +
                `preventing cache reuse. Check if CLAUDE.md has dynamic content.`,
            );
            hasSignals = true;
          }
          if (g.avg_input > 50000) {
            lines.push(
              `  ⚠️ ${g.group_jid}: avg ${fmt(g.avg_input)}K input tokens/msg — ` +
                `large static context. Consider trimming CLAUDE.md, summarizing ` +
                `memory files, or removing rarely-used sections.`,
            );
            hasSignals = true;
          }
          if (g.avg_output > 8000) {
            lines.push(
              `  ⚠️ ${g.group_jid}: avg ${fmt(g.avg_output)}K output tokens/msg — ` +
                `very verbose responses. Consider adding brevity instructions to CLAUDE.md.`,
            );
            hasSignals = true;
          }
        }
        if (!hasSignals) {
          lines.push(`  ✅ No major inefficiencies detected from the data.`);
        }
        lines.push(``);

        // Heaviest calls
        lines.push(`=== Heaviest Individual Calls (last 7 days) ===`);
        if (heaviest.length === 0) {
          lines.push(`  No data in last 7 days.`);
        } else {
          for (const h of heaviest) {
            const total = h.input_tokens + h.cache_read_tokens;
            lines.push(
              `  • ${h.ts} ${h.group_jid}:` +
                ` ${fmt(h.input_tokens)}K input + ${fmt(h.cache_read_tokens)}K cached` +
                ` = ${fmt(total)}K context | $${h.estimated_cost_usd.toFixed(5)}`,
            );
          }
        }
        lines.push(``);

        // 14-day trend
        lines.push(`=== 14-Day Cost Trend ===`);
        if (trend.length === 0) {
          lines.push(`  No data yet.`);
        } else {
          for (const d of trend) {
            lines.push(
              `  ${d.date}: $${d.cost.toFixed(4)}` +
                ` (${d.messages} msgs, ${fmt(d.input_tokens)}K input tokens)`,
            );
          }
        }
        lines.push(``);

        // File analysis instructions for the agent
        lines.push(`=== File Analysis — Run These Commands ===`);
        lines.push(
          `Run the following to identify large context files contributing to token costs:`,
        );
        lines.push(``);
        lines.push(
          `# Size of main CLAUDE.md (system prompt sent every message)`,
        );
        lines.push(
          `wc -c /workspace/CLAUDE.md 2>/dev/null || echo "no CLAUDE.md"`,
        );
        lines.push(``);
        lines.push(`# All markdown files sorted by size`);
        lines.push(
          `find /workspace -name "*.md" -not -path "*/.claude/*" | xargs wc -c 2>/dev/null | sort -rn | head -20`,
        );
        lines.push(``);
        lines.push(`# Memory files`);
        lines.push(
          `ls -lh /workspace/extra/memory/ 2>/dev/null || echo "no memory dir"`,
        );
        lines.push(``);
        lines.push(
          `After running these, cross-reference: ` +
            `1KB of markdown ≈ 250 tokens ≈ $0.00075/msg at Sonnet rates. ` +
            `A 20KB CLAUDE.md = ~5K tokens per message.`,
        );

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
      const report = getMonthlyCostReport(db);
      const today = getDailyCost(db);
      const projected = getProjectedMonthlyCost(db);
      const budgetPct = (report.total_usd / MONTHLY_BUDGET) * 100;
      const remaining = MONTHLY_BUDGET - report.total_usd;
      const month = new Date().toISOString().slice(0, 7);

      const lines: string[] = [];

      if (budgetPct >= 95) {
        lines.push(
          `🚨 ALERTA CRÍTICA: ${budgetPct.toFixed(0)}% del presupuesto consumido`,
        );
      } else if (budgetPct >= 80) {
        lines.push(
          `⚠️ AVISO: ${budgetPct.toFixed(0)}% del presupuesto consumido`,
        );
      }

      lines.push(`📊 Coste API — ${month}`);
      lines.push(``);
      lines.push(
        `Total mes:   $${report.total_usd.toFixed(3)} / $${MONTHLY_BUDGET}  (${budgetPct.toFixed(1)}%)`,
      );
      lines.push(`Restante:    $${remaining.toFixed(3)}`);
      lines.push(`Hoy:         $${today.toFixed(4)}`);
      lines.push(
        `Proyección:  $${projected.toFixed(2)}/mes (basada en últimos 7 días)`,
      );
      lines.push(``);

      if (report.by_group.length > 0) {
        lines.push(`Por grupo:`);
        for (const g of report.by_group) {
          lines.push(
            `  • ${g.group_jid}: $${g.cost.toFixed(4)}  (${g.messages} msgs)`,
          );
        }
        lines.push(``);
      }

      const t = report.token_breakdown;
      lines.push(`Tokens este mes:`);
      lines.push(`  Input:       ${fmt(t.input)}K`);
      lines.push(`  Output:      ${fmt(t.output)}K`);
      lines.push(`  Cache read:  ${fmt(t.cache_read)}K  (90% descuento)`);
      lines.push(`  Cache write: ${fmt(t.cache_write)}K`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } finally {
      db.close();
    }
  },
);

function fmt(n: number): string {
  return ((n ?? 0) / 1000).toFixed(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
