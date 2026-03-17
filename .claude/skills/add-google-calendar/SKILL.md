---
name: add-google-calendar
description: Add the Google Calendar MCP server to NanoClaw. Gives the container agent access to read and create calendar events via OAuth2. Requires a GCP project with the Calendar API enabled.
---

# Add Google Calendar MCP Server

This skill integrates the Google Calendar MCP server into NanoClaw. The agent running inside the container will be able to use Google Calendar tools (`mcp__google-calendar__*`) to read events, create meetings, and manage calendar data.

> **Important:** The `.mcp.json` approach does NOT work for container-based integrations. NanoClaw agents run inside isolated containers that cannot see the host's `.mcp.json`. The MCP server binary must be bind-mounted into the container and registered in `container/agent-runner/src/index.ts`.

## Phase 1: Pre-flight

### Check current state

Check if Google Calendar MCP is already configured:

```bash
grep -q 'GOOGLE_OAUTH_CREDENTIALS' .env && echo "GOOGLE_OAUTH_CREDENTIALS already set" || echo "Not configured"
```

Check if the OAuth token store already exists (means auth has been completed before):

```bash
ls ~/.config/google-calendar-mcp/tokens.json 2>/dev/null && echo "Tokens exist" || echo "No tokens yet"
```

Also check if the binary is already mounted in `src/container-runner.ts`:

```bash
grep -q 'google-calendar-mcp' src/container-runner.ts && echo "Mount already present" || echo "Mount missing"
```

If all three are present, skip to Phase 4 (Verify). If credentials exist but tokens don't, skip to Phase 3 (OAuth authorization).

### Ask the user

AskUserQuestion: Do you have a GCP project with the Google Calendar API enabled and an OAuth credentials JSON file, or do you need to create one?

If they have it, collect the path to the JSON file. If not, walk through Phase 3.

## Phase 2: Apply Code Changes

### Install the Google Calendar MCP server globally

```bash
npm install -g @cocal/google-calendar-mcp
```

Verify the binary exists:

```bash
which google-calendar-mcp
```

### Modify src/container-runner.ts

Three things must be mounted into the container: the OAuth credentials file, the token store directory, and the binary itself.

**Add the Google Calendar MCP block** — in `buildVolumeMounts`, after the additional mounts section, add:

```typescript
// Google Calendar MCP: mount credentials, token store, and binary if configured
const gcpCreds = process.env.GOOGLE_OAUTH_CREDENTIALS;
if (gcpCreds && fs.existsSync(gcpCreds)) {
  mounts.push({
    hostPath: gcpCreds,
    containerPath: '/home/node/gcp-oauth.keys.json',
    readonly: true,
  });
  const gcpTokensDir = path.join(os.homedir(), '.config', 'google-calendar-mcp');
  fs.mkdirSync(gcpTokensDir, { recursive: true });
  mounts.push({
    hostPath: gcpTokensDir,
    containerPath: '/home/node/.config/google-calendar-mcp',
    readonly: false,
  });
  const gcpBinary = path.join(os.homedir(), '.npm-global', 'bin', 'google-calendar-mcp');
  if (fs.existsSync(gcpBinary)) {
    mounts.push({
      hostPath: gcpBinary,
      containerPath: '/usr/local/bin/google-calendar-mcp',
      readonly: true,
    });
  }
}
```

**Pass the credentials path as a container env var** — in `buildContainerArgs`, add:

```typescript
// Expose Google Calendar MCP credentials path inside the container
if (process.env.GOOGLE_OAUTH_CREDENTIALS) {
  args.push('-e', 'GOOGLE_OAUTH_CREDENTIALS=/home/node/gcp-oauth.keys.json');
}
```

### Modify container/agent-runner/src/index.ts

Two changes are needed: register the MCP server, and whitelist its tools.

**1. Add `mcp__google-calendar__*` to `allowedTools`** — in the `allowedTools` array:

```typescript
'mcp__google-calendar__*',
```

