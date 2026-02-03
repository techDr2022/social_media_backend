import { Injectable, Logger } from '@nestjs/common';
import { RedisConnectionService } from '../config/redis-connection.service';

interface CircuitState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  lastFailure: Date | null;
  nextAttempt: Date | null;
  successCount: number; // For half-open state
}

/**
 * Circuit Breaker Service
 * 
 * Prevents cascading failures by:
 * - Opening circuit after failure threshold
 * - Blocking requests when circuit is open
 * - Testing with half-open state
 * - Auto-recovering when service is healthy
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly FAILURE_THRESHOLD = 5; // Open circuit after 5 failures
  private readonly TIMEOUT = 60000; // Keep open for 1 minute
  private readonly HALF_OPEN_SUCCESS_THRESHOLD = 2; // Need 2 successes to close

  constructor(private readonly redis: RedisConnectionService) {}

  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(
    serviceName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const state = await this.getState(serviceName);

    // Check if circuit is open
    if (state.state === 'OPEN') {
      if (state.nextAttempt && new Date() < state.nextAttempt) {
        const waitTime = Math.ceil(
          (state.nextAttempt.getTime() - Date.now()) / 1000,
        );
        throw new Error(
          `Circuit breaker OPEN for ${serviceName}. Service unavailable. Try again in ${waitTime}s`,
        );
      }
      // Try half-open
      state.state = 'HALF_OPEN';
      state.successCount = 0;
      await this.setState(serviceName, state);
      this.logger.log(`Circuit breaker HALF_OPEN for ${serviceName}`);
    }

    try {
      const result = await fn();

      // Success - update circuit state
      if (state.state === 'HALF_OPEN') {
        state.successCount = (state.successCount || 0) + 1;
        if (state.successCount >= this.HALF_OPEN_SUCCESS_THRESHOLD) {
          state.state = 'CLOSED';
          state.failures = 0;
          state.successCount = 0;
          await this.setState(serviceName, state);
          this.logger.log(`Circuit breaker CLOSED for ${serviceName}`);
        } else {
          await this.setState(serviceName, state);
        }
      } else if (state.state === 'CLOSED' && state.failures > 0) {
        // Reset failures on success
        state.failures = 0;
        await this.setState(serviceName, state);
      }

      return result;
    } catch (error) {
      state.failures = (state.failures || 0) + 1;
      state.lastFailure = new Date();

      // Open circuit if threshold exceeded
      if (state.failures >= this.FAILURE_THRESHOLD) {
        state.state = 'OPEN';
        state.nextAttempt = new Date(Date.now() + this.TIMEOUT);
        await this.setState(serviceName, state);
        this.logger.error(
          `Circuit breaker OPENED for ${serviceName} after ${state.failures} failures`,
        );
      } else {
        await this.setState(serviceName, state);
      }

      throw error;
    }
  }

  /**
   * Get current circuit state
   */
  async getState(serviceName: string): Promise<CircuitState> {
    const redis = this.redis.getConnection();
    const key = `circuit-breaker:${serviceName}`;
    const data = await redis.get(key);

    if (data) {
      const state = JSON.parse(data);
      // Convert date strings back to Date objects
      return {
        ...state,
        lastFailure: state.lastFailure ? new Date(state.lastFailure) : null,
        nextAttempt: state.nextAttempt ? new Date(state.nextAttempt) : null,
      };
    }

    return {
      state: 'CLOSED',
      failures: 0,
      lastFailure: null,
      nextAttempt: null,
      successCount: 0,
    };
  }

  /**
   * Set circuit state
   */
  private async setState(
    serviceName: string,
    state: CircuitState,
  ): Promise<void> {
    const redis = this.redis.getConnection();
    const key = `circuit-breaker:${serviceName}`;
    await redis.setex(key, 3600, JSON.stringify(state)); // 1 hour TTL
  }

  /**
   * Manually reset circuit (admin function)
   */
  async reset(serviceName: string): Promise<void> {
    const redis = this.redis.getConnection();
    const key = `circuit-breaker:${serviceName}`;
    await redis.del(key);
    this.logger.log(`Circuit breaker reset for ${serviceName}`);
  }

  /**
   * Get circuit breaker statistics
   */
  async getStats(serviceName: string): Promise<CircuitState> {
    return await this.getState(serviceName);
  }
}
