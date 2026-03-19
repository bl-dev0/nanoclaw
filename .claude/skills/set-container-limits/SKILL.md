# Skill: set-container-limits

Adds container resource limits to NanoClaw — memory, CPU, and PID limits that
prevent runaway agents from exhausting VPS resources. If the feature is already
installed, skips to configuration.

---

## Steps

### Step 1 — Detect installation state

Check if the feature is already installed:

```bash
grep -q 'CONTAINER_MEMORY_LIMIT' ~/nanoclaw/src/config.ts && echo "INSTALLED" || echo "NOT_INSTALLED"
```

- If `INSTALLED`: skip to **Step 5 (Configure)**.
- If `NOT_INSTALLED`: continue with Step 2.

---

### Step 2 — Patch `src/config.ts`

Read the full file first. Append the following block at the end of the file,
after the last export:

```typescript
// Container resource limits — prevent runaway agents from exhausting VPS resources.
// On an 8 GB VPS with MAX_CONCURRENT_CONTAINERS=5, keep CONTAINER_MEMORY_LIMIT at 1500m or lower.
export const CONTAINER_MEMORY_LIMIT =
  process.env.CONTAINER_MEMORY_LIMIT || '1500m';
export const CONTAINER_CPU_LIMIT = parseFloat(
  process.env.CONTAINER_CPU_LIMIT || '2',
);
export const CONTAINER_PIDS_LIMIT = parseInt(
  process.env.CONTAINER_PIDS_LIMIT || '512',
  10,
);
```

---

### Step 3 — Patch `src/types.ts`

Read the full file first. Locate the `ContainerConfig` interface and add two
optional fields:

```typescript
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  model?: string;
  memoryLimit?: string;  // e.g. '2g' — overrides CONTAINER_MEMORY_LIMIT for this group
  cpuLimit?: number;     // e.g. 3.0 — overrides CONTAINER_CPU_LIMIT for this group
}
```

---

### Step 4 — Patch `src/container-runner.ts`

Read the full file first.

**4a — Add imports**

Find the existing import from `./config.js` and add the three new constants:

```typescript
import {
  CONTAINER_CPU_LIMIT,
  CONTAINER_IMAGE,
  // ... existing imports ...
  CONTAINER_MEMORY_LIMIT,
  CONTAINER_PIDS_LIMIT,
  // ... rest of existing imports ...
} from './config.js';
```

**4b — Inject resource limit flags**

Find the block that handles the per-group model override:

```typescript
  // Per-group model override
  if (group.containerConfig?.model) {
    containerArgs.push('-e', `AGENT_MODEL=${group.containerConfig.model}`);
  }
```

Add immediately after it:

```typescript
  // Resource limits — prevent runaway agents from exhausting VPS resources.
  // Per-group overrides take precedence over global config.
  const memoryLimit = group.containerConfig?.memoryLimit ?? CONTAINER_MEMORY_LIMIT;
  const cpuLimit = group.containerConfig?.cpuLimit ?? CONTAINER_CPU_LIMIT;
  const imageIndex = containerArgs.lastIndexOf(CONTAINER_IMAGE);
  containerArgs.splice(
    imageIndex,
    0,
    `--memory=${memoryLimit}`,
    `--cpus=${cpuLimit}`,
    `--pids-limit=${CONTAINER_PIDS_LIMIT}`,
  );
```

The flags must be inserted **before** `CONTAINER_IMAGE` in the args array —
that is why `splice` at `imageIndex` is used instead of `push`.

---

### Step 5 — Configure limits

Show current values (from `.env` or defaults):

```bash
echo "CONTAINER_MEMORY_LIMIT=$(grep '^CONTAINER_MEMORY_LIMIT=' ~/nanoclaw/.env 2>/dev/null | cut -d= -f2 || echo '1500m (default)')"
echo "CONTAINER_CPU_LIMIT=$(grep '^CONTAINER_CPU_LIMIT=' ~/nanoclaw/.env 2>/dev/null | cut -d= -f2 || echo '2 (default)')"
echo "CONTAINER_PIDS_LIMIT=$(grep '^CONTAINER_PIDS_LIMIT=' ~/nanoclaw/.env 2>/dev/null | cut -d= -f2 || echo '512 (default)')"
```

