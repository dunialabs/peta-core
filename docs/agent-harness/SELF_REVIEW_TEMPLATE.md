# Self Review

## Change Map

- files changed
- why each file changed
- refactor-only changes vs behavior changes

## Behavior Changes

Describe the intended runtime, protocol, or operator-visible changes.

## Documentation Check

- source-of-truth docs updated
- downstream docs checked or reconciled
- if docs were not updated, why that is safe
- any stale docs still known after this task

## Most Likely Failure Points

1. 
2. 
3. 

## Edge Cases Not Covered

- old clients or old data
- auth, timeout, retry, or reconnection paths
- approval or permission merge behavior

## Boundary Check

- did this cross module boundaries unnecessarily
- did it duplicate existing logic
- did it widen API, schema, or security surface more than needed

## Verification Run

- commands executed
- commands skipped and why

## Rollback / Mitigation

What is the fastest safe fallback if this breaks?
