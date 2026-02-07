// src/social-accounts/social-accounts.service.ts
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokenRefreshService } from '../utils/token-refresh.service';
import { TokenExpirationService } from './token-expiration.service';
import { EncryptionService } from '../common/encryption.service';
import { AppException } from '../common/errors/custom-exception';
import { ErrorCode } from '../common/errors/error-codes';
import axios from 'axios';
import * as fs from 'fs';
import FormData from 'form-data';
import { refreshGoogleToken } from '../utils/google-refresh';

export type TokenStatus = 'healthy' | 'expiring_soon' | 'expired' | 'disconnected';

export interface TokenStatusItem {
  id: string;
  platform: string;
  displayName: string | null;
  username: string | null;
  tokenExpiresAt: Date | null;
  expiresInHuman: string;
  status: TokenStatus;
  canRefresh: boolean;
  reconnectPath: string;
}

@Injectable()
export class SocialAccountsService {
  private readonly logger = new Logger(SocialAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenRefresh: TokenRefreshService,
    private readonly tokenExpiration: TokenExpirationService,
    private readonly encryption: EncryptionService,
  ) {}

  // ---- OAUTH ----

async getValidYoutubeAccessToken(socialAccountId: string) {
  const account = await this.prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
  });

  if (!account || account.platform !== 'youtube') {
    throw new Error('Invalid YouTube account');
  }

  const refreshToken = this.encryption.decrypt(account.refreshToken);
  const accessTokenRaw = this.encryption.decrypt(account.accessToken);

  if (!refreshToken) {
    throw new Error('Missing refresh token');
  }

  // Use TokenRefreshService for automatic refresh with retry logic
  const accessToken = await this.tokenRefresh.getValidToken(
    account.platform,
    refreshToken,
    accessTokenRaw,
    account.tokenExpiresAt,
  );

  // Update token if it was refreshed
  const bufferTime = 5 * 60 * 1000; // 5 minutes
  const isExpired = !account.tokenExpiresAt ||
    account.tokenExpiresAt.getTime() <= Date.now() + bufferTime;

  if (isExpired || accessToken !== accessTokenRaw) {
    const refreshed = await this.tokenRefresh.refreshGoogleToken(refreshToken);

    await this.prisma.socialAccount.update({
      where: { id: account.id },
      data: {
        accessToken: this.encryption.encrypt(refreshed.accessToken),
        tokenExpiresAt: refreshed.expiresAt,
      },
    });

    this.logger.log(`✅ Refreshed YouTube token for account ${account.id}`);
    return refreshed.accessToken;
  }

  this.logger.log(`Using YouTube access token, expires at: ${account.tokenExpiresAt}`);
  return accessToken;
}

  buildYoutubeOAuthUrl(userId: string) {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly',
      ].join(' '),
      state: userId,
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async handleYoutubeOAuthCallback({
    code,
    userId,
  }: {
    code: string;
    userId: string;
  }) {
    // exchange code
    const tokenRes = await axios.post(
      'https://oauth2.googleapis.com/token',
      {
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI,
      }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    // fetch channel
    const channelRes = await axios.get(
      'https://www.googleapis.com/youtube/v3/channels',
      {
        headers: { Authorization: `Bearer ${access_token}` },
        params: { part: 'snippet', mine: true },
      }
    );

    const channel = channelRes.data.items?.[0];
    if (!channel) {
      throw new BadRequestException('No YouTube channel found');
    }

    return this.prisma.socialAccount.create({
      data: {
        userId,
        platform: 'youtube',
        externalId: channel.id,
        displayName: channel.snippet.title,
        accessToken: this.encryption.encrypt(access_token),
        refreshToken: this.encryption.encrypt(refresh_token),
        tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
      },
    });
  }

  // ---- TEST UPLOAD ----

  async testYoutubeUpload(userId: string) {
    const account = await this.prisma.socialAccount.findFirst({
      where: { userId, platform: 'youtube', isActive: true },
    });

    if (!account) {
      throw new BadRequestException('No YouTube account connected');
    }

    const filePath = 'uploads/test.mp4';
    if (!fs.existsSync(filePath)) {
      throw new BadRequestException('uploads/test.mp4 not found');
    }

    const form = new FormData();
    form.append(
      'metadata',
      JSON.stringify({
        snippet: {
          title: 'Test Upload from API',
          description: 'Testing YouTube upload',
        },
        status: { privacyStatus: 'private' },
      }),
      { contentType: 'application/json' }
    );
    form.append('media', fs.createReadStream(filePath));

    const accessToken =
  await this.getValidYoutubeAccessToken(account.id);

const res = await axios.post(
  'https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status',
  form,
  {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
  }
);


    return {
      success: true,
      videoId: res.data.id,
    };
  }

  // ---- GOOGLE MY BUSINESS (GMB) ----

  async getValidGmbAccessToken(socialAccountId: string) {
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });

    if (!account || account.platform !== 'gmb') {
      throw new Error('Invalid GMB account');
    }

    const refreshToken = this.encryption.decrypt(account.refreshToken);
    if (!refreshToken) {
      throw new Error('Missing refresh token');
    }

    // Check if token is expired or expiring soon (within 5 minutes)
    const now = new Date();
    const expiresAt = account.tokenExpiresAt;
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

    if (!expiresAt || expiresAt <= fiveMinutesFromNow) {
      this.logger.log(`GMB token expired or expiring soon, refreshing...`);
      
      // Use GMB-specific credentials for token refresh
      const gmbClientId =
        process.env.GMB_GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID!;
      const gmbClientSecret =
        process.env.GMB_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET!;
      
      const refreshed = await this.refreshGmbToken(refreshToken, gmbClientId, gmbClientSecret);
      
      const expiresIn = refreshed.expiresIn || 3600; // Default to 1 hour
      const newExpiresAt = new Date(now.getTime() + expiresIn * 1000);

      await this.prisma.socialAccount.update({
        where: { id: account.id },
        data: {
          accessToken: this.encryption.encrypt(refreshed.accessToken),
          tokenExpiresAt: newExpiresAt,
        },
      });

      return refreshed.accessToken;
    }

    const accessToken = this.encryption.decrypt(account.accessToken);
    this.logger.log(`Using GMB access token, expires at: ${account.tokenExpiresAt}`);
    return accessToken;
  }

  /**
   * Refresh GMB token using GMB-specific credentials
   */
  private async refreshGmbToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    try {
      const response = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 30000,
        },
      );

      if (!response.data.access_token) {
        throw new Error('No access token in response');
      }

      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in || 3600,
      };
    } catch (error: any) {
      const errorMessage =
        error.response?.data?.error_description ||
        error.response?.data?.error ||
        error.message;
      this.logger.error(`GMB token refresh failed: ${errorMessage}`);
      throw new Error(`GMB token refresh failed: ${errorMessage}`);
    }
  }

  buildGmbOAuthUrl(userId: string) {
    // Ensure redirect URI is a full URL (not just a path)
    let redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI_GMB;
    if (!redirectUri) {
      // Fallback: replace /youtube with /gmb in the YouTube redirect URI
      const youtubeUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:3001/social-accounts/callback/youtube';
      redirectUri = youtubeUri.replace('/youtube', '/gmb');
    }
    
    // Ensure it's a full URL (starts with http:// or https://)
    if (!redirectUri.startsWith('http://') && !redirectUri.startsWith('https://')) {
      // If it's just a path, prepend the frontend URL
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
      redirectUri = `${frontendUrl}${redirectUri.startsWith('/') ? '' : '/'}${redirectUri}`;
    }

    // Prefer dedicated GMB client if provided, otherwise fall back to main Google OAuth client
    const gmbClientId =
      process.env.GMB_GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID!;

    const params = new URLSearchParams({
      client_id: gmbClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/business.manage',
        'https://www.googleapis.com/auth/businesscommunications',
      ].join(' '),
      state: userId,
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async handleGmbOAuthCallback({
    code,
    userId,
  }: {
    code: string;
    userId: string;
  }) {
    // Prefer dedicated GMB client/secret if provided, otherwise fall back to main Google OAuth client
    const clientId =
      process.env.GMB_GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret =
      process.env.GMB_GOOGLE_CLIENT_SECRET ||
      process.env.GOOGLE_OAUTH_CLIENT_SECRET;

    // Ensure redirect URI is a full URL
    let redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI_GMB;
    if (!redirectUri) {
      const youtubeUri =
        process.env.GOOGLE_OAUTH_REDIRECT_URI ||
        'http://localhost:3001/social-accounts/callback/youtube';
      redirectUri = youtubeUri.replace('/youtube', '/gmb');
    }
    // Ensure it's a full URL
    if (
      !redirectUri.startsWith('http://') &&
      !redirectUri.startsWith('https://')
    ) {
      const frontendUrl =
        process.env.FRONTEND_URL || 'http://localhost:3001';
      redirectUri = `${frontendUrl}${
        redirectUri.startsWith('/') ? '' : '/'
      }${redirectUri}`;
    }

    // Log for debugging (don't log full secret)
    this.logger.log(
      `GMB OAuth callback - Client ID: ${clientId?.substring(0, 20)}..., Redirect URI: ${redirectUri}`,
    );

    // Exchange code for tokens with timeout
    const tokenRes = await axios.post(
      'https://oauth2.googleapis.com/token',
      {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      },
      {
        timeout: 30000, // 30 second timeout
      },
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;

      // Fetch GMB accounts to get account info with timeout and pagination
      try {
        // Fetch all accounts with pagination support
        const allAccounts: any[] = [];
        let nextPageToken: string | undefined = undefined;
        let pageCount = 0;
        const maxPages = 100; // Safety limit to prevent infinite loops

        do {
          const params: any = {};
          if (nextPageToken) {
            params.pageToken = nextPageToken;
          }

          const accountsRes = await axios.get(
            'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
            {
              headers: { Authorization: `Bearer ${access_token}` },
              params,
              timeout: 30000, // 30 second timeout
            }
          );

          const accounts = accountsRes.data.accounts || [];
          allAccounts.push(...accounts);
          
          nextPageToken = accountsRes.data.nextPageToken;
          pageCount++;

          this.logger.log(
            `Fetched GMB accounts page ${pageCount}: ${accounts.length} accounts (total so far: ${allAccounts.length})`
          );

          // Safety check to prevent infinite loops
          if (pageCount >= maxPages) {
            this.logger.warn(`Reached max pages limit (${maxPages}), stopping pagination`);
            break;
          }
        } while (nextPageToken);

        if (allAccounts.length === 0) {
          throw new BadRequestException('No Google My Business accounts found');
        }

        this.logger.log(`Total GMB accounts found: ${allAccounts.length}`);

      // Save ALL GMB accounts, not just the first one
      const createdAccounts: any[] = [];
      const scopes = 'https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/businesscommunications';

      for (const account of allAccounts) {
        const accountId = account.name?.split('/').pop() || account.name || 'unknown';
        // Use Google's readable name: accountName (business/person name), fallback to type + ID
        const displayName =
          account.accountName?.trim() ||
          (account.organizationInfo?.address as any)?.organization?.trim() ||
          (account.type === 'LOCATION_GROUP' ? `Location group · ${accountId}` : account.type === 'PERSONAL' ? 'Personal account' : `Account · ${accountId}`);

        // Check if account already exists
        const existingAccount = await this.prisma.socialAccount.findFirst({
          where: {
            userId,
            platform: 'gmb',
            externalId: accountId,
          },
        });

        if (existingAccount) {
          // Update existing account
          const updated = await this.prisma.socialAccount.update({
            where: { id: existingAccount.id },
            data: {
              displayName,
              accessToken: this.encryption.encrypt(access_token),
              refreshToken: this.encryption.encrypt(refresh_token),
              tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
              isActive: true,
              scopes,
            },
          });
          createdAccounts.push(updated);
        } else {
          // Create new account
          const created = await this.prisma.socialAccount.create({
            data: {
              userId,
              platform: 'gmb',
              accountType: account.type || 'LOCATION_GROUP',
              externalId: accountId,
              displayName,
              accessToken: this.encryption.encrypt(access_token),
              refreshToken: this.encryption.encrypt(refresh_token),
              tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
              scopes,
            },
          });
          createdAccounts.push(created);
        }
      }

      // Return the first account for backward compatibility, but all are saved
      return createdAccounts[0];
    } catch (error: any) {
      // Log full error from Google to diagnose 403
      const status = error.response?.status;
      const googleError = error.response?.data?.error;
      const reason = googleError?.message || error.message;
      const code = googleError?.code || error.response?.status;
      this.logger.error(
        `Error fetching GMB accounts: ${reason} (status=${status}, code=${code})`
      );
      if (error.response?.data) {
        this.logger.debug(`GMB API response: ${JSON.stringify(error.response.data)}`);
      }

      // For 429 (rate limit) errors, save tokens and tell user to wait/request quota
      if (error.response?.status === 429) {
        this.logger.warn('GMB API rate limit exceeded (429). Saving tokens. User needs to wait or request quota increase.');
        
        // Extract quota info from Google's error
        const quotaInfo = error.response?.data?.error?.details?.find((d: any) => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
        const quotaLimit = quotaInfo?.metadata?.quota_limit_value || 'unknown';
        
        // Check if pending sync account already exists
        const pendingExternalId = `pending-sync-${userId}`;
        const existingPending = await this.prisma.socialAccount.findFirst({
          where: {
            userId,
            platform: 'gmb',
            externalId: pendingExternalId,
          },
        });
        
        // Create or update placeholder account
        const placeholderAccount = existingPending
          ? await this.prisma.socialAccount.update({
              where: { id: existingPending.id },
              data: {
                accessToken: this.encryption.encrypt(access_token),
                refreshToken: this.encryption.encrypt(refresh_token),
                tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
                isActive: true,
                scopes: 'https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/businesscommunications',
                displayName: 'Google My Business (Rate Limited)',
              },
            })
          : await this.prisma.socialAccount.create({
              data: {
                userId,
                platform: 'gmb',
                externalId: pendingExternalId,
                displayName: 'Google My Business (Rate Limited)',
                accessToken: this.encryption.encrypt(access_token),
                refreshToken: this.encryption.encrypt(refresh_token),
                tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
                scopes: 'https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/businesscommunications',
                accountType: 'PENDING_SYNC',
              },
            });
        
        throw new BadRequestException(
          `Rate limit exceeded (429). Your quota is ${quotaLimit} requests/minute. ` +
          `Tokens have been saved. ` +
          `Wait 1 minute and try "Sync Locations" again, or request quota increase: ` +
          `https://console.cloud.google.com/apis/api/mybusinessaccountmanagement.googleapis.com/quotas?project=568077365772`
        );
      }

      // For 403 errors, save tokens but mark account as needing sync
      // User can sync accounts later once API is enabled
      if (error.response?.status === 403) {
        // Extract activation URL from Google's error response if available
        const googleErrorDetails = error.response?.data?.error?.details || [];
        const activationUrl = googleErrorDetails.find((d: any) => d['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')?.metadata?.activationUrl
          || googleErrorDetails.find((d: any) => d.links)?.links?.[0]?.url
          || 'https://console.cloud.google.com/apis/library/mybusinessaccountmanagement.googleapis.com';
        
        this.logger.warn(
          `GMB API access denied (403). Saving tokens for later sync. ` +
          `Enable API at: ${activationUrl}`
        );
        
        // Check if pending sync account already exists
        const pendingExternalId = `pending-sync-${userId}`;
        const existingPending = await this.prisma.socialAccount.findFirst({
          where: {
            userId,
            platform: 'gmb',
            externalId: pendingExternalId,
          },
        });
        
        // Create or update placeholder account that can be synced later
        const placeholderAccount = existingPending
          ? await this.prisma.socialAccount.update({
              where: { id: existingPending.id },
              data: {
                accessToken: this.encryption.encrypt(access_token),
                refreshToken: this.encryption.encrypt(refresh_token),
                tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
                isActive: true,
                scopes: 'https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/businesscommunications',
                displayName: 'Google My Business (Pending Sync)',
              },
            })
          : await this.prisma.socialAccount.create({
              data: {
                userId,
                platform: 'gmb',
                externalId: pendingExternalId,
                displayName: 'Google My Business (Pending Sync)',
                accessToken: this.encryption.encrypt(access_token),
                refreshToken: this.encryption.encrypt(refresh_token),
                tokenExpiresAt: new Date(Date.now() + expires_in * 1000),
                scopes: 'https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/businesscommunications',
                accountType: 'PENDING_SYNC',
              },
            });
        
        // Build helpful message with exact API name and Google's activation URL
        const apiName = 'My Business Account Management API';
        const googleMessage = error.response?.data?.error?.message || '';
        throw new BadRequestException(
          `403 Error: ${googleMessage.split('.')[0]}. ` +
          `We use 3 different Google APIs: 1) "My Business Account Management API" (for listing accounts - REQUIRED), ` +
          `2) "My Business Business Information API" (for locations), 3) "Google My Business API" (for reviews). ` +
          `You enabled #3, but we need #1 first. ` +
          `Tokens have been saved. Enable it here: ${activationUrl} ` +
          `Then wait 1-2 minutes and use "Sync Locations" to fetch your accounts.`
        );
      }
      
      // For other errors, provide a helpful message
      const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
      throw new BadRequestException(
        `Failed to fetch Google My Business accounts: ${errorMessage}. ` +
        'Please check your Google Cloud Console settings and try again.'
      );
    }
  }

  // ---- FACEBOOK ----

  async getValidFacebookAccessToken(socialAccountId: string) {
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });

    if (!account || account.platform !== 'facebook') {
      throw new Error('Invalid Facebook account');
    }

    const accessToken = this.encryption.decrypt(account.accessToken);
    if (!accessToken) {
      throw new Error('Missing access token');
    }

    // Facebook page tokens are long-lived (60 days)
    return accessToken;
  }

  // Facebook Pages (exclusively) - uses FACEBOOK_APP_ID and FACEBOOK_APP_SECRET
  buildFacebookOAuthUrl(userId: string) {
    const appId = process.env.FACEBOOK_APP_ID;
    if (!appId) {
      throw new Error('FACEBOOK_APP_ID must be set for Facebook Pages');
    }
    
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: process.env.FACEBOOK_OAUTH_REDIRECT_URI || 'http://localhost:3000/social-accounts/callback/facebook',
      scope: [
        'pages_show_list',
        'pages_read_engagement',
        'pages_manage_posts',
        'pages_read_user_content',
        // No Instagram scopes - this is for Facebook Pages only
      ].join(','),
      response_type: 'code',
      state: userId,
    });

    return `https://www.facebook.com/v21.0/dialog/oauth?${params}`;
  }

  // Facebook Pages callback (exclusively) - only creates Facebook Page accounts
  async handleFacebookOAuthCallback({
    code,
    userId,
  }: {
    code: string;
    userId: string;
  }) {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    
    if (!appId || !appSecret) {
      throw new Error('FACEBOOK_APP_ID and FACEBOOK_APP_SECRET must be set for Facebook Pages');
    }
    
    // Exchange code for access token
    const tokenRes = await axios.post(
      'https://graph.facebook.com/v21.0/oauth/access_token',
      {
        client_id: appId,
        client_secret: appSecret,
        code,
        redirect_uri: process.env.FACEBOOK_OAUTH_REDIRECT_URI || 'http://localhost:3000/social-accounts/callback/facebook',
      }
    );

    const { access_token, expires_in } = tokenRes.data;

    // Fetch user's Facebook Pages (no Instagram fields - Facebook Pages only)
    const pagesRes = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
      params: {
        access_token,
        fields: 'id,name,access_token',
      },
    });

    const pages = pagesRes.data.data || [];
    
    // Create accounts for each page (Facebook Pages only, no Instagram)
    const createdAccounts: any[] = [];
    for (const page of pages) {
      const account = await this.prisma.socialAccount.create({
        data: {
          userId,
          platform: 'facebook',
          externalId: page.id,
          displayName: page.name,
          accessToken: this.encryption.encrypt(page.access_token),
          tokenExpiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
          accountType: 'page',
        },
      });
      createdAccounts.push(account);
    }

    return createdAccounts;
  }

  // ---- INSTAGRAM ----

  async getValidInstagramAccessToken(socialAccountId: string) {
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });

    if (!account || account.platform !== 'instagram') {
      throw new Error('Invalid Instagram account');
    }

    account.accessToken = this.encryption.decrypt(account.accessToken);
    if (!account.accessToken) {
      throw new Error('Missing access token');
    }

    // Check if token is expired or will expire soon (within 1 hour)
    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour buffer

    // If no expiration date, this is likely an old account created before we added expiration tracking
    // Try to validate the token by making a test API call, and if it works, estimate expiration
    if (!account.tokenExpiresAt) {
      console.warn(`[Instagram Token] ⚠️ No expiration date set in database. This might be an old account.`);
      console.warn(`[Instagram Token] Attempting to validate token and set expiration date...`);

      try {
        // Try to validate token by fetching user info
        const validationRes = await axios.get(
          `https://graph.instagram.com/v24.0/me`,
          {
            params: {
              fields: 'id,username',
              access_token: account.accessToken,
            },
          }
        );
        
        if (validationRes.data?.id) {
          // Token is valid! Set expiration to a safe default (60 days from now, as if it's a long-lived token)
          // If it's actually short-lived, it will fail on next use and user will reconnect
          const estimatedExpiration = new Date(Date.now() + (60 * 24 * 60 * 60 * 1000)); // 60 days
          
          await this.prisma.socialAccount.update({
            where: { id: account.id },
            data: {
              tokenExpiresAt: estimatedExpiration,
            },
          });
          
          console.log(`[Instagram Token] ✅ Token validated and expiration date set: ${estimatedExpiration.toISOString()}`);
          console.log(`[Instagram Token] Note: If token is actually short-lived, it may expire sooner. User will need to reconnect if it fails.`);
          
          // Update account object for rest of function
          account.tokenExpiresAt = estimatedExpiration;
        } else {
          throw new Error('Token validation failed - no user ID in response');
        }
      } catch (validationError: any) {
        console.error(`[Instagram Token] ❌ Token validation failed:`, validationError.response?.data?.error?.message || validationError.message);
        throw new Error('Instagram token has no expiration date and validation failed. The token may be expired. Please disconnect and reconnect your Instagram account to get a new token with proper expiration tracking.');
      }
    }
    
    // Check if token is expired
    if (account.tokenExpiresAt <= now) {
      console.log(`[Instagram Token] ❌ Token is expired. Expires at: ${account.tokenExpiresAt.toISOString()}, Current: ${now.toISOString()}`);
      throw new Error(`Instagram token expired at ${account.tokenExpiresAt.toISOString()}. Please disconnect and reconnect your Instagram account to get a new token.`);
    }
    
    // Check if token expires soon (within 1 hour) - try to refresh if it's a long-lived token
    // Only attempt refresh if token was originally long-lived (expires more than 2 hours from now originally)
    // This avoids trying to refresh short-lived tokens (which can't be refreshed)
    const hoursUntilExpiration = (account.tokenExpiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
    
    if (account.tokenExpiresAt <= oneHourFromNow) {
      console.log(`[Instagram Token] Token expiring soon. Expires at: ${account.tokenExpiresAt.toISOString()}, Current: ${now.toISOString()}, Hours until expiration: ${hoursUntilExpiration.toFixed(2)}`);
      
      // Only try to refresh if this looks like a long-lived token (was valid for more than 2 hours)
      // Short-lived tokens (1 hour) cannot be refreshed
      // Per official docs: Tokens must be at least 24 hours old to refresh
      if (hoursUntilExpiration > 0.5) { // If it has more than 30 minutes, it might be refreshable
        try {
          console.log(`[Instagram Token] Attempting to refresh token (looks like long-lived token)...`);
          
          // Get token creation time (if available) or estimate from expiration
          // If we don't have createdAt, estimate based on expiration (assuming it's a 60-day token)
          const tokenCreatedAt = account.createdAt || new Date(account.tokenExpiresAt.getTime() - (60 * 24 * 60 * 60 * 1000));
          
          const refreshedToken = await this.refreshInstagramToken(
            account.accessToken,
            tokenCreatedAt,
            account.tokenExpiresAt,
            account.scopes // Pass permissions for validation
          );
          
          // Update account with new token (encrypt before storing)
          await this.prisma.socialAccount.update({
            where: { id: account.id },
            data: {
              accessToken: this.encryption.encrypt(refreshedToken.accessToken),
              tokenExpiresAt: refreshedToken.expiresAt,
            },
          });

          console.log(`[Instagram Token] ✅ Token refreshed successfully. New expiration: ${refreshedToken.expiresAt.toISOString()}`);
          return refreshedToken.accessToken;
        } catch (refreshError: any) {
          console.warn(`[Instagram Token] ⚠️ Failed to refresh token:`, refreshError.message);
          
          // If token is too new (<24 hours), log but don't throw error
          // The token should still work, we just can't refresh it yet
          if (refreshError.message.includes('24 hours')) {
            console.log(`[Instagram Token] Token is too new to refresh. Will try again later.`);
            // Continue using current token - it's still valid
          } else {
            // For other errors (expired, etc.), continue with current token
            // User will get error when token actually expires
            console.warn(`[Instagram Token] Cannot refresh token. Will use current token until it expires.`);
          }
        }
      } else {
        console.warn(`[Instagram Token] ⚠️ Token expires soon but appears to be short-lived (cannot refresh). User needs to reconnect.`);
      }
    }

    console.log(`[Instagram Token] ✅ Token is valid. Expires at: ${account.tokenExpiresAt.toISOString()}, Hours remaining: ${hoursUntilExpiration.toFixed(2)}`);
    return account.accessToken;
  }

  /**
   * Refresh Instagram long-lived access token
   * Instagram long-lived tokens (60 days) can be refreshed to extend for another 60 days
   * 
   * Requirements (per official docs):
   * - Token must be at least 24 hours old
   * - Token must be valid (not expired)
   * - User must have granted instagram_business_basic permission
   * - Tokens not refreshed in 60 days will expire and cannot be refreshed
   * 
   * See: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login#get-a-long-lived-access-token
   */
  private async refreshInstagramToken(
    accessToken: string,
    tokenCreatedAt: Date,
    tokenExpiresAt: Date,
    permissions?: string | null
  ): Promise<{ accessToken: string; expiresAt: Date }> {
    try {
      const now = new Date();
      const tokenAgeInHours = (now.getTime() - tokenCreatedAt.getTime()) / (1000 * 60 * 60);
      
      console.log(`[Instagram Token Refresh] Attempting to refresh token...`);
      console.log(`[Instagram Token Refresh] Token age: ${tokenAgeInHours.toFixed(2)} hours`);
      console.log(`[Instagram Token Refresh] Token expires at: ${tokenExpiresAt.toISOString()}`);
      
      // Per official docs: Token must be at least 24 hours old to refresh
      if (tokenAgeInHours < 24) {
        throw new Error(`Token is only ${tokenAgeInHours.toFixed(2)} hours old. Tokens must be at least 24 hours old before they can be refreshed.`);
      }
      
      // Per official docs: Token must be valid (not expired)
      if (tokenExpiresAt <= now) {
        throw new Error(`Token has expired. Cannot refresh expired tokens. Please reconnect your Instagram account.`);
      }
      
      // Per official docs: User must have granted instagram_business_basic permission
      // Note: API will reject if permission is missing, but we log it for debugging
      if (permissions) {
        const hasBusinessBasic = permissions.includes('instagram_business_basic') || permissions.includes('business_basic');
        console.log(`[Instagram Token Refresh] Permissions: ${permissions}`);
        console.log(`[Instagram Token Refresh] Has instagram_business_basic: ${hasBusinessBasic}`);
        if (!hasBusinessBasic) {
          console.warn(`[Instagram Token Refresh] ⚠️ Missing instagram_business_basic permission. Refresh may fail.`);
        }
      }
      
      console.log(`[Instagram Token Refresh] Token meets refresh requirements (>=24 hours old, not expired)`);
      
      const refreshRes = await axios.get(
        'https://graph.instagram.com/refresh_access_token',
        {
          params: {
            grant_type: 'ig_refresh_token',
            access_token: accessToken, // Current long-lived token
          },
        }
      );

      if (!refreshRes.data?.access_token) {
        throw new Error('Instagram token refresh response missing access_token');
      }

      const newAccessToken = refreshRes.data.access_token;
      const expiresIn = refreshRes.data.expires_in || 5183944; // Default to 60 days (per docs: 5183944 seconds)
      const expiresAt = new Date(Date.now() + expiresIn * 1000);

      console.log(`[Instagram Token Refresh] ✅ Token refreshed successfully`);
      console.log(`[Instagram Token Refresh] New expiration: ${expiresIn} seconds (${(expiresIn / 86400).toFixed(1)} days)`);
      console.log(`[Instagram Token Refresh] New token expires at: ${expiresAt.toISOString()}`);
      
      return {
        accessToken: newAccessToken,
        expiresAt,
      };
    } catch (error: any) {
      const errorMsg = error.response?.data?.error?.message || error.message;
      console.error(`[Instagram Token Refresh] ❌ Refresh failed:`, errorMsg);
      
      // Provide user-friendly error message
      if (errorMsg.includes('24 hours')) {
        throw new Error(`Token is too new to refresh. Please wait until the token is at least 24 hours old. ${errorMsg}`);
      } else if (errorMsg.includes('expired')) {
        throw new Error(`Cannot refresh expired token. Please reconnect your Instagram account to get a new token.`);
      } else {
        throw new Error(`Failed to refresh Instagram token: ${errorMsg}`);
      }
    }
  }

  // Instagram Login (without Facebook Page) - uses Instagram App ID/Secret
  buildInstagramOAuthUrl(userId: string) {
    // Instagram Login uses Instagram App ID/Secret (not Facebook App ID/Secret)
    const appId = process.env.INSTAGRAM_APP_ID;
    if (!appId) {
      console.error('[Instagram OAuth] INSTAGRAM_APP_ID is not set!');
      console.error('[Instagram OAuth] Current env vars:', {
        INSTAGRAM_APP_ID: process.env.INSTAGRAM_APP_ID,
        FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID,
      });
      throw new Error('INSTAGRAM_APP_ID must be set for Instagram Login (without Facebook Page). Please set INSTAGRAM_APP_ID=2367537797049461 in your .env file and restart the backend.');
    }
    
    console.log(`[Instagram OAuth] Using Instagram App ID: ${appId}`);
    
    const redirectUri = process.env.INSTAGRAM_OAUTH_REDIRECT_URI || 
      'http://localhost:3000/social-accounts/callback/instagram';
    
    // Instagram API with Instagram Login - does NOT require Facebook Page
    // Uses new scope values (old ones deprecated Jan 27, 2025)
    // See: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      scope: [
        'instagram_business_basic',           // New scope (replaces business_basic)
        'instagram_business_content_publish', // New scope (replaces business_content_publish)
        'instagram_business_manage_comments', // New scope (replaces business_manage_comments)
        'instagram_business_manage_messages', // New scope (replaces business_manage_messages)
      ].join(','),
      response_type: 'code',
      state: userId,
    });

    // Instagram Login uses Instagram's OAuth endpoint
    // See: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
    const oauthUrl = `https://www.instagram.com/oauth/authorize?${params}`;
    console.log(`[Instagram OAuth] Generated OAuth URL (first 200 chars):`, oauthUrl.substring(0, 200));
    console.log(`[Instagram OAuth] State parameter in URL:`, userId);
    console.log(`[Instagram OAuth] Full params:`, Object.fromEntries(params.entries()));
    return oauthUrl;
  }

  // Instagram with Facebook Login (with Facebook Page) - uses INSTAGRAM_WITH_FB_APP_ID and INSTAGRAM_WITH_FB_APP_SECRET
  buildInstagramWithFacebookOAuthUrl(userId: string) {
    // Instagram with Facebook Login uses separate App ID/Secret (different from Facebook Pages)
    const appId = process.env.INSTAGRAM_WITH_FB_APP_ID;
    if (!appId) {
      throw new Error('INSTAGRAM_WITH_FB_APP_ID must be set for Instagram with Facebook Login (with Facebook Page)');
    }
    
    const redirectUri = process.env.INSTAGRAM_WITH_FB_OAUTH_REDIRECT_URI || 
      'http://localhost:3000/social-accounts/callback/instagram-with-fb';
    
    // Instagram API with Facebook Login - requires Facebook Page
    // See: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      scope: [
        'pages_show_list',        // To list Facebook Pages
        'pages_read_engagement',  // To read page engagement
        'instagram_basic',         // Instagram basic access
        'instagram_content_publish', // Instagram content publishing
      ].join(','),
      response_type: 'code',
      state: userId,
    });

    // Instagram with Facebook Login uses Facebook's OAuth endpoint
    return `https://www.facebook.com/v21.0/dialog/oauth?${params}`;
  }

  // Instagram with Facebook Login callback - creates Instagram accounts from Facebook Pages
  async handleInstagramWithFacebookOAuthCallback({
    code,
    userId,
  }: {
    code: string;
    userId: string;
  }) {
    const appId = process.env.INSTAGRAM_WITH_FB_APP_ID;
    const appSecret = process.env.INSTAGRAM_WITH_FB_APP_SECRET;
    
    if (!appId || !appSecret) {
      throw new Error('INSTAGRAM_WITH_FB_APP_ID and INSTAGRAM_WITH_FB_APP_SECRET must be set for Instagram with Facebook Login');
    }
    
    const redirectUri = process.env.INSTAGRAM_WITH_FB_OAUTH_REDIRECT_URI || 
      'http://localhost:3000/social-accounts/callback/instagram-with-fb';

    // Exchange code for access token
    const tokenRes = await axios.post(
      'https://graph.facebook.com/v21.0/oauth/access_token',
      {
        client_id: appId,
        client_secret: appSecret,
        code,
        redirect_uri: redirectUri,
      }
    );

    const { access_token, expires_in } = tokenRes.data;

    // Fetch user's Facebook Pages with Instagram Business/Creator Accounts
    const pagesRes = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
      params: {
        access_token,
        fields: 'id,name,access_token,instagram_business_account',
      },
    });

    const pages = pagesRes.data.data || [];
    
    // Create Instagram accounts for pages that have Instagram Business/Creator Account
    const createdAccounts: any[] = [];
    for (const page of pages) {
      if (page.instagram_business_account) {
        try {
          const igAccountRes = await axios.get(
            `https://graph.facebook.com/v21.0/${page.instagram_business_account.id}`,
            {
              params: {
                access_token: page.access_token,
                fields: 'id,username',
              },
            }
          );

          const igAccount = igAccountRes.data;
          // Check if Instagram account already exists (to avoid duplicates)
          const existingIgAccount = await this.prisma.socialAccount.findFirst({
            where: {
              userId,
              platform: 'instagram',
              externalId: igAccount.id,
            },
          });

          const encryptedPageToken = this.encryption.encrypt(page.access_token);
          let savedAccount;
          if (existingIgAccount) {
            // Update existing Instagram account
            savedAccount = await this.prisma.socialAccount.update({
              where: { id: existingIgAccount.id },
              data: {
                displayName: igAccount.username || `Instagram ${igAccount.id}`,
                username: igAccount.username,
                accessToken: encryptedPageToken,
                tokenExpiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
                isActive: true,
              },
            });
            console.log(`✅ Updated existing Instagram account: ${igAccount.username || igAccount.id}`);
          } else {
            // Create new Instagram account
            savedAccount = await this.prisma.socialAccount.create({
              data: {
                userId,
                platform: 'instagram',
                externalId: igAccount.id,
                displayName: igAccount.username || `Instagram ${igAccount.id}`,
                username: igAccount.username,
                accessToken: encryptedPageToken,
                tokenExpiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
                accountType: 'business',
              },
            });
            console.log(`✅ Created new Instagram account: ${igAccount.username || igAccount.id}`);
          }
          
          if (savedAccount) {
            createdAccounts.push(savedAccount);
          }
        } catch (igError: any) {
          console.warn('Failed to fetch Instagram account:', igError.message);
          // Continue even if Instagram account fetch fails
        }
      }
    }

    return createdAccounts;
  }

  // Instagram Login callback (without Facebook Page) - uses Instagram App ID/Secret
  async handleInstagramOAuthCallback({
    code,
    userId,
  }: {
    code: string;
    userId: string;
  }) {
    // Instagram Login uses Instagram App ID/Secret (not Facebook App ID/Secret)
    const appId = process.env.INSTAGRAM_APP_ID;
    const appSecret = process.env.INSTAGRAM_APP_SECRET;
    
    if (!appId || !appSecret) {
      throw new Error('INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET must be set for Instagram Login');
    }
    // Use Instagram-specific redirect URI if set, otherwise derive from Facebook
    const redirectUri = process.env.INSTAGRAM_OAUTH_REDIRECT_URI || 
      (process.env.FACEBOOK_OAUTH_REDIRECT_URI || 'http://localhost:3000/social-accounts/callback/facebook').replace('/callback/facebook', '/callback/instagram');

    // Exchange code for access token
    // Instagram Login uses Instagram's token endpoint (not Facebook's Graph API)
    // See: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
    console.log(`[Instagram OAuth] Exchanging code for access token using Instagram endpoint`);
    console.log(`[Instagram OAuth] Redirect URI: ${redirectUri}`);
    
    let tokenRes;
    try {
      tokenRes = await axios.post(
        'https://api.instagram.com/oauth/access_token', // Instagram token endpoint
        new URLSearchParams({ // Must be x-www-form-urlencoded
          client_id: appId,
          client_secret: appSecret,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );
    } catch (tokenError: any) {
      console.error(`[Instagram OAuth] Token exchange failed:`, tokenError.response?.data || tokenError.message);
      console.error(`[Instagram OAuth] Request details:`, {
        endpoint: 'https://api.instagram.com/oauth/access_token',
        client_id: appId,
        redirect_uri: redirectUri,
        code_length: code?.length,
      });
      throw new Error(`Failed to exchange code for access token: ${tokenError.response?.data?.error?.message || tokenError.message}`);
    }

    console.log(`[Instagram OAuth] Token exchange response:`, {
      status: tokenRes.status,
      data_keys: Object.keys(tokenRes.data || {}),
      full_data: tokenRes.data, // Log full response for debugging
    });

    // Instagram Login token response format (per official docs):
    // {
    //   "data": [
    //     {
    //       "access_token": "...",
    //       "user_id": "...",
    //       "permissions": "..."
    //     }
    //   ]
    // }
    // But sometimes it might be a direct object, so handle both formats
    let tokenData: any;
    if (tokenRes.data?.data && Array.isArray(tokenRes.data.data) && tokenRes.data.data.length > 0) {
      // Official format: response has data array
      tokenData = tokenRes.data.data[0];
      console.log(`[Instagram OAuth] Using official response format (data array)`);
    } else if (tokenRes.data?.access_token) {
      // Alternative format: direct object
      tokenData = tokenRes.data;
      console.log(`[Instagram OAuth] Using direct response format`);
    } else {
      throw new Error(`Unexpected token response format: ${JSON.stringify(tokenRes.data)}`);
    }

    const { access_token, user_id: igAccountIdRaw, permissions } = tokenData;
    const expires_in = tokenData.expires_in; // Short-lived tokens don't always include expires_in
    
    console.log(`[Instagram OAuth] Extracted token data:`, {
      has_access_token: !!access_token,
      has_user_id: !!igAccountIdRaw,
      has_permissions: !!permissions,
      permissions: permissions,
      expires_in: expires_in,
    });

    // Convert user_id to string (Prisma expects externalId to be String)
    const igAccountId = String(igAccountIdRaw);

    console.log(`[Instagram OAuth] Got access token, user_id: ${igAccountId} (type: ${typeof igAccountIdRaw}), expires_in: ${expires_in}`);

    if (!igAccountId) {
      throw new Error('Instagram token response missing user_id. This should not happen.');
    }

    // Instagram Login - use the user_id directly from token response
    // See: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
    let igUsername: string | null = null;
    let igAccessToken = access_token;
    let tokenExpiresAt: Date | null = null;
    let refreshToken: string | null = null;

    // Exchange short-lived token (1 hour) for long-lived token (60 days)
    // Instagram Login tokens from api.instagram.com/oauth/access_token are SHORT-LIVED (~1 hour)
    // We need to exchange them for LONG-LIVED tokens (60 days) using Instagram Graph API
    // For Instagram Login Business Login, we use graph.instagram.com endpoint
    // See: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login#get-a-long-lived-access-token
    console.log(`[Instagram OAuth] Short-lived token expires in: ${expires_in} seconds (${expires_in ? (expires_in / 3600).toFixed(2) : 'unknown'} hours)`);
    console.log(`[Instagram OAuth] Attempting to exchange for long-lived token (60 days)...`);
    
    try {
      // Exchange short-lived token for long-lived token (60 days)
      // Per official docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login#get-a-long-lived-access-token
      // Requirements:
      // - Short-lived token must be valid (not expired)
      // - Must be done server-side (we're in backend, so ✅)
      const longLivedTokenRes = await axios.get(
        'https://graph.instagram.com/access_token',
        {
          params: {
            grant_type: 'ig_exchange_token',
            client_secret: appSecret,
            access_token: access_token, // Short-lived token from Step 2
          },
        }
      );

      if (longLivedTokenRes.data?.access_token) {
        igAccessToken = longLivedTokenRes.data.access_token;
        // Per official docs: expires_in is typically 5183944 seconds (~60 days)
        const longLivedExpiresIn = longLivedTokenRes.data.expires_in || 5183944; // Default: 60 days in seconds (per docs)
        tokenExpiresAt = new Date(Date.now() + longLivedExpiresIn * 1000);
        
        console.log(`[Instagram OAuth] ✅ Successfully exchanged for long-lived token`);
        console.log(`[Instagram OAuth] Long-lived token expires in: ${longLivedExpiresIn} seconds (${(longLivedExpiresIn / 86400).toFixed(1)} days)`);
        console.log(`[Instagram OAuth] Token expires at: ${tokenExpiresAt.toISOString()}`);
        console.log(`[Instagram OAuth] Token will be valid for ${Math.floor(longLivedExpiresIn / 86400)} days`);
        console.log(`[Instagram OAuth] Token can be refreshed before expiration (must be at least 24 hours old)`);
      } else {
        throw new Error('No access_token in exchange response');
      }
    } catch (exchangeError: any) {
      // Exchange failed - log the error but continue with short-lived token
      const errorMsg = exchangeError.response?.data?.error?.message || exchangeError.message;
      console.warn(`[Instagram OAuth] ⚠️ Failed to exchange for long-lived token: ${errorMsg}`);
      console.warn(`[Instagram OAuth] This might be normal for Instagram Login - some tokens cannot be exchanged`);
      console.warn(`[Instagram OAuth] Using short-lived token (expires in ~1 hour)`);
      console.warn(`[Instagram OAuth] ⚠️ User will need to reconnect when token expires (after ~1 hour)`);
      
      // Fallback to short-lived token
      // Instagram Login tokens from api.instagram.com/oauth/access_token are typically 1 hour
      tokenExpiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : new Date(Date.now() + 3600 * 1000); // Default to 1 hour if expires_in not provided
      console.log(`[Instagram OAuth] Short-lived token will expire at: ${tokenExpiresAt.toISOString()}`);
    }

    // Step 2: Fetch Instagram account details using the token
    // Try multiple methods to get the username
    // Instagram API with Instagram Login uses graph.instagram.com
    // See: https://developers.facebook.com/docs/instagram-platform/content-publishing
    console.log(`[Instagram OAuth] Attempting to fetch Instagram username for user_id: ${igAccountId}`);
    
    // Method 1: Try /me endpoint with Bearer token (represents the user from the token)
    if (!igUsername) {
      try {
        console.log(`[Instagram OAuth] Trying /me endpoint with Bearer token...`);
        const meRes = await axios.get(
          `https://graph.instagram.com/v24.0/me`,
          {
            params: {
              fields: 'username',
            },
            headers: {
              'Authorization': `Bearer ${igAccessToken}`,
            },
          }
        );
        
        if (meRes.data?.username) {
          igUsername = meRes.data.username;
          console.log(`[Instagram OAuth] ✅ Fetched username via /me (Bearer): ${igUsername}`);
        }
      } catch (meError: any) {
        console.log(`[Instagram OAuth] /me (Bearer) failed:`, meError.response?.data?.error?.message || meError.message);
      }
    }

    // Method 2: Try /me endpoint with query parameter
    if (!igUsername) {
      try {
        console.log(`[Instagram OAuth] Trying /me endpoint with query parameter...`);
        const meQueryRes = await axios.get(
          `https://graph.instagram.com/v24.0/me`,
          {
            params: {
              fields: 'username',
              access_token: igAccessToken,
            },
          }
        );
        
        if (meQueryRes.data?.username) {
          igUsername = meQueryRes.data.username;
          console.log(`[Instagram OAuth] ✅ Fetched username via /me (query): ${igUsername}`);
        }
      } catch (meQueryError: any) {
        console.log(`[Instagram OAuth] /me (query) failed:`, meQueryError.response?.data?.error?.message || meQueryError.message);
      }
    }

    // Method 3: Try /{igAccountId} endpoint with Bearer token
    if (!igUsername) {
      try {
        console.log(`[Instagram OAuth] Trying /${igAccountId} endpoint with Bearer token...`);
        const idRes = await axios.get(
          `https://graph.instagram.com/v24.0/${igAccountId}`,
          {
            params: {
              fields: 'username',
            },
            headers: {
              'Authorization': `Bearer ${igAccessToken}`,
            },
          }
        );
        
        if (idRes.data?.username) {
          igUsername = idRes.data.username;
          console.log(`[Instagram OAuth] ✅ Fetched username via /${igAccountId} (Bearer): ${igUsername}`);
        }
      } catch (idError: any) {
        console.log(`[Instagram OAuth] /${igAccountId} (Bearer) failed:`, idError.response?.data?.error?.message || idError.message);
      }
    }

    // Method 4: Try /{igAccountId} endpoint with query parameter
    if (!igUsername) {
      try {
        console.log(`[Instagram OAuth] Trying /${igAccountId} endpoint with query parameter...`);
        const idQueryRes = await axios.get(
          `https://graph.instagram.com/v24.0/${igAccountId}`,
          {
            params: {
              fields: 'username',
              access_token: igAccessToken,
            },
          }
        );
        
        if (idQueryRes.data?.username) {
          igUsername = idQueryRes.data.username;
          console.log(`[Instagram OAuth] ✅ Fetched username via /${igAccountId} (query): ${igUsername}`);
        }
      } catch (idQueryError: any) {
        console.log(`[Instagram OAuth] /${igAccountId} (query) failed:`, idQueryError.response?.data?.error?.message || idQueryError.message);
      }
    }

    // Method 5: Try with additional fields (sometimes username is returned with other fields)
    if (!igUsername) {
      try {
        console.log(`[Instagram OAuth] Trying /me with multiple fields...`);
        const multiFieldsRes = await axios.get(
          `https://graph.instagram.com/v24.0/me`,
          {
            params: {
              fields: 'id,username,account_type',
              access_token: igAccessToken,
            },
          }
        );
        
        if (multiFieldsRes.data?.username) {
          igUsername = multiFieldsRes.data.username;
          console.log(`[Instagram OAuth] ✅ Fetched username via /me (multi-fields): ${igUsername}`);
        }
      } catch (multiFieldsError: any) {
        console.log(`[Instagram OAuth] /me (multi-fields) failed:`, multiFieldsError.response?.data?.error?.message || multiFieldsError.message);
      }
    }

    // If all methods failed, log a summary
    if (!igUsername) {
      console.warn(`[Instagram OAuth] ⚠️ All username fetch methods failed. Will use placeholder.`);
      console.warn(`[Instagram OAuth] This is okay - the account is still valid and can be used for posting.`);
    }

    // Check if account already exists
    const existingAccount = await this.prisma.socialAccount.findFirst({
      where: {
        userId,
        platform: 'instagram',
        externalId: igAccountId,
      },
    });

    // If we couldn't fetch username, use a placeholder (we'll try to fetch it later)
    // Instagram Login tokens might not work with Graph API immediately, but the account is valid
    if (!igUsername) {
      console.warn(`[Instagram OAuth] ⚠️ Could not fetch username. Using placeholder display name.`);
      igUsername = `instagram_${igAccountId.substring(0, 8)}`; // Use first 8 chars of ID as placeholder
      console.log(`[Instagram OAuth] Using placeholder username: ${igUsername}`);
    }

    // Store permissions for future reference (required for token refresh validation)
    // Per docs: User must have granted instagram_business_basic permission to refresh tokens
    // Convert permissions array to comma-separated string for storage
    let permissionsStr: string;
    if (Array.isArray(permissions)) {
      permissionsStr = permissions.join(',');
    } else if (typeof permissions === 'string') {
      permissionsStr = permissions;
    } else {
      permissionsStr = '';
    }
    
    const hasBusinessBasic = permissionsStr.includes('instagram_business_basic') || permissionsStr.includes('business_basic');
    
    console.log(`[Instagram OAuth] Permissions granted: ${permissionsStr}`);
    console.log(`[Instagram OAuth] Has instagram_business_basic permission: ${hasBusinessBasic}`);
    
    let account;
    if (existingAccount) {
      // Update existing account
      console.log(`[Instagram OAuth] Updating existing Instagram account: ${existingAccount.id}`);
      account = await this.prisma.socialAccount.update({
        where: { id: existingAccount.id },
        data: {
          displayName: igUsername,
          username: igUsername,
          accessToken: this.encryption.encrypt(igAccessToken),
          refreshToken: refreshToken ? this.encryption.encrypt(refreshToken) : null,
          tokenExpiresAt: tokenExpiresAt,
          scopes: permissionsStr,
          isActive: true,
        },
      });
    } else {
      // Create new account
      console.log(`[Instagram OAuth] Creating new Instagram account: ${igUsername}`);
      account = await this.prisma.socialAccount.create({
        data: {
          userId,
          platform: 'instagram',
          externalId: igAccountId,
          displayName: igUsername,
          username: igUsername,
          accessToken: this.encryption.encrypt(igAccessToken),
          refreshToken: refreshToken ? this.encryption.encrypt(refreshToken) : null,
          tokenExpiresAt: tokenExpiresAt,
          scopes: permissionsStr,
          accountType: 'business',
        },
      });
    }

    console.log(`[Instagram OAuth] ✅ Instagram account saved: platform=${account.platform}, externalId=${account.externalId}, displayName=${account.displayName}`);
    return [account];
  }

  // ---- TOKEN STATUS (for "Your keys" page) ----

  private getReconnectPath(platform: string): string {
    const m: Record<string, string> = {
      youtube: '/connect/youtube',
      facebook: '/connect/facebook',
      instagram: '/connect/instagram',
    };
    return m[platform?.toLowerCase()] ?? '/connect';
  }

  async getTokenStatusForUser(userId: string): Promise<TokenStatusItem[]> {
    const accounts = await this.prisma.socialAccount.findMany({
      where: { userId },
      select: {
        id: true,
        platform: true,
        displayName: true,
        username: true,
        tokenExpiresAt: true,
        isActive: true,
        refreshToken: true, // used only to set canRefresh, not returned
      },
    });

    const now = Date.now();
    const in24h = now + 24 * 60 * 60 * 1000;

    return accounts.map((acc) => {
      const hasRefresh = acc.refreshToken != null && String(acc.refreshToken).trim() !== '';
      const plat = acc.platform?.toLowerCase();
      // YouTube/Google need refresh token; Facebook & Instagram show Refresh when active (backend will try token refresh)
      const canRefresh =
        (['youtube', 'google'].includes(plat) && hasRefresh) ||
        (['facebook', 'instagram'].includes(plat) && acc.isActive);

      let status: TokenStatus = 'healthy';
      if (!acc.isActive) {
        status = 'disconnected';
      } else if (!acc.tokenExpiresAt) {
        status = canRefresh ? 'healthy' : 'expired';
      } else {
        const exp = acc.tokenExpiresAt.getTime();
        if (exp <= now) status = 'expired';
        else if (exp <= in24h) status = 'expiring_soon';
      }

      const expiresInHuman = this.tokenExpiration.getTimeUntilExpirationHuman(acc.tokenExpiresAt);

      return {
        id: acc.id,
        platform: acc.platform,
        displayName: acc.displayName,
        username: acc.username,
        tokenExpiresAt: acc.tokenExpiresAt,
        expiresInHuman,
        status,
        canRefresh,
        reconnectPath: this.getReconnectPath(acc.platform),
      };
    });
  }

  async refreshAccountToken(accountId: string, userId: string): Promise<{ tokenExpiresAt: Date }> {
    const id = typeof accountId === 'string' ? accountId.trim() : '';
    if (!id) {
      throw new AppException(ErrorCode.ACCOUNT_NOT_FOUND, 'Account ID is required.', 400);
    }
    const account = await this.prisma.socialAccount.findFirst({
      where: { id },
    });
    if (!account) {
      this.logger.warn(`Refresh failed: account not found`, { accountId: id, userId });
      throw new AppException(
        ErrorCode.ACCOUNT_NOT_FOUND,
        'Account not found. Try reconnecting from Accounts, or use Reconnect below.',
        404,
      );
    }
    if (account.userId !== userId) {
      throw new AppException(
        ErrorCode.ACCOUNT_NOT_OWNED_BY_USER,
        'You do not have access to this account.',
        403,
      );
    }

    const platform = account.platform?.toLowerCase();
    const refreshToken = this.encryption.decrypt(account.refreshToken);
    const accessToken = this.encryption.decrypt(account.accessToken);

    if (!refreshToken && platform !== 'instagram') {
      throw new AppException(
        ErrorCode.ACCOUNT_TOKEN_EXPIRED,
        'No refresh token. Please reconnect this account.',
        400,
      );
    }

    let refreshed: { accessToken: string; expiresAt: Date };

    try {
      if (platform === 'youtube' || platform === 'google') {
        refreshed = await this.tokenRefresh.refreshGoogleToken(refreshToken!);
        await this.prisma.socialAccount.update({
          where: { id },
          data: {
            accessToken: this.encryption.encrypt(refreshed.accessToken),
            tokenExpiresAt: refreshed.expiresAt,
          },
        });
      } else if (platform === 'facebook') {
        if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) {
          throw new AppException(
            ErrorCode.EXTERNAL_API_ERROR,
            'Facebook app is not configured. Cannot refresh token.',
            503,
          );
        }
        refreshed = await this.tokenRefresh.refreshFacebookToken(
          accessToken || refreshToken!,
          process.env.FACEBOOK_APP_ID,
          process.env.FACEBOOK_APP_SECRET,
        );
        await this.prisma.socialAccount.update({
          where: { id },
          data: {
            accessToken: this.encryption.encrypt(refreshed.accessToken),
            tokenExpiresAt: refreshed.expiresAt,
          },
        });
      } else if (platform === 'instagram') {
        // Instagram uses its own long-lived refresh endpoint; getValidInstagramAccessToken refreshes and updates DB
        await this.getValidInstagramAccessToken(id);
        const updated = await this.prisma.socialAccount.findUnique({
          where: { id },
          select: { tokenExpiresAt: true },
        });
        if (!updated?.tokenExpiresAt) {
          throw new AppException(
            ErrorCode.ACCOUNT_TOKEN_EXPIRED,
            'Instagram token could not be refreshed. Please reconnect.',
            400,
          );
        }
        this.logger.log(
          `Manual refresh succeeded for instagram account ${accountId}, expires ${this.tokenExpiration.getTimeUntilExpirationHuman(updated.tokenExpiresAt)}`,
        );
        return { tokenExpiresAt: updated.tokenExpiresAt };
      } else {
        throw new AppException(
          ErrorCode.ACCOUNT_INVALID_PLATFORM,
          `Manual refresh is not supported for ${platform}.`,
          400,
        );
      }

      this.logger.log(
        `Manual refresh succeeded for ${platform} account ${accountId}, expires ${this.tokenExpiration.getTimeUntilExpirationHuman(refreshed.expiresAt)}`,
      );
      return { tokenExpiresAt: refreshed.expiresAt };
    } catch (e: any) {
      const msg = e?.message || 'Token refresh failed';
      this.logger.warn(`Manual refresh failed for account ${accountId}: ${msg}`, { errorCode: e?.errorCode });
      if (e instanceof AppException) throw e;
      if (msg.includes('invalid_grant') || msg.includes('expired') || msg.includes('re-authenticate')) {
        throw new AppException(
          ErrorCode.ACCOUNT_TOKEN_EXPIRED,
          'Token is invalid or expired. Please reconnect this account.',
          400,
        );
      }
      throw new AppException(ErrorCode.EXTERNAL_API_ERROR, msg, 503);
    }
  }

  // ---- GENERAL ----

  listForUser(userId: string) {
    return this.prisma.socialAccount.findMany({
      where: { userId, isActive: true },
    });
  }

  async deleteAccount(accountId: string, userId: string) {
    // Verify the account belongs to the user
    const account = await this.prisma.socialAccount.findFirst({
      where: {
        id: accountId,
        userId: userId,
      },
    });

    if (!account) {
      this.logger.warn(`Delete account failed: not found or not owned`, { accountId, userId });
      throw new AppException(
        ErrorCode.ACCOUNT_NOT_FOUND,
        'Account not found or does not belong to you.',
        404,
      );
    }

    // Check if there are any scheduled posts for this account
    const scheduledPostsCount = await this.prisma.scheduledPost.count({
      where: {
        socialAccountId: accountId,
        status: { in: ['pending', 'processing'] },
      },
    });

    if (scheduledPostsCount > 0) {
      this.logger.warn(`Cannot delete account: has scheduled posts`, {
        accountId,
        count: scheduledPostsCount,
      });
      throw new AppException(
        ErrorCode.POST_SCHEDULE_INVALID,
        `Cannot delete account: ${scheduledPostsCount} scheduled post(s) are linked. Cancel or complete them first.`,
        400,
      );
    }

    // Also check for any posts (success, failed, scheduled) - we'll delete them too
    const allPostsCount = await this.prisma.scheduledPost.count({
      where: {
        socialAccountId: accountId,
      },
    });

    if (allPostsCount > 0) {
      console.log(`🗑️ Deleting ${allPostsCount} associated post(s) for account ${accountId}`);
      // Delete all posts associated with this account
      await this.prisma.scheduledPost.deleteMany({
      where: {
        socialAccountId: accountId,
      },
    });
    }

    // Delete the account (hard delete)
    await this.prisma.socialAccount.delete({
      where: { id: accountId },
    });

    return { success: true, message: 'Account deleted successfully' };
  }
}
