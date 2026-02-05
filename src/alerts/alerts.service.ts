import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateAlertDto {
  userId: string;
  socialAccountId?: string;
  scheduledPostId?: string;
  type: 'scheduled' | 'processing' | 'success' | 'failed';
  platform: 'instagram' | 'facebook' | 'youtube';
  title: string;
  message: string;
  accountName?: string;
  postType?: 'photo' | 'video' | 'carousel';
  scheduledAt?: Date;
}

@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new alert
   */
  async create(dto: CreateAlertDto) {
    return this.prisma.alert.create({
      data: {
        userId: dto.userId,
        socialAccountId: dto.socialAccountId,
        scheduledPostId: dto.scheduledPostId,
        type: dto.type,
        platform: dto.platform,
        title: dto.title,
        message: dto.message,
        accountName: dto.accountName,
        postType: dto.postType,
        scheduledAt: dto.scheduledAt,
        isRead: false,
      },
    });
  }

  /**
   * Get alerts for a user with pagination
   * @param userId - User ID
   * @param limit - Number of alerts to return (default: 10)
   * @param cursor - Cursor for pagination (alert ID)
   * @param unreadOnly - Only return unread alerts (default: false)
   */
  async findForUser(
    userId: string,
    limit: number = 10,
    cursor?: string,
    unreadOnly: boolean = false,
  ) {
    const where: any = {
      userId,
    };

    if (unreadOnly) {
      where.isRead = false;
    }

    if (cursor) {
      where.id = {
        lt: cursor, // Get alerts older than cursor (for pagination)
      };
    }

    const alerts = await this.prisma.alert.findMany({
      where,
      orderBy: {
        createdAt: 'desc', // Newest first
      },
      take: limit + 1, // Fetch one extra to check if there are more
    });

    const hasMore = alerts.length > limit;
    const data = hasMore ? alerts.slice(0, limit) : alerts;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    return {
      alerts: data,
      hasMore,
      nextCursor,
    };
  }

  /**
   * Get unread count for a user
   */
  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.alert.count({
      where: {
        userId,
        isRead: false,
      },
    });
  }

  /**
   * Mark alert as read
   */
  async markAsRead(userId: string, alertId: string) {
    return this.prisma.alert.updateMany({
      where: {
        id: alertId,
        userId, // Ensure user owns this alert
      },
      data: {
        isRead: true,
      },
    });
  }

  /**
   * Mark all alerts as read for a user
   */
  async markAllAsRead(userId: string) {
    return this.prisma.alert.updateMany({
      where: {
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });
  }

  /**
   * Delete alert
   */
  async delete(userId: string, alertId: string) {
    return this.prisma.alert.deleteMany({
      where: {
        id: alertId,
        userId, // Ensure user owns this alert
      },
    });
  }

  /**
   * Format alert message for scheduled post
   */
  formatScheduledMessage(
    accountName: string,
    postType: 'photo' | 'video' | 'carousel',
    scheduledAt: Date,
  ): string {
    const typeLabel =
      postType === 'carousel'
        ? 'carousel'
        : postType === 'video'
          ? 'video'
          : 'photo';
    const formattedDate = scheduledAt.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    return `Your ${typeLabel} post for ${accountName} is scheduled for ${formattedDate}`;
  }

  /**
   * Format alert message for processing post
   */
  formatProcessingMessage(
    accountName: string,
    postType: 'photo' | 'video' | 'carousel',
  ): string {
    const typeLabel =
      postType === 'carousel'
        ? 'carousel'
        : postType === 'video'
          ? 'video'
          : 'photo';
    return `Your ${typeLabel} post for ${accountName} is being processed...`;
  }

  /**
   * Format alert message for successful post
   */
  formatSuccessMessage(
    accountName: string,
    postType: 'photo' | 'video' | 'carousel',
    postUrl?: string,
  ): string {
    const typeLabel =
      postType === 'carousel'
        ? 'carousel'
        : postType === 'video'
          ? 'video'
          : 'photo';
    if (postUrl) {
      return `Your ${typeLabel} post for ${accountName} was published successfully! View post`;
    }
    return `Your ${typeLabel} post for ${accountName} was published successfully!`;
  }

  /**
   * Format alert message for failed post
   */
  formatFailedMessage(
    accountName: string,
    postType: 'photo' | 'video' | 'carousel',
    errorMessage?: string,
  ): string {
    const typeLabel =
      postType === 'carousel'
        ? 'carousel'
        : postType === 'video'
          ? 'video'
          : 'photo';
    if (errorMessage) {
      return `Your ${typeLabel} post for ${accountName} failed: ${errorMessage}`;
    }
    return `Your ${typeLabel} post for ${accountName} failed to publish`;
  }
}
