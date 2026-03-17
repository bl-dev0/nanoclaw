---
name: add-ollama-tool
description: Add Ollama MCP server so the container agent can call local models for cheaper/faster tasks like summarization, translation, or general queries.
---

# Add Ollama Integration

This skill adds a stdio-based MCP server that exposes local Ollama models as tools for the container agent. Claude remains the orchestrator but can offload work to local models.

Tools added:
- `ollama_list_models` — lists installed Ollama models
- `ollama_generate` — sends a prompt to a specified model and returns the response

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/ollama-mcp-stdio.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

Verify Ollama is installed and running on the host:
```bash
ollama list
```

If Ollama is not installed, direct the user to https://ollama.com/download.

If no models are installed, suggest pulling one:

> You need at least one model. I recommend:
>
> ```bash
> ollama pull gemma3:1b    # Small, fast (815MB)
> ollama pull llama3.2:3b  # Good general purpose (2GB)
> ollama pull qwen3-coder:30b  # Best for code tasks (18GB)
> ```

## Phase 2: Apply Code Changes

### Ensure upstream remote
```bash
git remote -v
```

If `upstream` is missing, add it:
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch
```bash
git fetch upstream skill/ollama-tool
git merge upstream/skill/ollama-tool
```

This merges in:
- `container/agent-runner/src/ollama-mcp-stdio.ts` (Ollama MCP server)
- `scripts/ollama-watch.sh` (macOS notification watcher)
- Ollama MCP config in `container/agent-runner/src/index.ts` (allowedTools + mcpServers)
- `[OLLAMA]` log surfacing in `src/container-runner.ts`
- `OLLAMA_HOST` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Copy the new files:
```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/ollama-mcp-stdio.ts "$dir/"
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Validate code changes
```bash
npm run build
./container/build.sh
```

Build must be clean before proceeding.

## Phase 3: Configure

### Fix Ollama network binding (Linux/VPS only)

⚠️ On Linux, Ollama binds to `127.0.0.1` by default — inaccessible from Docker containers.
`host.docker.internal` does NOT resolve on Linux (only works on Docker Desktop for Mac/Windows).

Make Ollama listen on all interfaces:
```bash
sudo systemctl edit ollama
```

Add in the editor:
```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
```

Apply:
```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

Verify it is reachable from the Docker bridge network:
```bash
curl http://172.17.0.1:11434/api/tags   # Must return JSON
```

### Set OLLAMA_HOST in NanoClaw (Linux/VPS only)

The MCP server defaults to `host.docker.internal` which does not resolve on Linux.
Override it with the Docker gateway IP:
```bash
echo 'OLLAMA_HOST=http://172.17.0.1:11434' >> .env
echo 'OLLAMA_HOST=http://172.17.0.1:11434' >> data/env/env
```

### Clear session cache and restart
```bash
rm -rf data/sessions/*/agent-runner-src
systemctl --user restart nanoclaw   # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Test via Telegram / WhatsApp

Tell the user:

> Send a message like: "use ollama to tell me the capital of France"
>
> The agent should use `ollama_list_models` to find available models, then `ollama_generate` to get a response.

### Monitor activity (optional)

Run the watcher script for macOS notifications when Ollama is used:
```bash
./scripts/ollama-watch.sh
```

### Check logs if needed
```bash
tail -f logs/nanoclaw.log | grep -i ollama
```

Look for:
- `[OLLAMA] >>> Generating` — generation started
- `[OLLAMA] <<< Done` — generation completed

## Troubleshooting

### Agent says "Ollama is not installed"

The agent is trying to run `ollama` CLI inside the container instead of using the MCP tools. This means:
1. The MCP server wasn't registered — check `container/agent-runner/src/index.ts` has the `ollama` entry in `mcpServers`
2. The per-group source wasn't updated — re-copy files (see Phase 2)
3. The container wasn't rebuilt — run `./container/build.sh`

### "Failed to connect to Ollama"

On Linux/VPS, `host.docker.internal` does not resolve. Use the Docker gateway IP instead:

1. Verify Ollama listens on all interfaces: `curl http://172.17.0.1:11434/api/tags` (must return JSON)
2. If it fails, add `Environment="OLLAMA_HOST=0.0.0.0"` to the Ollama systemd unit (see Phase 3)
3. Verify `OLLAMA_HOST=http://172.17.0.1:11434` is set in both `.env` and `data/env/env`
4. Clear session cache: `rm -rf data/sessions/*/agent-runner-src` and restart

### Agent doesn't use Ollama tools

The agent may not know about the tools. Try being explicit: "use the ollama_generate tool with gemma3:1b to answer: ..."
