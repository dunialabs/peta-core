# Release Notes Style

Use this guidance when writing `release-notes.md` for `peta-core`.

## Goals

- Write in English.
- Optimize for GitHub release readers, not commit-by-commit archival.
- Explain what changed and why it matters.
- Preserve important technical details when they affect deployment, compatibility, auth flows, or runtime behavior.

## Required Rules

- Do not mention the release version bump commit itself.
- Do not copy raw commit subjects line-for-line unless a subject is already clear and user-facing.
- Do not invent features, bug fixes, or compatibility guarantees that are not supported by the context.
- Do not pad the notes with every internal refactor or doc-only change.

## Recommended Structure

Use the smallest structure that fits the release. A typical shape is:

```markdown
## Highlights
- ...

## Fixes and Improvements
- ...

## Operational Notes
- ...
```

Use `Operational Notes` only when there is something real to say, such as OAuth/provider changes, cache behavior, Docker/runtime implications, or follow-up considerations for operators.

## Writing Heuristics

- Start with the most important user-visible or operator-visible changes.
- Group related commits into a single coherent bullet instead of mirroring git history.
- Prefer impact-focused wording:
  - Good: "Added result caching controls with cache admission, storage backends, and namespace versioning support."
  - Weak: "Added ResultCacheManager, CacheKeyBuilder, CachePolicyResolver, ..."
- Mention provider names, API surfaces, cache behavior, auth behavior, and deployment/runtime changes explicitly when they matter.
- Mention tests only if they validate a significant new capability or regression fix that readers should care about.
- Treat README/docs-only changes as secondary unless they change deployment or usage materially.

## What to Inspect More Closely

- Commits with broad file touch sets across `src/mcp/core`, auth providers, repositories, or controllers
- Merge commits that may hide a larger feature set
- OAuth/provider additions or token-flow changes
- Docker/runtime path handling changes
- Caching or persistence changes

## Final Check

Before publishing, verify that the notes:

- Are fully in English
- Match the prepared `targetVersion`
- Reflect the range from the previous tag to the prepared release baseline
- Omit obvious noise
- Call out the most important changes first
