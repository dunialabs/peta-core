# Agent Harness

This directory contains lightweight templates for running Codex or other coding agents with a stable workflow in `peta-core`.

## When To Use It

- Use `EXEC_PLAN_TEMPLATE.md` for non-trivial implementation work.
- Use `CONFLICT_ANALYSIS_TEMPLATE.md` before architecture-affecting changes.
- Use `SELF_REVIEW_TEMPLATE.md` before handoff or PR review.
- Use `TASK_HANDOFF_TEMPLATE.md` when a task is paused or transferred to a new session.

## Operating Principle

Keep the harness small and explicit:

- one task, one plan
- one verification path matched to the risk level
- one doc impact decision
- one self-review before handoff
- one handoff note if the task spans sessions

## Recommended Flow

1. Read `AGENTS.md` and `START_HERE_FOR_AI.md`.
2. Create an execution plan if the change is not trivial.
3. Decide which source-of-truth docs are affected.
4. Implement the smallest viable slice.
5. Update docs while context is fresh.
6. Run `docs:check`, then `verify:fast`, then widen only if needed.
7. Complete a self-review.
8. Write a handoff note when the task is incomplete or risky.
