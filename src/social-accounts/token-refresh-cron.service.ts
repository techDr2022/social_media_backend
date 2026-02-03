import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TokenRefreshService } from '../utils/token-refresh.service';
import { TokenExpirationService } from './token-expiration.service';

/**
 * Token Refresh Cron Service
 * 
 * Automatically refreshes expiring OAuth tokens:
 * - Runs every hour
 * - Finds tokens expiring within 30 minutes
 * - Refreshes them proactively
 */
@Injectable()
export class TokenRefreshCronService {
  private readonly logger = new Logger(TokenRefreshCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenRefresh: TokenRefreshService,
    private readonly tokenExpiration: TokenExpirationService,
  ) {}

  /**
   * Refresh expiring tokens every hour
   */
  @Cron(CronExpression.EVERY_HOUR)
  async refreshExpiringTokens() {
    this.logger.log('🔄 Starting scheduled token refresh...');

    try {
      // Find tokens expiring within 30 minutes
      // Add retry logic for database connection
      let expiringAccounts;
      let retries = 3;
      while (retries > 0) {
        try {
          expiringAccounts = await this.tokenExpiration.findExpiringTokens(
            30,
            50, // Process max 50 at a time
          );
          break; // Success, exit retry loop
        } catch (dbError: any) {
          retries--;
          if (dbError.message?.includes('timeout') && retries > 0) {
            this.logger.warn(
              `⚠️ Database timeout, retrying... (${3 - retries}/3)`,
            );
            await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2s before retry
          } else {
            throw dbError; // Re-throw if not timeout or no retries left
          }
        }
      }

      if (!expiringAccounts) {
        this.logger.error('❌ Failed to fetch expiring tokens after retries');
        return;
      }

      if (expiringAccounts.length === 0) {
        this.logger.log('✅ No expiring tokens found');
        return;
      }

      this.logger.log(`Found ${expiringAccounts.length} tokens to refresh`);

      let successCount = 0;
      let failureCount = 0;

      for (const account of expiringAccounts) {
        try {
          if (!account.refreshToken) {
            this.logger.warn(
              `⚠️ Account ${account.id} has no refresh token, skipping`,
            );
            continue;
          }

          let refreshed: any;

          // Refresh based on platform
          if (account.platform === 'youtube' || account.platform === 'google') {
            refreshed = await this.tokenRefresh.refreshGoogleToken(
              account.refreshToken,
            );
          } else if (
            account.platform === 'facebook' ||
            account.platform === 'instagram'
          ) {
            if (
              !process.env.FACEBOOK_APP_ID ||
              !process.env.FACEBOOK_APP_SECRET
            ) {
              this.logger.warn(
                `⚠️ Facebook credentials not configured, skipping ${account.platform} account`,
              );
              continue;
            }

            refreshed = await this.tokenRefresh.refreshFacebookToken(
              account.accessToken || account.refreshToken,
              process.env.FACEBOOK_APP_ID,
              process.env.FACEBOOK_APP_SECRET,
            );
          } else {
            this.logger.warn(
              `⚠️ Unsupported platform ${account.platform} for account ${account.id}`,
            );
            continue;
          }

          // Update account with new token
          await this.prisma.socialAccount.update({
            where: { id: account.id },
            data: {
              accessToken: refreshed.accessToken,
              tokenExpiresAt: refreshed.expiresAt,
            },
          });

          successCount++;
          this.logger.log(
            `✅ Refreshed token for ${account.platform} account ${account.id} (expires in ${this.tokenExpiration.getTimeUntilExpirationHuman(refreshed.expiresAt)})`,
          );
        } catch (error: any) {
          failureCount++;
          const errorMessage =
            error.message || 'Unknown error during token refresh';

          // If refresh token is invalid, mark account as inactive
          if (
            errorMessage.includes('invalid_grant') ||
            errorMessage.includes('expired')
          ) {
            await this.prisma.socialAccount.update({
              where: { id: account.id },
              data: { isActive: false },
            });
            this.logger.warn(
              `⚠️ Marked account ${account.id} as inactive due to invalid refresh token`,
            );
          } else {
            this.logger.error(
              `❌ Failed to refresh token for account ${account.id}: ${errorMessage}`,
            );
          }
        }
      }

      this.logger.log(
        `✅ Token refresh completed: ${successCount} succeeded, ${failureCount} failed`,
      );

      // Log statistics (with error handling)
      try {
        const stats = await this.tokenExpiration.getExpirationStats();
        this.logger.log(
          `📊 Token expiration stats: ${stats.expired} expired, ${stats.expiringIn30Minutes} expiring soon, ${stats.healthy} healthy`,
        );
      } catch (statsError) {
        this.logger.warn('⚠️ Failed to get expiration stats (non-critical):', statsError);
      }
    } catch (error: any) {
      // Don't log full error stack for timeout errors (too verbose)
      if (error.message?.includes('timeout')) {
        this.logger.error(
          `❌ Error in scheduled token refresh: Database connection timeout - ${error.message}`,
        );
      } else {
        this.logger.error('❌ Error in scheduled token refresh:', error);
      }
    }
  }

  /**
   * Manual trigger for token refresh (can be called via API)
   */
  async manualRefresh() {
    this.logger.log('🔄 Manual token refresh triggered');
    await this.refreshExpiringTokens();
  }
}
