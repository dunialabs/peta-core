#!/usr/bin/env node

/**
 * Unified Application Startup Script
 *
 * This script handles both development and production environment startups
 * based on NODE_ENV environment variable.
 *
 * Features:
 * - Smart database detection and auto-start
 * - Database initialization and migrations
 * - TypeScript compilation (dev only)
 * - Automatic port allocation (dev) or fixed ports (prod)
 * - Cloudflared tunnel support (both environments)
 * - Graceful shutdown handling
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import chalk from 'chalk';
import ora from 'ora';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Ensure .env file exists, copy from .env.example if needed
 */
function ensureEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  const envExamplePath = path.join(process.cwd(), '.env.example');

  // If .env exists, do nothing
  if (fs.existsSync(envPath)) {
    return;
  }

  // If .env.example doesn't exist, warn and create minimal .env
  if (!fs.existsSync(envExamplePath)) {
    console.log(chalk.yellow('⚠️  Warning: .env.example not found'));
    console.log(chalk.gray('💡 Creating minimal .env file...'));
    // Create minimal .env with DATABASE_URL
    const minimalEnv = 'DATABASE_URL="postgresql://peta:peta123@localhost:5433/peta_mcp_gateway?schema=public"\n';
    fs.writeFileSync(envPath, minimalEnv, 'utf8');
    console.log(chalk.green('✅ Created minimal .env file\n'));
    return;
  }

  // Copy .env.example to .env
  try {
    fs.copyFileSync(envExamplePath, envPath);
    console.log(chalk.blue('📝 .env file not found, created from .env.example'));
    console.log(chalk.yellow('💡 Please review and update .env with your configuration\n'));
  } catch (error) {
    console.log(chalk.red(`❌ Failed to create .env file: ${error.message}`));
    process.exit(1);
  }
}

// Ensure .env file exists before loading
ensureEnvFile();

// Load environment variables from .env file
const dotenvPath = path.join(process.cwd(), '.env');
if (fs.existsSync(dotenvPath)) {
  const dotenv = await import('dotenv');
  dotenv.config({ path: dotenvPath });
}

// Determine environment
const NODE_ENV = process.env.NODE_ENV || 'development';
const isDevelopment = NODE_ENV === 'development';
const shouldAutostartPetaAuth = process.env.PETA_AUTH_AUTOSTART !== 'false';
const petaAuthBaseUrl = process.env.PETA_CORE_IN_DOCKER === 'true'
  ? 'http://peta-auth:7788'
  : 'http://localhost:7788';
const petaAuthHealthUrl = `${petaAuthBaseUrl}/healthz`;
const petaAuthHealthMaxWaitMs = 30000;
const petaAuthHealthRetryIntervalMs = 5000;
const petaAuthHealthMaxAttempts = Math.ceil(petaAuthHealthMaxWaitMs / petaAuthHealthRetryIntervalMs);

/**
 * Read version from package.json
 */
function getVersion() {
  try {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version || '1.0.0';
  } catch (error) {
    return '1.0.0';
  }
}

/**
 * Print startup banner
 */
function printBanner() {
  const VERSION = getVersion();
  const envLabel = NODE_ENV.toUpperCase();
  const orange = chalk.rgb(245, 103, 17);

  const banner = `
${chalk.cyan('┌─')} ${chalk.bold.white('peta-core')} ${chalk.dim(`v${VERSION}`)} ${chalk.cyan('────────────────────────────────────────────────────────────┐')}
${chalk.cyan('│')}                                                                               ${chalk.cyan('│')}
${chalk.cyan('│')}   ${orange('██████╗ ███████╗████████╗ █████╗')}                                            ${chalk.cyan('│')}
${chalk.cyan('│')}   ${orange('██╔══██╗██╔════╝╚══██╔══╝██╔══██╗')}    ${chalk.white('Zero-Trust Gateway for AI Agents')}       ${chalk.cyan('│')}
${chalk.cyan('│')}   ${orange('██████╔╝█████╗     ██║   ███████║')}                                           ${chalk.cyan('│')}
${chalk.cyan('│')}   ${orange('██╔═══╝ ██╔══╝     ██║   ██╔══██║')}    ${chalk.blue.underline('https://peta.io')}                        ${chalk.cyan('│')}
${chalk.cyan('│')}   ${orange('██║     ███████╗   ██║   ██║  ██║')}    ${chalk.dim('Docs:')} ${chalk.blue.underline('https://docs.peta.io')}             ${chalk.cyan('│')}
${chalk.cyan('│')}   ${orange('╚═╝     ╚══════╝   ╚═╝   ╚═╝  ╚═╝')}    ${chalk.dim('GitHub:')} ${chalk.blue.underline('github.com/dunialabs/peta-core')} ${chalk.cyan('│')}
${chalk.cyan('│')}                                                                               ${chalk.cyan('│')}
${chalk.cyan('│')}   ${chalk.dim('Dunia Labs, Inc.')}                         ${chalk.dim(`[${envLabel.padEnd(11)}]`)} ${chalk.gray('Press Ctrl+C to stop')} ${chalk.cyan('│')}
${chalk.cyan('└───────────────────────────────────────────────────────────────────────────────┘')}
`;

  console.log(banner);
}

