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
