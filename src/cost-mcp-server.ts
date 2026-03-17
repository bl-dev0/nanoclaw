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
  ],
}));

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: { params: { name: string } }) => {
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
