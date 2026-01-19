import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../../prisma/prisma.service';
import { SocialAccountsService } from '../../social-accounts.service';
import { InstagramPostDto } from './dto/instagram-post.dto';
import { LogsService } from '../../../logs/logs.service';

@Injectable()
export class InstagramService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socialAccountsService: SocialAccountsService,
    private readonly logsService: LogsService,
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
  }) {
    const { userId, socialAccountId, caption, mediaUrl, mediaType, scheduledPublishTime, locationId, userTags } = params;

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
      let scheduledTimestamp: number | null = null;
      if (scheduledPublishTime) {
        const scheduledDate = new Date(scheduledPublishTime);
        const now = new Date();
        
        if (isNaN(scheduledDate.getTime())) {
          throw new BadRequestException('Invalid scheduled publish time format. Use YYYY-MM-DDTHH:mm format.');
        }
        
        if (scheduledDate <= now) {
          throw new BadRequestException('Scheduled publish time must be in the future.');
        }
        
        // Instagram allows scheduling up to 25 hours in advance
        const maxScheduledTime = new Date();
        maxScheduledTime.setHours(maxScheduledTime.getHours() + 25);
        if (scheduledDate > maxScheduledTime) {
          throw new BadRequestException('Scheduled publish time cannot be more than 25 hours in the future.');
        }
        
        scheduledTimestamp = Math.floor(scheduledDate.getTime() / 1000);
        console.log('📅 Scheduled publish time:', scheduledDate.toISOString(), 'Unix:', scheduledTimestamp);
      }

      // Validate media URL if provided
      if (mediaType && !mediaUrl) {
        throw new BadRequestException('Media URL is required for photo/video posts');
      }

      // Create media container
      if (mediaType === 'photo' && mediaUrl) {
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

        // Schedule if provided
        if (scheduledTimestamp) {
          containerData.scheduled_publish_time = scheduledTimestamp.toString();
        }

        console.log('📤 Creating Instagram photo container...');
        console.log('🔄 Using Instagram Graph API (graph.instagram.com) for Instagram Login...');
        console.log('📋 Container data:', {
          image_url: mediaUrl.substring(0, 50) + '...',
          caption: caption?.substring(0, 50) || '',
          has_location: !!locationId,
          has_user_tags: !!userTags,
          scheduled: !!scheduledTimestamp,
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
            `https://graph.instagram.com/v24.0/me/media`,
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
              `https://graph.instagram.com/v24.0/${igUserId}/media`,
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
      } else if (mediaType === 'video' && mediaUrl) {
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

        // Schedule if provided
        if (scheduledTimestamp) {
          containerData.scheduled_publish_time = scheduledTimestamp.toString();
        }

        console.log('🎥 Creating Instagram video container...');
        console.log('🔄 Using Instagram Graph API (graph.instagram.com) for Instagram Login...');
        console.log('📋 Container data:', {
          video_url: mediaUrl.substring(0, 50) + '...',
          media_type: containerData.media_type,
          caption: caption?.substring(0, 50) || '',
          has_location: !!locationId,
          has_user_tags: !!userTags,
          scheduled: !!scheduledTimestamp,
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
            `https://graph.instagram.com/v24.0/me/media`,
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
              `https://graph.instagram.com/v24.0/${igUserId}/media`,
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
              url_me: `https://graph.instagram.com/v24.0/me/media`,
              url_ig_id: `https://graph.instagram.com/v24.0/${igUserId}/media`,
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
        // Instagram processes videos asynchronously - we need to poll for status
        // Check status
        let status = 'IN_PROGRESS';
        let attempts = 0;
        videoProcessingAttempts = 0; // Track attempts for database storage
        const maxAttempts = 30; // 30 attempts × 10 seconds = 5 minutes max wait
        // Why 30? Instagram videos can take 1-5 minutes to process depending on:
        // - Video length (longer = more time)
        // - Video resolution (higher = more time)
        // - Instagram server load
        // 5 minutes is a reasonable maximum wait time

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
          
          // Instagram API with Instagram Login uses graph.instagram.com
          // Access token should be sent as Bearer token in Authorization header
          try {
            const statusRes = await axios.get(
              `https://graph.instagram.com/v24.0/${mediaContainerId}`,
              {
                params: {
                  fields: 'status_code',
                },
                headers: {
                  'Authorization': `Bearer ${accessToken}`, // Send as Bearer token in header
                },
              }
            );

            status = statusRes.data.status_code;
            attempts++;
            videoProcessingAttempts = attempts; // Update for database storage
            
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
            // If status check fails, log but continue (might be temporary network issue)
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
                `Container ID: ${mediaContainerId}. ` +
                `This might be a temporary network issue. Try posting the video again.`
              );
            }
            
            // Continue to next attempt (will wait 10 seconds before next check)
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
              `The video is still processing. Status: ${status}. ` +
              `You may need to check Instagram manually or try again later.`
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
      } else if (!mediaType || !mediaUrl) {
        // Text-only post (not supported by Instagram, but we'll handle gracefully)
        throw new BadRequestException('Instagram requires media (photo or video). Text-only posts are not supported.');
      }

      // Ensure mediaContainerId is set
      if (!mediaContainerId) {
        throw new BadRequestException('Failed to create media container');
      }

      // Publish the media container
      if (!scheduledTimestamp) {
        // Immediate publish
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
            `https://graph.instagram.com/v24.0/${mediaContainerId}`,
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
            `https://graph.instagram.com/v24.0/me/media_publish`,
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
              `https://graph.instagram.com/v24.0/${igUserId}/media_publish`,
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
      } else {
        // Scheduled post - Instagram will publish automatically at the scheduled time
        postId = mediaContainerId; // Use container ID as post ID for scheduled posts
        console.log(`📅 Instagram post scheduled: ${postId}`);
        
        // Log scheduled post
        this.logsService.info(
          'instagram',
          'Instagram post scheduled successfully',
          { postId, containerId: mediaContainerId, mediaType, scheduledTime: scheduledPublishTime },
          userId,
          socialAccountId,
        );
      }

      // Try to fetch post URL (permalink) for immediate posts
      // postUrl already declared at top of function
      if (!scheduledTimestamp && postId) {
        try {
          // Wait a few seconds for Instagram to process the post
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          console.log('🔗 Fetching post permalink...');
          const permalinkRes = await axios.get(
            `https://graph.instagram.com/v24.0/${postId}`,
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
      } else if (scheduledTimestamp) {
        // For scheduled posts, we can't get the URL until it's published
        postUrl = null;
      }

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
              mediaUrl: mediaUrl || null,
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
          };
          
          await this.prisma.scheduledPost.create({
            data: {
              userId,
              socialAccountId,
              platform: 'instagram',
              type: mediaType || 'photo',
              content: caption || '',
              mediaUrl: mediaUrl || null,
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
          userMessage = `🚫 Instagram Posting Blocked - App Review Required\n\nYour app is in Development mode and Instagram blocks posting to real accounts.\n\n📋 QUICK FIX OPTIONS:\n\n1️⃣ **Use Test Users (Fastest for Development)**\n   Step 1: Go to https://developers.facebook.com/apps/${appId}/roles/test-users\n   Step 2: Create a Test User\n   Step 3: Connect Test User's Instagram Business Account\n   ✅ Posting will work with Test Users!\n\n2️⃣ **Submit for App Review (For Production)**\n   Step 1: Go to https://developers.facebook.com/apps/${appId}/app-review\n   Step 2: Request "instagram_content_publish" permission\n   Step 3: Fill out the form and submit\n   Step 4: Wait for approval (1-7 days)\n   ✅ Posting will work for all users!\n\n3️⃣ **Verify Instagram Business Account**\n   - Make sure your Instagram account is a Business Account\n   - Connect it to a Facebook Page\n   - Grant all required permissions\n\nError: ${igError.message}`;
        } else if (igError.message?.toLowerCase().includes('media') || igError.message?.toLowerCase().includes('url')) {
          userMessage = `📷 Media Upload Error\n\nInstagram cannot access the media from the provided URL.\n\nPossible causes:\n1. **Storage Bucket is Private** - Make the bucket public\n2. **URL is Invalid** - Check that the URL is accessible\n3. **Format Not Supported** - Instagram supports:\n   - Photos: JPG, PNG (max 8MB)\n   - Videos: MP4, MOV (max 100MB for posts, 1GB for Reels)\n4. **File Too Large** - Check Instagram size limits\n\nError: ${igError.message}`;
        }
      }

      throw new InternalServerErrorException(userMessage);
    }
  }
}

