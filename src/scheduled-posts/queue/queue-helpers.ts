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

  /**
   * Check if queue connection is healthy
   * Tests connection by getting queue stats (lightweight operation)
   */
  async isConnectionHealthy(): Promise<boolean> {
    try {
      // Try to get queue stats - this will fail if Redis is not connected
      const result = await Promise.race([
        this.queue.getJobCounts(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Connection check timeout after 3 seconds')), 3000);
        }),
      ]);
      this.logger.debug(`✅ Queue connection healthy, stats: ${JSON.stringify(result)}`);
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.warn(`⚠️ Queue connection check failed: ${errorMessage}`, errorStack);
      return false;
    }
  }

  /**
   * Add job to queue with retry mechanism and connection validation
   * 
   * @param jobName - Job name
   * @param jobData - Job data
   * @param options - Job options (delay, jobId, etc.)
   * @param maxRetries - Maximum retry attempts (default: 3)
   * @returns Promise that resolves when job is added successfully
   */
  async addJobWithRetry<T = any>(
    jobName: string,
    jobData: T,
    options: {
      delay?: number;
      jobId?: string;
      removeOnComplete?: boolean | { age?: number; count?: number };
      removeOnFail?: boolean | { age?: number; count?: number };
    },
    maxRetries = 3,
  ): Promise<any> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check connection health before attempting (skip on first attempt for speed)
        if (attempt > 1) {
          const isHealthy = await this.isConnectionHealthy();
          if (!isHealthy) {
            throw new Error('Queue connection is not healthy');
          }
        }

        // Add job with timeout protection
        const queuePromise = this.queue.add(jobName, jobData, options).catch((error) => {
          // Capture the actual error from BullMQ
          this.logger.error(`❌ Queue.add() error (attempt ${attempt}/${maxRetries}):`, {
            message: error?.message || 'Unknown error',
            stack: error?.stack,
            code: (error as any)?.code,
            errno: (error as any)?.errno,
            syscall: (error as any)?.syscall,
          });
          throw error;
        });
        
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Queue add operation timed out after 5 seconds (attempt ${attempt}/${maxRetries})`));
          }, 5000);
        });

        const result = await Promise.race([queuePromise, timeoutPromise]);
        
        if (attempt > 1) {
          this.logger.log(`✅ Job added successfully on attempt ${attempt}/${maxRetries}`);
        }
        
        return result;
      } catch (error: any) {
        lastError = error;
        const errorMessage = error.message || 'Unknown error';
        
        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
          this.logger.warn(
            `⚠️ Failed to add job (attempt ${attempt}/${maxRetries}): ${errorMessage}. Retrying in ${delay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          this.logger.error(
            `❌ Failed to add job after ${maxRetries} attempts: ${errorMessage}`,
          );
        }
      }
    }

    // All retries failed
    throw lastError || new Error('Failed to add job to queue after all retries');
  }
}
