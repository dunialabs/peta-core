import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deployScript = fileURLToPath(new URL('../docs/docker-deploy.sh', import.meta.url));
const envExample = fileURLToPath(new URL('../.env.example', import.meta.url));

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test('clean installer default excludes Peta Auth and its secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'peta-core-deploy-'));
  const bin = join(root, 'bin');
  const deployment = join(root, 'deployment [qa]*');

  try {
    mkdirSync(bin);
    writeExecutable(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');
    writeExecutable(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');

    execFileSync('/bin/bash', [deployScript], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DEPLOY_DIR: deployment,
      },
      stdio: 'ignore',
    });

    const compose = readFileSync(join(deployment, 'docker-compose.yml'), 'utf8');
    const environment = readFileSync(join(deployment, '.env'), 'utf8');

    expect(compose).not.toContain('peta-auth:');
    expect(compose).not.toContain('peta_auth_');
    expect(environment).toContain('PETA_AUTH_AUTOSTART=false');
    expect(environment).toContain('PETA_AUTH_VERSION=1.3.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enabling Peta Auth rejects missing runtime secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'peta-core-deploy-'));
  const bin = join(root, 'bin');
  const deployment = join(root, 'deployment');

  try {
    mkdirSync(bin);
    writeExecutable(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');

    expect(() => execFileSync('/bin/bash', [deployScript], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DEPLOY_DIR: deployment,
        PETA_AUTH_AUTOSTART: 'true',
      },
      stdio: 'ignore',
    })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enabling Peta Auth rejects a writable immediate secret parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'peta-core-deploy-'));
  const bin = join(root, 'bin');
  const deployment = join(root, 'deployment');
  const secrets = join(root, 'secrets');
  const masterKey = join(secrets, 'master-key');
  const clientSecrets = join(secrets, 'client-secrets.json');

  try {
    mkdirSync(bin);
    mkdirSync(secrets);
    writeFileSync(masterKey, Buffer.alloc(32));
    writeFileSync(clientSecrets, '{}');
    chmodSync(masterKey, 0o600);
    chmodSync(clientSecrets, 0o600);
    chmodSync(secrets, 0o777);
    writeExecutable(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');
    writeExecutable(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');

    expect(() => execFileSync('/bin/bash', [deployScript], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DEPLOY_DIR: deployment,
        PETA_AUTH_AUTOSTART: 'true',
        PETA_AUTH_MASTER_KEY_SOURCE: masterKey,
        PETA_AUTH_CLIENT_SECRETS_SOURCE: clientSecrets,
      },
      stdio: 'ignore',
    })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enabling Peta Auth rejects a symlinked immediate secret parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'peta-core-deploy-'));
  const bin = join(root, 'bin');
  const deployment = join(root, 'deployment');
  const realSecrets = join(root, 'real-secrets');
  const linkedSecrets = join(root, 'linked-secrets');
  const masterKey = join(linkedSecrets, 'master-key');
  const clientSecrets = join(linkedSecrets, 'client-secrets.json');

  try {
    mkdirSync(bin);
    mkdirSync(realSecrets);
    writeFileSync(join(realSecrets, 'master-key'), Buffer.alloc(32));
    writeFileSync(join(realSecrets, 'client-secrets.json'), '{}');
    chmodSync(join(realSecrets, 'master-key'), 0o600);
    chmodSync(join(realSecrets, 'client-secrets.json'), 0o600);
    symlinkSync(realSecrets, linkedSecrets);
    writeExecutable(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');
    writeExecutable(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');

    expect(() => execFileSync('/bin/bash', [deployScript], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DEPLOY_DIR: deployment,
        PETA_AUTH_AUTOSTART: 'true',
        PETA_AUTH_MASTER_KEY_SOURCE: masterKey,
        PETA_AUTH_CLIENT_SECRETS_SOURCE: clientSecrets,
      },
      stdio: 'ignore',
    })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enabling Peta Auth rejects a symlinked secret file before reading it', () => {
  const root = mkdtempSync(join(tmpdir(), 'peta-core-deploy-'));
  const bin = join(root, 'bin');
  const deployment = join(root, 'deployment');
  const secrets = join(root, 'secrets');
  const realMasterKey = join(secrets, 'real-master-key');
  const masterKey = join(secrets, 'master-key');
  const clientSecrets = join(secrets, 'client-secrets.json');

  try {
    mkdirSync(bin);
    mkdirSync(secrets);
    writeFileSync(realMasterKey, Buffer.alloc(32));
    writeFileSync(clientSecrets, '{}');
    chmodSync(realMasterKey, 0o600);
    chmodSync(clientSecrets, 0o600);
    chmodSync(secrets, 0o700);
    symlinkSync(realMasterKey, masterKey);
    writeExecutable(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');
    writeExecutable(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    writeExecutable(
      join(bin, 'stat'),
      '#!/bin/sh\ncase "$1:$2" in\n  -f:%Su) id -un ;;\n  -f:%Lp) echo 600 ;;\n  *) exit 97 ;;\nesac\n',
    );
    writeExecutable(join(bin, 'wc'), '#!/bin/sh\necho unexpected-secret-read >&2\nexit 98\n');

    let failure;
    try {
      execFileSync('/bin/bash', [deployScript], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DEPLOY_DIR: deployment,
          PETA_AUTH_AUTOSTART: 'true',
          PETA_AUTH_MASTER_KEY_SOURCE: masterKey,
          PETA_AUTH_CLIENT_SECRETS_SOURCE: clientSecrets,
        },
        encoding: 'utf8',
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeDefined();
    expect(String(failure.stdout)).toContain('Peta Auth runtime secret files must not be symbolic links');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enabling Peta Auth uses GNU stat formats on Linux', () => {
  const root = mkdtempSync(join(tmpdir(), 'peta-core-deploy-'));
  const bin = join(root, 'bin');
  const deployment = join(root, 'deployment');
  const secrets = join(root, 'secrets');
  const masterKey = join(secrets, 'master-key');
  const clientSecrets = join(secrets, 'client-secrets.json');

  try {
    mkdirSync(bin);
    mkdirSync(secrets);
    writeFileSync(masterKey, Buffer.alloc(32));
    writeFileSync(clientSecrets, '{}');
    chmodSync(masterKey, 0o600);
    chmodSync(clientSecrets, 0o600);
    chmodSync(secrets, 0o700);
    writeExecutable(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');
    writeExecutable(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'uname'), '#!/bin/sh\necho Linux\n');
    writeExecutable(
      join(bin, 'stat'),
      '#!/bin/sh\ncase "$1:$2" in\n  -c:%U) id -un ;;\n  -c:%a) echo 600 ;;\n  -f:*) echo misleading ;;\n  *) exit 97 ;;\nesac\n',
    );

    execFileSync('/bin/bash', [deployScript], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DEPLOY_DIR: deployment,
        PETA_AUTH_AUTOSTART: 'true',
        PETA_AUTH_MASTER_KEY_SOURCE: masterKey,
        PETA_AUTH_CLIENT_SECRETS_SOURCE: clientSecrets,
      },
      stdio: 'ignore',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enabling Peta Auth rejects an immediate secret parent with another owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'peta-core-deploy-'));
  const bin = join(root, 'bin');
  const deployment = join(root, 'deployment');
  const secrets = join(root, 'secrets');
  const masterKey = join(secrets, 'master-key');
  const clientSecrets = join(secrets, 'client-secrets.json');

  try {
    mkdirSync(bin);
    mkdirSync(secrets);
    writeFileSync(masterKey, Buffer.alloc(32));
    writeFileSync(clientSecrets, '{}');
    chmodSync(masterKey, 0o600);
    chmodSync(clientSecrets, 0o600);
    chmodSync(secrets, 0o700);
    writeExecutable(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');
    writeExecutable(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'stat'), `#!/bin/sh\ncase "$2" in\n  %Su|%U) [ "$3" = "${secrets}" ] && echo other-user || id -un ;;\n  %Lp|%a) echo 600 ;;\nesac\n`);

    expect(() => execFileSync('/bin/bash', [deployScript], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DEPLOY_DIR: deployment,
        PETA_AUTH_AUTOSTART: 'true',
        PETA_AUTH_MASTER_KEY_SOURCE: masterKey,
        PETA_AUTH_CLIENT_SECRETS_SOURCE: clientSecrets,
      },
      stdio: 'ignore',
    })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enabling Peta Auth accepts separate absolute secrets below a normal ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'peta-core-deploy-'));
  const bin = join(root, 'bin');
  const deployment = join(root, 'deployment');
  const ancestor = join(root, 'normal-ancestor');
  const secrets = join(ancestor, 'secrets');
  const masterKey = join(secrets, 'master-key');
  const clientSecrets = join(secrets, 'client-secrets.json');

  try {
    mkdirSync(bin);
    mkdirSync(secrets, { recursive: true });
    writeFileSync(masterKey, Buffer.alloc(32));
    writeFileSync(clientSecrets, '{}');
    chmodSync(masterKey, 0o600);
    chmodSync(clientSecrets, 0o600);
    chmodSync(secrets, 0o700);
    chmodSync(ancestor, 0o755);
    writeExecutable(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');
    writeExecutable(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');

    execFileSync('/bin/bash', [deployScript], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DEPLOY_DIR: deployment,
        PETA_AUTH_AUTOSTART: 'true',
        PETA_AUTH_MASTER_KEY_SOURCE: masterKey,
        PETA_AUTH_CLIENT_SECRETS_SOURCE: clientSecrets,
      },
      stdio: 'ignore',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated Peta Auth Compose keeps Auth private, scoped, and independently versioned', () => {
  const root = mkdtempSync(join(tmpdir(), 'peta-core-deploy-'));
  const bin = join(root, 'bin');
  const deployment = join(root, 'deployment');
  const masterKey = join(root, 'master-key');
  const clientSecrets = join(root, 'client-secrets.json');

  try {
    mkdirSync(bin);
    writeFileSync(masterKey, Buffer.alloc(32));
    writeFileSync(clientSecrets, '{}');

    writeExecutable(
      join(bin, 'docker'),
      '#!/bin/sh\nexit 0\n',
    );
    writeExecutable(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n');
    writeExecutable(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    writeExecutable(
      join(bin, 'stat'),
      '#!/bin/sh\ncase "$2" in %Su) id -un ;; %Lp) echo 600 ;; esac\n',
    );

    execFileSync('/bin/bash', [deployScript], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DEPLOY_DIR: deployment,
        PETA_VERSION: '9.9.9-core-test',
        PETA_AUTH_VERSION: '1.3.0-auth-test',
        PETA_AUTH_AUTOSTART: 'true',
        PETA_AUTH_MASTER_KEY_SOURCE: masterKey,
        PETA_AUTH_CLIENT_SECRETS_SOURCE: clientSecrets,
      },
      stdio: 'ignore',
    });

    const compose = readFileSync(join(deployment, 'docker-compose.yml'), 'utf8');
    const environment = readFileSync(join(deployment, '.env'), 'utf8');
    if (process.env.PETA_CORE_DEPLOY_ARTIFACT) {
      writeFileSync(process.env.PETA_CORE_DEPLOY_ARTIFACT, compose);
    }
    if (process.env.PETA_CORE_DEPLOY_ENV_ARTIFACT) {
      writeFileSync(process.env.PETA_CORE_DEPLOY_ENV_ARTIFACT, environment);
    }
    const authService = compose.slice(
      compose.indexOf('  peta-auth:'),
      compose.indexOf('  # Cloudflared Service'),
    );
    const coreService = compose.slice(
      compose.indexOf('  peta-core:'),
      compose.indexOf('  # Peta Auth Service'),
    );

    expect(authService).toContain('image: bcdunia/peta-auth:${PETA_AUTH_VERSION}');
    expect(authService).not.toContain('ports:');
    expect(authService).toContain('PETA_AUTH_MASTER_KEY_FILE: /run/secrets/peta_auth_master_key');
    expect(authService).toContain('PETA_AUTH_CLIENT_SECRETS_FILE: /run/secrets/peta_auth_client_secrets_json');
    expect(authService).toContain('- peta_auth_master_key');
    expect(authService).toContain('- peta_auth_client_secrets_json');
    expect(coreService).not.toContain('peta_auth_');
    expect(coreService).toContain('image: bcdunia/peta-core:9.9.9-core-test');
    expect(compose).toContain(`file: ${masterKey}`);
    expect(compose).toContain(`file: ${clientSecrets}`);
    expect(compose).toContain('response+="$$line"');
    expect(compose).toContain('[[ "$$response" == *"\\"ok\\":true"* ]]');
    expect(compose).not.toMatch(/response\+="\d+line"/);
    expect(environment).toContain('PETA_AUTH_VERSION=1.3.0-auth-test');
    expect(environment).toContain('PETA_VERSION=9.9.9-core-test');
    expect(environment).toContain('PETA_AUTH_AUTOSTART=true');
    expect(readFileSync(envExample, 'utf8')).toContain("PETA_AUTH_AUTOSTART='false'");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
