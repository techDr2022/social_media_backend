import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import IORedis from 'ioredis';
import { getRedisConfig } from './redis.config';

/**
 * Enhanced Redis Connection Service
 * 
 * Provides Redis connection with:
 * - Connection event listeners
 * - Error handling
 * - Retry strategy
 * - Health monitoring
 */
@Injectable()
export class RedisConnectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisConnectionService.name);
  private connection: IORedis | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly healthCheckIntervalMs = 30000; // 30 seconds

  /**
   * Create Redis connection with enhanced monitoring
   */
  createConnection(): IORedis {
    const config = getRedisConfig();

    // ioredis accepts URL directly as first parameter or in options
    const connectionOptions: any = {
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        this.logger.warn(`Redis retry attempt ${times}, waiting ${delay}ms`);
        if (times > this.maxReconnectAttempts) {
          this.logger.error(`❌ Redis reconnection failed after ${this.maxReconnectAttempts} attempts`);
          return null; // Stop retrying
        }
        return delay;
      },
      reconnectOnError: (err) => {
        // Network errors that should trigger reconnection
        const networkErrors = [
          'ECONNRESET',
          'ECONNREFUSED',
          'ETIMEDOUT',
          'ENOTFOUND',
          'READONLY',
          'EPIPE',
          'ECONNABORTED',
        ];
        
        const errorMessage = err.message.toUpperCase();
        const shouldReconnect = networkErrors.some(error => errorMessage.includes(error));
        
        if (shouldReconnect) {
          this.logger.warn(`🔄 Redis will reconnect due to error: ${err.message}`);
          return true;
        }
        
        // Don't reconnect for application errors (e.g., wrong command, auth errors)
        this.logger.error(`❌ Redis error (no reconnect): ${err.message}`);
        return false;
      },
      // Add connection timeout
      connectTimeout: 10000, // 10 seconds
      lazyConnect: false, // Connect immediately
      // Command timeout to detect stalled connections
      commandTimeout: 5000, // 5 seconds timeout for commands
      family: 4, // Use IPv4
    };

    // If URL is provided, use it directly (ioredis supports URL format)
    // Otherwise use host/port format
    let connection: IORedis;
    
    if (config.url) {
      try {
        connection = new IORedis(config.url, connectionOptions);
        this.logger.log(`Connecting to Redis: ${config.url.replace(/:[^:@]+@/, ':****@')}`); // Hide password in logs
      } catch (error) {
        this.logger.error(`Failed to create Redis connection with URL: ${error}`);
        // Fallback to host/port if URL fails
        connection = new IORedis({
          host: config.host || 'localhost',
          port: config.port || 6379,
          password: config.password,
          db: config.db || 0,
          ...connectionOptions,
        });
      }
    } else {
      connection = new IORedis({
        host: config.host || 'localhost',
        port: config.port || 6379,
        password: config.password,
        db: config.db || 0,
        ...connectionOptions,
      });
    }

    // Connection event listeners
    connection.on('connect', () => {
      this.logger.log('✅ Redis connected successfully');
      this.reconnectAttempts = 0;
      // Start health check after successful connection
      this.startHealthCheck();
    });

    connection.on('ready', () => {
      this.logger.log('✅ Redis ready to accept commands');
    });


    connection.on('close', () => {
      this.logger.warn('⚠️ Redis connection closed');
    });

    connection.on('reconnecting', (delay) => {
      this.reconnectAttempts++;
      if (this.reconnectAttempts <= this.maxReconnectAttempts) {
        this.logger.log(`🔄 Redis reconnecting... (attempt ${this.reconnectAttempts}, delay: ${delay}ms)`);
      } else {
        this.logger.error(`❌ Redis reconnection failed after ${this.maxReconnectAttempts} attempts`);
      }
    });

    // Handle connection errors more gracefully
    connection.on('error', (err) => {
      // Don't log ECONNRESET as error if we're reconnecting (it's expected during network issues)
      if (err.message.includes('ECONNRESET') && this.reconnectAttempts > 0) {
        this.logger.warn(`⚠️ Redis connection reset (reconnecting...): ${err.message}`);
      } else {
        this.logger.error(`❌ Redis connection error: ${err.message}`, err.stack);
      }
    });

    connection.on('end', () => {
      this.logger.warn('⚠️ Redis connection ended');
    });

    // Monitor Redis commands (useful for debugging)
    if (process.env.REDIS_DEBUG === 'true') {
      connection.on('command', (command) => {
        this.logger.debug(`Redis command: ${command[0]} ${command.slice(1).join(' ')}`);
      });
    }

    this.connection = connection;
    return connection;
  }

  /**
   * Get Redis connection (creates if not exists)
   */
  getConnection(): IORedis {
    if (!this.connection) {
      return this.createConnection();
    }
    return this.connection;
  }

  /**
   * Check if Redis is connected
   */
  async isConnected(): Promise<boolean> {
    if (!this.connection) {
      return false;
    }

    try {
      const result = await this.connection.ping();
      return result === 'PONG';
    } catch (error) {
      return false;
    }
  }

  /**
   * Get Redis connection info
   */
  async getConnectionInfo(): Promise<any> {
    if (!this.connection) {
      return { connected: false };
    }

    try {
      const info = await this.connection.info('server');
      const ping = await this.connection.ping();
      return {
        connected: true,
        ping: ping === 'PONG',
        info: info.split('\r\n').slice(0, 10), // First 10 lines
      };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Start periodic health check to prevent idle disconnections
   */
  private startHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      if (this.connection) {
        try {
          await this.connection.ping();
          // Health check successful - connection is alive
        } catch (error) {
          this.logger.warn(`⚠️ Redis health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          // Connection will be handled by error event listeners
        }
      }
    }, this.healthCheckIntervalMs);
  }

  /**
   * Stop health check
   */
  private stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Initialize connection on module init
   */
  async onModuleInit() {
    this.logger.log('Initializing Redis connection...');
    this.createConnection();
  }

  /**
   * Close connection on module destroy
   */
  async onModuleDestroy() {
    this.stopHealthCheck();
    if (this.connection) {
      this.logger.log('Closing Redis connection...');
      try {
        await this.connection.quit();
      } catch (error) {
        this.logger.warn(`Error closing Redis connection: ${error instanceof Error ? error.message : 'Unknown error'}`);
        // Force disconnect if quit fails
        this.connection.disconnect();
      }
      this.connection = null;
    }
  }
}
