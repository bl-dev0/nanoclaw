import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from './config.js';

// ─── Precios por token (USD por token individual, no por millón) ───────────
// Fuente: https://anthropic.com/pricing — actualizar si cambian
const PRICING: Record<
  string,
  {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
  }
> = {
  'claude-sonnet-4-20250514': {
    input: 3.0 / 1_000_000,
    output: 15.0 / 1_000_000,
    cacheWrite: 3.75 / 1_000_000,
    cacheRead: 0.3 / 1_000_000,
  },
  'claude-opus-4-20250514': {
    input: 15.0 / 1_000_000,
    output: 75.0 / 1_000_000,
    cacheWrite: 18.75 / 1_000_000,
    cacheRead: 1.5 / 1_000_000,
  },
  'claude-haiku-4-5-20251001': {
    input: 0.8 / 1_000_000,
    output: 4.0 / 1_000_000,
    cacheWrite: 1.0 / 1_000_000,
    cacheRead: 0.08 / 1_000_000,
  },
};

const DEFAULT_PRICING = PRICING['claude-sonnet-4-20250514'];

// ─── Tipos ─────────────────────────────────────────────────────────────────

export interface UsageData {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ─── Cálculo de coste ──────────────────────────────────────────────────────

export function calculateCost(model: string, usage: UsageData): number {
  const p = PRICING[model] ?? DEFAULT_PRICING;
  return (
    (usage.input_tokens ?? 0) * p.input +
    (usage.output_tokens ?? 0) * p.output +
    (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * p.cacheRead
  );
}

// ─── Escritura ─────────────────────────────────────────────────────────────

export function logUsage(
  db: Database.Database,
  groupJid: string,
  model: string,
  usage: UsageData,
  metadata?: object,
): void {
  const cost = calculateCost(model, usage);
  db.prepare(
    `
    INSERT INTO api_usage
      (timestamp, group_jid, model,
       input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
       estimated_cost_usd, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    new Date().toISOString(),
    groupJid,
    model,
    usage.input_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.cache_creation_input_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0,
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

// ─── Consultas ─────────────────────────────────────────────────────────────

export function getMonthlyCostReport(db: Database.Database) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const since = monthStart.toISOString();

  const { total } = db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
     FROM api_usage WHERE timestamp >= ?`,
    )
    .get(since) as { total: number };

  const byGroup = db
    .prepare(
      `SELECT group_jid, SUM(estimated_cost_usd) as cost, COUNT(*) as messages
     FROM api_usage WHERE timestamp >= ?
     GROUP BY group_jid ORDER BY cost DESC`,
    )
    .all(since) as { group_jid: string; cost: number; messages: number }[];

  const byDay = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', timestamp) as date, SUM(estimated_cost_usd) as cost
     FROM api_usage WHERE timestamp >= ?
     GROUP BY date ORDER BY date DESC LIMIT 30`,
    )
    .all(since) as { date: string; cost: number }[];

  const tokens = db
    .prepare(
      `SELECT
       COALESCE(SUM(input_tokens),       0) as input,
       COALESCE(SUM(output_tokens),      0) as output,
       COALESCE(SUM(cache_write_tokens), 0) as cache_write,
       COALESCE(SUM(cache_read_tokens),  0) as cache_read
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

export function getDailyCost(db: Database.Database): number {
  const today = new Date().toISOString().slice(0, 10);
  const { total } = db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
     FROM api_usage WHERE timestamp LIKE ?`,
    )
    .get(`${today}%`) as { total: number };
  return total;
}

export function getProjectedMonthlyCost(db: Database.Database): number {
  const { avg } = db
    .prepare(
      `
    SELECT COALESCE(AVG(daily_cost), 0) as avg
    FROM (
      SELECT strftime('%Y-%m-%d', timestamp) as day,
             SUM(estimated_cost_usd) as daily_cost
      FROM api_usage
      WHERE timestamp >= date('now', '-7 days')
      GROUP BY day
    )
  `,
    )
    .get() as { avg: number };
  return avg * 30;
}

/**
 * Generate a deterministic text report of API usage, grouped by day.
 * For each day: total cost, then per-group breakdown with model detail.
 * groupNames maps jid → human-readable name.
 * days: number of past days to include (default 7).
 */
export function generateApiReport(
  db: Database.Database,
  groupNames: Record<string, string>,
  days = 7,
): string {
  type DayRow = { date: string; cost: number; msgs: number };
  type DetailRow = {
    date: string;
    group_jid: string;
    model: string;
    msgs: number;
    input_k: number;
    output_k: number;
    cache_read_k: number;
    cache_write_k: number;
    cost: number;
  };

  const sinceExpr = `date('now', '-${days - 1} days')`;

  const byDay = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', timestamp) as date,
              SUM(estimated_cost_usd) as cost,
              COUNT(*) as msgs
       FROM api_usage
       WHERE timestamp >= ${sinceExpr}
       GROUP BY date ORDER BY date DESC`,
    )
    .all() as DayRow[];

  const detail = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', timestamp) as date,
              group_jid,
              model,
              COUNT(*) as msgs,
              ROUND(SUM(input_tokens)       / 1000.0, 1) as input_k,
              ROUND(SUM(output_tokens)      / 1000.0, 1) as output_k,
              ROUND(SUM(cache_read_tokens)  / 1000.0, 1) as cache_read_k,
              ROUND(SUM(cache_write_tokens) / 1000.0, 1) as cache_write_k,
              SUM(estimated_cost_usd) as cost
       FROM api_usage
       WHERE timestamp >= ${sinceExpr}
       GROUP BY date, group_jid, model
       ORDER BY date DESC, cost DESC`,
    )
    .all() as DetailRow[];

  // Index detail rows by date for fast lookup
  const detailByDate = new Map<string, DetailRow[]>();
  for (const row of detail) {
    const arr = detailByDate.get(row.date) ?? [];
    arr.push(row);
    detailByDate.set(row.date, arr);
  }

  const fmt2 = (n: number) => n.toFixed(2);
  const fmt4 = (n: number) => n.toFixed(4);
  const shortModel = (m: string) => {
    if (m.includes('haiku')) return 'haiku';
    if (m.includes('sonnet')) return 'sonnet';
    if (m.includes('opus')) return 'opus';
    return m.split('-')[1] ?? m;
  };
  const groupLabel = (jid: string) => groupNames[jid] ?? jid;

  if (byDay.length === 0) {
    return `API Report — last ${days} days\n\nNo data.`;
  }

  const lines: string[] = [`API Report — last ${days} days`, ''];

  // Monthly totals header
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthRow = db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) as cost, COUNT(*) as msgs
       FROM api_usage WHERE timestamp >= ?`,
    )
    .get(monthStart.toISOString()) as { cost: number; msgs: number };
  lines.push(
    `Month-to-date: $${fmt2(monthRow.cost)}  (${monthRow.msgs} calls)`,
  );
  lines.push('');

  for (const day of byDay) {
    lines.push(`── ${day.date}  $${fmt4(day.cost)}  (${day.msgs} calls)`);
    const rows = detailByDate.get(day.date) ?? [];
    for (const r of rows) {
      lines.push(
        `   ${groupLabel(r.group_jid)} [${shortModel(r.model)}]` +
          `  $${fmt4(r.cost)}  ${r.msgs}c` +
          `  in:${r.input_k}K out:${r.output_k}K` +
          `  cr:${r.cache_read_k}K cw:${r.cache_write_k}K`,
      );
    }
  }

  return lines.join('\n');
}
