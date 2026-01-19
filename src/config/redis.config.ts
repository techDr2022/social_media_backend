/**
 * Redis Configuration
 * 
 * Supports multiple Redis connection formats:
 * 1. REDIS_URL (single connection string) - Recommended for Railway/Cloud
 * 2. REDIS_HOST + REDIS_PORT + REDIS_PASSWORD - For separate variables
 */

export interface RedisConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
}

export function getRedisConfig(): RedisConfig {
  // Priority 1: Use REDIS_URL if provided (Railway/Cloud format)
  if (process.env.REDIS_URL) {
    return {
      url: process.env.REDIS_URL,
    };
  }

  // Priority 2: Use separate variables (local development)
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
  };
}

/**
 * Get Redis connection options for BullMQ
 */
export function getBullMQRedisConfig() {
  const config = getRedisConfig();
  
  if (config.url) {
    // Use URL format (Railway/Cloud)
    return {
      connection: {
        url: config.url,
      },
    };
  }
  
  // Use host/port format (local)
  return {
    connection: {
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
    },
  };
}









