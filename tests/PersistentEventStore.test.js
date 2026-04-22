import { jest } from '@jest/globals';

const findByEventId = jest.fn();
const findByStreamId = jest.fn();
const createEvent = jest.fn();

jest.unstable_mockModule('../dist/repositories/EventRepository.js', () => ({
  EventRepository: {
    findByEventId,
    findByStreamId,
    create: createEvent,
  },
}));

jest.unstable_mockModule('../dist/log/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      enqueueLog: jest.fn(),
    }),
  },
}));

jest.unstable_mockModule('../dist/logger/index.js', () => ({
  createLogger: () => ({
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  }),
}));

const { PersistentEventStore } = await import('../dist/mcp/core/PersistentEventStore.js');

describe('PersistentEventStore resumability', () => {
  beforeEach(() => {
    findByEventId.mockReset();
    findByStreamId.mockReset();
    createEvent.mockReset();
  });

  test('getStreamIdForEventId returns persisted stream ids for UUID and standalone GET streams', async () => {
    findByEventId
      .mockResolvedValueOnce({ streamId: '123e4567-e89b-12d3-a456-426614174000' })
      .mockResolvedValueOnce({ streamId: '_GET_stream' });

    const store = new PersistentEventStore('session-1', 'user-1');

    await expect(store.getStreamIdForEventId('uuid-event')).resolves.toBe(
      '123e4567-e89b-12d3-a456-426614174000',
    );
    await expect(store.getStreamIdForEventId('get-event')).resolves.toBe('_GET_stream');
  });

  test.each([
    {
      caseName: 'uuid stream ids',
      lastEventId: '123e4567-e89b-12d3-a456-426614174000_1710000000000_anchor',
      streamId: '123e4567-e89b-12d3-a456-426614174000',
    },
    {
      caseName: 'standalone GET stream ids',
      lastEventId: '_GET_stream_1710000000000_anchor',
      streamId: '_GET_stream',
    },
  ])('replayEventsAfter uses the persisted stream for $caseName', async ({ lastEventId, streamId }) => {
    findByEventId.mockResolvedValue({
      eventId: lastEventId,
      streamId,
      createdAt: new Date('2026-04-22T10:00:00.000Z'),
    });
    findByStreamId.mockResolvedValue([
      {
        eventId: `${streamId}_1710000003000_b`,
        messageData: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/b' }),
        createdAt: new Date('2026-04-22T10:00:03.000Z'),
      },
      {
        eventId: `${streamId}_1710000001000_a`,
        messageData: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/a' }),
        createdAt: new Date('2026-04-22T10:00:01.000Z'),
      },
    ]);

    const sent = [];
    const store = new PersistentEventStore('session-1', 'user-1');

    const replayedStreamId = await store.replayEventsAfter(lastEventId, {
      send: async (eventId, message) => {
        sent.push({ eventId, message });
      },
    });

    expect(replayedStreamId).toBe(streamId);
    expect(findByEventId).toHaveBeenCalledWith(lastEventId);
    expect(findByStreamId).toHaveBeenCalledWith(streamId, lastEventId);
    expect(sent.map((entry) => entry.eventId)).toEqual([
      `${streamId}_1710000001000_a`,
      `${streamId}_1710000003000_b`,
    ]);
  });
});
