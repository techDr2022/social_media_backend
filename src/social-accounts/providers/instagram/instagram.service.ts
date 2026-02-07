import { Injectable, BadRequestException, InternalServerErrorException, Inject, forwardRef } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../../prisma/prisma.service';
import { SocialAccountsService } from '../../social-accounts.service';
import { InstagramPostDto } from './dto/instagram-post.dto';
import { LogsService } from '../../../logs/logs.service';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { QUEUE_NAMES, JOB_NAMES, PublishPostJobData } from '../../../scheduled-posts/queue/post-queue.types';
import { QueueHelpers } from '../../../scheduled-posts/queue/queue-helpers';
import { AlertsService } from '../../../alerts/alerts.service';

@Injectable()
export class InstagramService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socialAccountsService: SocialAccountsService,
    private readonly logsService: LogsService,
    @InjectQueue(QUEUE_NAMES.POST_PUBLISH) private readonly postQueue: Queue,
    private readonly queueHelpers: QueueHelpers,
    private readonly alertsService: AlertsService,
  ) {}

  async createPost(params: {
    userId: string;
    socialAccountId: string;
    caption?: string;
    mediaUrl?: string;
    mediaType?: 'photo' | 'video' | 'carousel';
    scheduledPublishTime?: string;
    locationId?: string;
    userTags?: string;
    carouselUrls?: string[];
    carouselItems?: Array<{url: string; type: 'photo' | 'video'}>;
  }) {
    const { userId, socialAccountId, caption, mediaUrl, mediaType, scheduledPublishTime, locationId, userTags, carouselUrls, carouselItems } = params;

    // Debug logging
    console.log('🔍 Instagram createPost params:', {
      mediaType,
      mediaUrl: mediaUrl ? 'set' : 'undefined',
      carouselUrls: carouselUrls ? carouselUrls.length : 'undefined',
      carouselItems: carouselItems ? carouselItems.length : 'undefined',
    });

    // Validate carousel requirements
    if (mediaType === 'carousel' && (!carouselItems || carouselItems.length === 0)) {
      throw new BadRequestException('Carousel posts require at least one media item in carouselItems');
    }

    // Log post creation start (synchronous - no await needed!)
    this.logsService.info(
      'instagram',
      'Starting Instagram post creation',
      {
        socialAccountId,
        mediaType,
        hasCaption: !!caption,
        hasMediaUrl: !!mediaUrl,
        scheduled: !!scheduledPublishTime,
      },
      userId,
      socialAccountId,
    );

    // Get account
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });

    if (!account || account.platform !== 'instagram') {
      this.logsService.error('instagram', 'Invalid Instagram account', null, { socialAccountId }, userId, socialAccountId);
      throw new BadRequestException('Invalid Instagram account');
    }

    if (account.userId !== userId) {
      this.logsService.error('instagram', 'Account does not belong to user', null, { socialAccountId, accountUserId: account.userId, requestUserId: userId }, userId, socialAccountId);
      throw new BadRequestException('Account does not belong to user');
    }

    // Get valid access token
    let accessToken = await this.socialAccountsService.getValidInstagramAccessToken(account.id);
    const igUserId = account.externalId; // This should be the Instagram Business Account ID

    // For Instagram Login tokens, exchange short-lived token for long-lived token if needed
    // Instagram Login tokens from api.instagram.com/oauth/access_token are short-lived
    const appId = process.env.INSTAGRAM_APP_ID;
    const appSecret = process.env.INSTAGRAM_APP_SECRET;
    
    // Skip token exchange - use token directly from Step 2
    // According to Business Login docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
    // The token from api.instagram.com/oauth/access_token (Step 2) can be used directly for posting
    // Token exchange endpoint returns "Unsupported request" error, so we skip it
    console.log('📝 Using Instagram Login token directly (token exchange skipped)');
    console.log('📝 Token from Step 2 (api.instagram.com/oauth/access_token) is ready for posting');

    let mediaContainerId: string | undefined;
    let postId: string | undefined; // Track postId even if error occurs
    let postUrl: string | null = null; // Track postUrl even if error occurs
    let videoProcessingAttempts: number | undefined; // Track video processing attempts

    try {
      // Validate scheduled publish time if provided
      // Always use our Redis queue system for scheduled posts (Instagram Graph API doesn't reliably support scheduling)
      if (scheduledPublishTime) {
        const scheduledDate = new Date(scheduledPublishTime);
        const now = new Date();
        
        if (isNaN(scheduledDate.getTime())) {
          throw new BadRequestException('Invalid scheduled publish time format. Use YYYY-MM-DDTHH:mm format.');
        }
        
        if (scheduledDate <= now) {
          throw new BadRequestException('Scheduled publish time must be in the future.');
        }

        // Use our Redis queue system for ALL scheduled posts (works for any future date)
        console.log('📅 Using queue system for scheduled post:', scheduledDate.toISOString());
        console.log('📅 Using queue system for post scheduled beyond 25 hours');
        
        // Create post in database with pending status
        const scheduledAt = new Date(scheduledPublishTime);
        const post = await this.prisma.scheduledPost.create({
          data: {
            userId,
            socialAccountId,
            platform: 'instagram',
            type: mediaType || 'photo',
            content: caption || '',
            mediaUrl: mediaType === 'carousel' ? (carouselUrls && carouselUrls.length > 0 ? carouselUrls[0] : null) : mediaUrl || null,
            scheduledAt,
            status: 'pending',
          },
        });

        // Calculate delay in milliseconds
        const delay = scheduledAt.getTime() - Date.now();
        
        // Prepare job data with all Instagram-specific parameters
        const jobData: PublishPostJobData = {
          postId: post.id,
          userId: post.userId,
          socialAccountId: post.socialAccountId,
          platform: 'instagram',
          content: caption || '',
          mediaUrl: mediaType === 'carousel' ? undefined : mediaUrl || undefined,
          mediaType: mediaType || undefined,
          carouselItems: carouselItems || undefined,
          carouselUrls: carouselUrls || undefined,
          locationId: locationId || undefined,
          userTags: userTags || undefined,
        };

        // Add job to BullMQ queue with delay using retry mechanism
        try {
          await this.queueHelpers.addJobWithRetry(
            JOB_NAMES.PUBLISH_POST,
            jobData,
            {
              delay: delay,
              jobId: `post-${post.id}`,
              removeOnComplete: true,
              removeOnFail: false,
            },
            3, // Max 3 retries with exponential backoff
          );
          console.log(`✅ Job added to queue for post ${post.id}, scheduled for ${scheduledAt.toISOString()}`);

          // Log success
          this.logsService.info(
            'instagram',
            'Instagram post scheduled via queue system',
            { postId: post.id, scheduledAt: scheduledAt.toISOString() },
            userId,
            socialAccountId,
          );

          // Create alert for scheduled post (only if queue add succeeded)
          try {
            const accountName = account.displayName || account.username || 'Instagram Account';
            const postType = (mediaType || 'photo') as 'photo' | 'video' | 'carousel';
            const message = this.alertsService.formatScheduledMessage(
              accountName,
              postType,
              scheduledAt,
            );

            await this.alertsService.create({
              userId,
              socialAccountId,
              scheduledPostId: post.id,
              type: 'scheduled',
              platform: 'instagram',
              title: 'Scheduled Successfully',
              message,
              accountName,
              postType,
              scheduledAt,
            });
          } catch (alertError: any) {
            // Don't fail the request if alert creation fails
            console.error('Failed to create alert for scheduled post:', alertError.message);
          }
        } catch (queueError: any) {
          console.error(`❌ Failed to add job to queue after retries: ${queueError.message}`);
          // If Redis is unavailable or times out after retries, we still save the post to database
          // The post will remain in 'pending' status and can be manually processed or retried later
          // Don't throw error - post is saved, just queue failed
          this.logsService.error(
            'instagram',
            'Failed to add scheduled post to queue after retries (Redis unavailable or timeout)',
            queueError,
            { postId: post.id, scheduledAt: scheduledAt.toISOString() },
            userId,
            socialAccountId,
          );
          // Continue - post is saved, user can retry later or we can add a cron to process pending posts
        }

        // Return success response
        return {
          success: true,
          postId: post.id,
          message: 'Post scheduled successfully (will be published via queue system)',
        };
      }

      // Validate media URL if provided (but not for carousel posts)
      if (mediaType && mediaType !== 'carousel' && !mediaUrl) {
        throw new BadRequestException('Media URL is required for photo/video posts');
      }

      // Normalize mediaType: DB/job may send 'post'; we need 'photo' or 'video' for single media
      let effectiveMediaType = mediaType;
      if ((effectiveMediaType as string) === 'post' || (effectiveMediaType && !['photo', 'video', 'carousel'].includes(effectiveMediaType as 'photo' | 'video' | 'carousel'))) {
        if (mediaUrl) {
          const url = mediaUrl.toLowerCase().split('?')[0];
          effectiveMediaType = url.endsWith('.mp4') || url.endsWith('.mov') ? 'video' : 'photo';
        }
      }

      // Create media container (for immediate posts only - scheduled posts use queue system above)
      if (effectiveMediaType === 'photo' && mediaUrl) {
        // Photo post
        const containerData: any = {
          image_url: mediaUrl,
          caption: caption || '',
          // access_token will be sent as query parameter, not in body
        };

        // Add location if provided
        if (locationId) {
          containerData.location_id = locationId;
        }

        // Add user tags if provided
        if (userTags) {
          const tagIds = userTags.split(',').map(id => id.trim()).filter(Boolean);
          if (tagIds.length > 0) {
            // Instagram user tags format: [{"user_id": "123", "x": 0.5, "y": 0.5}]
            // For simplicity, we'll use default position (center)
            containerData.user_tags = JSON.stringify(
              tagIds.map(userId => ({ user_id: userId, x: 0.5, y: 0.5 }))
            );
          }
        }

        // No scheduling here - scheduled posts use queue system above

        console.log('📤 Creating Instagram photo container...');
        console.log('🔄 Using Instagram Graph API (graph.instagram.com) for Instagram Login...');
        console.log('📋 Container data:', {
          image_url: mediaUrl.substring(0, 50) + '...',
          caption: caption?.substring(0, 50) || '',
          has_location: !!locationId,
          has_user_tags: !!userTags,
          scheduled: false, // Scheduled posts use queue system
          user_id: igUserId,
        });
        console.log('🔑 Token preview:', accessToken.substring(0, 20) + '...');
        console.log('📝 Reference: https://developers.facebook.com/docs/instagram-platform/content-publishing');
        
        // Instagram API with Instagram Login uses graph.instagram.com
        // According to Get Started guide: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started
        // The /me endpoint represents the app user's ID from the access token
        // According to Content Publishing guide: https://developers.facebook.com/docs/instagram-platform/content-publishing
        // Use /me/media for Instagram Login (or /<IG_ID>/media with access_token as query parameter)
        const containerDataWithoutToken = { ...containerData };
        delete containerDataWithoutToken.access_token; // Remove from body
        
        // Try /me/media first (represents the user from the token)
        let containerRes;
        try {
          console.log('🔄 Trying /me/media endpoint (Instagram Login format)...');
          containerRes = await axios.post(
            `https://graph.instagram.com/v21.0/me/media`,
            containerDataWithoutToken,
            {
              params: {
                access_token: accessToken, // Send as query parameter (as shown in Get Started guide)
              },
              headers: {
                'Content-Type': 'application/json',
              },
            },
          );
          console.log('✅ Successfully used /me/media endpoint');
        } catch (meError: any) {
          // If /me/media fails, try /<IG_ID>/media
          console.log('⚠️ /me/media failed, trying /<IG_ID>/media endpoint...');
          try {
            containerRes = await axios.post(
              `https://graph.instagram.com/v21.0/${igUserId}/media`,
              containerDataWithoutToken,
              {
                params: {
                  access_token: accessToken, // Send as query parameter
                },
                headers: {
                  'Content-Type': 'application/json',
                },
              },
            );
            console.log('✅ Successfully used /<IG_ID>/media endpoint');
          } catch (igError: any) {
            // Both failed
            throw meError; // Throw the original /me error
          }
        }
        
        // Handle errors if both attempts failed
        if (!containerRes || !containerRes.data?.id) {
          const errorMsg = containerRes?.response?.data?.error?.message || 'Failed to create media container';
          const errorCode = containerRes?.response?.data?.error?.code;
          throw new InternalServerErrorException(
            `Failed to create Instagram media container: ${errorMsg}. Error Code: ${errorCode || 'N/A'}`
          );
        }

        mediaContainerId = containerRes.data.id;
        console.log(`✅ Photo container created: ${mediaContainerId}`);
        
        // Log photo container creation
        this.logsService.info(
          'instagram',
          'Photo container created successfully',
          { containerId: mediaContainerId, userId: igUserId },
          userId,
          socialAccountId,
        );
      } else if (effectiveMediaType === 'video' && mediaUrl) {
        // Video post
        // First, validate video URL is accessible
        try {
          console.log('🔍 Validating video URL:', mediaUrl);
          const videoCheck = await axios.head(mediaUrl, { 
            timeout: 5000,
            validateStatus: (status) => status < 500
          });
          console.log('✅ Video URL is accessible, status:', videoCheck.status);
        } catch (urlError: any) {
          console.warn('⚠️ Could not validate video URL:', urlError.message);
        }

        const containerData: any = {
          media_type: 'REELS', // or 'VIDEO' for regular video posts
          video_url: mediaUrl,
          caption: caption || '',
          // access_token will be sent as query parameter, not in body
        };

        // Add location if provided
        if (locationId) {
          containerData.location_id = locationId;
        }

        // Add user tags if provided
        if (userTags) {
          const tagIds = userTags.split(',').map(id => id.trim()).filter(Boolean);
          if (tagIds.length > 0) {
            containerData.user_tags = JSON.stringify(
              tagIds.map(userId => ({ user_id: userId, x: 0.5, y: 0.5 }))
            );
          }
        }

        // No scheduling here - scheduled posts use queue system above

        console.log('🎥 Creating Instagram video container...');
        console.log('🔄 Using Instagram Graph API (graph.instagram.com) for Instagram Login...');
        console.log('📋 Container data:', {
          video_url: mediaUrl.substring(0, 50) + '...',
          media_type: containerData.media_type,
          caption: caption?.substring(0, 50) || '',
          has_location: !!locationId,
          has_user_tags: !!userTags,
          scheduled: false, // Scheduled posts use queue system
          user_id: igUserId,
        });
        console.log('🔑 Token preview:', accessToken.substring(0, 20) + '...');
        console.log('📝 Reference: https://developers.facebook.com/docs/instagram-platform/content-publishing');
        
        // Instagram API with Instagram Login uses graph.instagram.com
        // Try /me/media first (represents the user from the token), then /<IG_ID>/media
        const containerDataWithoutToken = { ...containerData };
        delete containerDataWithoutToken.access_token; // Remove from body
        
        let containerRes;
        try {
          console.log('🔄 Trying /me/media endpoint for video (Instagram Login format)...');
          containerRes = await axios.post(
            `https://graph.instagram.com/v21.0/me/media`,
            containerDataWithoutToken,
            {
              params: {
                access_token: accessToken, // Send as query parameter
              },
              headers: {
                'Content-Type': 'application/json',
              },
            },
          );
          console.log('✅ Successfully used /me/media endpoint for video');
        } catch (meError: any) {
          // If /me/media fails, try /<IG_ID>/media
          console.log('⚠️ /me/media failed for video, trying /<IG_ID>/media endpoint...');
          try {
            containerRes = await axios.post(
              `https://graph.instagram.com/v21.0/${igUserId}/media`,
              containerDataWithoutToken,
              {
                params: {
                  access_token: accessToken, // Send as query parameter
                },
                headers: {
                  'Content-Type': 'application/json',
                },
              },
            );
            console.log('✅ Successfully used /<IG_ID>/media endpoint for video');
          } catch (igError: any) {
            // Both failed - log and throw
            console.error('❌ Instagram Graph API error (video):', {
              status: igError.response?.status,
              statusText: igError.response?.statusText,
              error: igError.response?.data,
              message: igError.message,
              url_me: `https://graph.instagram.com/v21.0/me/media`,
              url_ig_id: `https://graph.instagram.com/v21.0/${igUserId}/media`,
              token_type: accessToken.startsWith('IGAA') ? 'Instagram Login Token (IGAA)' : 'Unknown',
              token_preview: accessToken.substring(0, 30) + '...',
            });
            
            const errorMsg = igError.response?.data?.error?.message || meError.response?.data?.error?.message || igError.message;
            const errorCode = igError.response?.data?.error?.code || meError.response?.data?.error?.code;
            const errorType = igError.response?.data?.error?.type || meError.response?.data?.error?.type;
            
            throw new InternalServerErrorException(
              `Failed to create Instagram media container: ${errorMsg}. ` +
              `Error Code: ${errorCode || 'N/A'}, Type: ${errorType || 'N/A'}. ` +
              `Status: ${igError.response?.status || meError.response?.status || 'N/A'}. ` +
              `Tried both /me/media and /<IG_ID>/media endpoints.`
            );
          }
        }

        mediaContainerId = containerRes.data.id;
        console.log(`✅ Video container created: ${mediaContainerId}`);
        
        // Log video container creation
        this.logsService.info(
          'instagram',
          'Video container created successfully',
          { containerId: mediaContainerId, userId: igUserId },
          userId,
          socialAccountId,
        );

        // For videos, we need to wait for processing before publishing
        if (!mediaContainerId) {
          throw new InternalServerErrorException('Failed to create video container');
        }
        await this.waitForVideoProcessing(mediaContainerId, accessToken, userId, socialAccountId);
      } else if (effectiveMediaType === 'carousel' && ((carouselUrls && carouselUrls.length > 0) || (carouselItems && carouselItems.length > 0))) {
        // Carousel post - create multiple media containers and then a carousel container
        console.log('🎠 Creating Instagram carousel post...');
        console.log('🔄 Using Instagram Graph API (graph.instagram.com) for Instagram Login...');

        // Support both old carouselUrls and new carouselItems format
        const items = carouselItems || (carouselUrls ? carouselUrls.map(url => ({ url, type: 'photo' as const })) : []);

        console.log('📋 Carousel data:', {
          itemCount: items.length,
          caption: caption?.substring(0, 50) || '',
          has_location: !!locationId,
          has_user_tags: !!userTags,
          scheduled: false, // Scheduled posts use queue system
          user_id: igUserId,
          itemTypes: items.map(item => item.type),
        });

        // Step 1: Create individual media containers for each item
        const childContainerIds: string[] = [];

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const mediaUrl = item.url;
          const mediaType = item.type;
          
          // Validate image URL
          try {
            console.log(`🔍 Validating carousel ${mediaType} ${i + 1}/${items.length}:`, mediaUrl);
            const mediaCheck = await axios.head(mediaUrl, { 
              timeout: 5000,
              validateStatus: (status) => status < 500
            });
            console.log(`✅ Carousel ${mediaType} ${i + 1} is accessible, status:`, mediaCheck.status);
          } catch (urlError: any) {
            console.warn(`⚠️ Could not validate carousel ${mediaType} ${i + 1}:`, urlError.message);
          }

          const containerData: any = {};

          // Set the appropriate URL based on media type
          if (mediaType === 'video') {
            containerData.video_url = mediaUrl;
            containerData.media_type = 'VIDEO';
            containerData.is_carousel_item = true;
          } else {
            containerData.image_url = mediaUrl;
          }

          // Add location if provided (only to first item for carousel)
          if (i === 0 && locationId) {
            containerData.location_id = locationId;
          }

          // Add user tags if provided (only to first item for carousel)
          if (i === 0 && userTags) {
            const tagIds = userTags.split(',').map(id => id.trim()).filter(Boolean);
            if (tagIds.length > 0) {
              containerData.user_tags = JSON.stringify(
                tagIds.map(userId => ({ user_id: userId, x: 0.5, y: 0.5 }))
              );
            }
          }

          console.log(`📤 Creating carousel item container ${i + 1}/${items.length} (${mediaType})...`);
          
          const containerDataWithoutToken = { ...containerData };
          delete containerDataWithoutToken.access_token; // Remove from body
          
          let itemContainerRes;
          try {
            console.log(`🔄 Trying /me/media endpoint for carousel item ${i + 1}...`);
            itemContainerRes = await axios.post(
              `https://graph.instagram.com/v21.0/me/media`,
              containerDataWithoutToken,
              {
                params: {
                  access_token: accessToken,
                },
                headers: {
                  'Content-Type': 'application/json',
                },
              },
            );
            console.log(`✅ Successfully created carousel item ${i + 1} container`);
          } catch (meError: any) {
            console.log(`⚠️ /me/media failed for carousel item ${i + 1}, trying /<IG_ID>/media endpoint...`);
            try {
              itemContainerRes = await axios.post(
                `https://graph.instagram.com/v21.0/${igUserId}/media`,
                containerDataWithoutToken,
                {
                  params: {
                    access_token: accessToken,
                  },
                  headers: {
                    'Content-Type': 'application/json',
                  },
                },
              );
              console.log(`✅ Successfully created carousel item ${i + 1} container with /<IG_ID>/media`);
            } catch (igError: any) {
              throw meError; // Throw original error
            }
          }

          if (!itemContainerRes || !itemContainerRes.data?.id) {
            const errorMsg = itemContainerRes?.response?.data?.error?.message || 'Failed to create carousel item container';
            throw new InternalServerErrorException(
              `Failed to create carousel item ${i + 1} container: ${errorMsg}`
            );
          }

          const itemContainerId = itemContainerRes.data.id;
          childContainerIds.push(itemContainerId);
          console.log(`✅ Carousel item ${i + 1} container created: ${itemContainerId}`);
          
          // Verify the container exists before proceeding
          try {
            console.log(`🔍 Verifying carousel item ${i + 1} container exists...`);
            const verifyRes = await axios.get(
              `https://graph.instagram.com/v21.0/${itemContainerId}`,
              {
                params: {
                  fields: 'id,status_code',
                  access_token: accessToken,
                },
              },
            );
            console.log(`✅ Container ${itemContainerId} verified:`, {
              id: verifyRes.data.id,
              status_code: verifyRes.data.status_code,
            });
          } catch (verifyError: any) {
            console.warn(`⚠️ Could not verify container ${itemContainerId}:`, verifyError.response?.data?.error?.message || verifyError.message);
            // Continue anyway, but log the issue
          }
          
          // If this is a video, wait for processing to complete
          if (mediaType === 'video') {
            console.log(`🎬 Starting video processing for carousel item ${i + 1}...`);
            await this.waitForVideoProcessing(itemContainerId, accessToken, userId, socialAccountId);
            console.log(`✅ Video processing completed for carousel item ${i + 1}`);
          }
        }

        // Add a delay to ensure all containers are ready
        console.log('⏳ Waiting for carousel item containers to be ready...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Validate all child containers exist
        console.log('🔍 Validating all carousel child containers...');
        for (let i = 0; i < childContainerIds.length; i++) {
          const containerId = childContainerIds[i];
          try {
            const checkRes = await axios.get(
              `https://graph.instagram.com/v21.0/${containerId}`,
              {
                params: {
                  fields: 'id,status_code',
                  access_token: accessToken,
                },
              },
            );
            if (checkRes.data.status_code !== 'FINISHED') {
              console.warn(`⚠️ Container ${containerId} status: ${checkRes.data.status_code}`);
            }
          } catch (checkError: any) {
            console.error(`❌ Child container ${containerId} validation failed:`, checkError.response?.data?.error?.message || checkError.message);
            throw new InternalServerErrorException(
              `Child container ${containerId} is not accessible: ${checkError.response?.data?.error?.message || checkError.message}`
            );
          }
        }
        console.log('✅ All child containers validated');

        // Step 2: Create the carousel container
        const carouselContainerData: any = {
          media_type: 'CAROUSEL',
          children: childContainerIds, // Array of container IDs
          caption: caption || '',
        };

        // No scheduling here - scheduled posts use queue system above

        console.log('📤 Creating carousel container...');
        
        const carouselDataWithoutToken = { ...carouselContainerData };
        delete carouselDataWithoutToken.access_token; // Remove from body
        
        let carouselContainerRes;
        try {
          console.log('🔄 Trying /me/media endpoint for carousel container...');
          carouselContainerRes = await axios.post(
            `https://graph.instagram.com/v21.0/me/media`,
            carouselDataWithoutToken,
            {
              params: {
                access_token: accessToken,
              },
              headers: {
                'Content-Type': 'application/json',
              },
            },
          );
          console.log('✅ Successfully created carousel container with /me/media');
        } catch (meError: any) {
          console.log('⚠️ /me/media failed for carousel container, trying /<IG_ID>/media endpoint...');
          try {
            carouselContainerRes = await axios.post(
              `https://graph.instagram.com/v21.0/${igUserId}/media`,
              carouselDataWithoutToken,
              {
                params: {
                  access_token: accessToken,
                },
                headers: {
                  'Content-Type': 'application/json',
                },
              },
            );
            console.log('✅ Successfully created carousel container with /<IG_ID>/media');
          } catch (igError: any) {
            // If both fail
            const errorMsg = igError.response?.data?.error?.message || igError.message;
            const errorCode = igError.response?.data?.error?.code;
            
            throw new InternalServerErrorException(
              `Failed to create Instagram carousel container: ${errorMsg}. Error Code: ${errorCode || 'N/A'}.`
            );
          }
        }

        if (!carouselContainerRes || !carouselContainerRes.data?.id) {
          const errorMsg = carouselContainerRes?.response?.data?.error?.message || 'Failed to create carousel container';
          throw new InternalServerErrorException(`Failed to create Instagram carousel container: ${errorMsg}`);
        }

        mediaContainerId = carouselContainerRes.data.id;
        console.log(`✅ Carousel container created: ${mediaContainerId}`);
        
        // Log carousel container creation
        this.logsService.info(
          'instagram',
          'Carousel container created successfully',
          { containerId: mediaContainerId, childContainerIds, itemCount: items.length },
          userId,
          socialAccountId,
        );

        // Wait for carousel container to be ready (similar to video processing)
        console.log('⏳ Waiting for carousel container to be ready...');
        if (!mediaContainerId) {
          throw new InternalServerErrorException('Carousel container ID is missing');
        }
        await this.waitForCarouselProcessing(mediaContainerId, accessToken, userId, socialAccountId);
      } else if (!effectiveMediaType || (!mediaUrl && !(effectiveMediaType === 'carousel' && ((carouselUrls && carouselUrls.length > 0) || (carouselItems && carouselItems.length > 0))))) {
        // Text-only post (not supported by Instagram, but we'll handle gracefully)
        throw new BadRequestException('Instagram requires media (photo or video). Text-only posts are not supported.');
      }

      // Ensure mediaContainerId is set
      if (!mediaContainerId) {
        const hint = effectiveMediaType ? `mediaType=${effectiveMediaType}, mediaUrl=${mediaUrl ? 'set' : 'missing'}` : 'mediaType not photo/video/carousel';
        throw new BadRequestException(`Failed to create media container (${hint}). Check that media URL is accessible by Instagram.`);
      }

      // Publish the media container
      // Immediate publish (scheduled posts handled by queue system above)
      console.log('📤 Publishing Instagram post...');
      console.log('🔄 Using Instagram Graph API (graph.instagram.com) for Instagram Login...');
      
      // Instagram API with Instagram Login uses graph.instagram.com
      // For Instagram Login, we should wait a moment for the container to be ready
      // But for photos, it's usually instant. Let's add a small delay just in case.
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify container exists and is accessible before publishing
      try {
          console.log('🔍 Verifying container exists before publishing...');
          const containerCheck = await axios.get(
            `https://graph.instagram.com/v21.0/${mediaContainerId}`,
            {
              params: {
                fields: 'id,status_code',
                access_token: accessToken,
              },
            },
          );
        console.log('✅ Container verified:', {
          id: containerCheck.data.id,
          status_code: containerCheck.data.status_code,
        });
      } catch (checkError: any) {
        console.warn('⚠️ Could not verify container (might be okay):', checkError.response?.data?.error?.message || checkError.message);
        // Continue anyway - container might still be valid
      }
      
      // Try /me/media_publish first (represents the user from the token)
      // For Instagram Login, /<IG_ID>/media_publish might not work, so we'll only try /me
      let publishRes;
      try {
        console.log('🔄 Trying /me/media_publish endpoint (Instagram Login format)...');
        console.log('📋 Publish data:', {
          creation_id: mediaContainerId,
          container_created: 'just now',
        });
        
        publishRes = await axios.post(
          `https://graph.instagram.com/v21.0/me/media_publish`,
          {
            creation_id: mediaContainerId,
          },
          {
            params: {
              access_token: accessToken, // Send as query parameter
            },
            headers: {
              'Content-Type': 'application/json',
            },
          },
        );
        console.log('✅ Successfully used /me/media_publish endpoint');
        console.log('📋 Publish response:', {
          status: publishRes.status,
          statusText: publishRes.statusText,
          hasData: !!publishRes.data,
          dataKeys: publishRes.data ? Object.keys(publishRes.data) : [],
          fullData: JSON.stringify(publishRes.data, null, 2),
        });
      } catch (meError: any) {
        // Log the /me error details
        console.error('❌ /me/media_publish failed:', {
          status: meError.response?.status,
          statusText: meError.response?.statusText,
          error: meError.response?.data,
          message: meError.message,
          container_id: mediaContainerId,
          token_type: accessToken.startsWith('IGAA') ? 'Instagram Login Token (IGAA)' : 'Unknown',
          token_preview: accessToken.substring(0, 30) + '...',
        });
        
        // For Instagram Login, /<IG_ID>/media_publish typically doesn't work
        // But let's try it as a fallback and log the error
        console.log('⚠️ /me/media_publish failed, trying /<IG_ID>/media_publish endpoint as fallback...');
        try {
          publishRes = await axios.post(
            `https://graph.instagram.com/v21.0/${igUserId}/media_publish`,
            {
              creation_id: mediaContainerId,
            },
            {
              params: {
                access_token: accessToken, // Send as query parameter
              },
              headers: {
                'Content-Type': 'application/json',
              },
            },
          );
          console.log('✅ Successfully used /<IG_ID>/media_publish endpoint');
        } catch (igError: any) {
          // Both failed - log both errors and throw
          console.error('❌ /<IG_ID>/media_publish also failed:', {
            status: igError.response?.status,
            statusText: igError.response?.statusText,
            error: igError.response?.data,
            message: igError.message,
          });
          
          // Use the /me error message (more relevant for Instagram Login)
          const errorMsg = meError.response?.data?.error?.message || igError.response?.data?.error?.message || meError.message;
          const errorCode = meError.response?.data?.error?.code || igError.response?.data?.error?.code;
          const errorType = meError.response?.data?.error?.type || igError.response?.data?.error?.type;
          const errorSubcode = meError.response?.data?.error?.error_subcode || igError.response?.data?.error?.error_subcode;
          
          // Provide more helpful error message
          let helpfulMsg = `Failed to publish Instagram post: ${errorMsg}`;
          if (errorCode === 100 && errorSubcode === 33) {
            helpfulMsg += '\n\nThis error usually means:\n';
            helpfulMsg += '1. The container might not be ready yet (try waiting a few seconds)\n';
            helpfulMsg += '2. The access token might not have the required permissions (instagram_business_content_publish)\n';
            helpfulMsg += '3. The Instagram account might not be a Business or Creator account\n';
            helpfulMsg += `4. Container ID: ${mediaContainerId}`;
          }
          
          throw new InternalServerErrorException(
            helpfulMsg + `\nError Code: ${errorCode || 'N/A'}, Subcode: ${errorSubcode || 'N/A'}, Type: ${errorType || 'N/A'}. ` +
            `Status: ${meError.response?.status || 'N/A'}. ` +
            `Tried both /me/media_publish and /<IG_ID>/media_publish endpoints.`
          );
        }
      }

      // Check if publishRes has the expected data
      if (!publishRes || !publishRes.data || !publishRes.data.id) {
        console.error('❌ Publish response missing post ID:', {
          hasResponse: !!publishRes,
          hasData: !!publishRes?.data,
          responseData: publishRes?.data,
        });
        throw new InternalServerErrorException(
          `Failed to publish Instagram post: Instagram API returned invalid response. Container ID: ${mediaContainerId}`
        );
      }

      postId = publishRes.data.id;
      console.log(`✅ Instagram post published: ${postId}`);
      console.log(`📋 Full publish response:`, JSON.stringify(publishRes.data, null, 2));
      
      // Log successful publish (wrap in try-catch to prevent logging errors from breaking the flow)
      try {
        this.logsService.info(
          'instagram',
          'Instagram post published successfully',
          { postId, containerId: mediaContainerId, mediaType },
          userId,
          socialAccountId,
        );
      } catch (logError: any) {
        console.warn('⚠️ Failed to log success (non-critical):', logError.message);
      }

      // Scheduled posts are handled by queue system above, so we only reach here for immediate posts
      // Try to fetch post URL (permalink) for immediate posts
      // postUrl already declared at top of function
      if (postId) {
        try {
          // Wait a few seconds for Instagram to process the post
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          console.log('🔗 Fetching post permalink...');
          const permalinkRes = await axios.get(
            `https://graph.instagram.com/v21.0/${postId}`,
            {
              params: {
                fields: 'permalink',
                access_token: accessToken,
              },
            }
          );
          
          postUrl = permalinkRes.data.permalink;
          console.log(`✅ Post URL fetched: ${postUrl}`);
        } catch (permalinkError: any) {
          // If permalink fetch fails, construct URL as fallback
          console.warn('⚠️ Could not fetch permalink, using constructed URL:', permalinkError.message);
          postUrl = `https://www.instagram.com/p/${postId}/`;
        }
      }
      // Scheduled posts handled by queue system above, so no URL yet

      // Save to database (fire-and-forget to prevent blocking response)
      // This runs asynchronously so it doesn't delay the response
      const scheduledAt = scheduledPublishTime ? new Date(scheduledPublishTime) : new Date();
      
      // Prepare additional data to store in JSON field
      const additionalData: any = {
        containerId: mediaContainerId,
        mediaType: mediaType || 'photo',
        ...(mediaType === 'video' && videoProcessingAttempts !== undefined && {
          videoProcessing: {
            attempts: videoProcessingAttempts,
            elapsedSeconds: videoProcessingAttempts * 10,
            status: 'FINISHED',
          },
        }),
        ...(mediaType === 'carousel' && carouselUrls && {
          carousel: {
            imageCount: carouselUrls.length,
            imageUrls: carouselUrls,
          },
        }),
        publishedAt: new Date().toISOString(),
      };
      
      // Use setImmediate to defer database save until after response is sent
      setImmediate(async () => {
        try {
          await this.prisma.scheduledPost.create({
            data: {
              userId,
              socialAccountId,
              platform: 'instagram',
              type: mediaType || 'photo',
              content: caption || '',
              mediaUrl: mediaType === 'carousel' ? (carouselUrls && carouselUrls.length > 0 ? carouselUrls[0] : null) : mediaUrl || null,
              scheduledAt,
              status: scheduledPublishTime ? 'scheduled' : 'success',
              postedAt: scheduledPublishTime ? null : new Date(),
              externalPostId: postId ? String(postId) : null, // Save Instagram post ID
              permalink: postUrl && typeof postUrl === 'string' && postUrl.trim().length > 0 ? postUrl : null, // Save post URL
              data: additionalData, // Save additional JSON data (container IDs, processing info, etc.)
              errorMessage: null, // No error for successful posts
            },
          });
          console.log('✅ Post saved to database successfully (async)', {
            postId: postId || 'none',
            postUrl: postUrl || 'none',
            status: scheduledPublishTime ? 'scheduled' : 'success',
            hasData: true,
          });
        } catch (dbError: any) {
          console.error('❌ Failed to save post to database (non-critical):', dbError.message);
          // This is non-critical - post was published successfully
        }
      });
      
      console.log('✅ Post saved to database (deferred)', { postId, postUrl });

      // Log final success (fire-and-forget, non-blocking)
      // Use setImmediate to defer logging until after response is sent
      setImmediate(() => {
        try {
          this.logsService.info(
            'instagram',
            scheduledPublishTime ? 'Instagram post scheduled successfully' : 'Instagram post published successfully',
            {
              postId,
              postUrl: postUrl || undefined,
              mediaType,
              scheduled: !!scheduledPublishTime,
            },
            userId,
            socialAccountId,
          );
        } catch (logError: any) {
          console.warn('⚠️ Failed to log success (non-critical):', logError.message);
        }
      });

      console.log('✅ Returning success response:', {
        success: true,
        postId,
        postUrl: postUrl || null,
        hasPostUrl: !!postUrl,
      });

      // Build response object with all required fields
      // Ensure all values are JSON-serializable (no undefined, no functions, etc.)
      const response: {
        success: boolean;
        postId: string;
        message: string;
        postUrl?: string;
      } = {
        success: true,
        postId: String(postId), // Ensure it's a string
        message: scheduledPublishTime ? 'Post scheduled successfully' : 'Post published successfully',
      };
      
      // Only include postUrl if it exists and is a valid string
      if (postUrl && typeof postUrl === 'string' && postUrl.trim().length > 0) {
        response.postUrl = postUrl;
      }

      // Final validation - ensure response is serializable
      try {
        JSON.stringify(response);
      } catch (validateError: any) {
        console.error('[Instagram Service] Response validation failed:', validateError);
        // Return minimal safe response if validation fails
        return {
          success: true,
          postId: String(postId),
          message: 'Post published successfully',
        };
      }

      return response;
    } catch (error: any) {
      const errorMessage = error.response?.data?.error?.message || error.message;
      const errorStack = error.stack;
      
      console.error('❌ Instagram post creation error:', {
        message: errorMessage,
        status: error.response?.status,
        errorCode: error.response?.data?.error?.code,
        errorType: error.response?.data?.error?.type,
        stack: errorStack?.substring(0, 500),
      });
      
      // Log error (wrap in try-catch to prevent logging errors from breaking the flow)
      try {
        this.logsService.error(
          'instagram',
          'Instagram post creation failed',
          error,
          {
            socialAccountId,
            mediaType,
            errorMessage,
            apiError: error.response?.data?.error,
          },
          userId,
          socialAccountId,
        );
      } catch (logError: any) {
        console.warn('⚠️ Failed to log error (non-critical):', logError.message);
      }
      
      // Save failed post to database with any available postId/postUrl
      // IMPORTANT: Save postId/postUrl in dedicated fields, NOT in errorMessage
      // This allows proper querying and display even for partially failed posts
      setImmediate(async () => {
        try {
          // Prepare additional data for failed posts
          const failedData: any = {
            containerId: mediaContainerId || null,
            mediaType: mediaType || 'photo',
            errorOccurredAt: new Date().toISOString(),
            ...(mediaType === 'video' && videoProcessingAttempts !== undefined && {
              videoProcessing: {
                attempts: videoProcessingAttempts,
                elapsedSeconds: videoProcessingAttempts * 10,
                status: 'FAILED',
              },
            }),
            ...(mediaType === 'carousel' && carouselUrls && {
              carousel: {
                imageCount: carouselUrls.length,
                imageUrls: carouselUrls,
              },
            }),
          };
          
          await this.prisma.scheduledPost.create({
            data: {
              userId,
              socialAccountId,
              platform: 'instagram',
              type: mediaType || 'photo',
              content: caption || '',
              mediaUrl: mediaType === 'carousel' ? (carouselUrls && carouselUrls.length > 0 ? carouselUrls[0] : null) : mediaUrl || null,
              scheduledAt: scheduledPublishTime ? new Date(scheduledPublishTime) : new Date(),
              status: 'failed',
              externalPostId: postId ? String(postId) : null, // Save postId if available (partial success)
              permalink: postUrl && typeof postUrl === 'string' && postUrl.trim().length > 0 ? postUrl : null, // Save postUrl if available (partial success)
              data: failedData, // Save additional JSON data
              errorMessage: errorMessage, // Only the actual error message, not postId/postUrl
              postedAt: postId ? new Date() : null, // If we have postId, the post was actually published (partial success)
            },
          });
          console.log('✅ Failed post saved to database', {
            postId: postId || 'none',
            postUrl: postUrl || 'none',
            hasPartialSuccess: !!(postId || postUrl),
            errorMessage: errorMessage.substring(0, 100),
            hasData: true,
          });
        } catch (dbError: any) {
          console.error('❌ Failed to save failed post to database (non-critical):', dbError.message);
          // Non-critical - error response will still be sent
        }
      });

      // Provide user-friendly error message
      let userMessage = errorMessage;
      if (error.response?.data?.error) {
        const igError = error.response.data.error;
        
        // Token expiration error (code 190)
        if (igError.code === 190 || igError.message?.includes('Session has expired') || igError.message?.includes('expired')) {
          userMessage = `🔑 Instagram Token Expired\n\nYour Instagram access token has expired. You need to reconnect your Instagram account.\n\n⏰ **Token Expiration Times:**\n- Short-lived tokens: ~1 hour\n- Long-lived tokens: 60 days (if exchange works)\n- Tokens can be refreshed before expiration\n\n✅ **Solution:**\n1. Go to your Instagram accounts page\n2. Delete the expired Instagram account\n3. Click "Connect Instagram" to reconnect\n4. This will get a fresh token (we'll try to exchange it for a 60-day token)\n\nToken expired: ${igError.message || 'Access token is no longer valid'}\n\n💡 **Tip:** After reconnecting, the token should last 60 days. If it expires again quickly, there might be an issue with token exchange.`;
        } else if (igError.code === 100 || igError.error_subcode === 33) {
          const appId = process.env.INSTAGRAM_APP_ID || process.env.FACEBOOK_APP_ID || 'YOUR_APP_ID';
          userMessage = `🚫 Instagram Posting Blocked - App Review Required\n\nYour app is in Development mode and Instagram blocks posting to real accounts.\n\n📋 QUICK FIX OPTIONS:\n\n1️⃣ **Use Test Users (Fastest for Development)**\n   Step 1: Go to https://developers.facebook.com/apps/${appId}/roles/test-users\n   Step 2: Create a Test User\n   Step 3: Connect Test User's Instagram Business Account\n   ✅ Posting will work with Test Users!\n\n2️⃣ **Submit for App Review (For Production)**\n   Step 1: Go to https://developers.facebook.com/apps/${appId}/app-review\n   Step 2: Request "instagram_business_content_publish" permission (Instagram Login) or "instagram_content_publish" (if using Facebook Login)\n   Step 3: Fill out the form and submit\n   Step 4: Wait for approval (1-7 days)\n   ✅ Posting will work for all users!\n\n3️⃣ **Verify Instagram Business Account**\n   - Make sure your Instagram account is a Business Account\n   - Connect it to a Facebook Page\n   - Grant all required permissions\n\nError: ${igError.message}`;
        } else if (igError.message?.toLowerCase().includes('media') || igError.message?.toLowerCase().includes('url')) {
          userMessage = `📷 Media Upload Error\n\nInstagram cannot access the media from the provided URL.\n\nPossible causes:\n1. **Storage Bucket is Private** - Make the bucket public\n2. **URL is Invalid** - Check that the URL is accessible\n3. **Format Not Supported** - Instagram supports:\n   - Photos: JPG, PNG (max 8MB)\n   - Videos: MP4, MOV (max 100MB for posts, 1GB for Reels)\n4. **File Too Large** - Check Instagram size limits\n\nError: ${igError.message}`;
        }
      }

      throw new InternalServerErrorException(userMessage);
    }
  }

  /**
   * List all Instagram posts/uploads for a given account (for the current user)
   * This returns rows from ScheduledPost table for platform = 'instagram'
   */
  async listPostsForAccount(params: {
    userId: string;
    socialAccountId: string;
  }) {
    const { userId, socialAccountId } = params;

    // Validate account ownership
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });

    if (!account || account.platform !== 'instagram') {
      throw new BadRequestException('Invalid Instagram account');
    }

    if (account.userId !== userId) {
      throw new BadRequestException('Account does not belong to user');
    }

    // Return all scheduledPost rows for this user + account + platform
    const posts = await this.prisma.scheduledPost.findMany({
      where: {
        userId,
        socialAccountId,
        platform: 'instagram',
      },
      orderBy: [
        // Show most recently created / scheduled first
        { createdAt: 'desc' },
      ],
    });

    return posts;
  }

  /**
   * Delete an Instagram post/upload:
   * - Attempts to delete from Instagram Graph API (will fail as API doesn't support it)
   * - Deletes from ScheduledPost table
   * Note: Instagram Graph API does NOT support deleting published posts, but we attempt it anyway
   * and handle the error gracefully, then still remove from our database.
   */
  async deletePostForAccount(params: {
    userId: string;
    socialAccountId: string;
    scheduledPostId: string;
  }) {
    const { userId, socialAccountId, scheduledPostId } = params;

    // Validate account ownership
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });

    if (!account || account.platform !== 'instagram') {
      throw new BadRequestException('Invalid Instagram account');
    }

    if (account.userId !== userId) {
      throw new BadRequestException('Account does not belong to user');
    }

    // Find the post
    const post = await this.prisma.scheduledPost.findFirst({
      where: {
        id: scheduledPostId,
        userId,
        socialAccountId,
        platform: 'instagram',
      },
    });

    if (!post) {
      throw new BadRequestException('Post not found or does not belong to user');
    }

    let igDeleted = false;
    let igErrorMessage: string | null = null;

    // Attempt to delete from Instagram Graph API if we have an externalPostId
    // Note: Instagram API doesn't support deleting posts, but we try anyway for completeness
    if (post.externalPostId) {
      try {
        const accessToken = await this.socialAccountsService.getValidInstagramAccessToken(account.id);
        const igPostId = post.externalPostId;

        console.log(`🗑️ Attempting to delete Instagram post ${igPostId} from Instagram Graph API...`);
        console.log(`⚠️ Note: Instagram Graph API does NOT support deleting posts, but we'll attempt it anyway.`);

        // Try DELETE request to Instagram Graph API
        // This will likely fail with "Unsupported delete request" or similar
        try {
          const igRes = await axios.delete(
            `https://graph.instagram.com/v21.0/${igPostId}`,
            {
              params: {
                access_token: accessToken,
              },
            },
          );

          // If somehow it succeeds (unlikely), mark as deleted
          igDeleted = Boolean(igRes.data?.success || igRes.data === true);
          console.log(`✅ Instagram Graph API delete result for ${igPostId}:`, igRes.data);
        } catch (deleteError: any) {
          // Expected: Instagram API doesn't support DELETE
          const igError = deleteError.response?.data?.error;
          const fullErrorResponse = deleteError.response?.data;
          const statusCode = deleteError.response?.status;
          
          // Log the FULL error response so we can see exactly what Instagram says
          console.error(`❌ Instagram Graph API DELETE request failed:`);
          console.error(`   Status Code: ${statusCode}`);
          console.error(`   Error Object:`, JSON.stringify(igError, null, 2));
          console.error(`   Full Response:`, JSON.stringify(fullErrorResponse, null, 2));
          console.error(`   Error Message:`, deleteError.message);
          
          igErrorMessage =
            igError?.message ||
            fullErrorResponse?.error?.message ||
            deleteError.message ||
            'Instagram API does not support deleting posts';

          // Check if it's the specific "unsupported" error
          if (igError?.message?.toLowerCase().includes('unsupported') || 
              igError?.message?.toLowerCase().includes('does not support') ||
              igError?.type === 'OAuthException' ||
              statusCode === 400 || statusCode === 403) {
            console.log(`✅ Confirmed: Instagram Graph API does NOT support DELETE operation for media posts.`);
            console.log(`   This is a platform limitation, not a bug.`);
          } else {
            console.warn(`⚠️ Unexpected error - might be a different issue (not just unsupported operation)`);
          }
          
          console.log(`ℹ️ Post will be removed from our database only.`);
        }
      } catch (tokenError: any) {
        console.warn(`⚠️ Failed to get access token for Instagram delete:`, tokenError.message);
        igErrorMessage = `Failed to get access token: ${tokenError.message}`;
      }
    } else {
      console.log(`ℹ️ Post ${post.id} has no externalPostId; cannot attempt Instagram deletion.`);
    }

    // Always remove from our database, regardless of Instagram API result
    await this.prisma.scheduledPost.delete({
      where: { id: post.id },
    });

    console.log(`✅ Post record deleted from database: ${post.id}`);

    // Build response message
    let message = 'Post removed from your history.';
    if (igDeleted) {
      message = 'Post deleted from Instagram and removed from your history.';
    } else if (post.externalPostId) {
      message = 'Post removed from your history. Note: Instagram does not allow deleting published posts via API. You can delete it manually from the Instagram app.';
    }

    return {
      success: true,
      igDeleted,
      message,
      igErrorMessage: igErrorMessage || undefined,
    };
  }

  /**
   * Wait for video processing to complete
   */
  private async waitForVideoProcessing(
    mediaContainerId: string,
    accessToken: string,
    userId: string,
    socialAccountId: string
  ): Promise<void> {
    // For videos, we need to wait for processing before publishing
    // Instagram processes videos asynchronously - we need to poll for status
    let status = 'IN_PROGRESS';
    let attempts = 0;
    const maxAttempts = 30; // 30 attempts × 10 seconds = 5 minutes max wait

    console.log(`🎬 Starting video processing status check (max ${maxAttempts} attempts, 10 seconds each = ${maxAttempts * 10 / 60} minutes max)`);

    // Log video processing start
    this.logsService.info(
      'instagram',
      'Starting video processing status check',
      { containerId: mediaContainerId, maxAttempts, estimatedMaxTime: `${maxAttempts * 10 / 60} minutes` },
      userId,
      socialAccountId,
    );

    while (status === 'IN_PROGRESS' && attempts < maxAttempts) {
      // Wait 10 seconds between checks (don't spam Instagram API)
      await new Promise(resolve => setTimeout(resolve, 10000));

      try {
        const statusRes = await axios.get(
          `https://graph.instagram.com/v21.0/${mediaContainerId}`,
          {
            params: {
              fields: 'status_code',
            },
            headers: {
              'Authorization': `Bearer ${accessToken}`,
            },
          }
        );

        status = statusRes.data.status_code;
        attempts++;

        console.log(`📊 Video processing status: ${status} (attempt ${attempts}/${maxAttempts}, ${attempts * 10} seconds elapsed)`);

        // Log status check (only every 5 attempts to avoid too many logs)
        if (attempts % 5 === 0 || status !== 'IN_PROGRESS') {
          this.logsService.debug(
            'instagram',
            'Video processing status check',
            { status, attempt: attempts, maxAttempts, elapsedSeconds: attempts * 10, containerId: mediaContainerId },
            userId,
            socialAccountId,
          );
        }

        // If status is ERROR, fail immediately
        if (status === 'ERROR') {
          this.logsService.error(
            'instagram',
            'Video processing failed with ERROR status',
            null,
            { containerId: mediaContainerId, attempt: attempts },
            userId,
            socialAccountId,
          );
          throw new InternalServerErrorException(`Video processing failed. Instagram returned ERROR status. Container ID: ${mediaContainerId}`);
        }
      } catch (statusError: any) {
        attempts++;
        const elapsedSeconds = attempts * 10;
        console.warn(`⚠️ Status check failed (attempt ${attempts}/${maxAttempts}, ${elapsedSeconds} seconds elapsed):`, {
          error: statusError.response?.data?.error?.message || statusError.message,
          status: statusError.response?.status,
          containerId: mediaContainerId,
        });

        // Log status check failure
        this.logsService.warn(
          'instagram',
          'Video processing status check failed',
          {
            error: statusError.response?.data?.error?.message || statusError.message,
            statusCode: statusError.response?.status,
            attempt: attempts,
            maxAttempts,
            elapsedSeconds,
            containerId: mediaContainerId,
          },
          userId,
          socialAccountId,
        );

        // If we've tried many times and still getting errors, fail
        if (attempts >= maxAttempts) {
          this.logsService.error(
            'instagram',
            'Video processing status check failed after max attempts',
            statusError,
            {
              maxAttempts,
              elapsedSeconds: maxAttempts * 10,
              containerId: mediaContainerId,
              lastError: statusError.response?.data?.error?.message || statusError.message,
            },
            userId,
            socialAccountId,
          );
          throw new InternalServerErrorException(
            `Video processing status check failed after ${maxAttempts} attempts (${maxAttempts * 10} seconds). ` +
            `Last error: ${statusError.response?.data?.error?.message || statusError.message}. ` +
            `Container ID: ${mediaContainerId}.`
          );
        }
        continue;
      }
    }

    // Check final status
    if (status !== 'FINISHED') {
      if (status === 'IN_PROGRESS') {
        this.logsService.error(
          'instagram',
          'Video processing timed out',
          null,
          { containerId: mediaContainerId, attempts, elapsedSeconds: attempts * 10, finalStatus: status },
          userId,
          socialAccountId,
        );
        throw new InternalServerErrorException(
          `Video processing timed out after ${maxAttempts} attempts (${maxAttempts * 10} seconds). ` +
          `The video is still processing. Status: ${status}.`
        );
      } else {
        this.logsService.error(
          'instagram',
          'Video processing failed with non-FINISHED status',
          null,
          { containerId: mediaContainerId, finalStatus: status },
          userId,
          socialAccountId,
        );
        throw new InternalServerErrorException(
          `Video processing failed. Final status: ${status}. ` +
          `Container ID: ${mediaContainerId}`
        );
      }
    }

    console.log(`✅ Video processing completed successfully after ${attempts} attempts (${attempts * 10} seconds)`);

    // Log successful video processing
    this.logsService.info(
      'instagram',
      'Video processing completed successfully',
      { containerId: mediaContainerId, attempts, elapsedSeconds: attempts * 10 },
      userId,
      socialAccountId,
    );
  }

  private async waitForCarouselProcessing(
    mediaContainerId: string,
    accessToken: string,
    userId: string,
    socialAccountId: string
  ): Promise<void> {
    // For carousel containers, we need to wait for processing before publishing
    // Similar to video processing but carousels might process faster
    let status = 'IN_PROGRESS';
    let attempts = 0;
    const maxAttempts = 12; // 12 attempts × 5 seconds = 1 minute max wait

    console.log(`🎠 Starting carousel processing status check (max ${maxAttempts} attempts, 5 seconds each = ${maxAttempts * 5 / 60} minutes max)`);

    // Log carousel processing start
    this.logsService.info(
      'instagram',
      'Starting carousel processing status check',
      { containerId: mediaContainerId, maxAttempts, estimatedMaxTime: `${maxAttempts * 5 / 60} minutes` },
      userId,
      socialAccountId,
    );

    while (status === 'IN_PROGRESS' && attempts < maxAttempts) {
      // Wait 5 seconds between checks (carousel should process faster than video)
      await new Promise(resolve => setTimeout(resolve, 5000));

      try {
        const statusRes = await axios.get(
          `https://graph.instagram.com/v21.0/${mediaContainerId}`,
          {
            params: {
              fields: 'status_code',
            },
            headers: {
              'Authorization': `Bearer ${accessToken}`,
            },
          }
        );

        status = statusRes.data.status_code;
        attempts++;

        console.log(`📊 Carousel processing status: ${status} (attempt ${attempts}/${maxAttempts}, ${attempts * 5} seconds elapsed)`);

        // Log status check (only every 3 attempts to avoid too many logs)
        if (attempts % 3 === 0 || status !== 'IN_PROGRESS') {
          this.logsService.debug(
            'instagram',
            'Carousel processing status check',
            { status, attempt: attempts, maxAttempts, elapsedSeconds: attempts * 5, containerId: mediaContainerId },
            userId,
            socialAccountId,
          );
        }

        // If status is ERROR, fail immediately
        if (status === 'ERROR') {
          this.logsService.error(
            'instagram',
            'Carousel processing failed with ERROR status',
            null,
            { containerId: mediaContainerId, attempt: attempts },
            userId,
            socialAccountId,
          );
          throw new InternalServerErrorException(`Carousel processing failed. Instagram returned ERROR status. Container ID: ${mediaContainerId}`);
        }
      } catch (statusError: any) {
        attempts++;
        const elapsedSeconds = attempts * 5;
        console.warn(`⚠️ Carousel status check failed (attempt ${attempts}/${maxAttempts}, ${elapsedSeconds} seconds elapsed):`, {
          error: statusError.response?.data?.error?.message || statusError.message,
          status: statusError.response?.status,
          containerId: mediaContainerId,
        });

        // Log status check failure
        this.logsService.warn(
          'instagram',
          'Carousel processing status check failed',
          {
            error: statusError.response?.data?.error?.message || statusError.message,
            statusCode: statusError.response?.status,
            attempt: attempts,
            maxAttempts,
            elapsedSeconds,
            containerId: mediaContainerId,
          },
          userId,
          socialAccountId,
        );

        // If we've tried many times and still getting errors, fail
        if (attempts >= maxAttempts) {
          this.logsService.error(
            'instagram',
            'Carousel processing status check failed after max attempts',
            statusError,
            {
              maxAttempts,
              elapsedSeconds: maxAttempts * 5,
              containerId: mediaContainerId,
              lastError: statusError.response?.data?.error?.message || statusError.message,
            },
            userId,
            socialAccountId,
          );
          throw new InternalServerErrorException(
            `Carousel processing status check failed after ${maxAttempts} attempts (${maxAttempts * 5} seconds). ` +
            `Last error: ${statusError.response?.data?.error?.message || statusError.message}. ` +
            `Container ID: ${mediaContainerId}.`
          );
        }
        continue;
      }
    }

    // Check final status
    if (status !== 'FINISHED') {
      if (status === 'IN_PROGRESS') {
        this.logsService.error(
          'instagram',
          'Carousel processing timed out',
          null,
          { containerId: mediaContainerId, attempts, elapsedSeconds: attempts * 5, finalStatus: status },
          userId,
          socialAccountId,
        );
        throw new InternalServerErrorException(
          `Carousel processing timed out after ${maxAttempts} attempts (${maxAttempts * 5} seconds). ` +
          `The carousel is still processing. Status: ${status}.`
        );
      } else {
        this.logsService.error(
          'instagram',
          'Carousel processing failed with non-FINISHED status',
          null,
          { containerId: mediaContainerId, finalStatus: status },
          userId,
          socialAccountId,
        );
        throw new InternalServerErrorException(
          `Carousel processing failed. Final status: ${status}. ` +
          `Container ID: ${mediaContainerId}`
        );
      }
    }

    console.log(`✅ Carousel processing completed successfully after ${attempts} attempts (${attempts * 5} seconds)`);

    // Log successful carousel processing
    this.logsService.info(
      'instagram',
      'Carousel processing completed successfully',
      { containerId: mediaContainerId, attempts, elapsedSeconds: attempts * 5 },
      userId,
      socialAccountId,
    );
  }
}

