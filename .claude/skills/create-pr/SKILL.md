# Skill: /create-pr

When the user runs `/create-pr`, follow these steps in order.
Do not modify any repository files. This skill is read-only.

---

## Step 1: Check repository status
```bash
git status
git log --oneline -5
```

If there are uncommitted changes, warn the user:
> "There are uncommitted changes. Run `/save` first so the PR reflects all your changes."
Do not abort — continue anyway so the user can see the analysis.

---

## Step 2: Configure upstream and get the diff
```bash
# Add upstream remote if it doesn't exist
git remote -v | grep upstream || git remote add upstream https://github.com/qwibitai/nanoclaw.git

# Fetch current upstream state
git fetch upstream

# Commits your fork is ahead of upstream
git log upstream/main..HEAD --oneline

# Summary of modified files
git diff upstream/main --stat

# Full diff by area
git diff upstream/main -- src/
git diff upstream/main -- container/
git diff upstream/main -- .claude/skills/
git diff upstream/main -- package.json
```

---

## Step 3: Analyze the changes

Classify each change into one of these categories:

| Category | Examples |
|---|---|
| `feat` | New skill, new MCP integration, new command |
| `fix` | Documented bug fix, applied workaround |
| `docs` | Updated CLAUDE.md, README, new SKILL.md |
| `chore` | Config adjustment, version bump |
| `security` | UFW fix, file permissions, SSH hardening |

For each file modified relative to upstream, determine:
1. **What** the change does (functional description)
2. **Why** it was needed (motivation or problem it solves)
3. **Impact** on users adopting this fork (does it break anything? does it require manual steps?)

---

## Step 4: Generate PR content

Produce exactly this format, ready to paste into GitHub:

### PR TITLE
[type]: concise description in English (max 72 characters)
Examples:
- `feat: add Telegram channel support via /add-telegram skill`
- `feat: add GitHub MCP integration with fine-grained PAT support`
- `fix: allow Docker bridge traffic to credential proxy on port 3001`

If the PR includes multiple types, use the dominant type or `feat` if there are new features.

### PR DESCRIPTION
```markdown
## What this PR does

[1-3 sentences explaining the main change]

## Changes

### New skills
- `/add-telegram` — [brief description of what it adds and how it works]
- `/add-github` — [same]
- (list only those that exist in .claude/skills/ vs upstream)

### Modified core files
- `src/container-runner.ts` — [what changed and why]
- `container/agent-runner/src/index.ts` — [same]
- (list only files that differ from upstream)

### Bug fixes / documented workarounds
- [Fix description] — [context: what was failing, how it was detected]

## Motivation

[Why these changes are useful for other NanoClaw users]

## Testing

Tested on:
- Ubuntu 24.04 LTS / Node.js 24 / Docker 29 / ARM64 (Hetzner CAX21)

Steps to verify:
1. [Verification step 1]
2. [Verification step 2]

## Notes for reviewers

- [Any design considerations, trade-offs, or decisions worth highlighting]
- If container-runner.ts is modified: explain why the .mcp.json approach does not work
  inside containers and what was done instead.

## Checklist

- [ ] New skills include a complete SKILL.md with full instructions
- [ ] No secrets or API keys in the diff
- [ ] Changes to container-runner.ts are additive (do not break base functionality)
- [ ] Fixes/workarounds are documented with enough context to reproduce them
```

---

## Step 5: Final output

Show the user:

1. **Analysis summary:** how many commits ahead, how many files modified, detected change categories.
2. **Suggested title** (max 72 characters, in English).
3. **Full description** ready to paste into the GitHub PR description field.
4. **Reminder:**
   > To open the PR: go to `https://github.com/YOUR_USERNAME/nanoclaw/compare/main...qwibitai:main`  
   > Or from GitHub: your fork → "Contribute" → "Open pull request"

---

## Agent notes

- This skill does NOT `git push`, does NOT create the PR via API, does NOT modify any files.
- If the diff is very large (>50 files), suggest the user split it into smaller PRs by functional area.
- Write the title and description in **English** (the upstream project language).
- If any custom skill (e.g. `/add-github`, `/add-google-calendar`) solves a problem documented
  in the upstream issues, mention it in the "Motivation" section.
