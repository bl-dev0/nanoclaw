---
name: contribute-skill
description: Contribute a skill to the upstream NanoClaw repository. Creates a clean branch from upstream/main containing only the skill file, validates it for generic content, and opens a PR.
---

# Contribute a Skill to Upstream NanoClaw

This skill packages one of your local skills into a clean contribution PR against the upstream NanoClaw repository. It follows the contribution model described in CONTRIBUTING.md:

> A PR that contributes a skill should not modify any source files.
> Your skill should contain the instructions Claude follows to add the feature — not pre-built code.

## Phase 1: Select the skill to contribute

List available skills:

```bash
ls .claude/skills/
```

AskUserQuestion: Which skill do you want to contribute to upstream? (Enter the folder name, e.g. `add-cost-monitoring`)

Store the answer as `SKILL_NAME`. Verify the skill exists:

```bash
test -f ".claude/skills/${SKILL_NAME}/SKILL.md" && echo "OK" || echo "NOT FOUND"
```

If not found, stop and tell the user to check the name.

## Phase 2: Validate the skill for generic content

Read the skill file:

```bash
cat ".claude/skills/${SKILL_NAME}/SKILL.md"
```

Check for content that would make the skill non-reusable by other users. Scan for:

**Hardcoded personal paths:**
```bash
grep -n "/home/[a-z]\+/" ".claude/skills/${SKILL_NAME}/SKILL.md" | grep -v "home/node"
```

**Hardcoded usernames (not placeholders):**
```bash
grep -n "home/node\|/home/" ".claude/skills/${SKILL_NAME}/SKILL.md" | grep -v "node\|<\|placeholder"
```

**Non-English prose** (Spanish or other language in instructions — not in example bot messages):
```bash
grep -nP '[áéíóúñüÁÉÍÓÚÑÜ¿¡]' ".claude/skills/${SKILL_NAME}/SKILL.md"
```

**Personal names/projects** that shouldn't be there:
Scan the file content manually for any of:
- Specific assistant names (not `<AssistantName>` or `@AssistantName`)
- Specific group names (not `<your-group-folder>` or `<folder-name>`)
- Specific project/repo names that are personal (not used as examples with `e.g.`)

If any issues are found, list them clearly and ask:

AskUserQuestion: The skill has the following issues that should be fixed before contributing: [list issues]. How do you want to proceed?
- "Fix them now" → work through each issue, edit the file, re-validate
- "Skip validation and contribute anyway" → proceed with a warning in the PR description
- "Cancel" → abort

## Phase 3: Set up upstream remote

```bash
git remote get-url upstream 2>/dev/null || echo "MISSING"
```

If missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

Fetch latest upstream:

```bash
git fetch upstream --quiet
echo "Upstream fetched. Latest upstream commit:"
git log upstream/main --oneline -1
```

## Phase 4: Create contribution branch

The branch must start from `upstream/main` — not from your fork's `main`. This ensures the PR contains only the skill file and no personal code changes.

```bash
BRANCH="contrib/${SKILL_NAME}"

# Check if branch already exists
git branch --list "$BRANCH"
```

If the branch already exists, ask:

AskUserQuestion: Branch `contrib/<skill-name>` already exists. What should we do?
- "Delete and recreate from upstream/main" → `git branch -D "$BRANCH"`
- "Cancel" → abort

Create and switch to the branch:

```bash
git checkout upstream/main -b "$BRANCH"
```

## Phase 5: Add the skill file

Copy only the skill file onto this branch — nothing from src/, container/, or any other modified files:

```bash
# Restore just the skill directory from your fork's main
git checkout main -- ".claude/skills/${SKILL_NAME}/"

git status
```

Confirm only `.claude/skills/${SKILL_NAME}/SKILL.md` (and any supporting files in that folder) are staged. If anything else appears staged, unstage it:

```bash
git restore --staged .
git checkout main -- ".claude/skills/${SKILL_NAME}/"
```

## Phase 6: Write the commit and PR description

Read the skill's `name` and `description` from its frontmatter:

```bash
head -5 ".claude/skills/${SKILL_NAME}/SKILL.md"
```

Generate a commit message:
```
skill: add <skill-name>

<description from frontmatter>
```

Commit:

```bash
git add ".claude/skills/${SKILL_NAME}/"
git commit -m "skill: add ${SKILL_NAME}

$(grep '^description:' ".claude/skills/${SKILL_NAME}/SKILL.md" | sed 's/^description: //')"
```

## Phase 7: Push and open PR

```bash
git push origin "$BRANCH"
```

Check if `gh` is available and authenticated:

```bash
gh auth status 2>/dev/null && echo "GH OK" || echo "GH NOT AVAILABLE"
```

**If `gh` is available**, create the PR automatically against the upstream repo.

First, get the GitHub username from the origin remote:

```bash
GITHUB_USER=$(git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git||' | cut -d/ -f1)
SKILL_DESC=$(grep '^description:' ".claude/skills/${SKILL_NAME}/SKILL.md" | sed 's/^description: //')
```

Then create the PR (construct the body as a variable first to avoid heredoc issues):

```bash
PR_BODY="## Type of Change

- [x] **Skill** - adds a new skill in \`.claude/skills/\`

## Description

${SKILL_DESC}

Run \`/${SKILL_NAME}\` in Claude Code from the root of a NanoClaw installation.

## For Skills

- [ ] I have not made any changes to source code
- [ ] My skill contains instructions for Claude to follow (not pre-built code)
- [ ] I tested this skill on a fresh clone

🤖 Contributed via [NanoClaw contribute-skill](https://github.com/qwibitai/nanoclaw)"

gh pr create \
  --repo qwibitai/nanoclaw \
  --head "${GITHUB_USER}:${BRANCH}" \
  --base main \
  --title "skill: add ${SKILL_NAME}" \
  --body "$PR_BODY"
```

**If `gh` is not available**, show the user what to do manually:

> Push succeeded. To open the PR manually:
>
> 1. Go to: https://github.com/qwibitai/nanoclaw/compare/main...<your-github-username>:<branch-name>
> 2. Title: `skill: add <skill-name>`
> 3. Make sure the base is `qwibitai/nanoclaw:main` and the head is your fork's `contrib/<skill-name>` branch
> 4. Verify the PR only contains `.claude/skills/<skill-name>/SKILL.md`

## Phase 8: Return to main

Switch back to your working branch:

```bash
git checkout main
echo "Back on main. Contribution branch preserved as: ${BRANCH}"
```

Show a summary:

```
✅ Skill contributed successfully.

Branch:  contrib/<skill-name>
PR:      <url if opened automatically>

Your fork's main branch is unchanged.
The contribution branch contains only the skill file.
```

## Troubleshooting

### "Branch diverged from upstream"

If `upstream/main` has advanced since you created the contribution branch:

```bash
git checkout "contrib/${SKILL_NAME}"
git rebase upstream/main
git push origin "contrib/${SKILL_NAME}" --force-with-lease
```

### "PR shows unexpected files"

The branch was not created from `upstream/main`. Delete the branch, re-run from Phase 4.

### "gh: not authenticated"

```bash
gh auth login
```

Choose GitHub.com → HTTPS → authenticate with browser.
