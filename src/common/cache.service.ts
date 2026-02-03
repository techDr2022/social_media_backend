import { Injectable, Logger } from '@nestjs/common';
import { RedisConnectionService } from '../config/redis-connection.service';

/**
 * Cache Service
 * 
 * Provides Redis-based caching with:
 * - TTL support
 * - Get-or-set pattern
 * - Cache invalidation
 * - Graceful degradation (returns null on error, doesn't crash)
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly DEFAULT_TTL = 3600; // 1 hour

  constructor(private readonly redis: RedisConnectionService) {}

  /**
   * Get cached value
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const redis = this.redis.getConnection();
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.error(`Cache get error for key ${key}:`, error);
      return null; // Fail gracefully - return null instead of crashing
    }
  }

  /**
   * Set cached value
   */
  async set(key: string, value: any, ttl = this.DEFAULT_TTL): Promise<void> {
    try {
      const redis = this.redis.getConnection();
      await redis.setex(key, ttl, JSON.stringify(value));
    } catch (error) {
      this.logger.error(`Cache set error for key ${key}:`, error);
      // Don't throw - caching is not critical
    }
  }

  /**
   * Delete cached value
   */
  async delete(key: string): Promise<void> {
    try {
      const redis = this.redis.getConnection();
      await redis.del(key);
    } catch (error) {
      this.logger.error(`Cache delete error for key ${key}:`, error);
    }
  }

  /**
   * Get or set pattern (most common use case)
   */
  async getOrSet<T>(
    key: string,
    fn: () => Promise<T>,
    ttl = this.DEFAULT_TTL,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    const value = await fn();
    await this.set(key, value, ttl);
    return value;
  }

  /**
   * Invalidate cache pattern (e.g., all user:* keys)
   */
  async invalidatePattern(pattern: string): Promise<number> {
    try {
      const redis = this.redis.getConnection();
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        return await redis.del(...keys);
      }
      return 0;
    } catch (error) {
      this.logger.error(
        `Cache invalidate error for pattern ${pattern}:`,
        error,
      );
      return 0;
    }
  }

  /**
   * Get multiple cached values
   */
  async mget<T>(keys: string[]): Promise<(T | null)[]> {
    try {
      const redis = this.redis.getConnection();
      const values = await redis.mget(...keys);
      return values.map((v) => (v ? JSON.parse(v) : null));
    } catch (error) {
      this.logger.error(`Cache mget error:`, error);
      return keys.map(() => null);
    }
  }

  /**
   * Set multiple cached values
   */
  async mset(
    entries: Array<{ key: string; value: any; ttl?: number }>,
  ): Promise<void> {
    try {
      const redis = this.redis.getConnection();
      const pipeline = redis.pipeline();

      for (const entry of entries) {
        pipeline.setex(
          entry.key,
          entry.ttl || this.DEFAULT_TTL,
          JSON.stringify(entry.value),
        );
      }

      await pipeline.exec();
    } catch (error) {
      this.logger.error(`Cache mset error:`, error);
    }
  }

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      const redis = this.redis.getConnection();
      const result = await redis.exists(key);
      return Boolean(result);
    } catch (error) {
      this.logger.error(`Cache exists error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Get TTL for a key
   */
  async getTTL(key: string): Promise<number> {
    try {
      const redis = this.redis.getConnection();
      return await redis.ttl(key);
    } catch (error) {
      this.logger.error(`Cache TTL error for key ${key}:`, error);
      return -1;
    }
  }
}
