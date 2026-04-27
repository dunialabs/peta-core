import { EventStore, StreamId, EventId, ReplayOptions, JSONRPCMessage, CachedEvent } from '../types/mcp.js';
import { EventRepository } from '../../repositories/EventRepository.js';
import { createLogger } from '../../logger/index.js';

/**
 * Persistent EventStore implementation
 * Supports in-memory cache and database persistent storage
 */
export class PersistentEventStore implements EventStore {
  private eventCache: Map<string, Map<string, CachedEvent>> = new Map();
  private readonly cacheSize: number = 1000; // Maximum number of cached events per stream
  private readonly eventRetentionDays: number = 7;
  private readonly maxCacheSize: number = 10000; // Total cache size limit
  
  // Logger for PersistentEventStore
  private logger = createLogger('PersistentEventStore', { sessionId: this.sessionId, userId: this.userId });

  constructor(
    private sessionId: string,
    private userId: string,
  ) {}

  /**
   * Store event
   * @param streamId ID of the stream the event belongs to
   * @param message JSON-RPC message to store
   * @returns Generated event ID
   */
  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    try {
      // Generate event ID
      const eventId = this.generateEventId(streamId);

      const eventEntity = {
        eventId,
        streamId,
        sessionId: this.sessionId,
        messageType: message.method ? message.method : 'response',
        messageData: JSON.stringify(message),
        expiresAt: new Date(Date.now() + this.eventRetentionDays * 24 * 60 * 60 * 1000)
    };

      // Persist before returning the event ID so SDK resumption can replay it.
      await this.persistToDatabase(eventEntity);

      // Store to in-memory cache after durable persistence succeeds.
      this.storeEventInCache(streamId, eventId, message);

      this.logger.debug({ eventId, streamId }, 'Event stored');
      return eventId;
    } catch (error) {
      this.logger.error({ error }, 'Failed to store event');
      throw error;
    }
  }

  /**
   * Resolve the stream that owns the specified event
   */
  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    const event = await EventRepository.findByEventIdForSession(eventId, this.sessionId);
    return event?.streamId;
  }

  /**
   * Replay events after specified event ID
   * @param lastEventId Last received event ID
   * @param options Replay options
   * @returns Stream ID
   */
  async replayEventsAfter(lastEventId: EventId, options: ReplayOptions): Promise<StreamId> {
    try {
      const anchorEvent = await EventRepository.findByEventIdForSession(lastEventId, this.sessionId);
      if (!anchorEvent) {
        throw new Error(`Invalid event ID: ${lastEventId}`);
      }

      const streamId = anchorEvent.streamId;

      this.logger.debug({ streamId, lastEventId }, 'Replaying events for stream after event');

      // Get events from database in durable insertion order for this session and stream.
      const sortedEvents = await EventRepository.findByStreamIdForSessionAfterId(
        this.sessionId,
        streamId,
        anchorEvent.id,
      );

      // Replay events
      for (const event of sortedEvents) {
        try {
          const message = JSON.parse(event.messageData) as JSONRPCMessage;
          await options.send(event.eventId, message);
          this.logger.debug({ eventId: event.eventId }, 'Replayed event');
        } catch (parseError) {
          this.logger.error({ error: parseError, eventId: event.eventId }, 'Failed to parse event');
          // Continue processing next event
        }
      }

      this.logger.info({ streamId, eventCount: sortedEvents.length }, 'Replayed events for stream');
      return streamId;
    } catch (error) {
      this.logger.error({ error }, 'Failed to replay events');
      throw error;
    }
  }

  /**
   * Get event from in-memory cache
   */
  getEventFromCache(streamId: string, eventId: string): CachedEvent | undefined {
    const streamCache = this.eventCache.get(streamId);
    return streamCache?.get(eventId);
  }

  /**
   * Get all events after specified event ID from in-memory cache
   */
  getEventsAfterFromCache(streamId: string, afterEventId: string): CachedEvent[] {
    const streamCache = this.eventCache.get(streamId);
    if (!streamCache) return [];

    const events: CachedEvent[] = [];
    let foundLastEvent = false;

    // Sort by event ID (event ID contains timestamp, so lexicographic sort is sufficient)
    const sortedEvents = Array.from(streamCache.values()).sort((a, b) => 
      a.eventId.localeCompare(b.eventId)
    );

    for (const event of sortedEvents) {
      if (event.eventId === afterEventId) {
        foundLastEvent = true;
        continue;
      }
      if (foundLastEvent) {
        events.push(event);
      }
    }

    return events;
  }

  /**
   * Clean up events for specified stream
   */
  cleanupStream(streamId: string): void {
    this.eventCache.delete(streamId);
    this.logger.debug({ streamId }, 'Cleaned up cache for stream');
  }

  /**
   * Clean up expired cached events
   */
  cleanupExpiredCache(): void {
    const now = new Date();
    let cleanedCount = 0;

    for (const [streamId, streamCache] of this.eventCache) {
      for (const [eventId, event] of streamCache) {
        if (event.timestamp < now) {
          streamCache.delete(eventId);
          cleanedCount++;
        }
      }
      
      // If stream cache is empty, delete the entire stream
      if (streamCache.size === 0) {
        this.eventCache.delete(streamId);
      }
    }

    if (cleanedCount > 0) {
      this.logger.info({ cleanedCount }, 'Cleaned up expired cached events');
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    totalStreams: number;
    totalEvents: number;
    memoryUsage: number;
  } {
    let totalEvents = 0;
    for (const streamCache of this.eventCache.values()) {
      totalEvents += streamCache.size;
    }

    return {
      totalStreams: this.eventCache.size,
      totalEvents,
      memoryUsage: this.estimateMemoryUsage()
    };
  }

  /**
   * Store event to in-memory cache
   */
  private storeEventInCache(streamId: string, eventId: string, message: JSONRPCMessage): void {
    // Ensure stream cache exists
    if (!this.eventCache.has(streamId)) {
      this.eventCache.set(streamId, new Map());
    }

    const streamCache = this.eventCache.get(streamId)!;

    // Check cache size limit
    if (streamCache.size >= this.cacheSize) {
      // Delete oldest event (sort by event ID, as it contains timestamp)
      const oldestEventId = Array.from(streamCache.keys()).sort()[0];
      streamCache.delete(oldestEventId);
      this.logger.debug({ oldestEventId, streamId }, 'Removed oldest event from stream cache');
    }

    // Store new event
    const cachedEvent: CachedEvent = {
      eventId,
      message,
      timestamp: new Date(),
      streamId
    };

    streamCache.set(eventId, cachedEvent);

    // Check total cache size
    this.enforceTotalCacheLimit();
  }

  /**
   * Enforce total cache size limit
   */
  private enforceTotalCacheLimit(): void {
    let totalEvents = 0;
    for (const streamCache of this.eventCache.values()) {
      totalEvents += streamCache.size;
    }

    if (totalEvents > this.maxCacheSize) {
      // Need to clean up cache, delete oldest events
      const allEvents: Array<{ streamId: string; eventId: string; timestamp: Date }> = [];
      
      for (const [streamId, streamCache] of this.eventCache) {
        for (const [eventId, event] of streamCache) {
          allEvents.push({ streamId, eventId, timestamp: event.timestamp });
        }
      }

      // Sort by timestamp, delete oldest events
      allEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      
      const eventsToRemove = totalEvents - this.maxCacheSize;
      for (let i = 0; i < eventsToRemove; i++) {
        const { streamId, eventId } = allEvents[i];
        const streamCache = this.eventCache.get(streamId);
        if (streamCache) {
          streamCache.delete(eventId);
          if (streamCache.size === 0) {
            this.eventCache.delete(streamId);
          }
        }
      }

      this.logger.debug({ eventsToRemove }, 'Cleaned up events to maintain cache size limit');
    }
  }

  /**
   * Generate event ID
   */
  private generateEventId(streamId: string): string {
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 10);
    return `${streamId}_${timestamp}_${randomStr}`;
  }

  /**
   * Persist event to database asynchronously
   */
  private async persistToDatabase(eventEntity: {eventId: string;
    streamId: string;
    sessionId: string;
    messageType: string;
    messageData: string;
    expiresAt: Date}): Promise<void> {
    await EventRepository.create({
      eventId: eventEntity.eventId,
      streamId: eventEntity.streamId,
      sessionId: eventEntity.sessionId,
      messageType: eventEntity.messageType,
      messageData: eventEntity.messageData,
      expiresAt: eventEntity.expiresAt
    });
  }

  /**
   * Estimate memory usage (rough estimate)
   */
  private estimateMemoryUsage(): number {
    let totalSize = 0;
    
    // Estimate Map overhead
    totalSize += this.eventCache.size * 64; // Rough overhead per Map
    
    for (const streamCache of this.eventCache.values()) {
      totalSize += streamCache.size * 128; // Rough overhead per event
    }
    
    return totalSize; // Return bytes
  }
}
