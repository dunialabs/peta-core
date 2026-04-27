import { jest } from '@jest/globals';

const findByEventId = jest.fn();
const findByEventIdForSession = jest.fn();
const findByStreamId = jest.fn();
const findByStreamIdForSessionAfterId = jest.fn();
const createEvent = jest.fn();

jest.unstable_mockModule('../dist/repositories/EventRepository.js', () => ({
  EventRepository: {
    findByEventId,
    findByEventIdForSession,
    findByStreamId,
    findByStreamIdForSessionAfterId,
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
    findByEventIdForSession.mockReset();
    findByStreamId.mockReset();
    findByStreamIdForSessionAfterId.mockReset();
    createEvent.mockReset();
    createEvent.mockResolvedValue({ id: 1 });
  });

  test('getStreamIdForEventId returns persisted stream ids for UUID and standalone GET streams', async () => {
    findByEventIdForSession
      .mockResolvedValueOnce({ streamId: '123e4567-e89b-12d3-a456-426614174000' })
      .mockResolvedValueOnce({ streamId: '_GET_stream' });

    const store = new PersistentEventStore('session-1', 'user-1');

    await expect(store.getStreamIdForEventId('uuid-event')).resolves.toBe(
      '123e4567-e89b-12d3-a456-426614174000',
    );
    await expect(store.getStreamIdForEventId('get-event')).resolves.toBe('_GET_stream');
    expect(findByEventIdForSession).toHaveBeenNthCalledWith(1, 'uuid-event', 'session-1');
    expect(findByEventIdForSession).toHaveBeenNthCalledWith(2, 'get-event', 'session-1');
  });

  test('storeEvent waits for durable persistence before returning the event id', async () => {
    let resolveCreate;
    let completed = false;
    createEvent.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const store = new PersistentEventStore('session-1', 'user-1');
    const storePromise = store
      .storeEvent('stream-1', { jsonrpc: '2.0', method: 'notifications/test' })
      .then((eventId) => {
        completed = true;
        return eventId;
      });

    await Promise.resolve();
    expect(completed).toBe(false);

    resolveCreate({ id: 7 });
    await expect(storePromise).resolves.toMatch(/^stream-1_/);
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        streamId: 'stream-1',
      }),
    );
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
    findByEventIdForSession.mockResolvedValue({
      id: 42,
      eventId: lastEventId,
      streamId,
      createdAt: new Date('2026-04-22T10:00:00.000Z'),
    });
    findByStreamIdForSessionAfterId.mockResolvedValue([
      {
        eventId: `${streamId}_1710000001000_a`,
        messageData: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/a' }),
        createdAt: new Date('2026-04-22T10:00:01.000Z'),
      },
      {
        eventId: `${streamId}_1710000003000_b`,
        messageData: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/b' }),
        createdAt: new Date('2026-04-22T10:00:03.000Z'),
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
    expect(findByEventIdForSession).toHaveBeenCalledWith(lastEventId, 'session-1');
    expect(findByStreamIdForSessionAfterId).toHaveBeenCalledWith('session-1', streamId, 42);
    expect(sent.map((entry) => entry.eventId)).toEqual([
      `${streamId}_1710000001000_a`,
      `${streamId}_1710000003000_b`,
    ]);
  });

  test('replayEventsAfter rejects event IDs outside the current session', async () => {
    findByEventIdForSession.mockResolvedValue(null);
    const store = new PersistentEventStore('session-1', 'user-1');

    await expect(
      store.replayEventsAfter('other-session-event', {
        send: jest.fn(),
      }),
    ).rejects.toThrow('Invalid event ID: other-session-event');
    expect(findByStreamIdForSessionAfterId).not.toHaveBeenCalled();
  });
});
