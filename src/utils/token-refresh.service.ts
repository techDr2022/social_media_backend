import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface TokenRefreshResult {
  accessToken: string;
  expiresAt: Date;
  expiresIn: number;
}

@Injectable()
export class TokenRefreshService {
  private readonly logger = new Logger(TokenRefreshService.name);

  /**
   * Refresh Google OAuth token with retry logic and enhanced error handling
   */
  async refreshGoogleToken(
    refreshToken: string,
    retries = 3,
  ): Promise<TokenRefreshResult> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await axios.post(
          'https://oauth2.googleapis.com/token',
          new URLSearchParams({
            client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
            client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          }),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        );

        if (!response.data.access_token) {
          throw new Error('No access token in response');
        }

        const expiresAt = new Date(
          Date.now() + response.data.expires_in * 1000,
        );

        this.logger.log(
          `✅ Successfully refreshed Google token (attempt ${attempt})`,
        );

        return {
          accessToken: response.data.access_token,
          expiresAt,
          expiresIn: response.data.expires_in,
        };
      } catch (error: any) {
        const errorMessage =
          error.response?.data?.error_description ||
          error.response?.data?.error ||
          error.message;

        this.logger.error(
          `❌ Token refresh attempt ${attempt}/${retries} failed: ${errorMessage}`,
        );

        // Handle specific errors
        if (error.response?.data?.error === 'invalid_grant') {
          throw new Error(
            'Refresh token expired - user needs to re-authenticate',
          );
        }

        if (error.response?.data?.error === 'invalid_client') {
          throw new Error('Invalid OAuth client credentials');
        }

        // If this was the last attempt, throw the error
        if (attempt === retries) {
          throw new Error(
            `Token refresh failed after ${retries} attempts: ${errorMessage}`,
          );
        }

        // Exponential backoff: wait before retrying
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        this.logger.log(`⏳ Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('Token refresh failed - unexpected error');
  }

  /**
   * Refresh Facebook OAuth token
   */
  async refreshFacebookToken(
    accessToken: string,
    appId: string,
    appSecret: string,
  ): Promise<TokenRefreshResult> {
    try {
      // Facebook tokens are long-lived, but we can extend them
      const response = await axios.get(
        'https://graph.facebook.com/v21.0/oauth/access_token',
        {
          params: {
            grant_type: 'fb_exchange_token',
            client_id: appId,
            client_secret: appSecret,
            fb_exchange_token: accessToken,
          },
        },
      );

      if (!response.data.access_token) {
        throw new Error('No access token in response');
      }

      const expiresAt = new Date(
        Date.now() + (response.data.expires_in || 5184000) * 1000, // Default 60 days
      );

      this.logger.log('✅ Successfully refreshed Facebook token');

      return {
        accessToken: response.data.access_token,
        expiresAt,
        expiresIn: response.data.expires_in || 5184000,
      };
    } catch (error: any) {
      const errorMessage =
        error.response?.data?.error?.message || error.message;
      this.logger.error(`❌ Facebook token refresh failed: ${errorMessage}`);
      throw new Error(`Facebook token refresh failed: ${errorMessage}`);
    }
  }

  /**
   * Get valid token for a social account (auto-refresh if needed)
   */
  async getValidToken(
    platform: string,
    refreshToken: string | null,
    currentAccessToken: string | null,
    tokenExpiresAt: Date | null,
  ): Promise<string> {
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    // Check if token is expired or expiring soon (within 5 minutes)
    const bufferTime = 5 * 60 * 1000; // 5 minutes
    const isExpired =
      !tokenExpiresAt ||
      tokenExpiresAt.getTime() <= Date.now() + bufferTime;

    if (!isExpired && currentAccessToken) {
      this.logger.log(`✅ Token still valid for ${platform}`);
      return currentAccessToken;
    }

    this.logger.log(`🔄 Refreshing expired token for ${platform}`);

    if (platform === 'youtube' || platform === 'google') {
      const refreshed = await this.refreshGoogleToken(refreshToken);
      return refreshed.accessToken;
    }

    if (platform === 'facebook' || platform === 'instagram') {
      if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) {
        throw new Error('Facebook app credentials not configured');
      }
      const refreshed = await this.refreshFacebookToken(
        currentAccessToken || refreshToken,
        process.env.FACEBOOK_APP_ID,
        process.env.FACEBOOK_APP_SECRET,
      );
      return refreshed.accessToken;
    }

    throw new Error(`Unsupported platform for token refresh: ${platform}`);
  }
}
