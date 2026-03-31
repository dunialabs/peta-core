#!/usr/bin/env node

import { execSync } from 'node:child_process';

const REPO_ROOT = process.cwd();
const allowReason = process.env.DOCS_CHECK_ALLOW_NO_UPDATE?.trim();

const rules = [
  {
    label: 'API and protocol behavior',
    codeMatchers: [
      (file) => file.startsWith('src/controllers/'),
      (file) => file.startsWith('src/controllers/handlers/'),
      (file) => file.startsWith('src/mcp/controllers/'),
      (file) => file.startsWith('src/oauth/controllers/'),
      (file) => file.startsWith('src/socket/'),
      (file) => file.startsWith('src/user/')
    ],
    docMatchers: [
      (file) => file === 'docs/api/API.md',
      (file) => file === 'docs/api/ADMIN_API.md',
      (file) => file === 'docs/api/SOCKET_USAGE.md',
      (file) => file === 'docs/reference.md'
    ],
    recommendedDocs: [
      'docs/api/API.md',
      'docs/api/ADMIN_API.md',
      'docs/api/SOCKET_USAGE.md',
      'docs/reference.md'
    ]
  },
  {
    label: 'Security, OAuth, and permissions',
    codeMatchers: [
      (file) => file.startsWith('src/security/'),
      (file) => file.startsWith('src/oauth/'),
      (file) => file.startsWith('src/middleware/'),
      (file) => file.startsWith('src/mcp/auth/')
    ],
    docMatchers: [
      (file) => file === 'docs/security.md',
      (file) => file === 'docs/api/API.md',
      (file) => file === 'docs/reference.md'
    ],
    recommendedDocs: [
      'docs/security.md',
      'docs/api/API.md',
      'docs/reference.md'
    ]
  },
  {
    label: 'Core gateway architecture and runtime behavior',
    codeMatchers: [
      (file) => file.startsWith('src/mcp/core/'),
      (file) => file.startsWith('src/mcp/services/'),
      (file) => file.startsWith('src/services/')
    ],
    docMatchers: [
      (file) => file === 'docs/architecture.md',
      (file) => file === 'CLAUDE.md',
      (file) => file === 'mcp-tools-guide.md',
      (file) => file === 'docs/reference.md'
    ],
    recommendedDocs: [
      'docs/architecture.md',
      'CLAUDE.md',
      'mcp-tools-guide.md',
      'docs/reference.md'
    ]
  },
  {
    label: 'Database and persistence behavior',
    codeMatchers: [
      (file) => file === 'prisma/schema.prisma',
      (file) => file.startsWith('prisma/migrations/'),
      (file) => file.startsWith('src/repositories/'),
      (file) => file.includes('EventStore'),
      (file) => file.includes('Cache')
    ],
    docMatchers: [
      (file) => file === 'docs/architecture.md',
      (file) => file === 'docs/reference.md',
      (file) => file === 'docs/security.md'
    ],
    recommendedDocs: [
      'docs/architecture.md',
      'docs/reference.md',
      'docs/security.md'
    ]
  },
  {
    label: 'Runtime, startup, and deployment',
    codeMatchers: [
      (file) => file === 'src/index.ts',
      (file) => file.startsWith('src/config/'),
      (file) => file === 'Dockerfile',
      (file) => file === 'docker-compose.yml',
      (file) => file === 'docker-build-push.sh',
      (file) => file === 'docker-build-push-ghcr.sh',
      (file) => file.startsWith('scripts/') && file !== 'scripts/docs-check.js'
    ],
    docMatchers: [
      (file) => file === 'README.md',
      (file) => file === 'docs/deployment.md',
      (file) => file === 'docs/DOCKER_DEPLOYMENT.md'
    ],
    recommendedDocs: [
      'README.md',
      'docs/deployment.md',
      'docs/DOCKER_DEPLOYMENT.md'
    ]
  }
];

function run(command) {
  return execSync(command, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function getChangedFiles() {
  const tracked = run('git diff --name-only --diff-filter=ACDMRTUXB HEAD --');
  const untracked = run('git ls-files --others --exclude-standard');
  return [...tracked.split('\n'), ...untracked.split('\n')]
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((file) => !file.startsWith('dist/'))
    .filter((file) => !file.startsWith('node_modules/'));
}

function matchesRule(file, matchers) {
  return matchers.some((matcher) => matcher(file));
}

function formatList(items) {
  return items.map((item) => `  - ${item}`).join('\n');
}

function main() {
  let changedFiles = [];

  try {
    changedFiles = getChangedFiles();
  } catch (error) {
    console.error('[docs:check] Failed to inspect git changes.');
    console.error(error.message);
    process.exit(1);
  }

  if (changedFiles.length === 0) {
    console.log('[docs:check] No working tree changes detected.');
    process.exit(0);
  }

  const failures = [];

  for (const rule of rules) {
    const codeFiles = changedFiles.filter((file) => matchesRule(file, rule.codeMatchers));

    if (codeFiles.length === 0) {
      continue;
    }

    const docFiles = changedFiles.filter((file) => matchesRule(file, rule.docMatchers));

    if (docFiles.length > 0) {
      continue;
    }

    failures.push({ rule, codeFiles });
  }

  if (failures.length === 0) {
    console.log('[docs:check] Relevant documentation changes detected for the current diff.');
    process.exit(0);
  }

  console.error('[docs:check] Documentation impact appears unaddressed for the current diff.\n');

  for (const failure of failures) {
    console.error(`- ${failure.rule.label}`);
    console.error('  Changed code files:');
    console.error(formatList(failure.codeFiles));
    console.error('  Expected one of these docs to change:');
    console.error(formatList(failure.rule.recommendedDocs));
    console.error('');
  }

  if (allowReason) {
    console.warn(`[docs:check] Override accepted with DOCS_CHECK_ALLOW_NO_UPDATE="${allowReason}"`);
    process.exit(0);
  }

  console.error('Add the relevant docs, or rerun with DOCS_CHECK_ALLOW_NO_UPDATE="<reason>" when a doc update is intentionally unnecessary.');
  process.exit(1);
}

main();
