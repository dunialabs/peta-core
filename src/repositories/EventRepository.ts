/**
 * Event Repository - Direct database access using Prisma
 */

import { prisma } from '../config/prisma.js';
import { Event } from '@prisma/client';

export class EventRepository {
  /**
   * Save event to database
   */
  static async create(data: {
    eventId: string;
    streamId: string;
    sessionId: string;
    messageType: string;
    messageData: string;
    expiresAt?: Date;
  }): Promise<Event> {
    return await prisma.event.create({
      data: {
        eventId: data.eventId,
        streamId: data.streamId,
        sessionId: data.sessionId,
        messageType: data.messageType,
        messageData: data.messageData,
        createdAt: new Date(),
        expiresAt: data.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000), // Default 24 hour expiration
      },
    });
  }

  /**
   * Find event by event ID
   */
  static async findByEventId(eventId: string): Promise<Event | null> {
    return await prisma.event.findUnique({
      where: { eventId }
    });
  }

  static async findByEventIdForSession(eventId: string, sessionId: string): Promise<Event | null> {
    return await prisma.event.findFirst({
      where: { eventId, sessionId },
    });
  }

  /**
   * Find events by stream ID
   */
  static async findByStreamId(streamId: string, afterEventId?: string): Promise<Event[]> {
    if (!afterEventId) {
      return await prisma.event.findMany({
        where: { streamId },
        orderBy: { createdAt: 'asc' },
      });
    }

    // First find the event with specified eventId, get its creation time
    const afterEvent = await prisma.event.findUnique({
      where: { eventId: afterEventId },
      select: { createdAt: true }
    });

    if (!afterEvent) {
      // If specified event not found, return all events
      return await prisma.event.findMany({
        where: { streamId },
        orderBy: { createdAt: 'asc' },
      });
    }

    // Return all events created after the specified event
    return await prisma.event.findMany({
      where: {
        streamId,
        createdAt: { gt: afterEvent.createdAt },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  static async findByStreamIdForSessionAfterId(
    sessionId: string,
    streamId: string,
    afterId: number,
  ): Promise<Event[]> {
    return await prisma.event.findMany({
      where: {
        sessionId,
        streamId,
        id: { gt: afterId },
      },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * Find events by session ID
   */
  static async findBySessionId(sessionId: string): Promise<Event[]> {
    return await prisma.event.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Bulk save events
   */
  static async createMany(events: Array<{
    eventId: string;
    streamId: string;
    sessionId: string;
    messageType: string;
    messageData: string;
    expiresAt?: Date;
  }>): Promise<number> {
    const data = events.map(e => ({
      ...e,
      expiresAt: e.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000)
    }));

    const result = await prisma.event.createMany({ data });
    return result.count;
  }

  /**
   * Delete all events for specified stream
   */
  static async deleteByStreamId(streamId: string): Promise<number> {
    const result = await prisma.event.deleteMany({
      where: { streamId },
    });
    return result.count;
  }

  /**
   * Delete expired events
   */
  static async deleteExpired(): Promise<number> {
    const result = await prisma.event.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    return result.count;
  }

  /**
   * Delete events before specified date
   */
  static async deleteBefore(date: Date): Promise<number> {
    const result = await prisma.event.deleteMany({
      where: {
        createdAt: { lt: date },
      },
    });
    return result.count;
  }

  /**
   * Get event statistics
   */
  static async getStats(): Promise<{
    total: number;
    byStream: Record<string, number>;
    oldestEvent: Date | null;
    newestEvent: Date | null;
  }> {
    const [total, events, oldest, newest] = await Promise.all([
      prisma.event.count(),
      prisma.event.groupBy({
        by: ['streamId'],
        _count: { streamId: true },
      }),
      prisma.event.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true }
      }),
      prisma.event.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true }
      })
    ]);

    const byStream: Record<string, number> = {};
    events.forEach(e => {
      byStream[e.streamId] = e._count.streamId;
    });

    return {
      total,
      byStream,
      oldestEvent: oldest?.createdAt || null,
      newestEvent: newest?.createdAt || null,
    };
  }

  /**
   * Clear all events
   */
  static async deleteAll(): Promise<void> {
    await prisma.event.deleteMany({});
  }
}

// Export singleton (backward compatibility)
export const EventRepositoryInstance = EventRepository;
export default EventRepository;
