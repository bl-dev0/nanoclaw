---
name: rebuild
description: Rebuild the NanoClaw Docker agent image and restart the service. Optionally clears the agent-runner-src cache for one or all groups.
---

# Rebuild Docker Image

This skill rebuilds the `nanoclaw-agent:latest` Docker image from `~/nanoclaw/container/` and restarts the systemd service. Run this whenever `container/agent-runner/src/index.ts` or other files inside `container/` are modified.

## Phase 1: Clear Agent-Runner Cache (Optional)

The agent-runner source is copied into per-group directories on first container run. If `container/agent-runner/src/index.ts` was changed (e.g. new MCP server added, tool allowlist updated), the cached copies must be cleared so containers pick up the new code.

Ask the user:

AskUserQuestion: Clear the agent-runner-src cache?
- **All groups** (Recommended) — clears cache for every group so all containers pick up the new index.ts
- **Specific group** — clear only one group's cache
- **Skip** — skip cache clearing (only safe if the change doesn't affect agent-runner/src/index.ts)

If **All groups**:

```bash
rm -rf ~/nanoclaw/data/sessions/*/agent-runner-src
echo "Cleared agent-runner-src for all groups"
ls ~/nanoclaw/data/sessions/
```

If **Specific group**, ask which group (list existing ones):

```bash
ls ~/nanoclaw/data/sessions/
```

Then clear it:

```bash
rm -rf ~/nanoclaw/data/sessions/<group>/agent-runner-src
echo "Cleared agent-runner-src for <group>"
```

## Phase 2: Rebuild Docker Image

```bash
docker build -t nanoclaw-agent:latest -f ~/nanoclaw/container/Dockerfile ~/nanoclaw/container/
```

This streams build output — show it to the user. The build typically takes 1–3 minutes on first run (layer cache speeds up subsequent builds).

**If the build fails**, stop and report the error. Common causes:
- Syntax error in a file inside `container/` — read the failing step in the build output
- Missing dependency — check `container/package.json`
- Stale buildkit cache — see troubleshooting below

Do not proceed to restart if the build failed.

## Phase 3: Restart Service

```bash
systemctl --user restart nanoclaw
```

Wait a moment, then verify it started cleanly:

```bash
systemctl --user status nanoclaw --no-pager
```

Confirm `Active: active (running)`. If the service failed to start, show the last log lines:

```bash
tail -20 ~/nanoclaw/logs/nanoclaw.log
tail -20 ~/nanoclaw/logs/nanoclaw.error.log
```

## Troubleshooting

### Build cache is stale (COPY steps use old files)

`--no-cache` alone does not invalidate COPY steps — the buildkit volume retains stale files. To force a clean rebuild:

```bash
docker builder prune -f
docker build --no-cache -t nanoclaw-agent:latest -f ~/nanoclaw/container/Dockerfile ~/nanoclaw/container/
```

### "Cannot connect to the Docker daemon"

Docker is not running or the user lacks permission:

```bash
sudo systemctl start docker
# Or add user to docker group (requires re-login):
sudo usermod -aG docker $USER
```

### Service restarts but agent still uses old behavior

The agent-runner-src cache was not cleared. Clear it and trigger a new container run:

```bash
rm -rf ~/nanoclaw/data/sessions/*/agent-runner-src
systemctl --user restart nanoclaw
```
