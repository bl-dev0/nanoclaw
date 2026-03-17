---
name: add-github
description: Add the GitHub MCP server to NanoClaw. Gives the container agent access to GitHub — read issues, PRs, code, and more — scoped to specific repositories via a Personal Access Token.
---

# Add GitHub MCP Server

This skill integrates the GitHub MCP server into NanoClaw. The agent running inside the container will be able to use GitHub tools (`mcp__github__*`) to read issues, pull requests, file contents, and other repository data.

> **Important:** The `.mcp.json` approach does NOT work for container-based integrations. NanoClaw agents run inside isolated containers that cannot see the host's `.mcp.json`. The MCP server binary must be bind-mounted into the container and registered in `container/agent-runner/src/index.ts`.

## Phase 1: Pre-flight

### Check current state

Check if GitHub MCP is already configured:

```bash
grep -q 'GITHUB_TOKEN' .env && echo "GITHUB_TOKEN already set" || echo "Not configured"
```

Also check if the binary is already mounted in `src/container-runner.ts`:

```bash
grep -q 'mcp-server-github' src/container-runner.ts && echo "Mount already present" || echo "Mount missing"
```

If both are present, skip to Phase 3 (Setup) to verify the token is correct.

### Ask the user

AskUserQuestion: Do you have a GitHub Personal Access Token for the target repository, or do you need to create one?

If they need one, explain in Phase 3. If they have one, collect it now.

## Phase 2: Apply Code Changes

### Install the GitHub MCP server globally

```bash
npm install -g @modelcontextprotocol/server-github
```

Verify the binary exists:

```bash
ls ~/.npm-global/lib/node_modules/@modelcontextprotocol/server-github/dist/index.js
```

### Modify src/container-runner.ts

Two changes are needed: mount the binary into the container, and pass the token as a container environment variable.

**1. Add the binary mount** — in `buildVolumeMounts`, after the Google Calendar MCP block, add:

```typescript
// GitHub MCP: mount the server binary if GITHUB_TOKEN is set
if (process.env.GITHUB_TOKEN) {
  const githubBinary = path.join(
    os.homedir(),
    '.npm-global',
    'lib',
    'node_modules',
    '@modelcontextprotocol',
    'server-github',
    'dist',
    'index.js',
  );
  if (fs.existsSync(githubBinary)) {
    mounts.push({
      hostPath: githubBinary,
      containerPath: '/usr/local/lib/mcp-server-github.js',
      readonly: true,
    });
  }
}
```

**2. Pass the token as a container env var** — in `buildContainerArgs`, after the Google Calendar env block, add:

```typescript
// Pass GitHub token for GitHub MCP server
if (process.env.GITHUB_TOKEN) {
  args.push('-e', `GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`);
}
```

### Modify container/agent-runner/src/index.ts

Two changes are needed: register the MCP server, and whitelist its tools.

**1. Add `mcp__github__*` to `allowedTools`** — in the `allowedTools` array alongside the other `mcp__*` entries:

```typescript
'mcp__github__*',
```

**2. Add the `github` server to `mcpServers`** — after the `google-calendar` conditional block:

```typescript
...(process.env.GITHUB_TOKEN ? {
  github: {
    command: 'node',
    args: ['/usr/local/lib/mcp-server-github.js'],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN,
    },
  },
} : {}),
```

### Build and validate

```bash
npm run build
```

Build must be clean (no TypeScript errors) before proceeding.

## Phase 3: Setup

### Create a GitHub Personal Access Token (if needed)

Tell the user:

> Create a fine-grained Personal Access Token scoped to the specific repository:
>
> 1. Go to **GitHub** > **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens**
> 2. Click **Generate new token**
> 3. Set **Repository access** to the specific repo (e.g., SpendWise)
> 4. Under **Permissions**, grant at minimum:
>    - **Contents**: Read-only (to read files and code)
>    - **Issues**: Read-only (to read issues)
>    - **Pull requests**: Read-only (to read PRs)
>    - Add write permissions only if the agent needs to create issues, comment, etc.
> 5. Copy the token (starts with `github_pat_`)

Wait for the user to provide the token.

### Add GITHUB_TOKEN to .env

