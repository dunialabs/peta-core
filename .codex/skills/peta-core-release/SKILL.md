---
name: peta-core-release
description: Publish peta-core releases from origin/main by preparing a detached temporary release workspace, generating English GitHub release notes, pushing Docker images, tagging the release, and publishing the GitHub release. Use when Codex is asked to release peta-core, bump the next patch version, publish a specific peta-core version, resume a prepared peta-core release, or clean up an abandoned prepared release workspace.
---

# Peta Core Release

Use the repository release engine instead of manually editing version files or tagging by hand.

## Release Workflow

1. Resolve the repo root with `git rev-parse --show-toplevel` and require the basename to be `peta-core`.
2. Run the repository release engine from the repo root:
   - Default patch release: `node scripts/release-main.js prepare --json`
   - Specific version: `node scripts/release-main.js prepare --version X.Y.Z --json`
3. Read the JSON output and note `manifestPath`, `contextPath`, `notesPath`, `targetTag`, and `targetVersion`.
4. Read `release-context.md`. If commit titles are vague, inspect the referenced commits, files, or PRs before writing notes.
5. Write English release notes to `notesPath`. Follow [references/release-notes-style.md](references/release-notes-style.md).
6. Publish with `node scripts/release-main.js publish --manifest <manifestPath>`.
7. If the user asks to abandon a prepared release, or if prepare succeeded but publish should not continue, run `node scripts/release-main.js cleanup --manifest <manifestPath>`.

## Operating Rules

- Always release from `origin/main`. Do not release the current branch directly.
- Do not edit `package.json` or `package-lock.json` by hand. The script uses `npm version`.
- Do not create Git tags manually before `publish`. The publish step owns tag creation and GitHub release creation.
- Keep release notes in English even if the conversation is in another language.
- Do not ask for confirmation before publishing unless the user explicitly requests a confirmation step. This workflow is intended to publish directly.
- If `prepare` fails, fix the reported blocker and rerun `prepare`.
- If `publish` fails after `prepare`, keep the manifest path and prefer rerunning `publish` with the same manifest instead of starting over, unless `origin/main` has moved.

## Notes Inputs

- `release-context.md` is the primary summary source.
- Inspect git commits or diffs when the context mentions an important change but the title is too vague.
- Inspect PR details only when they materially improve accuracy; do not inflate notes with unnecessary PR metadata.
- Ignore pure housekeeping noise unless it changes runtime behavior in a meaningful way.

## Outputs

- Publish the GitHub release with title `vX.Y.Z`.
- Ensure the release is marked as latest.
- Keep the final user-facing summary short and include the prepared/published version plus any resume path if something failed.
