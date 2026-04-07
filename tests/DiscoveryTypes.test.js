import {
  evaluateExposureRules,
  validateDiscoveryProfileConfig,
} from '../dist/types/discovery.types.js';

describe('discovery.types', () => {
  const EXAMPLE_SERVER_ID = 'da89481f669047cf8511ef59cbee6314';

  test('accepts low and high direct exposure risk levels', () => {
    expect(
      validateDiscoveryProfileConfig({
        directExposureRules: [
          {
            match: {
              riskLevels: ['low', 'high'],
            },
            directCallable: true,
          },
        ],
      }),
    ).toBeNull();
  });

  test('rejects unsupported direct exposure risk levels', () => {
    expect(
      validateDiscoveryProfileConfig({
        directExposureRules: [
          {
            match: {
              riskLevels: ['medium'],
            },
            directCallable: true,
          },
        ],
      }),
    ).toContain('"low" or "high"');
  });

  test('ignores malformed rule arrays during runtime evaluation', () => {
    expect(
      evaluateExposureRules(
        [
          {
            match: {
              riskLevels: 'high',
            },
            directCallable: true,
          },
        ],
        {
          serverId: EXAMPLE_SERVER_ID,
          riskLevel: 'high',
        },
        false,
      ),
    ).toBe(false);
  });
});
