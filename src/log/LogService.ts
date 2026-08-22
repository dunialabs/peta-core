import { LogRepository } from '../repositories/LogRepository.js';
import { LogEntry } from '../repositories/LogRepository.js';
import { MCPEventLogType } from '../types/enums.js';
import { DisconnectReason } from '../types/auth.types.js';
import { createLogger } from '../logger/index.js';
import { redactError, redactStructuredField } from '../utils/logRedaction.js';

/**
 * Async Log Service with Batch Queue
 */
export class LogService {
  private static instance: LogService = new LogService();
  private logQueue: LogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 100;
  private readonly FLUSH_INTERVAL = 5000; // 5 seconds
  private isShuttingDown = false;
  
  // Logger for LogService
  private logger = createLogger('LogService');

  private constructor() {
    // Start flush timer
    this.startFlushTimer();
  }

  static getInstance(): LogService {
    return LogService.instance;
  }

  /**
   * Generate uniformRequestId
   * Format: ${sessionId}_${timestamp}_${random4}
   */
  generateUniformRequestId(sessionId: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6);
    return `${sessionId}_${timestamp}_${random}`;
  }

  /**
   * Extract key fields from request/response for logging
   */
  private extractKeyFields(data: any): string {
    if (!data) return '';

    const extracted: any = {};

    if (data.method) extracted.method = data.method;
    if (data.params) {
      if (data.params.name) extracted.name = data.params.name;
      if (data.params.uri) extracted.uri = data.params.uri;
      if (data.params.arguments) {
        // Summarize arguments (not full content)
        extracted.arguments = Object.keys(data.params.arguments);
      }
      if (data.params._meta) extracted._meta = data.params._meta;
    }
    if (data.content) {
      extracted.contentCount = Array.isArray(data.content) ? data.content.length : 1;
    }
    if (data.isError !== undefined) extracted.isError = data.isError;
    if (data.result) extracted.hasResult = true;
    if (data.error) {
      extracted.error = {
        code: data.error.code,
        message: data.error.message
      };
    }

    return JSON.stringify(extracted);
  }

  /**
   * Add log to queue
   */
  private async enqueue(entry: LogEntry): Promise<void> {
    if (this.isShuttingDown) {
      // If shutting down, write immediately
      try {
        await LogRepository.save(entry);
      } catch (error) {
        this.logger.error({ error }, 'Failed to save log during shutdown');
      }
      return;
    }

    this.logQueue.push(entry);

    // Flush if batch size reached
    if (this.logQueue.length >= this.BATCH_SIZE) {
      await this.flush();
    }
  }

  /**
   * Flush queue to database
   */
  private async flush(): Promise<void> {
    if (this.logQueue.length === 0) return;

    const batch = [...this.logQueue];
    this.logQueue = [];

    try {
      // Write to database in parallel (Promise.all)
      await Promise.all(
        batch.map(entry => LogRepository.save(entry))
      );
      this.logger.debug({ count: batch.length }, 'Flushed logs');
    } catch (error) {
      this.logger.error({ error }, 'Failed to flush logs');
      // Re-queue failed logs
      this.logQueue.unshift(...batch);
    }
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(err => this.logger.error({ error: err }, 'Timer flush error'));
    }, this.FLUSH_INTERVAL);
  }

  /**
   * Stop flush timer (for graceful shutdown)
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();
    this.logger.info('Shutdown complete');
  }

  /**
   * Enqueue a log entry to the batch queue
   * This is the main method for logging all event types
   */
  async enqueueLog(entry: LogEntry): Promise<void> {
    await this.enqueue({
      ...entry,
      requestParams: redactStructuredField(entry.requestParams),
      responseResult: redactStructuredField(entry.responseResult),
      error: entry.error === undefined ? undefined : redactError(entry.error),
    });
  }
}
