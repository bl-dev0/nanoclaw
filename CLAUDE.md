# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Adding Integrations

Never modify `src/container-runner.ts`, `container/agent-runner/src/index.ts`, or other core files directly to add integrations. Always create or use a skill in `.claude/skills/`. The `.mcp.json` approach does not work for container-based integrations — MCP servers must be bind-mounted via `container-runner.ts` and registered in `container/agent-runner/src/index.ts`, which is what the skills document.

## VPS Operational Notes

**Docker image rebuild required:** Every time `container/agent-runner/src/index.ts` is modified, rebuild the image:
```bash
docker build -t nanoclaw-agent:latest -f ~/nanoclaw/container/Dockerfile ~/nanoclaw/container/ && systemctl --user restart nanoclaw
```

**Telegram Group Privacy:** Bots don't read all group messages by default. Fix: BotFather → select bot → Bot Settings → Group Privacy → Turn off. Then remove and re-add the bot to existing groups for the change to take effect.

**GitHub tokens for organization repos:** Fine-grained tokens are org-specific. For repos under an org (e.g. `Beequa-Labs/spend-wise`), create the token with **Resource owner** set to the org, not your personal account.

**MCP integrations don't use `.mcp.json`:** Containers cannot read the host's `.mcp.json`. Use `container-runner.ts` + `container/agent-runner/src/index.ts` via skills instead (see `## Adding Integrations`).

**After any new MCP integration:** Clear the agent-runner-src cache so the updated `index.ts` is picked up:
```bash
rm -rf ~/nanoclaw/data/sessions/<group>/agent-runner-src
# Or clear all groups:
rm -rf ~/nanoclaw/data/sessions/*/agent-runner-src
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