```bash
echo "GITHUB_TOKEN=<their-token>" >> .env
```

Or edit `.env` directly to add the line.

### Add GITHUB_TOKEN to the systemd unit

The token must also be in the systemd unit so it survives service restarts:

```bash
systemctl --user edit nanoclaw --force
```

This opens an editor. Add or extend the `[Service]` block in the override file (`~/.config/systemd/user/nanoclaw.service.d/override.conf`):

```ini
[Service]
Environment=GITHUB_TOKEN=<their-token>
```

Save and close the editor, then reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user restart nanoclaw
```

### Clear the agent-runner cache

The agent-runner source is copied into per-group directories on first run. Delete the cache so the updated `index.ts` is picked up:

```bash
rm -rf ~/nanoclaw/data/sessions/<your-group-folder>/agent-runner-src
```

If other groups exist, clear their caches too:

```bash
for d in ~/nanoclaw/data/sessions/*/agent-runner-src; do rm -rf "$d"; done
```

## Phase 4: Verify

### Test GitHub access

Tell the user to send a message to their main chat:

> ¿Cuáles son los issues abiertos en [repo]?

The agent should respond with a list of open issues fetched via the `mcp__github__*` tools. Watch the logs to confirm the MCP server starts cleanly:

```bash
tail -f logs/nanoclaw.log
```

Look for lines mentioning `github` MCP server initialization. Any `GITHUB_PERSONAL_ACCESS_TOKEN` errors indicate the token wasn't passed correctly — verify it's in both `.env` and the systemd override.

### Check logs if needed

Container logs for a specific group:

```bash
tail -f groups/<your-group-folder>/logs/container-*.log 2>/dev/null || ls -t groups/<your-group-folder>/logs/ | head -3
```

## Troubleshooting

### MCP server not loading

The most common cause is the binary not existing at the expected path. Verify:

```bash
ls ~/.npm-global/lib/node_modules/@modelcontextprotocol/server-github/dist/index.js
```

If missing, reinstall:

```bash
npm install -g @modelcontextprotocol/server-github
```

### Token not reaching the container

Check that `GITHUB_TOKEN` is present in the host environment when the service starts:

```bash
systemctl --user show nanoclaw | grep GITHUB_TOKEN
```

If missing, ensure the systemd override is set correctly:

```bash
cat ~/.config/systemd/user/nanoclaw.service.d/override.conf
```

Then reload and restart:

```bash
systemctl --user daemon-reload && systemctl --user restart nanoclaw
```

### `mcp__github__*` tools not available to agent

The agent-runner source cache was not cleared. The old `index.ts` (without the github entry) is still running inside the container. Clear the cache:

```bash
rm -rf ~/nanoclaw/data/sessions/<your-group-folder>/agent-runner-src
```

### 401 / authentication errors from GitHub

The token is invalid, expired, or lacks the required permissions. Regenerate the token on GitHub and update both `.env` and the systemd override, then daemon-reload and restart.

### `.mcp.json` changes have no effect

This is expected. Container-based agents do not read `.mcp.json` from the host. All MCP configuration must go through `container/agent-runner/src/index.ts`. The `.mcp.json` file only applies to non-containerized Claude Code sessions.

## After Setup

If running `npm run dev` while the service is active:

```bash
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove GitHub MCP integration:

1. Remove `GITHUB_TOKEN` from `.env`
2. Remove `Environment=GITHUB_TOKEN=...` from `~/.config/systemd/user/nanoclaw.service.d/override.conf`
3. Remove the binary mount block from `src/container-runner.ts` (`buildVolumeMounts`)
4. Remove the `GITHUB_TOKEN` env arg from `src/container-runner.ts` (`buildContainerArgs`)
5. Remove the `github` entry from `mcpServers` in `container/agent-runner/src/index.ts`
6. Remove `'mcp__github__*'` from `allowedTools` in `container/agent-runner/src/index.ts`
7. Clear the agent-runner cache: `rm -rf ~/nanoclaw/data/sessions/*/agent-runner-src`
8. Rebuild and restart:
   ```bash
   npm run build
   systemctl --user daemon-reload && systemctl --user restart nanoclaw
   ```