Ask the user which limits to change. Guidance:

- **CONTAINER_MEMORY_LIMIT** — Docker memory string (`1500m`, `2g`, etc.).
  On an 8 GB VPS with up to 5 concurrent containers, keep at `1500m` or lower.
  OOM kills (exit 137) are handled gracefully by NanoClaw.
- **CONTAINER_CPU_LIMIT** — fractional cores (`2`, `1.5`, etc.). Prevents CPU
  starvation of the host without affecting LLM call latency.
- **CONTAINER_PIDS_LIMIT** — max PIDs inside the container (`512`). Prevents
  fork bombs. Normal load (Node.js + Chromium) uses well under 200 PIDs.

If the user is happy with defaults, skip to Step 7.

---

### Step 6 — Write values to `.env`

For each value the user wants to change, upsert it in `~/nanoclaw/.env`:

```bash
grep -q '^CONTAINER_MEMORY_LIMIT=' ~/nanoclaw/.env \
  && sed -i 's/^CONTAINER_MEMORY_LIMIT=.*/CONTAINER_MEMORY_LIMIT=<VALUE>/' ~/nanoclaw/.env \
  || echo 'CONTAINER_MEMORY_LIMIT=<VALUE>' >> ~/nanoclaw/.env

grep -q '^CONTAINER_CPU_LIMIT=' ~/nanoclaw/.env \
  && sed -i 's/^CONTAINER_CPU_LIMIT=.*/CONTAINER_CPU_LIMIT=<VALUE>/' ~/nanoclaw/.env \
  || echo 'CONTAINER_CPU_LIMIT=<VALUE>' >> ~/nanoclaw/.env

grep -q '^CONTAINER_PIDS_LIMIT=' ~/nanoclaw/.env \
  && sed -i 's/^CONTAINER_PIDS_LIMIT=.*/CONTAINER_PIDS_LIMIT=<VALUE>/' ~/nanoclaw/.env \
  || echo 'CONTAINER_PIDS_LIMIT=<VALUE>' >> ~/nanoclaw/.env
```

Only run the lines for the variables the user actually changed.

Then update the systemd unit override so values survive reboots (Linux VPS):

```bash
systemctl --user cat nanoclaw 2>/dev/null | grep 'CONTAINER_'
```

If missing from the unit, add via `systemctl --user edit nanoclaw --force`
under `[Service]`:

```ini
Environment=CONTAINER_MEMORY_LIMIT=<VALUE>
Environment=CONTAINER_CPU_LIMIT=<VALUE>
Environment=CONTAINER_PIDS_LIMIT=<VALUE>
```

If already present, find the override `.conf` file and edit it directly with
the Edit tool.

---

### Step 7 — Build and restart

```bash
cd ~/nanoclaw && npm run build
```

If the build succeeds:

```bash
systemctl --user restart nanoclaw
sleep 3
systemctl --user status nanoclaw --no-pager | head -6
```

---

### Step 8 — Confirm

Tell the user:
- Which limits are now active
- That limits apply to the **next** container launched (running containers are unaffected until they restart)
- How to verify: `docker stats --no-stream` after sending a message to the agent
- Per-group overrides can be set in `groups/<name>/config.json` via `containerConfig.memoryLimit` and `containerConfig.cpuLimit`

---

## Files modified

| File | Change |
|---|---|
| `src/config.ts` | Add `CONTAINER_MEMORY_LIMIT`, `CONTAINER_CPU_LIMIT`, `CONTAINER_PIDS_LIMIT` |
| `src/types.ts` | Add optional `memoryLimit` and `cpuLimit` to `ContainerConfig` |
| `src/container-runner.ts` | Import new constants, inject `--memory`, `--cpus`, `--pids-limit` flags |
