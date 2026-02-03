import { Injectable, Logger } from '@nestjs/common';
import { RedisConnectionService } from '../../config/redis-connection.service';

/**
 * Job Tracker Service
 * 
 * Tracks processed jobs in Redis to prevent duplicate processing:
 * - Mark jobs as processed
 * - Check if job was processed
 * - Get processing statistics
 */
@Injectable()
export class JobTrackerService {
  private readonly logger = new Logger(JobTrackerService.name);
  private readonly PROCESSED_JOBS_KEY = 'scheduled-posts:processed';
  private readonly PROCESSED_JOBS_TTL = 60 * 60 * 24 * 7; // 7 days in seconds

  constructor(private readonly redisConnection: RedisConnectionService) {}

  /**
   * Get Redis connection
   */
  private getRedis() {
    return this.redisConnection.getConnection();
  }

  /**
   * Mark a post job as processed
   */
  async markAsProcessed(postId: string): Promise<void> {
    try {
      const redis = this.getRedis();
      await redis.sadd(this.PROCESSED_JOBS_KEY, postId);
      await redis.expire(this.PROCESSED_JOBS_KEY, this.PROCESSED_JOBS_TTL);
      this.logger.debug(`Marked post ${postId} as processed`);
    } catch (error) {
      this.logger.error(`Failed to mark post ${postId} as processed:`, error);
      throw error;
    }
  }

  /**
   * Check if a post job has been processed
   */
  async isProcessed(postId: string): Promise<boolean> {
    try {
      const redis = this.getRedis();
      const result = await redis.sismember(this.PROCESSED_JOBS_KEY, postId);
      return Boolean(result);
    } catch (error) {
      this.logger.error(`Failed to check if post ${postId} is processed:`, error);
      return false;
    }
  }

  /**
   * Remove a post from processed list (allows reprocessing)
   */
  async unmarkAsProcessed(postId: string): Promise<void> {
    try {
      const redis = this.getRedis();
      await redis.srem(this.PROCESSED_JOBS_KEY, postId);
      this.logger.debug(`Unmarked post ${postId} from processed list`);
    } catch (error) {
      this.logger.error(`Failed to unmark post ${postId}:`, error);
      throw error;
    }
  }

  /**
   * Mark multiple posts as processed
   */
  async markMultipleAsProcessed(postIds: string[]): Promise<number> {
    if (postIds.length === 0) {
      return 0;
    }

    try {
      const redis = this.getRedis();
      const added = await redis.sadd(this.PROCESSED_JOBS_KEY, ...postIds);
      await redis.expire(this.PROCESSED_JOBS_KEY, this.PROCESSED_JOBS_TTL);
      this.logger.debug(`Marked ${added} posts as processed`);
      return added;
    } catch (error) {
      this.logger.error('Failed to mark multiple posts as processed:', error);
      return 0;
    }
  }

  /**
   * Get count of processed jobs
   */
  async getProcessedCount(): Promise<number> {
    try {
      const redis = this.getRedis();
      return await redis.scard(this.PROCESSED_JOBS_KEY);
    } catch (error) {
      this.logger.error('Failed to get processed count:', error);
      return 0;
    }
  }

  /**
   * Get all processed post IDs
   */
  async getAllProcessed(): Promise<string[]> {
    try {
      const redis = this.getRedis();
      return await redis.smembers(this.PROCESSED_JOBS_KEY);
    } catch (error) {
      this.logger.error('Failed to get all processed posts:', error);
      return [];
    }
  }

  /**
   * Clear all processed jobs (use with caution)
   */
  async clearAllProcessed(): Promise<void> {
    try {
      const redis = this.getRedis();
      await redis.del(this.PROCESSED_JOBS_KEY);
      this.logger.warn('⚠️ Cleared all processed jobs');
    } catch (error) {
      this.logger.error('Failed to clear processed jobs:', error);
      throw error;
    }
  }

  /**
   * Get processing statistics
   */
  async getStats(): Promise<{
    processedCount: number;
    keyExists: boolean;
    ttl: number;
  }> {
    try {
      const redis = this.getRedis();
      const [count, exists, ttl] = await Promise.all([
        redis.scard(this.PROCESSED_JOBS_KEY),
        redis.exists(this.PROCESSED_JOBS_KEY),
        redis.ttl(this.PROCESSED_JOBS_KEY),
      ]);

      return {
        processedCount: count,
        keyExists: Boolean(exists),
        ttl: ttl > 0 ? ttl : -1, // -1 means no expiration
      };
    } catch (error) {
      this.logger.error('Failed to get job tracker stats:', error);
      return {
        processedCount: 0,
        keyExists: false,
        ttl: -1,
      };
    }
  }
}
