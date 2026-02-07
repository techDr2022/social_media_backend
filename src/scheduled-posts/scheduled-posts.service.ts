import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { PrismaService } from '../prisma/prisma.service';
import { CreateScheduledPostDto } from './dto/create-scheduled-post.dto';
import { UpdateScheduledPostDto } from './dto/update-scheduled-post.dto';
import { PublishPostJobData } from './queue/post-queue.types';
import { QUEUE_NAMES, JOB_NAMES } from './queue/post-queue.types';
import { QueueHelpers } from './queue/queue-helpers';
import { DatabaseTransactionService } from '../common/database-transaction.service';

@Injectable()
export class ScheduledPostsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.POST_PUBLISH) private readonly postQueue: Queue,
    private readonly queueHelpers: QueueHelpers,
    private readonly transactionService: DatabaseTransactionService,
  ) {}

  async create(userId: string, dto: CreateScheduledPostDto, media?: { url: string; filename: string; mimeType?: string; size?: number }) {
    const scheduledAt = new Date(dto.scheduledAt);
    const now = new Date();
    
    // Validate scheduled time is in future
    if (scheduledAt <= now) {
      throw new BadRequestException('Scheduled time must be in the future');
    }

    // Validate social account
    const socialAccount = await this.prisma.socialAccount.findUnique({
      where: { id: dto.socialAccountId },
    });
    
    if (!socialAccount || socialAccount.userId !== userId) {
      throw new BadRequestException('Invalid socialAccountId or not owned by user');
    }

    // Validate platform
    if (!['instagram', 'facebook', 'youtube'].includes(dto.platform)) {
      throw new BadRequestException(`Unsupported platform: ${dto.platform}`);
    }

    // Parse optional carousel data (JSON strings from FormData)
    let carouselUrls: string[] | undefined;
    let carouselItems: Array<{ url: string; type: 'photo' | 'video' }> | undefined;
    if (dto.carouselUrls) {
      try {
        const parsed = JSON.parse(dto.carouselUrls);
        if (Array.isArray(parsed)) carouselUrls = parsed.filter((u: unknown) => typeof u === 'string');
      } catch {
        // ignore invalid JSON
      }
    }
    if (dto.carouselItems) {
      try {
        const parsed = JSON.parse(dto.carouselItems);
        if (Array.isArray(parsed))
          carouselItems = parsed.filter(
            (item: any) => item && typeof item?.url === 'string' && (item?.type === 'photo' || item?.type === 'video'),
          ) as Array<{ url: string; type: 'photo' | 'video' }>;
      } catch {
        // ignore invalid JSON
      }
    }
    const carouselData =
      (carouselUrls?.length ?? 0) > 0 || (carouselItems?.length ?? 0) > 0
        ? { carouselUrls, carouselItems }
        : undefined;

    const accountLabel = socialAccount?.displayName || socialAccount?.username || dto.socialAccountId;
    console.log(`[ScheduledPosts] Scheduling started for ${dto.platform} (account: ${accountLabel}, at: ${dto.scheduledAt})`);

    if (carouselData) {
      const n = carouselUrls?.length ?? carouselItems?.length ?? 0;
      console.log(`[ScheduledPosts] Received carousel: ${n} item(s) (media already uploaded by client)`);
    } else if (media?.url) {
      console.log(`[ScheduledPosts] Received media URL: ${media.url.split('/').pop() || media.filename || 'media'}`);
    } else {
      console.log(`[ScheduledPosts] No media attached (text-only post)`);
    }

    // Use transaction to ensure atomicity: create post + add to queue
    return await this.transactionService.executeInTransaction(async (tx) => {
      console.log(`[ScheduledPosts] Saving scheduled post to database...`);
      // Create post in database
      const post = await tx.scheduledPost.create({
        data: {
          userId,
          platform: dto.platform,
          content: dto.content,
          scheduledAt,
          timezone: dto.timezone ?? undefined,
          socialAccountId: dto.socialAccountId,
          mediaUrl: media?.url ?? undefined,
          status: 'pending',
          data: carouselData ?? undefined,
          type: dto.platform === 'instagram' && carouselData ? 'carousel' : 'post',
        },
      });

      // Calculate delay in milliseconds
      const delay = scheduledAt.getTime() - now.getTime();
      
      // Prepare job data (include carousel so PostProcessor creates carousel, not single media)
      // mediaType must be 'carousel' for Instagram so createPost enters the carousel branch
      const jobData: PublishPostJobData = {
        postId: post.id,
        userId: post.userId,
        socialAccountId: post.socialAccountId,
        platform: post.platform as 'instagram' | 'facebook' | 'youtube',
        content: post.content,
        mediaUrl: post.mediaUrl || undefined,
        mediaType: post.type || undefined,
        carouselUrls: Array.isArray(carouselUrls) && carouselUrls.length > 0 ? carouselUrls : undefined,
        carouselItems: Array.isArray(carouselItems) && carouselItems.length > 0 ? carouselItems : undefined,
      };

      // Add job to BullMQ queue with delay using retry mechanism
      // Redis will automatically trigger this job at scheduled time
      const delayMinutes = Math.round(delay / 60000);
      console.log(`[ScheduledPosts] Adding job to queue (will publish in ${delayMinutes} min at scheduled time)...`);
      try {
        await this.queueHelpers.addJobWithRetry(
          JOB_NAMES.PUBLISH_POST,
          jobData,
          {
            delay: delay, // Redis triggers job at exact scheduled time
            jobId: `post-${post.id}`, // Unique job ID (prevents duplicates)
            removeOnComplete: true,
            removeOnFail: false, // Keep failed jobs for debugging
          },
          3, // Max 3 retries with exponential backoff
        );
        console.log(`[ScheduledPosts] Scheduled successfully: post ${post.id} for ${accountLabel} (${dto.platform}) at ${dto.scheduledAt}`);
      } catch (queueError: any) {
        console.error(`❌ Failed to add scheduled post to queue after retries: ${queueError.message}`);
        // If Redis fails, rollback the transaction to maintain consistency
        // This ensures we don't have orphaned posts in the database
        throw new BadRequestException(`Failed to schedule post: ${queueError.message}`);
      }

      return post;
    });
  }

  async findForUser(userId: string) {
    return this.prisma.scheduledPost.findMany({
      where: { userId },
      orderBy: { scheduledAt: 'desc' },
    });
  }

  async findOne(userId: string, id: string) {
    return this.prisma.scheduledPost.findFirst({
      where: { id, userId },
    });
  }

  async update(userId: string, id: string, dto: UpdateScheduledPostDto) {
    const existing = await this.findOne(userId, id);
    if (!existing) return null;
    
    const data: any = { ...dto };
    if (dto.scheduledAt) {
      data.scheduledAt = new Date(dto.scheduledAt);
      
      // If scheduled time changed and post is still pending, update the job in queue
      if (existing.status === 'pending') {
        const newScheduledAt = data.scheduledAt;
        const existingData = (existing as any).data as { carouselUrls?: string[]; carouselItems?: Array<{ url: string; type: 'photo' | 'video' }> } | null;
        
        try {
          // Use QueueHelpers to reschedule (include carousel data if present)
          const jobData: PublishPostJobData = {
            postId: id,
            userId: existing.userId,
            socialAccountId: existing.socialAccountId,
            platform: existing.platform as 'instagram' | 'facebook' | 'youtube',
            content: existing.content,
            mediaUrl: existing.mediaUrl || undefined,
            mediaType: existing.type || undefined,
            carouselUrls: existingData?.carouselUrls?.length ? existingData.carouselUrls : undefined,
            carouselItems: existingData?.carouselItems?.length ? existingData.carouselItems : undefined,
          };
          
          await this.queueHelpers.reschedulePost(id, newScheduledAt, jobData);
        } catch (error) {
          // If queue update fails, continue with database update
          console.error('Failed to update job in queue:', error);
        }
      }
    }
    
    return this.prisma.scheduledPost.update({
      where: { id },
      data,
    });
  }

  async remove(userId: string, id: string) {
    const existing = await this.findOne(userId, id);
    if (!existing) return null;
    
    // Remove job from queue if still pending
    if (existing.status === 'pending') {
      await this.queueHelpers.removeJob(id);
    }
    
    await this.prisma.scheduledPost.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Get queue statistics
   */
  async getQueueStats() {
    return await this.queueHelpers.getQueueStats();
  }

  /**
   * Get all media files for a user (for media library)
   */
  async findAllMediaForUser(userId: string) {
    const posts = await this.prisma.scheduledPost.findMany({
      where: {
        userId,
        mediaUrl: { not: null },
      },
      select: {
        id: true,
        platform: true,
        mediaUrl: true,
        content: true,
        scheduledAt: true,
        status: true,
        createdAt: true,
        socialAccount: {
          select: {
            id: true,
            displayName: true,
            username: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Transform to media library format
    return posts
      .filter((post) => post.mediaUrl) // Ensure mediaUrl exists
      .map((post) => ({
        id: post.id,
        platform: post.platform,
        mediaUrl: post.mediaUrl,
        caption: post.content || '',
        scheduledAt: post.scheduledAt,
        status: post.status,
        createdAt: post.createdAt,
        accountName: post.socialAccount?.displayName || post.socialAccount?.username || 'Unknown',
        accountId: post.socialAccount?.id,
      }));
  }

}
