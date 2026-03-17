# Skill: add-cost-monitoring

Implementa un sistema de monitorización de costes de API para NanoClaw.
Captura el usage (tokens) de cada respuesta del Agent SDK, lo persiste en SQLite,
expone un MCP tool para que el agente informe de costes, y envía alertas automáticas
por Telegram cuando se supera el 80% del presupuesto mensual.

---

## Pasos de implementación

Ejecuta los siguientes pasos en orden. No saltes ninguno. Antes de modificar
cualquier archivo existente, léelo completo para entender su estructura actual.

---

### Paso 1 — Crear la tabla SQLite `api_usage`

Ejecuta este comando bash para añadir la tabla a la base de datos existente:

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

Verifica que la tabla existe:

```bash
sqlite3 ~/nanoclaw/store/messages.db ".tables" | grep api_usage
```

---

### Paso 2 — Crear `src/cost-tracker.ts`

Crea el archivo `src/cost-tracker.ts` con el siguiente contenido exacto:

```typescript
import Database from 'better-sqlite3';

// ─── Precios por token (USD por token individual, no por millón) ───────────
// Fuente: https://anthropic.com/pricing — actualizar si cambian
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
    (usage.input_tokens                      ?? 0) * p.input +
    (usage.output_tokens                     ?? 0) * p.output +
    (usage.cache_creation_input_tokens       ?? 0) * p.cacheWrite +
    (usage.cache_read_input_tokens           ?? 0) * p.cacheRead
  );
}

// ─── Escritura ─────────────────────────────────────────────────────────────

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

// ─── Consultas ─────────────────────────────────────────────────────────────

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

### Paso 3 — Crear `src/cost-mcp-server.ts`

Crea el archivo `src/cost-mcp-server.ts`:

```typescript
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
      lines.push(`🚨 ALERTA CRÍTICA: ${budgetPct.toFixed(0)}% del presupuesto consumido`);
    } else if (budgetPct >= 80) {
      lines.push(`⚠️ AVISO: ${budgetPct.toFixed(0)}% del presupuesto consumido`);
    }

    lines.push(`📊 Coste API — ${month}`);
    lines.push(``);
    lines.push(`Total mes:   $${report.total_usd.toFixed(3)} / $${MONTHLY_BUDGET}  (${budgetPct.toFixed(1)}%)`);
    lines.push(`Restante:    $${remaining.toFixed(3)}`);
    lines.push(`Hoy:         $${today.toFixed(4)}`);
    lines.push(`Proyección:  $${projected.toFixed(2)}/mes (basada en últimos 7 días)`);
    lines.push(``);

    if (report.by_group.length > 0) {
      lines.push(`Por grupo:`);
      for (const g of report.by_group) {
        lines.push(`  • ${g.group_jid}: $${g.cost.toFixed(4)}  (${g.messages} msgs)`);
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
});

