#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const remoteName = 'origin';
const baseRef = `${remoteName}/main`;
const gitHubApiAccept = 'application/vnd.github+json';

function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'help';
  const options = parseOptions(args.slice(1));

  try {
    switch (command) {
      case 'prepare':
        printResult(prepareRelease(options), options.json);
        break;
      case 'publish':
        printResult(publishRelease(options), options.json);
        break;
      case 'cleanup':
        printResult(cleanupRelease(options), options.json);
        break;
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    fail(error);
  }
}

function parseOptions(args) {
  const options = {
    bump: 'patch',
    json: false,
    manifest: '',
    notesFile: '',
    version: ''
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case '--bump':
        options.bump = args[index + 1] ?? '';
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--manifest':
        options.manifest = args[index + 1] ?? '';
        index += 1;
        break;
      case '--notes-file':
        options.notesFile = args[index + 1] ?? '';
        index += 1;
        break;
      case '--version':
        options.version = args[index + 1] ?? '';
        index += 1;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/release-main.js prepare [--version 1.2.3 | --bump patch|minor|major] [--json]
  node scripts/release-main.js publish --manifest /tmp/.../manifest.json [--notes-file /tmp/.../release-notes.md] [--json]
  node scripts/release-main.js cleanup --manifest /tmp/.../manifest.json [--json]

prepare
  Fetch origin/main, create a detached temporary worktree, collect release context,
  bump version with npm, and create the local release commit. No remote side effects.

publish
  Push the prepared release commit to origin/main, run docker-build-push.sh in
  non-interactive mode, create/push the release tag, and publish the GitHub release.

cleanup
  Remove the temporary worktree and its manifest directory.`);
}

function prepareRelease(options) {
  assertBump(options.bump);
  ensureCommand('git');
  ensureCommand('gh');
  ensureCommand('node');
  ensureCommand('npm');

  assertRepoRoot();
  checkGitHubAuth();
  refreshRemoteState();

  const remoteUrl = trim(run('git', ['remote', 'get-url', remoteName], { cwd: repoRoot }).stdout);
  const repoInfo = parseGitHubRepo(remoteUrl);
  const baseSha = trim(run('git', ['rev-parse', '--verify', baseRef], { cwd: repoRoot }).stdout);
  const previousTag = resolvePreviousTag(baseSha);
  const changesSinceTag = Number.parseInt(
    trim(run('git', ['rev-list', '--count', `${previousTag}..${baseSha}`], { cwd: repoRoot }).stdout),
    10
  );

  if (changesSinceTag === 0) {
    throw new Error(`No commits found between ${previousTag} and ${baseRef}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peta-core-release-'));
  const worktreePath = path.join(tempRoot, 'worktree');
  let worktreeReady = false;

  try {
    run('git', ['worktree', 'add', '--detach', worktreePath, baseSha], { cwd: repoRoot });
    worktreeReady = true;

    const packageJsonPath = path.join(worktreePath, 'package.json');
    const packageLockPath = path.join(worktreePath, 'package-lock.json');
    const currentVersion = readPackageVersion(packageJsonPath);
    const previousTagVersion = previousTag.replace(/^v/, '');

    if (currentVersion !== previousTagVersion) {
      throw new Error(
        `Package version ${currentVersion} does not match latest tag ${previousTag}. Refuse to prepare a new release from an inconsistent baseline.`
      );
    }

    const targetVersion = options.version || bumpVersion(currentVersion, options.bump);
    assertSemver(targetVersion, 'Target version');

    if (compareVersions(targetVersion, currentVersion) <= 0) {
      throw new Error(`Target version ${targetVersion} must be greater than current version ${currentVersion}`);
    }

    const targetTag = `v${targetVersion}`;
    assertTagMissing(targetTag);

    run('npm', ['version', targetVersion, '--no-git-tag-version'], { cwd: worktreePath });

    if (!fs.existsSync(packageLockPath)) {
      throw new Error('package-lock.json is missing after npm version update');
    }

    run('git', ['add', 'package.json', 'package-lock.json'], { cwd: worktreePath });
    run('git', ['commit', '-m', `chore(release): ${targetTag}`], { cwd: worktreePath });

    const releaseCommitSha = trim(run('git', ['rev-parse', 'HEAD'], { cwd: worktreePath }).stdout);
    const context = collectReleaseContext({
      baseSha,
      previousTag,
      repoInfo,
      targetTag,
      targetVersion,
      worktreePath
    });

    const contextPath = path.join(tempRoot, 'release-context.md');
    const notesPath = path.join(tempRoot, 'release-notes.md');
    const manifestPath = path.join(tempRoot, 'manifest.json');

    fs.writeFileSync(contextPath, renderReleaseContext(context), 'utf8');
    fs.writeFileSync(notesPath, '', 'utf8');

    const manifest = {
      baseRef,
      baseSha,
      contextPath,
      createdAt: new Date().toISOString(),
      notesPath,
      previousTag,
      releaseCommitSha,
      remoteName,
      repoInfo,
      repoRoot,
      targetTag,
      targetVersion,
      worktreePath
    };

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    return {
      action: 'prepare',
      baseSha,
      contextPath,
      manifestPath,
      notesPath,
      previousTag,
      releaseCommitSha,
      targetTag,
      targetVersion,
      worktreePath
    };
  } catch (error) {
    if (worktreeReady) {
      safeCleanup(worktreePath, tempRoot);
    } else if (fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }

    throw error;
  }
}

function publishRelease(options) {
  assertPublicReleaseEvidence();
  ensureCommand('git');
  ensureCommand('gh');

  const manifest = readManifest(options.manifest);
  const notesPath = path.resolve(options.notesFile || manifest.notesPath);
  assertFileExists(manifest.worktreePath, 'Prepared worktree');
  assertFileExists(notesPath, 'Release notes file');

  const notes = trim(fs.readFileSync(notesPath, 'utf8'));

  if (!notes) {
    throw new Error(`Release notes file is empty: ${notesPath}`);
  }

  const currentHead = trim(run('git', ['rev-parse', 'HEAD'], { cwd: manifest.worktreePath }).stdout);

  if (currentHead !== manifest.releaseCommitSha) {
    throw new Error(
      `Prepared worktree HEAD ${currentHead} does not match manifest commit ${manifest.releaseCommitSha}`
    );
  }

  refreshRemoteState();

  const remoteMainSha = trim(run('git', ['rev-parse', '--verify', baseRef], { cwd: repoRoot }).stdout);

  if (remoteMainSha !== manifest.baseSha && remoteMainSha !== manifest.releaseCommitSha) {
    throw new Error(
      `${baseRef} moved from ${manifest.baseSha} to ${remoteMainSha}. Aborting publish to avoid releasing the wrong code.`
    );
  }

  if (remoteMainSha === manifest.baseSha) {
    run('git', ['push', remoteName, `HEAD:main`], { cwd: manifest.worktreePath, stdio: 'inherit' });
  }

  run('./docker-build-push.sh', ['--non-interactive'], {
    cwd: manifest.worktreePath,
    env: {
      ...process.env,
      PUBLISH_TAG: manifest.targetVersion
    },
    stdio: 'inherit'
  });

  ensureTagOnRemote(manifest);
  ensureGitHubRelease(manifest, notesPath);

  safeCleanup(manifest.worktreePath, path.dirname(options.manifest || manifest.notesPath));

  return {
    action: 'publish',
    notesPath,
    targetTag: manifest.targetTag,
    targetVersion: manifest.targetVersion
  };
}

function cleanupRelease(options) {
  const manifest = readManifest(options.manifest);
  const tempRoot = path.dirname(options.manifest);
  safeCleanup(manifest.worktreePath, tempRoot);

  return {
    action: 'cleanup',
    manifestPath: options.manifest,
    removed: true
  };
}

function collectReleaseContext({ baseSha, previousTag, repoInfo, targetTag, targetVersion, worktreePath }) {
  const commits = parseCommitLog(
    run(
      'git',
      [
        'log',
        '--reverse',
        '--format=%H%x1f%s%x1f%b%x1f%an%x1f%aI%x1e',
        `${previousTag}..${baseSha}`
      ],
      { cwd: worktreePath }
    ).stdout
  ).map((commit) => ({
    ...commit,
    files: resolveCommitFiles(commit.sha, worktreePath)
  }));

  const prs = new Map();

  for (const commit of commits) {
    const prNumber = extractPrNumberFromCommit(commit.subject);

    if (prNumber) {
      const prSummary = resolvePrSummary(repoInfo, prNumber);
      commit.pr = {
        number: prNumber,
        title: prSummary.title,
        url: prSummary.url
      };

      if (!prs.has(prNumber)) {
        prs.set(prNumber, resolvePrDetails(repoInfo, prNumber));
      }
    }
  }

  return {
    baseRef,
    baseSha,
    commits,
    diffStat: trim(
      run(
        'git',
        ['diff', '--stat', `${previousTag}..${baseSha}`, '--', '.', ':(exclude).openchrome/**'],
        { cwd: worktreePath }
      ).stdout
    ),
    generatedAt: new Date().toISOString(),
    previousTag,
    prs: Array.from(prs.values()),
    repository: `${repoInfo.owner}/${repoInfo.repo}`,
    targetTag,
    targetVersion
  };
}

function renderReleaseContext(context) {
  const lines = [
    '# Peta Core Release Context',
    '',
    `- Repository: ${context.repository}`,
    `- Base ref: ${context.baseRef}`,
    `- Base commit: ${context.baseSha}`,
    `- Previous tag: ${context.previousTag}`,
    `- Target version: ${context.targetVersion}`,
    `- Target tag: ${context.targetTag}`,
    `- Generated at: ${context.generatedAt}`,
    '',
    '## Instructions',
    '',
    '- Write release notes in English.',
    '- Focus on meaningful user-facing changes, important fixes, and notable internal behavior changes.',
    '- Do not mention the release version bump commit itself.',
    '- Ignore standalone housekeeping noise unless it changes runtime behavior in a meaningful way.',
    '- When commit titles are vague, use PR details and touched files to infer the actual change.',
    '',
    '## Diff Stat',
    '',
    '```text',
    context.diffStat || '(no diff stat)',
    '```',
    '',
    '## Commits'
  ];

  for (const commit of context.commits) {
    lines.push('');
    lines.push(`### ${commit.sha.slice(0, 7)} ${commit.subject}`);
    lines.push(`- Author: ${commit.author}`);
    lines.push(`- Date: ${commit.date}`);

    if (commit.pr) {
      lines.push(`- PR: #${commit.pr.number} ${commit.pr.title} (${commit.pr.url})`);
    }

    if (commit.files.length > 0) {
      lines.push(`- Files: ${commit.files.join(', ')}`);
    }

    if (commit.body) {
      lines.push('- Body:');
      lines.push('');
      lines.push('```text');
      lines.push(commit.body);
      lines.push('```');
    }
  }

  if (context.prs.length > 0) {
    lines.push('');
    lines.push('## PR Details');

    for (const pr of context.prs) {
      lines.push('');
      lines.push(`### #${pr.number} ${pr.title}`);
      lines.push(`- URL: ${pr.url}`);
      lines.push(`- Author: ${pr.author}`);
      lines.push(`- Merged at: ${pr.mergedAt || 'unknown'}`);

      if (pr.labels.length > 0) {
        lines.push(`- Labels: ${pr.labels.join(', ')}`);
      }

      if (pr.files.length > 0) {
        lines.push(`- Files: ${pr.files.join(', ')}`);
      }

      if (pr.body) {
        lines.push('- Description:');
        lines.push('');
        lines.push('```text');
        lines.push(pr.body);
        lines.push('```');
      }
    }
  }

  lines.push('');

  return `${lines.join('\n')}\n`;
}

function parseCommitLog(output) {
  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, body, author, date] = record.split('\x1f');

      return {
        author: trim(author),
        body: trim(body),
        date: trim(date),
        sha: trim(sha),
        subject: trim(subject)
      };
    });
}

