import { Logger } from '@nestjs/common';

/**
 * Enhanced Logger Service
 * 
 * Provides enhanced logging with context and structured data:
 * - Context-aware logging
 * - Structured data logging
 * - Performance tracking
 */
export class EnhancedLogger extends Logger {
  /**
   * Log with context and optional data
   */
  logWithContext(context: string, message: string, data?: any) {
    const logMessage = `[${context}] ${message}`;
    if (data) {
      this.log(logMessage, JSON.stringify(data, null, 2));
    } else {
      this.log(logMessage);
    }
  }

  /**
   * Error with context and optional error object
   */
  errorWithContext(context: string, message: string, error?: any) {
    const logMessage = `[${context}] ${message}`;
    if (error) {
      const errorDetails = {
        message: error.message,
        stack: error.stack,
        ...(error.response && {
          status: error.response.status,
          data: error.response.data,
        }),
      };
      this.error(logMessage, JSON.stringify(errorDetails, null, 2));
    } else {
      this.error(logMessage);
    }
  }

  /**
   * Warn with context
   */
  warnWithContext(context: string, message: string, data?: any) {
    const logMessage = `[${context}] ${message}`;
    if (data) {
      this.warn(logMessage, JSON.stringify(data, null, 2));
    } else {
      this.warn(logMessage);
    }
  }

  /**
   * Debug with context
   */
  debugWithContext(context: string, message: string, data?: any) {
    const logMessage = `[${context}] ${message}`;
    if (data) {
      this.debug(logMessage, JSON.stringify(data, null, 2));
    } else {
      this.debug(logMessage);
    }
  }

  /**
   * Log performance metrics
   */
  logPerformance(
    context: string,
    operation: string,
    durationMs: number,
    metadata?: any,
  ) {
    const logMessage = `[${context}] ${operation} completed in ${durationMs}ms`;
    if (metadata) {
      this.log(logMessage, JSON.stringify(metadata, null, 2));
    } else {
      this.log(logMessage);
    }
  }

  /**
   * Log API call
   */
  logApiCall(
    method: string,
    url: string,
    statusCode: number,
    durationMs: number,
    error?: any,
  ) {
    const context = 'API_CALL';
    const message = `${method} ${url} - ${statusCode} (${durationMs}ms)`;

    if (error) {
      this.errorWithContext(context, message, error);
    } else if (statusCode >= 400) {
      this.warnWithContext(context, message);
    } else {
      this.logWithContext(context, message);
    }
  }

  /**
   * Log database operation
   */
  logDatabaseOperation(
    operation: string,
    table: string,
    durationMs: number,
    recordCount?: number,
  ) {
    const context = 'DATABASE';
    const message = `${operation} on ${table}${recordCount ? ` (${recordCount} records)` : ''} - ${durationMs}ms`;
    this.logWithContext(context, message);
  }

  /**
   * Log queue operation
   */
  logQueueOperation(
    operation: string,
    queueName: string,
    jobId?: string,
    metadata?: any,
  ) {
    const context = 'QUEUE';
    const message = `${operation} on ${queueName}${jobId ? ` (job: ${jobId})` : ''}`;
    this.logWithContext(context, message, metadata);
  }
}
