import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Database Transaction Service
 * 
 * Provides safe transaction management with:
 * - Automatic rollback on error
 * - Retry on deadlock/conflict
 * - Timeout protection
 */
@Injectable()
export class DatabaseTransactionService {
  private readonly logger = new Logger(DatabaseTransactionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Execute operations in a transaction
   * Automatically rolls back on error
   */
  async executeInTransaction<T>(
    callback: (tx: PrismaService) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          return await callback(tx as PrismaService);
        },
        {
          maxWait: 5000, // Max time to wait for transaction (5 seconds)
          timeout: 10000, // Max time transaction can run (10 seconds)
        },
      );
    } catch (error: any) {
      this.logger.error('Transaction failed:', error.message);
      throw error;
    }
  }

  /**
   * Execute with retry on deadlock/conflict
   */
  async executeWithRetry<T>(
    callback: (tx: PrismaService) => Promise<T>,
    maxRetries = 3,
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.executeInTransaction(callback);
      } catch (error: any) {
        // Check if it's a retryable error
        const isRetryable =
          error.code === 'P2034' || // Transaction conflict
          error.code === '40P01' || // Deadlock detected
          error.code === 'P1008'; // Operations timed out

        if (!isRetryable || attempt === maxRetries) {
          throw error;
        }

        // Wait before retry (exponential backoff)
        const delay = Math.pow(2, attempt) * 100; // 200ms, 400ms, 800ms
        this.logger.warn(
          `Transaction conflict detected, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('Transaction failed after retries');
  }
}
