import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisConnectionService } from '../config/redis-connection.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisConnectionService,
  ) {}

  @Get()
  async check() {
    const checks = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'social-media-backend',
      checks: {
        database: await this.checkDatabase(),
        redis: await this.checkRedis(),
      },
    };

    const allHealthy = Object.values(checks.checks).every(
      (c: any) => c.status === 'healthy',
    );

    return {
      ...checks,
      status: allHealthy ? 'ok' : 'degraded',
    };
  }

  @Get('detailed')
  async detailedCheck() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      database: await this.checkDatabase(),
      redis: await this.checkRedis(),
      environment: process.env.NODE_ENV,
      version: process.env.npm_package_version || '1.0.0',
    };
  }

  private async checkDatabase() {
    try {
      const start = Date.now();
      await this.prisma.$queryRaw`SELECT 1`;
      const latency = Date.now() - start;

      return {
        status: 'healthy',
        latency: `${latency}ms`,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async checkRedis() {
    try {
      const isConnected = await this.redis.isConnected();
      const info = await this.redis.getConnectionInfo();

      return {
        status: isConnected ? 'healthy' : 'unhealthy',
        ...info,
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}









