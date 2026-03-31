import { CacheSerializer } from '../dist/mcp/core/cache/CacheSerializer.js';

describe('CacheSerializer', () => {
  test('deserializes Uint8Array payloads from DB-backed cache reads', () => {
    const serializer = new CacheSerializer();
    const payload = {
      content: [{ type: 'text', text: 'ok' }],
    };
    const envelope = serializer.createEnvelope({
      operation: 'tool',
      serverId: 'server-1',
      entityId: 'gmailListMessages',
      scopeType: 'user',
      scopeHash: 'scope-hash',
      ttlSeconds: 30,
      admissionPolicy: 'immediate',
      admittedAfterObservations: 0,
      requestHash: 'request-hash',
      payload,
      payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    });

    const serialized = serializer.serialize(envelope, false, 4096);
    const parsed = serializer.deserialize(new Uint8Array(serialized));

    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      operation: 'tool',
      entityId: 'gmailListMessages',
      payload,
    });
  });
});
