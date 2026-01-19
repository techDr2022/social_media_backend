import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { getBullMQRedisConfig } from '../../config/redis.config';
import { QUEUE_NAMES } from './post-queue.types';
import { PostProcessor } from './post-processor';
import { MediaHandler } from './media-handler';
import { PrismaModule } from '../../prisma/prisma.module';
import { InstagramModule } from '../../social-accounts/providers/instagram/instagram.module';
import { FacebookModule } from '../../social-accounts/providers/facebook/facebook.module';
import { YoutubeModule } from '../../social-accounts/providers/youtube/youtube.module';

/**
 * Post Queue Module
 * 
 * Sets up BullMQ queue for scheduled post publishing.
 * 
 * Queue Configuration:
 * - Name: 'post-publish'
 * - Redis: Configured via REDIS_URL or REDIS_HOST/PORT
 * - Concurrency: 5 (process 5 posts simultaneously)
 */
@Module({
  imports: [
    BullModule.forRoot({
      ...getBullMQRedisConfig(),
      // Performance optimizations
      settings: {
        stalledInterval: 30000, // Check for stalled jobs every 30s
        maxStalledCount: 1, // Retry stalled jobs once
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.POST_PUBLISH,
      defaultJobOptions: {
        // Retry failed jobs 3 times
        attempts: 3,
        // Exponential backoff between retries
        backoff: {
          type: 'exponential',
          delay: 5000, // Start with 5 seconds
        },
        // Remove completed jobs after 1 hour
        removeOnComplete: {
          age: 3600, // 1 hour
          count: 1000, // Keep last 1000 jobs
        },
        // Keep failed jobs for 24 hours for debugging
        removeOnFail: {
          age: 86400, // 24 hours
        },
        // Timeout for job processing (5 minutes for large files)
        timeout: 300000,
      },
    }),
    PrismaModule, // For PrismaService
    InstagramModule, // For InstagramService
    FacebookModule, // For FacebookService
    YoutubeModule, // For YoutubeService
  ],
  providers: [PostProcessor, MediaHandler],
  exports: [BullModule],
})
export class PostQueueModule {}

