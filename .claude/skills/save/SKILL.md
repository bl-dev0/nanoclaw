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

## Phase 2: Commit

### Ask for commit message

AskUserQuestion: What is the commit message?

Keep it short and descriptive (e.g. "Add GitHub MCP integration", "Update SpendWise Dev CLAUDE.md").

### Stage and commit

```bash
git add -A
git status
```

Confirm the staged files look correct (no `.env`, no `data/`), then commit:

```bash
git commit -m "<their message>"
```

If the commit fails (pre-commit hook, GPG signing, etc.), report the error and stop — do not retry with `--no-verify`.

## Phase 3: Push

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
