import {
  appendStderrTail,
  buildCustomStdioRunnerLaunchPlan,
  classifyCustomStdioRunnerFailure,
  CUSTOM_STDIO_RUNNER_IMAGE,
  isExplicitDockerCommand,
} from '../dist/mcp/core/CustomStdioRunner.js';

describe('CustomStdioRunner helpers', () => {
  test('normalizes docker command variants correctly', () => {
    expect(isExplicitDockerCommand('docker')).toBe(true);
    expect(isExplicitDockerCommand('/usr/bin/docker')).toBe(true);
    expect(isExplicitDockerCommand('C:\\Program Files\\Docker\\docker.exe')).toBe(true);
    expect(isExplicitDockerCommand('DOCKER.EXE')).toBe(true);
    expect(isExplicitDockerCommand('"docker"')).toBe(true);
    expect(isExplicitDockerCommand('uvx')).toBe(false);
  });

  test('builds runner launch plan from custom stdio config', () => {
    const plan = buildCustomStdioRunnerLaunchPlan({
      command: 'uvx',
      args: ['mcp-server-time', '--local-timezone=Asia/Shanghai'],
      env: {
        LOG_LEVEL: 'debug',
      },
      cwd: '/workspace/project',
    });

    expect(plan.metadata).toEqual({
      runnerImage: CUSTOM_STDIO_RUNNER_IMAGE,
      originalCommand: 'uvx',
    });

    expect(plan.launchConfig.command).toBe('docker');
    expect(plan.launchConfig.args).toEqual([
      'run',
      '-i',
      '--rm',
      '--init',
      '-v',
      'peta-mcp-runner-cache:/home/runner/.cache',
      '-w',
      '/workspace/project',
      '-e',
      'LOG_LEVEL=debug',
      CUSTOM_STDIO_RUNNER_IMAGE,
      'uvx',
      'mcp-server-time',
      '--local-timezone=Asia/Shanghai',
    ]);
    expect(plan.launchConfig.cwd).toBeUndefined();
    expect(plan.launchConfig.env).toBeUndefined();
    expect(plan.launchConfig.stderr).toBe('pipe');
  });

  test('classifies docker startup and command failures', () => {
    expect(
      classifyCustomStdioRunnerFailure(
        125,
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
      ).category,
    ).toBe('runner_startup_failure');

    expect(classifyCustomStdioRunnerFailure(127, '').category).toBe('runner_command_failure');
    expect(classifyCustomStdioRunnerFailure(1, 'some unknown error').category).toBe(
      'runner_command_failure',
    );
    expect(classifyCustomStdioRunnerFailure(null, '', '').category).toBe(
      'runner_unknown_failure',
    );
  });

  test('keeps only stderr tail up to max length', () => {
    expect(appendStderrTail('', 'abcdefghij', 5)).toBe('fghij');
  });

  test('decodes Uint8Array stderr chunks as utf8 text', () => {
    const chunk = new Uint8Array(Buffer.from('stderr text', 'utf8'));
    expect(appendStderrTail('', chunk, 100)).toBe('stderr text');
  });
});
