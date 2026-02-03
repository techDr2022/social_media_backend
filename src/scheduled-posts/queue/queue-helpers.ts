import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { QUEUE_NAMES, JOB_NAMES } from './post-queue.types';

/**
 * Queue Helper Functions
 * 
 * Provides utility functions for common queue operations:
 * - Check if job exists
 * - Remove jobs
 * - Reschedule jobs
 * - Get queue statistics
 */
@Injectable()
export class QueueHelpers {
  private readonly logger = new Logger(QueueHelpers.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.POST_PUBLISH) private readonly queue: Queue,
  ) {}

  /**
   * Check if a post job exists in queue
   */
  async hasJob(postId: string): Promise<boolean> {
    try {
      const job = await this.queue.getJob(`post-${postId}`);
      return !!job;
    } catch (error) {
      this.logger.error(`Error checking job for post ${postId}:`, error);
      return false;
    }
  }

  /**
   * Get job by post ID
   */
  async getJob(postId: string) {
    try {
      return await this.queue.getJob(`post-${postId}`);
    } catch (error) {
      this.logger.error(`Error getting job for post ${postId}:`, error);
      return null;
    }
  }

  /**
   * Remove job from queue
   */
  async removeJob(postId: string): Promise<boolean> {
    try {
      const job = await this.queue.getJob(`post-${postId}`);
      if (job) {
        await job.remove();
        this.logger.log(`✅ Removed job for post ${postId}`);
        return true;
      }
      this.logger.log(`ℹ️ No job found for post ${postId}`);
      return false;
    } catch (error) {
      this.logger.error(`❌ Failed to remove job for post ${postId}:`, error);
      return false;
    }
  }

  /**
   * Remove multiple jobs by post IDs
   */
  async removeJobs(postIds: string[]): Promise<number> {
    let removedCount = 0;
    for (const postId of postIds) {
      if (await this.removeJob(postId)) {
        removedCount++;
      }
    }
    return removedCount;
  }

  /**
   * Reschedule a post job
   */
  async reschedulePost(
    postId: string,
    newScheduledAt: Date,
    jobData: any,
  ): Promise<boolean> {
    try {
      // Remove old job
      await this.removeJob(postId);

      // Calculate new delay
      const delay = Math.max(0, newScheduledAt.getTime() - Date.now());

      if (delay <= 0) {
        this.logger.warn(
          `⚠️ Cannot reschedule post ${postId} - scheduled time is in the past`,
        );
        return false;
      }

      // Add new job
      await this.queue.add(JOB_NAMES.PUBLISH_POST, jobData, {
        delay,
        jobId: `post-${postId}`,
      });

      this.logger.log(
        `✅ Rescheduled post ${postId} for ${newScheduledAt.toISOString()}`,
      );
      return true;
    } catch (error) {
      this.logger.error(`❌ Failed to reschedule post ${postId}:`, error);
      return false;
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats() {
    try {
      const counts = await this.queue.getJobCounts();
      return {
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
        delayed: counts.delayed || 0,
        total:
          (counts.waiting || 0) +
          (counts.active || 0) +
          (counts.completed || 0) +
          (counts.failed || 0) +
          (counts.delayed || 0),
      };
    } catch (error) {
      this.logger.error('Error getting queue stats:', error);
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        total: 0,
      };
    }
  }

  /**
   * Get failed jobs
   */
  async getFailedJobs(limit = 10) {
    try {
      const jobs = await this.queue.getFailed(0, limit);
      return jobs.map((job) => ({
        id: job.id,
        postId: job.data.postId,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        timestamp: new Date(job.timestamp),
      }));
    } catch (error) {
      this.logger.error('Error getting failed jobs:', error);
      return [];
    }
  }

  /**
   * Retry failed job
   */
  async retryFailedJob(jobId: string | number): Promise<boolean> {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job) {
        this.logger.warn(`Job ${jobId} not found`);
        return false;
      }

      await job.retry();
      this.logger.log(`✅ Retried failed job ${jobId}`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Failed to retry job ${jobId}:`, error);
      return false;
    }
  }

  /**
   * Clean completed jobs older than specified age
   */
  async cleanCompletedJobs(ageInSeconds = 3600): Promise<number> {
    try {
      const cleaned = await this.queue.clean(ageInSeconds * 1000, 'completed');
      this.logger.log(`✅ Cleaned ${cleaned.length} completed jobs`);
      return cleaned.length;
    } catch (error) {
      this.logger.error('Error cleaning completed jobs:', error);
      return 0;
    }
  }

  /**
   * Clean failed jobs older than specified age
   */
  async cleanFailedJobs(ageInSeconds = 86400): Promise<number> {
    try {
      const cleaned = await this.queue.clean(ageInSeconds * 1000, 'failed');
      this.logger.log(`✅ Cleaned ${cleaned.length} failed jobs`);
      return cleaned.length;
    } catch (error) {
      this.logger.error('Error cleaning failed jobs:', error);
      return 0;
    }
  }

  /**
   * Pause queue processing
   */
  async pauseQueue(): Promise<void> {
    await this.queue.pause();
    this.logger.log('⏸️ Queue paused');
  }

  /**
   * Resume queue processing
   */
  async resumeQueue(): Promise<void> {
    await this.queue.resume();
    this.logger.log('▶️ Queue resumed');
  }

  /**
   * Check if queue is paused
   */
  async isPaused(): Promise<boolean> {
    return await this.queue.isPaused();
  }
}
