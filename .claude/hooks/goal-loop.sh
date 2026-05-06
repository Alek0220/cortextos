#!/bin/bash
# Hook: goal-loop.sh
# Trigger: Stop (must run BEFORE quality-gates.sh in the Stop chain)
# Purpose:
#   When `/goal` is active (.claude/.goal-state.json shows active+not-completed
#   AND budget not exhausted), block Stop with exit 2 and inject a "continue
#   the /goal loop" directive — so Claude auto-iterates without user prompts.
#
#   When the goal completes or the budget exhausts → exit 0, letting the rest
#   of the Stop chain (skill-optimizer + mulch sync) run normally.
#
# Termination guarantees:
#   1. Budget counter (.claude/.goal-state.json iteration vs max_iterations) —
#      /goal Phase 2f calls `goal-budget.sh tick` per iteration.
#   2. Stop-fire backstop: if this hook fires more than max_iterations*4 times
#      without the budget counter advancing, force-stop with a warning. Guards
#      against pathological cases where Claude returns without ticking.
#
# stdin JSON: { session_id, stop_hook_active, ... }

set -eu

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$PROJECT_ROOT" || exit 0

STATE=".claude/.goal-state.json"
[ -f "$STATE" ] || exit 0  # no goal active → defer to next hook

# Read & advance stop-fire counter (in same JSON file).
read -r ACTIVE COMPLETED ITER MAX STOP_FIRES <<EOF
$(python3 - <<'PY'
import json
s = json.load(open(".claude/.goal-state.json"))
s["stop_fires"] = s.get("stop_fires", 0) + 1
open(".claude/.goal-state.json", "w").write(json.dumps(s, indent=2))
print(s.get("active", False), s.get("completed", False),
      s.get("iteration", 0), s.get("max_iterations", 50),
      s["stop_fires"])
PY
)
EOF

# Goal already done or never started → pass.
if [ "$ACTIVE" != "True" ] || [ "$COMPLETED" = "True" ]; then
    exit 0
fi

# Budget exhausted → pass (let /goal Phase 3 wrap run normally).
if [ "$ITER" -ge "$MAX" ]; then
    exit 0
fi

# Backstop: prevent runaway loops if Claude isn't ticking the counter.
HARD_CAP=$((MAX * 4))
if [ "$STOP_FIRES" -ge "$HARD_CAP" ]; then
    cat >&2 <<EOF
[goal-loop] HARD STOP — Stop hook fired $STOP_FIRES times but iteration is only $ITER/$MAX.
The /goal loop appears stuck (not ticking the budget counter). Force-stopping.

To recover:
  - Inspect .claude/.goal-state.json
  - Check GOAL.md "Blocked on" section
  - Resume with: /goal --resume   (after fixing root cause)
  - Or reset:    .claude/scripts/goal-budget.sh reset
EOF
    # Mark complete so we don't repeat the warning forever.
    .claude/scripts/goal-budget.sh complete >/dev/null 2>&1 || true
    exit 0
fi

# Active goal + budget left → inject continue directive.
cat >&2 <<EOF
[goal-loop] /goal active — iteration $ITER/$MAX. Continue the loop.

Phase 2 next steps (do these without user prompting):
  1. Read PLAN.md → take the top "Pending" task into "In progress".
  2. Implement it (read before edit, atomic scope).
  3. Run the validation command from GOAL.md (≤3 retries on failure).
  4. On green: stage & commit (one task = one commit).
  5. Update PLAN.md (move task → Done) + tick GOAL.md success criteria.
  6. Run: .claude/scripts/goal-budget.sh tick
  7. If all success criteria ticked → run: .claude/scripts/goal-budget.sh complete
     (then Phase 3 wrap runs; this hook will pass on the next Stop)

If you hit a true blocker (3 validation failures + no clear fix), append the
trace to GOAL.md "Blocked on" and run goal-budget.sh complete.

Do NOT wait for the user to confirm. The whole point of /goal is autonomous
iteration. The budget counter ($ITER/$MAX) is your only stop condition besides
explicit completion or genuine blockers.
EOF
exit 2
