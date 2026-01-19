import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  level: LogLevel;
  service: string;
  message: string;
  method?: string; // HTTP method: GET, POST, PUT, DELETE, etc.
  path?: string; // Request path/endpoint
  ipAddress?: string; // Client IP address
  userAgent?: string; // User agent/browser info
  screenSize?: string; // Screen size if available (widthxheight)
  requestData?: any; // Request body/data
  responseData?: any; // Response data
  statusCode?: number; // HTTP status code
  responseTime?: number; // Response time in milliseconds
  details?: any;
  userId?: string;
  accountId?: string;
  errorStack?: string;
}

interface BufferedLogEntry {
  level: string;
  service: string;
  message: string;
  method?: string | null;
  path?: string | null;
  ipaddress?: string | null;
  useragent?: string | null;
  screensize?: string | null;
  requestdata?: string | null;
  responsedata?: string | null;
  statuscode?: number | null;
  responsetime?: number | null;
  details?: string | null;
  userid?: string | null;
  accountid?: string | null;
  errorstack?: string | null;
}

@Injectable()
export class LogsService implements OnModuleDestroy {
  private readonly logger = new Logger(LogsService.name);
  private readonly buffer: BufferedLogEntry[] = [];
  private readonly bufferSize = 100; // Flush when buffer reaches this size (increased for better performance)
  private readonly flushInterval = 5000; // Flush every 5 seconds (increased to reduce DB writes)
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  constructor(private readonly prisma: PrismaService) {
    // Start periodic flush timer
    this.startFlushTimer();
  }

  /**
   * Log an entry - adds to buffer, doesn't write to DB immediately
   * This is extremely fast (just pushes to array) - no await needed!
   */
  log(entry: LogEntry): void {
    // Synchronous function - no async overhead!
    try {
      // Convert entry to database format (only what we need)
      const dbEntry: BufferedLogEntry = {
        level: entry.level,
        service: entry.service,
        message: entry.message.substring(0, 1000), // Limit message length for performance
        method: entry.method || null,
        path: entry.path || null,
        ipaddress: entry.ipAddress || null,
        useragent: entry.userAgent ? entry.userAgent.substring(0, 500) : null, // Limit length
        screensize: entry.screenSize || null,
        requestdata: entry.requestData ? this.safeStringify(entry.requestData, 5000) : null, // Limit size
        responsedata: entry.responseData ? this.safeStringify(entry.responseData, 5000) : null, // Limit size
        statuscode: entry.statusCode || null,
        responsetime: entry.responseTime || null,
        details: entry.details ? this.safeStringify(entry.details, 2000) : null, // Limit size
        userid: entry.userId || null,
        accountid: entry.accountId || null,
        errorstack: entry.errorStack ? entry.errorStack.substring(0, 5000) : null, // Limit stack trace
      };

      // Add to buffer (super fast - just array push, no async overhead!)
      this.buffer.push(dbEntry);

      // Flush if buffer is full (fire and forget)
      if (this.buffer.length >= this.bufferSize) {
        // Use setImmediate to avoid blocking
        setImmediate(() => {
          this.flushBuffer().catch((error) => {
            this.logger.error(`Error flushing log buffer: ${error.message}`);
          });
        });
      }
    } catch (error: any) {
      // If buffer push fails (shouldn't happen), just log to console
      this.logger.error(`Error adding log to buffer: ${error.message}`);
    }
  }

  /**
   * Safe JSON stringify with size limit
   */
  private safeStringify(obj: any, maxSize: number): string | null {
    try {
      const str = JSON.stringify(obj);
      if (str.length > maxSize) {
        return str.substring(0, maxSize) + '... (truncated)';
      }
      return str;
    } catch (error) {
      return null;
    }
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0 && !this.isFlushing) {
        this.flushBuffer().catch((error) => {
          this.logger.error(`Error in periodic flush: ${error.message}`);
        });
      }
    }, this.flushInterval);
  }

  /**
   * Flush buffer to database (batched write)
   * This writes all buffered logs in a single database transaction
   */
  private async flushBuffer(): Promise<void> {
    if (this.isFlushing || this.buffer.length === 0) {
      return;
    }

    this.isFlushing = true;
    const logsToFlush = [...this.buffer]; // Copy buffer
    this.buffer.length = 0; // Clear buffer

    try {
      // Batch insert all logs at once (much faster than individual inserts)
      await this.prisma.log.createMany({
        data: logsToFlush,
        skipDuplicates: true, // Skip if there are any duplicates (shouldn't happen)
      });

      // Don't log flush - too verbose, logs are in database anyway
    } catch (error: any) {
      // If batch insert fails, try to save logs back to buffer (but limit to prevent memory leak)
      if (this.buffer.length < 1000) {
        this.buffer.unshift(...logsToFlush); // Put them back at the front
      }
      // Only log error message, not the full error object (which might contain buffer data)
      this.logger.error(`Error flushing ${logsToFlush.length} logs to database: ${error.message}`);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Force flush buffer (useful for shutdown)
   */
  async forceFlush(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushBuffer();
  }

  /**
   * Cleanup on module destroy - flush remaining logs
   */
  async onModuleDestroy(): Promise<void> {
    await this.forceFlush();
  }

  /**
   * Convenience methods for different log levels
   * These are synchronous (no await needed) - super fast!
   */
  info(service: string, message: string, details?: any, userId?: string, accountId?: string): void {
    this.log({ level: 'info', service, message, details, userId, accountId });
  }

  warn(service: string, message: string, details?: any, userId?: string, accountId?: string): void {
    this.log({ level: 'warn', service, message, details, userId, accountId });
  }

  error(
    service: string,
    message: string,
    error?: Error | any,
    details?: any,
    userId?: string,
    accountId?: string,
  ): void {
    const errorStack = error?.stack || (error instanceof Error ? error.stack : String(error));
    const errorDetails = details || (error?.response?.data ? { apiError: error.response.data } : undefined);
    this.log({
      level: 'error',
      service,
      message,
      errorStack,
      details: errorDetails,
      userId,
      accountId,
    });
  }

  debug(service: string, message: string, details?: any, userId?: string, accountId?: string): void {
    this.log({ level: 'debug', service, message, details, userId, accountId });
  }
}
