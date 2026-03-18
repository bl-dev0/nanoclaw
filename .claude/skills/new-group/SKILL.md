---
name: new-group
description: Register a new Telegram group with NanoClaw. Creates the group folder, CLAUDE.md, and SQLite registration.
---

# New Group

This skill registers a new Telegram group with NanoClaw, creates its isolated folder and CLAUDE.md, and provides reminders for any follow-up steps.

## Phase 1: Gather Information

### Ask for group details

AskUserQuestion: What is the name and purpose of this group?

Collect:
- **Display name** — e.g. "SpendWise Dev", "Family", "Work"
- **Purpose / context** — what will this group be used for? What should the assistant know about it?

AskUserQuestion: Should this be a main group (no trigger required) or a standard group (trigger word required)?
- **Standard group** — responds only when the trigger word is mentioned (e.g. `@AssistantName`) (Recommended for most groups)
- **Main group** — responds to every message (only one main group should exist)

AskUserQuestion: Which Claude model should this group use?
- **Sonnet** (`claude-sonnet-4-6`) — balanced, fast, recommended for most groups (Recommended)
- **Haiku** (`claude-haiku-4-5-20251001`) — fastest and cheapest, good for lightweight tasks
- **Opus** (`claude-opus-4-6`) — most capable, best for complex reasoning and architecture decisions

### Get the Telegram chat ID

If the user doesn't have the chat ID yet, tell them:

> To get the Telegram chat ID:
>
> 1. Create a new Telegram group (or use an existing one)
> 2. Add your bot to the group
> 3. Send `/chatid` in the group — the bot will reply with the chat ID
>
> The chat ID for groups is a negative number starting with `-100` (e.g. `-1001234567890`).

Wait for the user to provide the chat ID.

### Confirm folder name

Derive a snake_case folder name from the group name (e.g. "SpendWise Dev" → `spendwise_dev`, "Family Chat" → `family_chat`). Confirm with the user before proceeding.

## Phase 2: Register the Group

### Register in SQLite

For a **standard group**:

```bash
cd ~/nanoclaw
npx tsx setup/index.ts --step register -- \
  --jid "tg:<chat-id>" \
  --name "<group-name>" \
  --folder "<folder-name>" \
  --trigger "@<AssistantName>" \
  --channel telegram
```

For a **main group** (no trigger required):

```bash
cd ~/nanoclaw
npx tsx setup/index.ts --step register -- \
  --jid "tg:<chat-id>" \
  --name "<group-name>" \
  --folder "<folder-name>" \
  --trigger "@<AssistantName>" \
  --channel telegram \
  --no-trigger-required \
  --is-main
```

Confirm the registration succeeded with no errors.

### Set model override (if not Sonnet)

If the user chose Haiku or Opus, apply the model override now. First verify the feature is applied:

```bash
grep -n "AGENT_MODEL" src/container-runner.ts 2>/dev/null && echo "Applied" || echo "Not applied — run /set-group-model first"
```

If applied, run:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/nanoclaw/store/messages.db');
const row = db.prepare('SELECT container_config FROM registered_groups WHERE folder = ?').get('<folder>');
const cfg = row?.container_config ? JSON.parse(row.container_config) : {};
cfg.model = '<model-id>';
db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(JSON.stringify(cfg), '<folder>');
db.close();
console.log('Done:', JSON.stringify(cfg));
"
```

Model IDs: `claude-haiku-4-5-20251001` · `claude-sonnet-4-6` · `claude-opus-4-6`

If the feature is not yet applied, tell the user to run `/set-group-model` first — it installs the required code changes.

If the user chose Sonnet (the SDK default), skip this step — no override needed.

### Restart the service

The service loads registered groups **only at startup** — new groups written to SQLite are not picked up until restart:

```bash
systemctl --user restart nanoclaw
```

On macOS (launchd):
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Confirm the service is running before continuing.

## Phase 3: Create Group CLAUDE.md

Create `groups/<folder-name>/CLAUDE.md` tailored to the group's purpose. At minimum include:

- The assistant's name and persona
- The group's purpose and context
- Any specific behavior, tone, or constraints relevant to this group
- If the group has access to specific tools (GitHub, Calendar, etc.), document them

Write the CLAUDE.md in the user's preferred language — agents read and respond in whatever language their CLAUDE.md is written in.

Example structure:

```markdown
# <Group Name>

You are <AssistantName>, [role description].

## Context

[Purpose and relevant background for this group]

## [Additional sections as needed]
```

Use the information the user provided in Phase 1 to write a useful, specific CLAUDE.md — not a generic placeholder.

## Phase 4: Reminders

### Group Privacy (for group chats)

Tell the user:

> **Important:** By default, Telegram bots only see @mentions and commands in groups — not all messages. Since this is a standard group using a trigger word, this may already be fine. But if you want the bot to see all messages:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/mybots` and select your bot
> 3. Go to **Bot Settings** > **Group Privacy** > **Turn off**
> 4. **Remove and re-add the bot to the group** — the change only takes effect for new group memberships

### Docker rebuild (if new MCP integrations were added)

If this new group requires MCP tools that were just added (new entries in `container/agent-runner/src/index.ts`), run `/rebuild` to rebuild the Docker image and clear the cache.

If no changes were made to the container configuration, no rebuild is needed — the new group's agent-runner-src directory will be created fresh on its first container run.

## Troubleshooting

### "Group not found" or bot doesn't respond

1. Confirm the bot is a member of the group
2. Check the JID is correct: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE folder = '<folder>'"`
3. Verify the trigger: for standard groups, the message must contain the registered trigger word
4. Check Group Privacy is off if messages aren't being seen

### Wrong trigger word registered

Update the trigger directly in SQLite with a quick node script:

```javascript
// scripts/fix-trigger.mjs
import Database from 'better-sqlite3';
const db = new Database('store/messages.db');
db.prepare("UPDATE registered_groups SET trigger_pattern = '@<AssistantName>' WHERE folder = '<folder>'").run();
db.close();
```

```bash
node scripts/fix-trigger.mjs && rm scripts/fix-trigger.mjs
```

### Group responds but uses wrong persona

The `groups/<folder>/CLAUDE.md` was not created or contains incorrect content. Edit it and the next container run will pick up the changes automatically — no rebuild needed.
