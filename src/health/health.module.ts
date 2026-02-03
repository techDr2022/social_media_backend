import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PostQueueModule } from '../scheduled-posts/queue/post-queue.module';

@Module({
  imports: [
    PrismaModule, // For PrismaService
    PostQueueModule, // For RedisConnectionService
  ],
  controllers: [HealthController],
})
export class HealthModule {}









