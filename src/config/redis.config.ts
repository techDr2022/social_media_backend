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
  // Check if we're in local development (not production OR no Railway environment)
  const isLocalDev = process.env.NODE_ENV !== 'production' || !process.env.RAILWAY_ENVIRONMENT;

  console.log('[Redis Config] Environment check:', {
    hasRedisUrl: !!redisUrl,
    hasRedisPublicUrl: !!redisPublicUrl,
    isRailwayInternal,
    isLocalDev,
    nodeEnv: process.env.NODE_ENV,
    railwayEnv: process.env.RAILWAY_ENVIRONMENT,
  });

  // Priority 1: If we're in local dev AND REDIS_URL is internal AND we have a public URL, use public
  if (isLocalDev && isRailwayInternal && redisPublicUrl) {
    console.log('[Redis Config] ✅ Using REDIS_PUBLIC_URL for local development (internal URL detected)');
    return {
      url: redisPublicUrl,
    };
  }

  // Priority 2: Use REDIS_URL if provided (Railway/Cloud format)
  // BUT: If it's an internal URL and we're local, prefer public URL (redundant check for safety)
  if (redisUrl) {
    if (isLocalDev && isRailwayInternal && redisPublicUrl) {
      console.log('[Redis Config] ✅ Using REDIS_PUBLIC_URL (local dev with internal URL)');
      return { url: redisPublicUrl };
    }
    console.log('[Redis Config] Using REDIS_URL:', redisUrl.replace(/:[^:@]+@/, ':****@'));
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
 * Get Redis connection options for Bull (NestJS BullModule)
 *
 * NOTE: Despite the "BullMQ" name, this project currently uses `bull` v3
 * via `@nestjs/bull`, which expects a `redis` option (not `connection`).
 * We keep the function name for backwards compatibility, but the shape
 * is now correct for Bull v3.
 */
export function getBullMQRedisConfig() {
  const config = getRedisConfig();
  
  if (config.url) {
    // Use URL format (Railway/Cloud)
    console.log('[BullMQ Redis Config] Using URL format:', config.url.replace(/:[^:@]+@/, ':****@'));

    // Parse URL to extract components for Bull `redis` options
    try {
      const urlObj = new URL(config.url);
      const host = urlObj.hostname;
      const port = parseInt(urlObj.port || '6379', 10);
      const password = urlObj.password;
      
      console.log('[BullMQ Redis Config] Parsed connection details:', {
        host,
        port,
        hasPassword: !!password,
        protocol: urlObj.protocol,
      });
      
      return {
        redis: {
          host,
          port,
          password,
          // Important Bull/ioredis options:
          maxRetriesPerRequest: null, // Required to avoid MaxRetriesPerRequestError
          enableReadyCheck: false, // Don't wait for "ready" event (faster startup)
        },
      };
    } catch (parseError) {
      console.error('[BullMQ Redis Config] Error parsing URL, using URL directly:', parseError);
      // Fallback: let Bull handle the URL directly
      return {
        redis: config.url,
      };
    }
  }
  
  // Use host/port format (local)
  console.log('[BullMQ Redis Config] Using host/port format:', { host: config.host, port: config.port });
  return {
    redis: {
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    },
  };
}

















