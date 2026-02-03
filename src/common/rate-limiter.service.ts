import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { RedisConnectionService } from '../config/redis-connection.service';

interface RateLimitConfig {
  requests: number;
  window: number; // seconds
}

/**
 * Rate Limiter Service
 * 
 * Implements rate limiting per platform/user to prevent:
 * - Overwhelming external APIs
 * - Abuse and DoS attacks
 * - Cost overruns
 */
@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);

  // Platform-specific rate limits (requests per window)
  private readonly rateLimits: Record<string, RateLimitConfig> = {
    instagram: { requests: 25, window: 3600 }, // 25 per hour
    facebook: { requests: 50, window: 3600 }, // 50 per hour
    youtube: { requests: 10, window: 3600 }, // 10 per hour
    default: { requests: 10, window: 3600 }, // Default limit
  };

  constructor(private readonly redis: RedisConnectionService) {}

  /**
   * Check if request is allowed
   * Returns: { allowed: boolean, remaining: number, resetAt: Date }
   */
  async checkRateLimit(
    key: string,
    platform: string,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    const config =
      this.rateLimits[platform.toLowerCase()] || this.rateLimits.default;
    const redis = this.redis.getConnection();

    const redisKey = `rate-limit:${platform}:${key}`;
    const current = await redis.incr(redisKey);

    // Set expiration on first request
    if (current === 1) {
      await redis.expire(redisKey, config.window);
    }

    const ttl = await redis.ttl(redisKey);
    const resetAt = new Date(Date.now() + ttl * 1000);

    const allowed = current <= config.requests;
    const remaining = Math.max(0, config.requests - current);

    if (!allowed) {
      this.logger.warn(
        `Rate limit exceeded for ${platform}:${key} - ${current}/${config.requests} requests`,
      );
    }

    return {
      allowed,
      remaining,
      resetAt,
    };
  }

  /**
   * Throttle function execution
   * Throws error if rate limit exceeded
   */
  async throttle<T>(
    key: string,
    platform: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const limit = await this.checkRateLimit(key, platform);

    if (!limit.allowed) {
      throw new HttpException(
        {
          errorCode: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded for ${platform}. Try again after ${limit.resetAt.toISOString()}`,
          resetAt: limit.resetAt.toISOString(),
          remaining: limit.remaining,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return await fn();
  }

  /**
   * Get rate limit info without incrementing
   */
  async getRateLimitInfo(
    key: string,
    platform: string,
  ): Promise<{ remaining: number; resetAt: Date | null; limit: number }> {
    const config =
      this.rateLimits[platform.toLowerCase()] || this.rateLimits.default;
    const redis = this.redis.getConnection();
    const redisKey = `rate-limit:${platform}:${key}`;

    const current = parseInt((await redis.get(redisKey)) || '0', 10);
    const ttl = await redis.ttl(redisKey);

    return {
      remaining: Math.max(0, config.requests - current),
      resetAt: ttl > 0 ? new Date(Date.now() + ttl * 1000) : null,
      limit: config.requests,
    };
  }

  /**
   * Reset rate limit for a key (admin function)
   */
  async resetRateLimit(key: string, platform: string): Promise<void> {
    const redis = this.redis.getConnection();
    const redisKey = `rate-limit:${platform}:${key}`;
    await redis.del(redisKey);
    this.logger.log(`Reset rate limit for ${platform}:${key}`);
  }
}
