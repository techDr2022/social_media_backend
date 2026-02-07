import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GmbService } from './gmb.service';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class GmbSchedulerService {
  private readonly logger = new Logger(GmbSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmbService: GmbService,
  ) {}

  /**
   * Process due GMB posts every minute. No Redis – uses DB + cron.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processDuePosts() {
    const due = await this.prisma.gmbPost.findMany({
      where: {
        status: 'scheduled',
        scheduledAt: { lte: new Date() },
      },
      take: 20,
    });

    if (due.length > 0) {
      this.logger.log(`GMB scheduler: processing ${due.length} due post(s)`);
    }

    for (const post of due) {
      try {
        await this.gmbService.publishPostToGoogle(post.id);
      } catch (err) {
        // Error already saved to post.errorMessage by publishPostToGoogle
        this.logger.warn(`GMB scheduler: post ${post.id} failed: ${(err as Error).message}`);
        continue;
      }
    }
  }
}
