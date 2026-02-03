import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private pool: Pool;
  private poolStatsInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Create pool and adapter before calling super()
    // Optimized connection pool
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.DB_POOL_MAX || '20', 10), // Maximum pool size
      min: parseInt(process.env.DB_POOL_MIN || '5', 10), // Minimum pool size
      idleTimeoutMillis: 30000, // Close idle connections after 30s
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000', 10), // Wait 10s for connection (increased from 2s)
      statement_timeout: 30000, // 30s query timeout
      query_timeout: 30000,
      application_name: 'social-media-api',
      // Retry connection on failure
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    const adapter = new PrismaPg(pool);

    // Prisma 7: we must pass adapter - super() must be called first
    super({ adapter });

    // Now we can assign to this.pool after super()
    this.pool = pool;

    // Log pool errors
    this.pool.on('error', (err) => {
      this.logger.error('Database pool error:', err);
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('✅ Database connected');
    this.startPoolStatsLogging();
  }

  async onModuleDestroy() {
    if (this.poolStatsInterval) {
      clearInterval(this.poolStatsInterval);
    }
    await this.$disconnect();
    await this.pool.end();
    this.logger.log('✅ Database disconnected');
  }

  /**
   * Log pool statistics periodically
   */
  private startPoolStatsLogging() {
    if (process.env.NODE_ENV === 'production') {
      // Only log in production, less frequently
      this.poolStatsInterval = setInterval(() => {
        this.logger.debug('Database Pool Stats:', {
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount,
          waitingCount: this.pool.waitingCount,
        });
      }, 300000); // Every 5 minutes
    }
  }

  /**
   * Get pool statistics
   */
  getPoolStats() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }
}