function resolveCommitFiles(sha, cwd) {
  const output = trim(
    run('git', ['show', '--format=', '--name-only', sha, '--', '.', ':(exclude).openchrome/**'], {
      cwd
    }).stdout
  );

  if (!output) {
    return [];
  }

  return output
    .split('\n')
    .map((line) => trim(line))
    .filter(Boolean)
    .filter((line) => !line.startsWith('.openchrome/'));
}

function extractPrNumberFromCommit(subject) {
  const mergeMatch = /^Merge pull request #(\d+)/u.exec(subject);

  if (mergeMatch) {
    return Number.parseInt(mergeMatch[1], 10);
  }

  const squashMatch = /\(#(\d+)\)$/u.exec(subject);

  if (squashMatch) {
    return Number.parseInt(squashMatch[1], 10);
  }

  return null;
}

function resolvePrSummary(repoInfo, prNumber) {
  const prResponse = run(
    'gh',
    [
      'api',
      '-H',
      `Accept: ${gitHubApiAccept}`,
      `repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prNumber}`
    ],
    { cwd: repoRoot }
  );
  const pr = parseJson(prResponse.stdout, {});

  return {
    title: pr.title ?? `PR #${prNumber}`,
    url: pr.html_url ?? `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${prNumber}`
  };
}

function resolvePrDetails(repoInfo, prNumber) {
  const prResponse = run(
    'gh',
    [
      'api',
      '-H',
      `Accept: ${gitHubApiAccept}`,
      `repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prNumber}`
    ],
    { cwd: repoRoot }
  );
  const filesResponse = run(
    'gh',
    [
      'api',
      '-H',
      `Accept: ${gitHubApiAccept}`,
      `repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prNumber}/files`
    ],
    { cwd: repoRoot }
  );

  const pr = parseJson(prResponse.stdout, {});
  const files = parseJson(filesResponse.stdout, []);

  return {
    author: pr.user?.login ?? 'unknown',
    body: trim(pr.body ?? ''),
    files: Array.isArray(files)
      ? files.map((file) => file.filename).filter(Boolean).filter((file) => !file.startsWith('.openchrome/'))
      : [],
    labels: Array.isArray(pr.labels)
      ? pr.labels.map((label) => label.name).filter(Boolean)
      : [],
    mergedAt: pr.merged_at ?? '',
    number: pr.number ?? prNumber,
    title: pr.title ?? `PR #${prNumber}`,
    url: pr.html_url ?? `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${prNumber}`
  };
}

function ensureTagOnRemote(manifest) {
  const remoteTagSha = trim(
    runMaybe('git', ['ls-remote', '--tags', remoteName, `refs/tags/${manifest.targetTag}^{}`], {
      cwd: repoRoot
    }).stdout
  );

  if (remoteTagSha) {
    const [existingSha] = remoteTagSha.split('\t');

    if (existingSha !== manifest.releaseCommitSha) {
      throw new Error(
        `Remote tag ${manifest.targetTag} already exists on ${existingSha}, expected ${manifest.releaseCommitSha}`
      );
    }

    return;
  }

  run('git', ['tag', '-a', manifest.targetTag, '-m', `Release ${manifest.targetTag}`], {
    cwd: manifest.worktreePath
  });
  run('git', ['push', remoteName, `refs/tags/${manifest.targetTag}`], {
    cwd: manifest.worktreePath,
    stdio: 'inherit'
  });
}

function ensureGitHubRelease(manifest, notesPath) {
  const existing = runMaybe(
    'gh',
    ['release', 'view', manifest.targetTag, '--repo', `${manifest.repoInfo.owner}/${manifest.repoInfo.repo}`],
    { cwd: repoRoot }
  );

  if (existing.ok) {
    return;
  }

  run(
    'gh',
    [
      'release',
      'create',
      manifest.targetTag,
      '--repo',
      `${manifest.repoInfo.owner}/${manifest.repoInfo.repo}`,
      '--title',
      manifest.targetTag,
      '--notes-file',
      notesPath,
      '--latest=false',
      '--verify-tag'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  );
}

function refreshRemoteState() {
  run('git', ['fetch', remoteName, 'main', '--tags', '--prune'], { cwd: repoRoot, stdio: 'inherit' });
}

function resolvePreviousTag(baseSha) {
  const output = trim(run('git', ['describe', '--tags', '--abbrev=0', baseSha], { cwd: repoRoot }).stdout);
  assertSemver(output.replace(/^v/, ''), 'Latest tag version');
  return output;
}

function assertTagMissing(targetTag) {
  const existing = trim(
    runMaybe('git', ['ls-remote', '--tags', remoteName, `refs/tags/${targetTag}`], { cwd: repoRoot }).stdout
  );

  if (existing) {
    throw new Error(`Target tag already exists on remote: ${targetTag}`);
  }
}

function readManifest(manifestPath) {
  if (!manifestPath) {
    throw new Error('--manifest is required');
  }

  assertFileExists(manifestPath, 'Manifest');

  const manifest = parseJson(fs.readFileSync(manifestPath, 'utf8'), null);

  if (!manifest) {
    throw new Error(`Manifest is not valid JSON: ${manifestPath}`);
  }

  return manifest;
}

function readPackageVersion(packageJsonPath) {
  const pkg = parseJson(fs.readFileSync(packageJsonPath, 'utf8'), null);
  const version = pkg?.version;
  assertSemver(version, 'package.json version');
  return version;
}

function bumpVersion(currentVersion, bump) {
  const [major, minor, patch] = currentVersion.split('.').map((value) => Number.parseInt(value, 10));

  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unsupported bump type: ${bump}`);
  }
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) {
      return 1;
    }

    if (leftParts[index] < rightParts[index]) {
      return -1;
    }
  }

  return 0;
}

function parseGitHubRepo(remoteUrl) {
  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/u.exec(remoteUrl);
  const httpsMatch = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/u.exec(remoteUrl);
  const match = sshMatch || httpsMatch;

  if (!match) {
    throw new Error(`Unsupported GitHub remote URL: ${remoteUrl}`);
  }

  return {
    owner: match[1],
    repo: match[2]
  };
}

function assertRepoRoot() {
  const topLevel = trim(run('git', ['rev-parse', '--show-toplevel'], { cwd: repoRoot }).stdout);

  if (topLevel !== repoRoot) {
    throw new Error(`Expected repo root ${repoRoot}, got ${topLevel}`);
  }
}

function checkGitHubAuth() {
  run('gh', ['auth', 'status'], { cwd: repoRoot, stdio: 'inherit' });
}

function ensureCommand(command) {
  const result = runMaybe('which', [command], { cwd: repoRoot });

  if (!result.ok) {
    throw new Error(`Required command not found: ${command}`);
  }
}

function assertFileExists(targetPath, label) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

function assertPublicReleaseEvidence() {
  const evidence = [
    ['PETA_CONSOLE_TLS_REVOCATION_EVIDENCE', process.env.PETA_CONSOLE_TLS_REVOCATION_EVIDENCE],
    ['PETA_CONSOLE_TLS_ROTATION_EVIDENCE', process.env.PETA_CONSOLE_TLS_ROTATION_EVIDENCE],
    ['PETA_CONSOLE_REPLACEMENT_DEPLOYMENT_EVIDENCE', process.env.PETA_CONSOLE_REPLACEMENT_DEPLOYMENT_EVIDENCE]
  ];

  for (const [name, evidencePath] of evidence) {
    if (!evidencePath || !fs.existsSync(evidencePath) || !fs.statSync(evidencePath).isFile()) {
      throw new Error(`${name} must point to a readable evidence file before creating a public Git tag or GitHub Release`);
    }
    if (!trim(fs.readFileSync(evidencePath, 'utf8'))) {
      throw new Error(`${name} evidence file is empty: ${evidencePath}`);
    }
  }
}

function assertBump(value) {
  if (!['patch', 'minor', 'major'].includes(value)) {
    throw new Error(`Unsupported bump type: ${value}`);
  }
}

function assertSemver(value, label) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value)) {
    throw new Error(`${label} must be a simple semver like 1.2.3, received: ${value}`);
  }
}

function parseJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function printResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.action === 'prepare') {
    console.log(`Prepared ${result.targetTag}`);
    console.log(`Manifest: ${result.manifestPath}`);
    console.log(`Context:  ${result.contextPath}`);
    console.log(`Notes:    ${result.notesPath}`);
    console.log(`Worktree: ${result.worktreePath}`);
    console.log(`Publish:  node scripts/release-main.js publish --manifest ${result.manifestPath}`);
    console.log(`Cleanup:  node scripts/release-main.js cleanup --manifest ${result.manifestPath}`);
    return;
  }

  if (result.action === 'publish') {
    console.log(`Published ${result.targetTag}`);
    return;
  }

  if (result.action === 'cleanup') {
    console.log(`Removed release workspace for ${result.manifestPath}`);
  }
}

function safeCleanup(worktreePath, tempRoot) {
  if (worktreePath && fs.existsSync(worktreePath)) {
    runMaybe('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
  }

  if (tempRoot && fs.existsSync(tempRoot)) {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
}

function run(command, args, options = {}) {
  const result = execute(command, args, options);

  if (result.status !== 0) {
    throw new Error(formatCommandError(command, args, result));
  }

  return result;
}

function runMaybe(command, args, options = {}) {
  const result = execute(command, args, options);

  return {
    ...result,
    ok: result.status === 0
  };
}

function execute(command, args, options = {}) {
  const {
    cwd = repoRoot,
    env = process.env,
    stdio = 'pipe'
  } = options;

  const spawnOptions = {
    cwd,
    encoding: 'utf8',
    env
  };

  if (stdio === 'inherit') {
    spawnOptions.stdio = 'inherit';
  }

  const result = spawnSync(command, args, spawnOptions);

  return {
    command,
    args,
    status: result.status ?? 1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? ''
  };
}

function formatCommandError(command, args, result) {
  const parts = [`Command failed: ${command} ${args.join(' ')}`];

  if (result.stdout) {
    parts.push(`stdout:\n${result.stdout}`);
  }

  if (result.stderr) {
    parts.push(`stderr:\n${result.stderr}`);
  }

  return parts.join('\n\n');
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

main();
