import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InstagramService } from '../../social-accounts/providers/instagram/instagram.service';
import { FacebookService } from '../../social-accounts/providers/facebook/facebook.service';
import { YoutubeService } from '../../social-accounts/providers/youtube/youtube.service';
import { MediaHandler } from './media-handler';
import { PublishPostJobData, PublishPostJobResult } from './post-queue.types';
import { JOB_NAMES, QUEUE_NAMES } from './post-queue.types';

/**
 * Post Processor (Worker)
 * 
 * Processes scheduled post publishing jobs.
 * 
 * Flow:
 * 1. Receives job from Redis queue at scheduled time
 * 2. Updates post status to 'processing'
 * 3. Calls platform-specific service to publish
 * 4. Updates post status to 'success' or 'failed'
 * 
 * Error Handling:
 * - Automatic retries (3 attempts)
 * - Logs all errors
 * - Updates database on failure
 */
@Processor(QUEUE_NAMES.POST_PUBLISH)
@Injectable()
export class PostProcessor {
  private readonly logger = new Logger(PostProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly instagramService: InstagramService,
    private readonly facebookService: FacebookService,
    private readonly youtubeService: YoutubeService,
    private readonly mediaHandler: MediaHandler,
  ) {}

  /**
   * Process publish-post job
   * 
   * Triggered automatically by Redis at scheduled time
   * Concurrency: 5 - Process 5 posts simultaneously
   */
  @Process({
    name: JOB_NAMES.PUBLISH_POST,
    concurrency: 5, // Process 5 posts simultaneously
  })
  async handlePublishPost(
    job: Job<PublishPostJobData>,
  ): Promise<PublishPostJobResult> {
    const { postId, userId, socialAccountId, platform, content, mediaUrl, mediaType } = job.data;
    
    const startTime = Date.now();
    this.logger.log(
      `[Job ${job.id}] Processing scheduled post ${postId} for platform ${platform}`,
    );

    try {
      // 1. Update status to 'processing'
      await this.updatePostStatus(postId, 'processing', {
        jobId: job.id.toString(),
        startedAt: new Date(),
      });

      // 2. Handle media (verify accessibility)
      let processedMediaUrl = mediaUrl;
      if (mediaUrl) {
        this.logger.log(`[Job ${job.id}] Processing media: ${mediaUrl}`);
        
        try {
          processedMediaUrl = await this.mediaHandler.prepareMediaForPublishing(
            mediaUrl,
            platform,
            postId,
          );
          this.logger.log(`[Job ${job.id}] Media verified: ${processedMediaUrl}`);
        } catch (mediaError: any) {
          this.logger.error(`[Job ${job.id}] Media preparation failed: ${mediaError.message}`);
          throw new Error(`Media not accessible: ${mediaError.message}`);
        }
      }

      // 3. Publish based on platform
      let result: PublishPostJobResult;
      
      switch (platform) {
        case 'instagram':
          result = await this.publishInstagramPost({
            userId,
            socialAccountId,
            content,
            mediaUrl: processedMediaUrl,
            mediaType,
          });
          break;
          
        case 'facebook':
          result = await this.publishFacebookPost({
            userId,
            socialAccountId,
            content,
            mediaUrl: processedMediaUrl,
            mediaType,
          });
          break;
          
        case 'youtube':
          result = await this.publishYoutubePost({
            userId,
            socialAccountId,
            content,
            mediaUrl: processedMediaUrl,
          });
          break;
          
        default:
          throw new Error(`Unsupported platform: ${platform}`);
      }

      // 4. Calculate processing time
      const processingTime = Date.now() - startTime;

      // 5. Update status to 'success' with details
      await this.updatePostStatus(postId, 'success', {
        jobId: job.id.toString(),
        postId: result.postId,
        postUrl: result.postUrl,
        processingTime,
        completedAt: new Date(),
      });

      this.logger.log(
        `[Job ${job.id}] Successfully published post ${postId} in ${processingTime}ms`,
      );
      
      return result;
      
    } catch (error: any) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error.message || 'Unknown error';
      const errorStack = error.stack;
      
      this.logger.error(
        `[Job ${job.id}] Failed to publish post ${postId} after ${processingTime}ms: ${errorMessage}`,
        errorStack,
      );
      
      // Update status to 'failed' with error details
      await this.updatePostStatus(postId, 'failed', {
        jobId: job.id.toString(),
        error: errorMessage,
        errorStack,
        processingTime,
        failedAt: new Date(),
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts || 3,
      });

      // Re-throw to trigger BullMQ retry mechanism
      throw error;
    }
  }

  /**
   * Publish Instagram post
   */
  private async publishInstagramPost(params: {
    userId: string;
    socialAccountId: string;
    content: string;
    mediaUrl?: string;
    mediaType?: string;
  }): Promise<PublishPostJobResult> {
    let caption = params.content;
    let mediaType: 'photo' | 'video' | undefined;
    
    // Parse content if it's JSON (for YouTube-style posts)
    try {
      const parsed = JSON.parse(params.content);
      if (parsed.caption) caption = parsed.caption;
      if (parsed.mediaType) mediaType = parsed.mediaType;
    } catch {
      // Content is plain text, use as-is
    }

    const result = await this.instagramService.createPost({
      userId: params.userId,
      socialAccountId: params.socialAccountId,
      caption: caption,
      mediaUrl: params.mediaUrl,
      mediaType: mediaType || (params.mediaUrl ? 'photo' : undefined),
      // No scheduledPublishTime - we're publishing now!
    });

    return {
      success: true,
      postId: result.postId,
      postUrl: result.postUrl,
    };
  }

  /**
   * Publish Facebook post
   */
  private async publishFacebookPost(params: {
    userId: string;
    socialAccountId: string;
    content: string;
    mediaUrl?: string;
    mediaType?: string;
  }): Promise<PublishPostJobResult> {
    let message = params.content;
    
    try {
      const parsed = JSON.parse(params.content);
      if (parsed.message) message = parsed.message;
    } catch {
      // Content is plain text
    }

    const result = await this.facebookService.createPost({
      userId: params.userId,
      socialAccountId: params.socialAccountId,
      message: message,
      mediaUrl: params.mediaUrl,
      mediaType: params.mediaType as 'photo' | 'video',
      // No scheduledPublishTime - we're publishing now!
    });

    return {
      success: true,
      postId: result.postId,
    };
  }

  /**
   * Publish YouTube post
   */
  private async publishYoutubePost(params: {
    userId: string;
    socialAccountId: string;
    content: string;
    mediaUrl?: string;
  }): Promise<PublishPostJobResult> {
    // YouTube needs file path, not URL
    // This requires downloading from storage first
    // TODO: Implement file download from Supabase Storage for YouTube
    throw new Error('YouTube scheduled posts require file path - needs additional implementation');
  }

  /**
   * Update post status in database with detailed tracking
   * IMPORTANT: Uses externalPostId and permalink fields for proper data storage
   */
  private async updatePostStatus(
    postId: string,
    status: 'processing' | 'success' | 'failed',
    details?: {
      jobId?: string;
      postId?: string; // External post ID from Instagram/Facebook
      postUrl?: string; // Permalink to the post
      error?: string;
      errorStack?: string;
      processingTime?: number;
      startedAt?: Date;
      completedAt?: Date;
      failedAt?: Date;
      attempt?: number;
      maxAttempts?: number;
    },
  ): Promise<void> {
    const updateData: any = {
      status,
      updatedAt: new Date(),
    };

    if (status === 'success') {
      updateData.postedAt = details?.completedAt || new Date();
      // Store external post ID and URL in dedicated fields (NOT in errorMessage)
      updateData.externalPostId = details?.postId ? String(details.postId) : null;
      updateData.permalink = details?.postUrl && typeof details.postUrl === 'string' && details.postUrl.trim().length > 0 
        ? details.postUrl 
        : null;
      updateData.errorMessage = null; // Clear any previous errors
    } else if (status === 'failed') {
      // For failed posts, still save postId/postUrl if available (partial success scenario)
      // This happens if the post was created but some step failed (e.g., fetching permalink)
      updateData.externalPostId = details?.postId ? String(details.postId) : null;
      updateData.permalink = details?.postUrl && typeof details.postUrl === 'string' && details.postUrl.trim().length > 0 
        ? details.postUrl 
        : null;
      // Store actual error message (not postId/postUrl)
      const errorDetails = {
        error: details?.error,
        attempt: details?.attempt,
        maxAttempts: details?.maxAttempts,
        processingTime: details?.processingTime,
        ...(details?.errorStack && { stack: details.errorStack.substring(0, 1000) }), // Limit stack trace
      };
      updateData.errorMessage = JSON.stringify(errorDetails);
      // If we have postId, the post was actually published (partial success)
      updateData.postedAt = details?.postId ? (details.failedAt || new Date()) : null;
    } else if (status === 'processing') {
      // Keep existing externalPostId and permalink when processing
      // Don't overwrite them
    }

    await this.prisma.scheduledPost.update({
      where: { id: postId },
      data: updateData,
    });
  }
}