**2. Add the `google-calendar` server to `mcpServers`** — conditionally based on `GOOGLE_OAUTH_CREDENTIALS`:

```typescript
...(process.env.GOOGLE_OAUTH_CREDENTIALS ? {
  'google-calendar': {
    command: 'google-calendar-mcp',
    env: {
      GOOGLE_OAUTH_CREDENTIALS: process.env.GOOGLE_OAUTH_CREDENTIALS,
    },
  },
} : {}),
```

### Build and validate

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Create a GCP project and OAuth credentials (if needed)

Tell the user:

> 1. Go to [Google Cloud Console](https://console.cloud.google.com)
> 2. Create a new project (or select an existing one)
> 3. Go to **APIs & Services** > **Library** and enable the **Google Calendar API**
> 4. Go to **APIs & Services** > **OAuth consent screen**:
>    - Choose **External** user type
>    - Fill in the app name, support email, and developer contact email
>    - Add the scope `https://www.googleapis.com/auth/calendar`
>    - Add your Google account as a test user
> 5. Go to **APIs & Services** > **Credentials** > **Create Credentials** > **OAuth client ID**
>    - Application type: **Desktop app**
>    - Download the JSON file

### Transfer the credentials file to the server

If the user downloaded the JSON on their local machine but NanoClaw runs on a VPS, they need to transfer it:

```bash
# Run this on local machine:
scp ~/Downloads/client_secret_*.json user@your-vps:~/gcp-oauth.keys.json
```

> **Security note:** `scp` from Windows does **not** preserve Unix permissions — files arrive with `0775` by default, making them world-readable by any process on the system, including Docker containers. Always fix permissions immediately after transfer.

On the server, lock down the file:

```bash
chmod 600 ~/gcp-oauth.keys.json
```

Verify:

```bash
ls -la ~/gcp-oauth.keys.json
# Expected output: -rw------- 1 <user> <user> ... gcp-oauth.keys.json
```

Or paste the JSON content directly into `~/gcp-oauth.keys.json` on the server.

### Add GOOGLE_OAUTH_CREDENTIALS to .env

```bash
echo "GOOGLE_OAUTH_CREDENTIALS=~/gcp-oauth.keys.json" >> .env
```

### Add GOOGLE_OAUTH_CREDENTIALS to the systemd unit

The path must also be in the systemd unit so it survives service restarts:

```bash
systemctl --user edit nanoclaw --force
```

Add or extend the `[Service]` block in the override file:

```ini
[Service]
Environment=GOOGLE_OAUTH_CREDENTIALS=/home/<username>/gcp-oauth.keys.json
```

Save and close the editor.

### Authorize via OAuth

The MCP server must complete the OAuth flow once to obtain and store tokens. This requires a browser.

**If running on a VPS (no browser):** Set up an SSH tunnel first so the OAuth redirect can reach the server:

```bash
# Run this on local machine (keep it open):
ssh -L 3500:localhost:3500 user@your-vps
```

Then, on the server, run the auth command:

```bash
npx @cocal/google-calendar-mcp auth
```

This will print a URL. Open it in a browser on your local machine. After granting access, Google redirects to `localhost:3500` — the SSH tunnel forwards this back to the server, completing the flow.

**If running locally (browser available):**

```bash
npx @cocal/google-calendar-mcp auth
```

Open the printed URL in your browser and grant calendar access.

### Verify tokens were saved

```bash
ls ~/.config/google-calendar-mcp/tokens.json && echo "Tokens saved successfully"
```

If the file doesn't exist, the auth flow didn't complete. Re-run it with the SSH tunnel in place.

Lock down the token file permissions:

```bash
chmod 600 ~/.config/google-calendar-mcp/tokens.json
```

Verify:

```bash
ls -la ~/.config/google-calendar-mcp/tokens.json
# Expected output: -rw------- 1 <user> <user> ... tokens.json
```

### Reload and restart the service

```bash
systemctl --user daemon-reload
systemctl --user restart nanoclaw
```

### Clear the agent-runner cache

The agent-runner source is copied into per-group directories on first run. Delete the cache so the updated `index.ts` is picked up:

```bash
rm -rf ~/nanoclaw/data/sessions/<your-group-folder>/agent-runner-src
```

If other groups exist, clear all caches:

```bash
for d in ~/nanoclaw/data/sessions/*/agent-runner-src; do rm -rf "$d"; done
```

## Phase 4: Verify

### Test Calendar access

Tell the user to send a message to their main chat:

> ¿Qué tengo en el calendario hoy?

The agent should respond with today's events fetched via the `mcp__google-calendar__*` tools. Watch the logs to confirm the MCP server starts cleanly:

```bash
tail -f logs/nanoclaw.log
```

### Check logs if needed

Container logs for a specific group:

```bash
tail -f groups/<your-group-folder>/logs/container-*.log 2>/dev/null || ls -t groups/<your-group-folder>/logs/ | head -3
```

## Troubleshooting

### Binary not found (`google-calendar-mcp: not found`)

The npm global bin directory may differ. Check where the binary was installed:

```bash
npm root -g
ls $(npm root -g)/../bin/google-calendar-mcp
```

Update the binary path in `src/container-runner.ts` to match if it differs from `~/.npm-global/bin/google-calendar-mcp`.

### OAuth flow fails on VPS

The OAuth callback lands on `localhost:3500`. Without the SSH tunnel, the browser redirect fails silently. Ensure:

1. The tunnel is open: `ssh -L 3500:localhost:3500 user@your-vps`
2. The tunnel stays open during the entire auth flow
3. After clicking "Allow" in the browser, wait a few seconds before closing the tunnel

### Tokens expire or become invalid

Re-run the auth command to refresh tokens:

```bash
npx @cocal/google-calendar-mcp auth
```

The token store at `~/.config/google-calendar-mcp/tokens.json` will be updated in place. No service restart needed — the MCP server reads tokens on each request.

### `mcp__google-calendar__*` tools not available to agent

The agent-runner source cache was not cleared. Clear it:

```bash
rm -rf ~/nanoclaw/data/sessions/<your-group-folder>/agent-runner-src
```

### Credentials not reaching the container

Check that `GOOGLE_OAUTH_CREDENTIALS` is in the host environment:

```bash
systemctl --user show nanoclaw | grep GOOGLE_OAUTH
```

If missing, check the systemd override:

```bash
cat ~/.config/systemd/user/nanoclaw.service.d/override.conf
```

Then reload and restart:

```bash
systemctl --user daemon-reload && systemctl --user restart nanoclaw
```

### "Access blocked: app not verified" on OAuth screen

The GCP OAuth consent screen is in testing mode. Add your Google account as a test user:

1. Go to **APIs & Services** > **OAuth consent screen**
2. Scroll to **Test users** > **Add users**
3. Add the Google account you're authorizing

## After Setup

If running `npm run dev` while the service is active:

```bash
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove Google Calendar MCP integration:

1. Remove `GOOGLE_OAUTH_CREDENTIALS` from `.env`
2. Remove `Environment=GOOGLE_OAUTH_CREDENTIALS=...` from `~/.config/systemd/user/nanoclaw.service.d/override.conf`
3. Remove the Google Calendar MCP block from `src/container-runner.ts` (`buildVolumeMounts` and `buildContainerArgs`)
4. Remove the `google-calendar` entry from `mcpServers` in `container/agent-runner/src/index.ts`
5. Remove `'mcp__google-calendar__*'` from `allowedTools` in `container/agent-runner/src/index.ts`
6. Optionally delete stored tokens: `rm -rf ~/.config/google-calendar-mcp/`
7. Clear the agent-runner cache: `rm -rf ~/nanoclaw/data/sessions/*/agent-runner-src`
8. Rebuild and restart:
   ```bash
   npm run build
   systemctl --user daemon-reload && systemctl --user restart nanoclaw
   ```
