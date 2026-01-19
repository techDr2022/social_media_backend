import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { PrismaService } from '../prisma/prisma.service';
import { CreateScheduledPostDto } from './dto/create-scheduled-post.dto';
import { UpdateScheduledPostDto } from './dto/update-scheduled-post.dto';
import { PublishPostJobData } from './queue/post-queue.types';
import { QUEUE_NAMES, JOB_NAMES } from './queue/post-queue.types';

@Injectable()
export class ScheduledPostsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.POST_PUBLISH) private readonly postQueue: Queue,
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

    // Create post in database
    const post = await this.prisma.scheduledPost.create({
      data: {
        userId,
        platform: dto.platform,
        content: dto.content,
        scheduledAt,
        timezone: dto.timezone ?? undefined,
        socialAccountId: dto.socialAccountId,
        mediaUrl: media?.url ?? undefined,
        status: 'pending',
      },
    });

    // Calculate delay in milliseconds
    const delay = scheduledAt.getTime() - now.getTime();
    
    // Prepare job data
    const jobData: PublishPostJobData = {
      postId: post.id,
      userId: post.userId,
      socialAccountId: post.socialAccountId,
      platform: post.platform as 'instagram' | 'facebook' | 'youtube',
      content: post.content,
      mediaUrl: post.mediaUrl || undefined,
      mediaType: post.type || undefined,
    };

    // Add job to BullMQ queue with delay
    // Redis will automatically trigger this job at scheduled time
    await this.postQueue.add(
      JOB_NAMES.PUBLISH_POST,
      jobData,
      {
        delay: delay, // Redis triggers job at exact scheduled time
        jobId: `post-${post.id}`, // Unique job ID (prevents duplicates)
        removeOnComplete: true,
        removeOnFail: false, // Keep failed jobs for debugging
      }
    );

    return post;
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
        const now = new Date();
        const delay = newScheduledAt.getTime() - now.getTime();
        
        if (delay > 0) {
          try {
            // Remove old job
            const oldJob = await this.postQueue.getJob(`post-${id}`);
            if (oldJob) {
              await oldJob.remove();
            }
            
            // Add new job with updated time
            const jobData: PublishPostJobData = {
              postId: id,
              userId: existing.userId,
              socialAccountId: existing.socialAccountId,
              platform: existing.platform as 'instagram' | 'facebook' | 'youtube',
              content: existing.content,
              mediaUrl: existing.mediaUrl || undefined,
              mediaType: existing.type || undefined,
            };
            
            await this.postQueue.add(
              JOB_NAMES.PUBLISH_POST,
              jobData,
              {
                delay: delay,
                jobId: `post-${id}`,
              }
            );
          } catch (error) {
            // If queue update fails, continue with database update
            console.error('Failed to update job in queue:', error);
          }
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
      try {
        const job = await this.postQueue.getJob(`post-${id}`);
        if (job) {
          await job.remove();
        }
      } catch (error) {
        // If queue removal fails, continue with database delete
        console.error('Failed to remove job from queue:', error);
      }
    }
    
    await this.prisma.scheduledPost.delete({ where: { id } });
    return { success: true };
  }
}
