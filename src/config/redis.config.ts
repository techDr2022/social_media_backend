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
  // Priority 1: Use REDIS_PUBLIC_URL for local development (if REDIS_URL is internal)
  // This handles Railway internal URLs that aren't accessible locally
  const redisUrl = process.env.REDIS_URL;
  const redisPublicUrl = process.env.REDIS_PUBLIC_URL;
  const isRailwayInternal = redisUrl?.includes('railway.internal');
  const isLocalDev = process.env.NODE_ENV !== 'production' || !process.env.RAILWAY_ENVIRONMENT;

  // If we have a public URL and we're in local dev with an internal URL, use public
  if (isLocalDev && isRailwayInternal && redisPublicUrl) {
    return {
      url: redisPublicUrl,
    };
  }

  // Priority 2: Use REDIS_URL if provided (Railway/Cloud format)
  if (redisUrl) {
    return {
      url: redisUrl,
    };
  }

  // Priority 3: Use separate variables (local development)
  return {
    host: process.env.REDIS_HOST || process.env.REDISHOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || process.env.REDISPORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || process.env.REDISPASSWORD || undefined,
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
        maxRetriesPerRequest: null, // Required for BullMQ
        enableReadyCheck: false,
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
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,
    },
  };
}

