function fmt(n: number): string {
  return ((n ?? 0) / 1000).toFixed(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

### Paso 4 — Hook de logging en `container-runner.ts`

Lee `src/container-runner.ts` completo. Localiza el lugar donde se procesan
las respuestas del Agent SDK buscando:
- La función que ejecuta el agente (puede llamarse `runAgent`, `runContainer`,
  `executeAgent`, o similar)
- El loop `for await` que itera sobre eventos del SDK
- Cualquier referencia a `type: 'message'`, `usage`, `input_tokens`, o
  `output_tokens` en el flujo de respuesta

Una vez localizado, añade la importación al inicio del archivo:

```typescript
import { logUsage } from './cost-tracker.js';
```

Y dentro del loop de eventos, añade el hook donde aparezcan los datos de usage.
El patrón exacto depende de la versión del SDK. Busca uno de estos patrones:

**Patrón A** — eventos de tipo `message`:
```typescript
if (event.type === 'message' && event.message?.usage) {
  logUsage(db, groupJid, event.message.model ?? 'claude-sonnet-4-20250514', event.message.usage);
}
```

**Patrón B** — resultado final con usage:
```typescript
if (result?.usage) {
  logUsage(db, groupJid, result.model ?? 'claude-sonnet-4-20250514', result.usage);
}
```

**Patrón C** — si el SDK devuelve un stream con `finalMessage`:
```typescript
if (stream.finalMessage?.usage) {
  logUsage(db, groupJid, stream.finalMessage.model ?? 'claude-sonnet-4-20250514', stream.finalMessage.usage);
}
```

Usa el patrón que encaje con la estructura real del código. Si hay más de un
punto donde se recibe usage (por ejemplo, en mensajes intermedios y en el
mensaje final), usa **solo el mensaje final** para evitar doble conteo.

Asegúrate de que la variable `db` (instancia de better-sqlite3) está disponible
en el scope donde añades el hook. Si no lo está, pásala como parámetro o
ábrela localmente.

---

### Paso 5 — Modificar `container/agent-runner/src/index.ts`

Lee el archivo completo. Localiza:
1. El objeto `mcpServers` (donde están registrados github, google-calendar, etc.)
2. El array `allowedTools` (donde están los patrones `mcp__github__*`, etc.)

Añade al objeto `mcpServers`:

```typescript
'cost-monitoring': {
  command: 'node',
  args: ['/home/jorge/nanoclaw/dist/cost-mcp-server.js'],
  env: {
    DB_PATH: '/home/jorge/nanoclaw/store/messages.db',
    MONTHLY_BUDGET_USD: '25',
  },
},
```

Añade al array `allowedTools`:

```typescript
'mcp__cost-monitoring__get_cost_report',
```

---

### Paso 6 — Lógica de alertas en `src/index.ts`

Lee `src/index.ts` completo. Localiza:
- La función o el punto donde NanoClaw envía mensajes proactivos al chat
  principal (la misma función que usan las tareas programadas para enviar
  notificaciones)
- El loop principal de procesamiento de mensajes

Añade la importación al inicio:

```typescript
import { getMonthlyCostReport } from './cost-tracker.js';
```

Añade esta función en el módulo (fuera del loop principal):

```typescript
const MONTHLY_BUDGET_USD  = 25;
const ALERT_WARN_PCT      = 0.80;
const ALERT_CRITICAL_PCT  = 0.95;

// Tracking en memoria para no spamear (se resetea al reiniciar el proceso)
const budgetAlertsToday = new Set<string>();
let budgetAlertDate     = new Date().toISOString().slice(0, 10);

async function checkBudgetAlert(
  db: Database.Database,
  sendMessage: (text: string) => Promise<void>
): Promise<void> {
  // Resetear flags si cambió el día
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
      `🚨 *ALERTA CRÍTICA — Presupuesto API*\n` +
      `${(pct * 100).toFixed(0)}% consumido: ` +
      `$${report.total_usd.toFixed(2)} de $${MONTHLY_BUDGET_USD}\n` +
      `Quedan $${(MONTHLY_BUDGET_USD - report.total_usd).toFixed(2)}. ` +
      `Considera reducir tareas programadas.`
    );
  } else if (pct >= ALERT_WARN_PCT && !budgetAlertsToday.has('warning')) {
    budgetAlertsToday.add('warning');
    await sendMessage(
      `⚠️ *Aviso de presupuesto API*\n` +
      `${(pct * 100).toFixed(0)}% consumido este mes: ` +
      `$${report.total_usd.toFixed(2)} de $${MONTHLY_BUDGET_USD}`
    );
  }
}
```

Llama a `checkBudgetAlert(db, sendToMain)` **después de cada respuesta del
agente** que haya registrado usage. Usa la misma función `sendToMain` (o
equivalente) que usan las tareas programadas para enviar mensajes proactivos
al chat principal de Telegram.

---

### Paso 7 — Compilar TypeScript

```bash
cd ~/nanoclaw
npm run build
```

Si el comando falla, intenta:

```bash
npx tsc --noEmit  # Solo verificar errores de tipos
npx tsc           # Compilar
```

Corrige cualquier error de tipos antes de continuar. Los errores más probables son:
- `db` no disponible en el scope del hook → pásala como parámetro
- Tipos de `usage` no reconocidos → añade `as any` temporalmente si el SDK
  no exporta el tipo

---

### Paso 8 — Reconstruir imagen Docker

```bash
docker build -t nanoclaw-agent:latest \
  -f ~/nanoclaw/container/Dockerfile \
  ~/nanoclaw/container/
```

Espera a que termine sin errores.

---

### Paso 9 — Limpiar caché y reiniciar

```bash
# Borrar caché de sesiones para forzar recreación del contenedor
rm -rf ~/nanoclaw/data/sessions/*/agent-runner-src

# Reiniciar el servicio
systemctl --user restart nanoclaw
sleep 3
systemctl --user status nanoclaw
```

---

### Paso 10 — Verificación

**10.1 Verificar tabla vacía (es correcto al inicio):**
```bash
sqlite3 ~/nanoclaw/store/messages.db \
  "SELECT COUNT(*) FROM api_usage;"
# Debe retornar: 0
```

**10.2 Enviar un mensaje de prueba desde Telegram y verificar registro:**
```bash
# Esperar 10 segundos tras el mensaje, luego:
sqlite3 ~/nanoclaw/store/messages.db \
  "SELECT timestamp, group_jid, model, input_tokens, output_tokens,
          ROUND(estimated_cost_usd, 6) as cost_usd
   FROM api_usage ORDER BY id DESC LIMIT 3;"
```

Si la tabla sigue vacía tras el mensaje, el hook en `container-runner.ts`
no está capturando el usage. Revisa el Paso 4 — el punto de captura puede
estar en una ubicación diferente del código. Usa:
```bash
grep -rn "usage\|input_tokens\|output_tokens" ~/nanoclaw/src/ --include="*.ts" \
  | grep -v "cost-tracker\|cost-mcp"
```
para localizar dónde el código existente ya procesa el usage del SDK.

**10.3 Verificar MCP tool desde Telegram:**
```
Tom, ¿cuánto he gastado este mes en API?
```
Tom debe invocar `get_cost_report` y responder con el breakdown.

---

## Resumen de archivos modificados

| Archivo | Tipo de cambio |
|---|---|
| `store/messages.db` | Nueva tabla `api_usage` + índices |
| `src/cost-tracker.ts` | **Nuevo** — cálculo y consultas |
| `src/cost-mcp-server.ts` | **Nuevo** — MCP tool `get_cost_report` |
| `src/container-runner.ts` | Añadir import + hook de logging |
| `container/agent-runner/src/index.ts` | Añadir MCP server + allowedTool |
| `src/index.ts` | Añadir import + función `checkBudgetAlert` |

---

## Notas importantes

- El MCP server (`cost-mcp-server.ts`) corre en el **host**, no dentro del
  contenedor Docker. Se comunica via stdio igual que los otros MCP servers.
- La tabla `api_usage` usa la misma base de datos `store/messages.db` que
  el resto de NanoClaw — no se necesita una nueva base de datos.
- El budget de $25 está hardcodeado en dos sitios: la env var del MCP server
  (Paso 5) y la constante en `src/index.ts` (Paso 6). Mantenlos sincronizados.
- Si `better-sqlite3` no está disponible en el host (solo en el contenedor),
  instálalo: `npm install better-sqlite3 @types/better-sqlite3`