/**
 * Utility logging functions
 */
function logSuccess(message) {
  console.log(`  ${chalk.green('✓')} ${message}`);
}

function logInfo(message) {
  console.log(`  ${chalk.cyan('→')} ${message}`);
}

function logError(message) {
  console.log(`  ${chalk.red('✗')} ${message}`);
}

function createSpinner(text) {
  return ora({
    text: chalk.white(text),
    spinner: 'dots',
    color: 'cyan',
  });
}

/**
 * Execute command with spinner
 */
function executeWithSpinner(command, args, spinnerText, successMessage, options = {}, failureMessage = null) {
  return new Promise((resolve, reject) => {
    const spinner = createSpinner(spinnerText);
    spinner.start();

    const child = spawn(command, args, {
      stdio: 'pipe',
      cwd: process.cwd(),
      ...options
    });

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('close', (code) => {
      spinner.stop();
      if (code === 0) {
        logSuccess(successMessage);
        resolve({ stdout, stderr, code });
      } else {
        const fallbackMessage = successMessage.replace('successfully', 'failed').replace('built', 'build failed');
        logError(failureMessage || fallbackMessage);
        const hasStdout = stdout && stdout.trim().length > 0;
        const hasStderr = stderr && stderr.trim().length > 0;
        if (hasStdout) {
          console.error(chalk.yellow('--- Command stdout ---'));
          console.error(stdout.trimEnd());
        }
        if (hasStderr) {
          console.error(chalk.red('--- Command stderr ---'));
          console.error(stderr.trimEnd());
        }
        if (!hasStdout && !hasStderr) {
          console.error(chalk.yellow('No output captured from failed command.'));
        }
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', (error) => {
      spinner.stop();
      logError(`Failed to execute ${command}`);
      reject(error);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkPetaAuthHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(petaAuthHealthUrl, { signal: controller.signal });
    return response.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForPetaAuthHealth() {
  const spinner = createSpinner('Waiting for peta-auth health check...');
  spinner.start();

  for (let attempt = 1; attempt <= petaAuthHealthMaxAttempts; attempt++) {
    const healthy = await checkPetaAuthHealth();
    if (healthy) {
      spinner.stop();
      logSuccess(`peta-auth is healthy (${petaAuthHealthUrl})`);
      return;
    }

    if (attempt < petaAuthHealthMaxAttempts) {
      await sleep(petaAuthHealthRetryIntervalMs);
    }
  }

  spinner.stop();
  logError(`peta-auth health check failed after ${petaAuthHealthMaxWaitMs / 1000}s (${petaAuthHealthUrl})`);
  throw new Error('peta-auth health check failed');
}

async function startPetaAuthIfNeeded() {
  if (!shouldAutostartPetaAuth) {
    logInfo('Skipping peta-auth autostart (PETA_AUTH_AUTOSTART=false)');
    console.log();
    return;
  }

  await executeWithSpinner(
    'docker',
    ['compose', 'up', '-d', 'peta-auth'],
    'Starting peta-auth...',
    'peta-auth started',
    {},
    'Failed to start peta-auth'
  );

  await waitForPetaAuthHealth();
  console.log();
}

/**
 * Main startup function
 */
async function startApplication() {
  printBanner();

  try {
    // Step 1: Database initialization (smart auto-start + migrations)
    await executeWithSpinner(
      'npm',
      ['run', 'db:init'],
      'Initializing database...',
      'Database initialized'
    );
    console.log(); // Add spacing

    // Step 2: Peta Auth auto-start (optional)
    await startPetaAuthIfNeeded();

    // Step 3: TypeScript compilation (development only)
    if (isDevelopment) {
      await executeWithSpinner(
        'npm',
        ['run', 'build'],
        'Building backend...',
        'Backend built successfully'
      );
      console.log();
    } else {
      // Production: Check if dist/ exists
      const distPath = path.join(process.cwd(), 'dist');
      if (!fs.existsSync(distPath)) {
        logError('dist/ directory not found');
        logInfo('Run: npm run build');
        process.exit(1);
      }
      logSuccess('Using pre-compiled code from dist/');
      console.log();
    }

    // Step 4: Port allocation (development only)
    let backendPort = parseInt(process.env.BACKEND_PORT || '3002');

    if (isDevelopment) {
      try {
        const portManager = await import('./port-manager.js');
        const ports = await portManager.allocatePorts();
        backendPort = ports.backendPort;
        logInfo(`Port allocation: Backend will use port ${backendPort}`);
        console.log();
      } catch (error) {
        logInfo('Port allocation failed, using default port');
        console.log();
      }
    }

    // Step 5: Start the application
    const spinner = createSpinner('Starting services...');
    spinner.start();

    const env = {
      ...process.env,
      BACKEND_PORT: backendPort,
      BACKEND_HTTPS_PORT: backendPort,
      NODE_ENV: NODE_ENV
    };

    let child;

    if (isDevelopment) {
      // Development: Use concurrently with tsx for hot reload
      const concurrentlyArgs = [
        '--kill-others-on-fail',
        '--raw', // Remove [0] [1] prefixes to make logs cleaner
        'npm run db:start',
        `BACKEND_PORT=${backendPort} BACKEND_HTTPS_PORT=${backendPort} NODE_ENV=${NODE_ENV} npm run dev:backend-only`
      ];

      child = spawn('npx', ['concurrently', ...concurrentlyArgs], {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: env,
        cwd: process.cwd()
      });
    } else {
      // Production: Run compiled code directly
      child = spawn('node', ['dist/index.js'], {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: env,
        cwd: process.cwd()
      });
    }

    // Monitor output to detect successful startup
    let startupDetected = false;

    // Note: many tools (including concurrently / tsx) may write startup logs to stderr.
    // Also, 'data' events can split lines, so we do line buffering for reliable detection.
    const stripAnsi = (str) => str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    const startupPortRegex = new RegExp(`\\b(port|ports?)\\b[^\\n]*\\b${backendPort}\\b`, 'i');
    const startupListenRegex = new RegExp(`\\blisten(ing)?\\b[^\\n]*\\b${backendPort}\\b`, 'i');

    const isStartupIndicator = (line) => {
      const normalized = stripAnsi(line).replace(/\r/g, '').toLowerCase();
      return (
        normalized.includes('server ready') ||
        normalized.includes(`http://localhost:${backendPort}`) ||
        normalized.includes(`https://localhost:${backendPort}`) ||
        normalized.includes(`http://127.0.0.1:${backendPort}`) ||
        normalized.includes(`https://127.0.0.1:${backendPort}`) ||
        startupPortRegex.test(normalized) ||
        startupListenRegex.test(normalized)
      );
    };

    let bufferedStdout = '';
    let bufferedStderr = '';
    let stdoutRemainder = '';
    let stderrRemainder = '';

    const flushBufferedOutput = () => {
      if (bufferedStdout) {
        process.stdout.write(bufferedStdout);
        bufferedStdout = '';
      }
      if (bufferedStderr) {
        process.stderr.write(bufferedStderr);
        bufferedStderr = '';
      }
    };

    const onStartupDetected = () => {
      if (startupDetected) return;
      startupDetected = true;
      spinner.stop();
      logSuccess(`Services ready on :${backendPort}`);
      logInfo(`Service URL: ${chalk.blue.underline(`http://localhost:${backendPort}`)}`);
      console.log();
      console.log(chalk.green.bold('  🚀 peta-core is ready!'));
      console.log();
      flushBufferedOutput();
    };

    const handleOutput = (data, isStderr) => {
      const output = data.toString();

      // Buffer everything until we either detect startup or hit the fallback timer,
      // then flush once and start streaming live output.
      if (!startupDetected) {
        if (isStderr) bufferedStderr += output;
        else bufferedStdout += output;
      } else {
        if (isStderr) process.stderr.write(output);
        else process.stdout.write(output);
      }

      // Detection (line-buffered) on BOTH streams
      const combined = (isStderr ? stderrRemainder : stdoutRemainder) + output;
      const lines = combined.split(/\n/);
      const remainder = lines.pop() ?? '';
      if (isStderr) stderrRemainder = remainder;
      else stdoutRemainder = remainder;

      if (!startupDetected) {
        for (const line of lines) {
          if (isStartupIndicator(line)) {
            onStartupDetected();
            break;
          }
        }
      }
    };

    if (child.stdout) {
      child.stdout.on('data', (data) => handleOutput(data, false));
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => handleOutput(data, true));
    }

    // Fallback: stop spinner after 10 seconds if no startup detected
    setTimeout(() => {
      if (!startupDetected) {
        spinner.stop();
        logInfo('Services starting...');
        console.log();

        // Start forwarding all output (and flush anything buffered so far)
        startupDetected = true;
        flushBufferedOutput();
      }
    }, 10000);

    // Step 6: Graceful shutdown handling
    let isShuttingDown = false;

    process.on('SIGINT', async () => {
      if (isShuttingDown) {
        logInfo('Shutdown already in progress, ignoring signal');
        return;
      }

      isShuttingDown = true;
      console.log(); // New line after Ctrl+C
      logInfo('Shutting down services...');
      child.kill('SIGINT');
      // Wait for child process to exit naturally via 'close' event
    });

    process.on('SIGTERM', async () => {
      if (isShuttingDown) {
        return;
      }

      isShuttingDown = true;
      console.log();
      logInfo('Shutting down services...');
      child.kill('SIGTERM');
    });

    child.on('close', (code) => {
      console.log();
      logInfo(`Services stopped with code ${code}`);
      process.exit(code);
    });

    child.on('error', (error) => {
      spinner.stop();
      logError(`Failed to start services: ${error.message}`);
      process.exit(1);
    });

  } catch (error) {
    logError(`Startup failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

// Execute startup
startApplication();
