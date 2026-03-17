---
name: save
description: Commit and push all local changes to origin main. Checks for accidentally staged secrets before committing.
---

# Save (Commit & Push)

This skill commits all pending changes and pushes to `origin main`. It checks for secrets before committing and refuses to proceed if dangerous files are staged.

## Phase 1: Review Changes

### Show working tree status

```bash
git status
```

Present the output to the user so they can see exactly what files will be staged.

### Check for dangerous files

Before staging anything, scan for files that must never be committed:

```bash
git status --porcelain | grep -E '^\s*[MADRCU?].*\.env$|^\s*[MADRCU?].*data/'
```

Also check if `.env` or `data/` appear in the staged area:

```bash
git diff --cached --name-only 2>/dev/null | grep -E '^\.env$|^data/'
```

**If `.env` or anything under `data/` is staged or would be staged by `git add -A`, stop immediately.** Tell the user:

> ⚠️ Refusing to commit: `.env` or `data/` files are staged. These contain secrets and runtime state that must never be pushed.
>
> To unstage them:
> ```bash
> git reset HEAD .env
> git reset HEAD data/
> ```

Do not proceed until the user confirms these are cleared.

### Scan the diff for secrets

```bash
git diff HEAD
```

Scan the output for patterns that look like secrets:
- Lines containing `sk-ant-api`, `ghp_`, `github_pat_`, `AAEM`, `xoxb-`, `xoxp-`
- Lines containing `API_KEY=`, `TOKEN=`, `SECRET=`, `PASSWORD=` followed by a non-empty value
- Long random-looking strings (>30 chars) on assignment lines

If any suspicious patterns are found, warn the user:

> ⚠️ Possible secret detected in diff:
> `[the suspicious line]`
>
> Review before committing. Proceed anyway?

Use `AskUserQuestion` to confirm before continuing if secrets are detected.

## Phase 2: Generate Commit Message

### Analyze changes
```bash
git diff --staged --stat 2>/dev/null || git diff --stat
git diff HEAD
```

Analyze the diff to understand what changed. Then generate a commit message following conventional commits format:
- `feat:` for new features or capabilities
- `fix:` for bug fixes
- `chore:` for maintenance, dependencies, config changes
- `docs:` for documentation only changes
- `refactor:` for code restructuring without behavior change
- `security:` for security-related changes

The message format:
- **Subject line**: under 72 characters, imperative mood, no period at end
- **Body** (if multi-file or complex change): blank line after subject, then bullet points summarizing key changes

Example for a multi-file change:
```
feat: add persistent memory system with FTS5 search

- Add memory MCP server with memory_search, memory_write, memory_get tools
- Mount per-group memory directories in container-runner.ts
- Register memory tools in agent-runner
- Update telegram_main CLAUDE.md with memory instructions
```

### Present for confirmation
Show the generated commit message to the user using AskUserQuestion with these options:
1. "Looks good — commit and push" → proceed to Phase 3
2. "Edit message" → ask the user for their preferred message, then proceed
3. "Cancel" → abort without committing

## Phase 3: Commit and Push

### Stage and commit
```bash
git add -A
git status
```

Confirm no `.env` or `data/` files are staged, then:
```bash
git commit -m "<generated or edited message>"
```

If the commit fails (pre-commit hook, GPG signing, etc.), report the error and stop — do not retry with `--no-verify`.

## Phase 4: Push

```bash
git push origin main
```

If the push is rejected (non-fast-forward), do NOT force push. Report the conflict to the user:

> Push rejected — remote has commits not in local. Run `git pull --rebase origin main` first, then `/save` again.

On success, show the final git log line:

```bash
git log --oneline -1
```

## Troubleshooting

### Pre-commit hook fails

Read the hook error and fix the underlying issue. Never use `--no-verify`.

### "Everything up to date"

No new commits to push — the branch is already in sync with remote.

### Merge conflict after pull

Resolve conflicts manually, stage the resolved files, then run `/save` again.
