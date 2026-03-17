# Skill: set-monthly-budget

Updates the monthly API budget used by the cost monitoring system.
Writes the new value to `.env` and the systemd unit override, then restarts
the service so the change takes effect immediately.

Requires the `add-cost-monitoring` skill to be installed first.

---

## Steps

### Step 1 — Show current value

Read the current budget from `.env`:

```bash
grep '^MONTHLY_BUDGET_USD=' ~/nanoclaw/.env 2>/dev/null || echo "MONTHLY_BUDGET_USD not set (default: 25)"
```

Show it to the user.

---

### Step 2 — Ask for the new value

Ask the user: "What should the new monthly budget be? (in USD)"

Wait for their answer. Validate that it is a positive number before continuing.

---

### Step 3 — Update `.env`

```bash
grep -q '^MONTHLY_BUDGET_USD=' ~/nanoclaw/.env \
  && sed -i 's/^MONTHLY_BUDGET_USD=.*/MONTHLY_BUDGET_USD=<VALUE>/' ~/nanoclaw/.env \
  || echo 'MONTHLY_BUDGET_USD=<VALUE>' >> ~/nanoclaw/.env
```

Verify the change:

```bash
grep '^MONTHLY_BUDGET_USD=' ~/nanoclaw/.env
```

---

### Step 4 — Update the systemd unit override

The service does not read `.env` automatically; the variable must also live in
the unit override. Check the current override first:

```bash
systemctl --user cat nanoclaw 2>/dev/null | grep MONTHLY_BUDGET_USD
```

**If the variable is already there**, update it in place:

```bash
OVERRIDE_FILE=$(systemctl --user show nanoclaw -p FragmentPath --value 2>/dev/null)
OVERRIDE_DIR=$(dirname "$OVERRIDE_FILE")/nanoclaw.service.d
ls "$OVERRIDE_DIR"/*.conf 2>/dev/null | head -3
```

Find the override `.conf` file and edit it — change the `Environment=MONTHLY_BUDGET_USD=...`
line to the new value using the Edit tool.

**If the variable is not there**, open the override editor:

```bash
systemctl --user edit nanoclaw --force
```

Add under `[Service]`:
```ini
Environment=MONTHLY_BUDGET_USD=<VALUE>
```

---

### Step 5 — Restart the service

```bash
systemctl --user restart nanoclaw
sleep 3
systemctl --user status nanoclaw --no-pager | head -6
```

---

### Step 6 — Confirm

Show the user a summary:
- New budget value
- Where it was saved
- That the service restarted successfully
