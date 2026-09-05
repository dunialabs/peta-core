import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() }),
}));

const { ApprovalRequestHasher } = await import('../dist/mcp/services/ApprovalRequestHasher.js');

describe('ApprovalRequestHasher', () => {
  test('preserves every JSON value while sorting object keys', () => {
    const hasher = new ApprovalRequestHasher();
    const base = {
      emptyArray: [],
      nullable: null,
      ordered: [{ second: 2, first: 1 }, null, []],
      _meta: { nested: { tenant: 'acme', retry: 0 } },
    };
    const reordered = {
      _meta: { nested: { retry: 0, tenant: 'acme' } },
      ordered: [{ first: 1, second: 2 }, null, []],
      nullable: null,
      emptyArray: [],
    };

    expect(hasher.computeHash('user', 'server', 'tool', base, 1)).toBe(
      hasher.computeHash('user', 'server', 'tool', reordered, 1),
    );
  });

  test.each([
    ['null field', { value: null }, {}],
    ['empty array', { value: [] }, {}],
    ['nested metadata', { _meta: { tenant: 'acme' } }, { _meta: { tenant: 'other' } }],
    ['array position', { values: ['first', 'second'] }, { values: ['second', 'first'] }],
    ['own __proto__ key', JSON.parse('{"__proto__":{"tenant":"acme"}}'), {}],
  ])('does not merge approvals that differ by %s', (_name, left, right) => {
    const hasher = new ApprovalRequestHasher();

    expect(hasher.computeHash('user', 'server', 'tool', left, 1)).not.toBe(
      hasher.computeHash('user', 'server', 'tool', right, 1),
    );
  });

  test('uses a new hash input version so legacy lossy hashes cannot be claimed', () => {
    const hasher = new ApprovalRequestHasher();
    const legacyHash = createHash('sha256').update('user|server|tool|{}|1').digest('hex');

    expect(hasher.computeHash('user', 'server', 'tool', { value: null }, 1)).not.toBe(legacyHash);
  });
});
