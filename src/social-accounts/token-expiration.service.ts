import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Token Expiration Service
 * 
 * Provides utilities for tracking and managing token expiration:
 * - Check if token is expired
 * - Calculate time until expiration
 * - Find expiring tokens
 */
@Injectable()
export class TokenExpirationService {
  private readonly logger = new Logger(TokenExpirationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Check if token is expired or expiring soon (within buffer time)
   */
  isTokenExpired(
    tokenExpiresAt: Date | null,
    bufferMinutes = 5,
  ): boolean {
    if (!tokenExpiresAt) {
      return true;
    }

    // Consider expired if expires within buffer time
    const bufferTime = bufferMinutes * 60 * 1000;
    return tokenExpiresAt.getTime() <= Date.now() + bufferTime;
  }

  /**
   * Get time until expiration in seconds
   */
  getTimeUntilExpiration(tokenExpiresAt: Date | null): number {
    if (!tokenExpiresAt) {
      return 0;
    }
    return Math.max(
      0,
      Math.floor((tokenExpiresAt.getTime() - Date.now()) / 1000),
    );
  }

  /**
   * Get time until expiration in human-readable format
   */
  getTimeUntilExpirationHuman(tokenExpiresAt: Date | null): string {
    const seconds = this.getTimeUntilExpiration(tokenExpiresAt);

    if (seconds === 0) {
      return 'expired';
    }

    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days} day${days > 1 ? 's' : ''}`;
    }
    if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''}`;
    }
    if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    }
    return `${seconds} second${seconds > 1 ? 's' : ''}`;
  }

  /**
   * Find accounts with expiring tokens
   */
  async findExpiringTokens(
    bufferMinutes = 30,
    limit = 100,
  ): Promise<any[]> {
    const bufferTime = bufferMinutes * 60 * 1000;
    const expirationThreshold = new Date(Date.now() + bufferTime);

    return await this.prisma.socialAccount.findMany({
      where: {
        tokenExpiresAt: {
          lte: expirationThreshold,
        },
        refreshToken: { not: null },
        isActive: true,
      },
      take: limit,
      orderBy: {
        tokenExpiresAt: 'asc', // Most urgent first
      },
    });
  }

  /**
   * Find accounts with expired tokens
   */
  async findExpiredTokens(limit = 100): Promise<any[]> {
    return await this.prisma.socialAccount.findMany({
      where: {
        OR: [
          { tokenExpiresAt: { lte: new Date() } },
          { tokenExpiresAt: null },
        ],
        refreshToken: { not: null },
        isActive: true,
      },
      take: limit,
      orderBy: {
        tokenExpiresAt: 'asc',
      },
    });
  }

  /**
   * Get token expiration statistics
   */
  async getExpirationStats() {
    const now = new Date();
    const in30Minutes = new Date(now.getTime() + 30 * 60 * 1000);
    const in1Hour = new Date(now.getTime() + 60 * 60 * 1000);
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const [expired, expiring30min, expiring1hour, expiring24hours, total] =
      await Promise.all([
        this.prisma.socialAccount.count({
          where: {
            OR: [{ tokenExpiresAt: { lte: now } }, { tokenExpiresAt: null }],
            isActive: true,
          },
        }),
        this.prisma.socialAccount.count({
          where: {
            tokenExpiresAt: {
              gte: now,
              lte: in30Minutes,
            },
            isActive: true,
          },
        }),
        this.prisma.socialAccount.count({
          where: {
            tokenExpiresAt: {
              gte: in30Minutes,
              lte: in1Hour,
            },
            isActive: true,
          },
        }),
        this.prisma.socialAccount.count({
          where: {
            tokenExpiresAt: {
              gte: in1Hour,
              lte: in24Hours,
            },
            isActive: true,
          },
        }),
        this.prisma.socialAccount.count({
          where: { isActive: true },
        }),
      ]);

    return {
      expired,
      expiringIn30Minutes: expiring30min,
      expiringIn1Hour: expiring1hour,
      expiringIn24Hours: expiring24hours,
      total,
      healthy: total - expired - expiring30min,
    };
  }
}
