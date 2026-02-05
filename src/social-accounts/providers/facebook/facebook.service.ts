import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import FormData from 'form-data';
import { PrismaService } from '../../../prisma/prisma.service';
import { SocialAccountsService } from '../../social-accounts.service';
import { FacebookPostDto } from './dto/facebook-post.dto';
import { AlertsService } from '../../../alerts/alerts.service';
import { EncryptionService } from '../../../common/encryption.service';

@Injectable()
export class FacebookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socialAccountsService: SocialAccountsService,
    private readonly alertsService: AlertsService,
    private readonly encryption: EncryptionService,
  ) {}

  async createPost(params: {
    userId: string;
    socialAccountId: string;
    message?: string;
    mediaUrl?: string;
    mediaType?: 'photo' | 'video';
    scheduledPublishTime?: string;
    collaborator?: string;
    shareToStory?: boolean;
    privacy?: 'PUBLIC' | 'FRIENDS' | 'CUSTOM';
    privacyValue?: string;
    isCarousel?: boolean;
    carouselUrls?: string[];
  }) {
    const {
      userId,
      socialAccountId,
      message,
      mediaUrl,
      mediaType,
      scheduledPublishTime,
      collaborator,
      shareToStory,
      privacy,
      privacyValue,
      isCarousel,
      carouselUrls,
    } = params;

    // Get account
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });

    if (!account || account.platform !== 'facebook') {
      throw new BadRequestException('Invalid Facebook account');
    }

    if (account.userId !== userId) {
      throw new BadRequestException('Account does not belong to user');
    }

    // Get valid access token
    let accessToken = await this.socialAccountsService.getValidFacebookAccessToken(account.id);
    const pageId = account.externalId;
    let tokenData: any = null;

    // Verify token and get fresh page token if needed
    try {
      if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) {
        console.warn('Facebook APP_ID or APP_SECRET not set, skipping token debug');
      } else {
        const tokenDebug = await axios.get(`https://graph.facebook.com/v21.0/debug_token`, {
          params: {
            input_token: accessToken,
            access_token: process.env.FACEBOOK_APP_ID + '|' + process.env.FACEBOOK_APP_SECRET,
          },
        });

        tokenData = tokenDebug.data.data;
        
        // Log app mode detection
        if (tokenData.app_id === process.env.FACEBOOK_APP_ID) {
          console.log(`📱 App ID: ${tokenData.app_id}`);
          console.log(`👤 User ID: ${tokenData.user_id}`);
          console.log(`🔑 Token Type: ${tokenData.type}`);
          if (tokenData.type === 'PAGE') {
            console.log(`📄 Page ID: ${tokenData.profile_id}`);
          }
        }
        
        // If token is a user token, get fresh page token
        if (tokenData.type === 'USER' || (tokenData.type === 'PAGE' && tokenData.profile_id !== pageId)) {
        console.log('Using user account token to get fresh page token');
        
        // Get user's pages with fresh token
        const pagesRes = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
          params: {
            access_token: accessToken,
            fields: 'id,name,access_token',
          },
        });

        const pages = pagesRes.data.data || [];
        const targetPage = pages.find((p: any) => p.id === pageId);

        if (targetPage) {
          console.log(`✅ Got fresh page token for page ${pageId} (${targetPage.name})`);
          accessToken = targetPage.access_token;

          // Update stored token (encrypt before storing)
          await this.prisma.socialAccount.update({
            where: { id: account.id },
            data: { accessToken: this.encryption.encrypt(accessToken) },
          });
        }
      }
      }
    } catch (tokenErr: any) {
      console.warn('Token verification failed:', tokenErr.response?.data?.error?.message || tokenErr.message);
      // Continue with existing token even if verification fails
    }

    let postId: string;

    // For carousel posts, store the first image URL so the UI has a thumbnail
    const finalMediaUrl =
      isCarousel && carouselUrls && carouselUrls.length > 0 ? carouselUrls[0] : mediaUrl;

    try {
      // Verify we can access the page
      try {
        const pageInfo = await axios.get(`https://graph.facebook.com/v21.0/${pageId}`, {
          params: {
            access_token: accessToken,
            fields: 'id,name',
          },
        });
        console.log(`✅ Page token verified - can access page: ${pageInfo.data.name} (ID: ${pageId})`);
      } catch (pageErr: any) {
        console.warn('Page access test failed:', pageErr.response?.data?.error?.message || pageErr.message);
      }

      // Helper function to add privacy settings
      // Note: For Page posts, privacy parameter may not apply the same way as user posts
      // But we set it to EVERYONE to ensure maximum visibility
      const addPrivacySettings = (data: any, isFormData: boolean = false) => {
        if (isFormData) {
          // For FormData (photos/videos endpoints), send as JSON string
          let privacyValue_str = '';
          if (privacy === 'FRIENDS') {
            privacyValue_str = JSON.stringify({ value: 'ALL_FRIENDS' });
          } else if (privacy === 'CUSTOM' && privacyValue) {
            privacyValue_str = JSON.stringify({ 
              value: 'CUSTOM',
              allow: privacyValue.split(',').map((id: string) => id.trim())
            });
          } else {
            // Default to PUBLIC/EVERYONE
            privacyValue_str = JSON.stringify({ value: 'EVERYONE' });
          }
          data.append('privacy', privacyValue_str);
        } else {
          // For JSON requests (feed/posts endpoints), send as object
          // Facebook Graph API expects privacy as an object for JSON requests
          if (privacy === 'FRIENDS') {
            data.privacy = { value: 'ALL_FRIENDS' };
          } else if (privacy === 'CUSTOM' && privacyValue) {
            data.privacy = { 
              value: 'CUSTOM',
              allow: privacyValue.split(',').map((id: string) => id.trim())
            };
          } else {
            // Default to PUBLIC/EVERYONE - this is the correct format for Page posts
            data.privacy = { value: 'EVERYONE' };
          }
        }
      };

      // Helper function to add collaborator (tags)
      const addCollaborator = (data: any, isFormData: boolean = false) => {
        if (collaborator) {
          // Collaborator can be comma-separated user IDs or page IDs
          // Facebook requires tags to be an array
          const tagIds = collaborator
            .split(',')
            .map((id: string) => id.trim())
            .filter((id: string) => id.length > 0);
          
          if (tagIds.length > 0) {
            if (isFormData) {
              // For FormData (photos/videos), tags might not be supported or need special handling
              // Try appending each tag separately with array notation
              tagIds.forEach((tagId: string) => {
                data.append('tags[]', tagId);
              });
            } else {
              // For regular JSON posts, set as array
              data.tags = tagIds;
            }
          }
        }
      };

      // Validate scheduled publish time if provided
      let scheduledTimestamp: number | null = null;
      if (scheduledPublishTime) {
        const scheduledDate = new Date(scheduledPublishTime);
        const now = new Date();
        
        // Check if date is valid
        if (isNaN(scheduledDate.getTime())) {
          throw new BadRequestException('Invalid scheduled publish time format. Use YYYY-MM-DDTHH:mm format.');
        }
        
        // Check if date is in the past
        if (scheduledDate <= now) {
          throw new BadRequestException('Scheduled publish time must be in the future.');
        }
        
        // Check if date is too far in the future (Facebook limit: 6 months)
        const sixMonthsFromNow = new Date();
        sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
        if (scheduledDate > sixMonthsFromNow) {
          throw new BadRequestException('Scheduled publish time cannot be more than 6 months in the future.');
        }
        
        scheduledTimestamp = Math.floor(scheduledDate.getTime() / 1000);
        console.log('📅 Scheduled publish time:', scheduledDate.toISOString(), 'Unix:', scheduledTimestamp);
      }

      // Post to Facebook
      // Handle carousel posts (multiple images)
      if (isCarousel && carouselUrls && carouselUrls.length >= 2) {
        console.log(`🎠 Creating carousel post with ${carouselUrls.length} images...`);

        // Facebook carousel: upload each photo as unpublished, then create a feed post with attached_media
        const photoIds: string[] = [];

        for (let i = 0; i < carouselUrls.length; i++) {
          const imageUrl = carouselUrls[i];
          try {
            console.log(`📤 Uploading carousel photo ${i + 1}/${carouselUrls.length} from URL: ${imageUrl}`);
            
            // Validate URL is accessible before sending to Facebook
            try {
              const urlCheck = await axios.head(imageUrl, { 
                timeout: 5000,
                validateStatus: (status) => status < 500
              });
              console.log(`✅ URL accessible, status: ${urlCheck.status}`);
            } catch (urlErr: any) {
              console.warn(`⚠️ URL check failed for photo ${i + 1}:`, urlErr.message);
              // Continue anyway - Facebook will validate it
            }

            const photoFormData = new FormData();
            photoFormData.append('url', imageUrl);
            photoFormData.append('access_token', accessToken);
            photoFormData.append('published', 'false'); // don't publish individual photos

            const photoRes = await axios.post(
              `https://graph.facebook.com/v21.0/${pageId}/photos`,
              photoFormData,
              {
                headers: photoFormData.getHeaders(),
              },
            );

            if (photoRes.data.id) {
              photoIds.push(photoRes.data.id);
              console.log(`✅ Uploaded carousel photo ${i + 1}/${carouselUrls.length}: ${photoRes.data.id}`);
            } else {
              console.warn(`⚠️ Photo ${i + 1} uploaded but no ID returned:`, photoRes.data);
            }
          } catch (photoErr: any) {
            const errorDetails = photoErr.response?.data?.error || {};
            const errorMessage = errorDetails.message || photoErr.message;
            const errorCode = errorDetails.code;
            const errorType = errorDetails.type;
            
            console.error(`⚠️ Failed to upload carousel photo ${i + 1}:`, {
              message: errorMessage,
              code: errorCode,
              type: errorType,
              url: imageUrl,
              fullError: errorDetails
            });
          }
        }

        if (photoIds.length === 0) {
          throw new Error('Failed to upload any photos for carousel post');
        }

        const postData: any = {
          message: message || '',
          access_token: accessToken,
          attached_media: photoIds.map((id) => ({ media_fbid: id })),
        };
        // NOTE: Do NOT add privacy parameter for Page posts!
        // Facebook rejects: "Posts where the actor is a page cannot also include privacy"
        // Page posts are public by default if the Page is public

        if (scheduledTimestamp) {
          postData.scheduled_publish_time = scheduledTimestamp;
          postData.published = false;
        } else {
          // Explicitly set published: true for immediate posts
          // Without this, Facebook may leave the post unpublished/draft
          postData.published = true;
          // Ensure post is visible on timeline
          postData.timeline_visibility = 'normal';
          postData.is_hidden = false;
        }

        console.log(`📤 Creating carousel post with ${photoIds.length} photos...`);
        console.log(`👁️ Visibility: published=${postData.published}, timeline_visibility=${postData.timeline_visibility}, is_hidden=${postData.is_hidden}`);
        console.log(`ℹ️ Note: Privacy parameter NOT used for Page posts (Facebook requirement)`);
        const feedRes = await axios.post(
          `https://graph.facebook.com/v21.0/${pageId}/feed`,
          postData,
        );

        postId = feedRes.data.id;
        console.log(`✅ Carousel post created: ${postId}`);
      } else if (mediaType === 'photo' && mediaUrl) {
        // Validate that the image URL is accessible
        try {
          console.log('🔍 Validating image URL:', mediaUrl);
          const imageCheck = await axios.head(mediaUrl, { 
            timeout: 5000,
            validateStatus: (status) => status < 500 // Accept redirects and 404s
          });
          console.log('✅ Image URL is accessible, status:', imageCheck.status);
        } catch (urlError: any) {
          console.warn('⚠️ Could not validate image URL:', urlError.message);
          // Continue anyway - Facebook will validate it
        }

        // Photo post
        const formData = new FormData();
        formData.append('message', message || '');
        formData.append('url', mediaUrl);
        formData.append('access_token', accessToken);
        // NOTE: Do NOT add privacy parameter for Page posts!
        // Facebook rejects: "Posts where the actor is a page cannot also include privacy"
        // Note: Tags/collaborators not supported for photo posts via FormData
        // Skip addCollaborator for FormData posts

        if (scheduledTimestamp) {
          formData.append('scheduled_publish_time', scheduledTimestamp.toString());
          formData.append('published', 'false');
        } else {
          // Explicitly set published: true for immediate posts
          formData.append('published', 'true');
        }

        console.log('📤 Posting photo to Facebook...');
        const res = await axios.post(
          `https://graph.facebook.com/v21.0/${pageId}/photos`,
          formData,
          {
            headers: formData.getHeaders(),
          },
        );

        postId = res.data.id;
      } else if (mediaType === 'video' && mediaUrl) {
        // Video post
        console.log('🎥 Posting video to Facebook:', mediaUrl);
        const formData = new FormData();
        formData.append('description', message || '');
        formData.append('file_url', mediaUrl);
        formData.append('access_token', accessToken);
        // NOTE: Do NOT add privacy parameter for Page posts!
        // Facebook rejects: "Posts where the actor is a page cannot also include privacy"
        // Note: Tags/collaborators not supported for video posts via FormData
        // Skip addCollaborator for FormData posts

        if (scheduledTimestamp) {
          formData.append('scheduled_publish_time', scheduledTimestamp.toString());
          formData.append('published', 'false');
        } else {
          // Explicitly set published: true for immediate posts
          formData.append('published', 'true');
        }

        const res = await axios.post(
          `https://graph.facebook.com/v21.0/${pageId}/videos`,
          formData,
          {
            headers: formData.getHeaders(),
          },
        );

        postId = res.data.id;
      } else {
        // Text post - Try /posts endpoint first, fallback to /feed if needed
        const postData: any = {
          message: message || '',
          access_token: accessToken,
        };
        // NOTE: Do NOT add privacy parameter for Page posts!
        // Facebook rejects: "Posts where the actor is a page cannot also include privacy"
        addCollaborator(postData);

        if (scheduledTimestamp) {
          postData.scheduled_publish_time = scheduledTimestamp;
          postData.published = false;
        } else {
          // Explicitly set published: true for immediate posts
          postData.published = true;
          postData.timeline_visibility = 'normal';
          postData.is_hidden = false;
        }

        try {
          // Try /posts endpoint (recommended)
          const res = await axios.post(
            `https://graph.facebook.com/v21.0/${pageId}/posts`,
            postData,
          );
          postId = res.data.id;
        } catch (postsError: any) {
          // If /posts fails with App Review error, try /feed as fallback
          const fbError = postsError.response?.data?.error;
          if (fbError && (fbError.code === 100 || fbError.error_subcode === 33)) {
            console.log('⚠️ /posts endpoint blocked, trying /feed as fallback...');
            try {
              const feedRes = await axios.post(
                `https://graph.facebook.com/v21.0/${pageId}/feed`,
                postData,
              );
              postId = feedRes.data.id;
              console.log('✅ Successfully posted using /feed endpoint');
            } catch (feedError: any) {
              // If /feed also fails, throw the original error
              throw postsError;
            }
          } else {
            // If it's a different error, throw it
            throw postsError;
          }
        }
      }

      // Log final post result
      console.log(
        `✅ Facebook post created for page ${pageId}. Type: ${mediaType || 'text'}, Status: ${
          scheduledPublishTime ? 'scheduled' : 'immediate'
        }, Post ID: ${postId}`,
      );

      // Create story separately if requested
      if (shareToStory && mediaUrl && mediaType) {
        try {
          console.log(`📱 Creating separate story with ${mediaType}...`);
          
          if (mediaType === 'photo') {
            // Photo story - can use URL
            const storyFormData = new FormData();
            storyFormData.append('url', mediaUrl);
            storyFormData.append('access_token', accessToken);
            storyFormData.append('published', 'true');
            
            try {
              const storyRes = await axios.post(
                `https://graph.facebook.com/v21.0/${pageId}/photos`,
                storyFormData,
                {
                  headers: storyFormData.getHeaders(),
                },
              );
              
              if (storyRes.data.id) {
                console.log(`✅ Story photo created: ${storyRes.data.id}`);
              }
            } catch (storyError: any) {
              const errorMsg = storyError.response?.data?.error?.message || storyError.message;
              console.warn('⚠️ Story photo creation failed:', errorMsg);
            }
          } else if (mediaType === 'video') {
            // Video story - need to download and upload directly
            console.log('📥 Downloading video from Supabase for story upload...');
            
            try {
              // Download video from Supabase Storage
              const videoResponse = await axios.get(mediaUrl, {
                responseType: 'stream',
                timeout: 60000, // 60 second timeout
              });
              
              // Create FormData for direct video upload
              const storyFormData = new FormData();
              storyFormData.append('source', videoResponse.data, {
                filename: `story-${Date.now()}.mp4`,
                contentType: 'video/mp4',
              });
              storyFormData.append('access_token', accessToken);
              storyFormData.append('description', message || '');
              storyFormData.append('published', 'true');
              
              console.log('📤 Uploading video directly to Facebook story...');
              
              // Upload video directly to Facebook
              const storyRes = await axios.post(
                `https://graph.facebook.com/v21.0/${pageId}/videos`,
                storyFormData,
                {
                  headers: {
                    ...storyFormData.getHeaders(),
                  },
                  maxContentLength: Infinity,
                  maxBodyLength: Infinity,
                  timeout: 300000, // 5 minutes for large videos
                },
              );
              
              if (storyRes.data.id) {
                console.log(`✅ Story video created: ${storyRes.data.id}`);
              } else {
                console.log('⚠️ Story video upload response:', storyRes.data);
              }
            } catch (storyError: any) {
              const errorMsg = storyError.response?.data?.error?.message || storyError.message;
              console.warn('⚠️ Story video creation failed:', errorMsg);
              
              if (errorMsg.includes('permission') || errorMsg.includes('not supported')) {
                console.log('💡 Note: Video stories may require pages_manage_metadata permission or may not be supported for this Page type.');
              }
            }
          }
          
        } catch (storyError: any) {
          console.warn('⚠️ Story creation error:', storyError.response?.data?.error?.message || storyError.message);
          // Don't fail the main post if story creation fails
        }
      } else if (shareToStory && !mediaUrl) {
        console.log('⚠️ Stories require media (photo/video). Text-only stories are not supported.');
      }

      // Save to database
      const scheduledAt = scheduledPublishTime ? new Date(scheduledPublishTime) : new Date();

      const scheduledPost = await this.prisma.scheduledPost.create({
        data: {
          userId,
          socialAccountId,
          platform: 'facebook',
          type: isCarousel ? 'photo' : (mediaType || 'text'),
          content: message || (isCarousel ? `Carousel post with ${carouselUrls?.length || 0} images` : ''),
          mediaUrl: finalMediaUrl || null,
          scheduledAt,
          status: scheduledPublishTime ? 'scheduled' : 'success',
          postedAt: scheduledPublishTime ? null : new Date(),
          externalPostId: postId ? String(postId) : null, // Save Facebook post ID in dedicated field
          permalink: null, // Facebook API doesn't return permalink in response (would need separate API call to fetch)
          errorMessage: null, // No error for successful posts
        },
      });

      // Create alert for scheduled post (Facebook uses native scheduling)
      if (scheduledPublishTime) {
        try {
          const accountName = account.displayName || account.username || 'Facebook Page';
          const postType = (isCarousel ? 'carousel' : (mediaType || 'photo')) as 'photo' | 'video' | 'carousel';
          const formattedDate = scheduledAt.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          });
          const message = `Your ${postType} post for ${accountName} is scheduled for ${formattedDate}. Post scheduled through the app.`;

          await this.alertsService.create({
            userId,
            socialAccountId,
            scheduledPostId: scheduledPost.id,
            type: 'scheduled',
            platform: 'facebook',
            title: 'Scheduled Successfully',
            message,
            accountName,
            postType,
            scheduledAt,
          });
        } catch (alertError: any) {
          // Don't fail the request if alert creation fails
          console.error('Failed to create alert for scheduled Facebook post:', alertError.message);
        }
      }

      return {
        success: true,
        postId,
        message: scheduledPublishTime ? 'Post scheduled successfully' : 'Post published successfully',
      };
    } catch (error: any) {
      const errorMessage = error.response?.data?.error?.message || error.message;
      
      // Save failed post to database
      // Note: Facebook doesn't return postId on failure, so externalPostId will be null
      await this.prisma.scheduledPost.create({
        data: {
          userId,
          socialAccountId,
          platform: 'facebook',
          type: isCarousel ? 'photo' : (mediaType || 'text'),
          content: message || (isCarousel ? `Carousel post with ${carouselUrls?.length || 0} images` : ''),
          mediaUrl: finalMediaUrl || null,
          scheduledAt: scheduledPublishTime ? new Date(scheduledPublishTime) : new Date(),
          status: 'failed',
          externalPostId: null, // Facebook doesn't return postId on error
          permalink: null, // No permalink on error
          errorMessage: errorMessage, // Only actual error message
        },
      });

      // Provide user-friendly error message
      let userMessage = errorMessage;
      if (error.response?.data?.error) {
        const fbError = error.response.data.error;
        
        // Handle scheduled publish time errors FIRST (most specific)
        if (fbError.message?.toLowerCase().includes('scheduled') || 
            fbError.message?.toLowerCase().includes('publish time') ||
            (fbError.code === 100 && fbError.message?.toLowerCase().includes('invalid'))) {
          userMessage = `📅 Scheduled Publish Time Error\n\n${fbError.message}\n\nPossible causes:\n1. **Time is in the past** - Scheduled time must be in the future\n2. **Time format is invalid** - Use format: YYYY-MM-DDTHH:mm (e.g., 2024-12-25T14:30)\n3. **Time is too far in future** - Maximum: 6 months from now\n4. **Timezone issue** - Make sure you're using the correct timezone\n\nCurrent scheduled time: ${scheduledPublishTime || 'Not set'}\n\n💡 Solution: Set a valid future date and time, or remove the scheduled time to post immediately.`;
        }
        // Handle image/video file errors
        else if (fbError.message?.toLowerCase().includes('image') || 
            fbError.message?.toLowerCase().includes('file') ||
            (fbError.message?.toLowerCase().includes('invalid') && !fbError.message?.toLowerCase().includes('scheduled'))) {
          const mediaTypeText = mediaType === 'video' ? 'Video' : (mediaType === 'photo' ? 'Image' : 'Media');
          userMessage = `📷 ${mediaTypeText} Upload Error\n\nFacebook cannot access the ${mediaType || 'media'} from the provided URL.\n\nPossible causes:\n1. **Supabase Storage Bucket is Private** - Make the bucket public\n   - Go to: https://supabase.com/dashboard/project/rwohhynsgbtlfhphjyjn/storage/buckets\n   - Click on "Facebook" bucket\n   - Toggle "Public bucket" to ON\n\n2. **URL is Invalid** - Check that the URL is accessible\n   - Try opening the URL in a browser: ${mediaUrl || 'N/A'}\n   - Make sure it's a direct link to the file\n\n3. **Format Not Supported** - Facebook supports:\n   - Photos: JPG, PNG, GIF, WebP (max 4MB)\n   - Videos: MP4, MOV, AVI (max 1.75GB for standard, 4GB for pages)\n\n4. **File Too Large** - Facebook has size limits\n   - Photos: Maximum 4MB\n   - Videos: Maximum 1.75GB (standard) or 4GB (pages)\n\nError: ${fbError.message}`;
        } else if (fbError.code === 100 || fbError.error_subcode === 33) {
          const appId = process.env.FACEBOOK_APP_ID || 'YOUR_APP_ID';
          userMessage = `🚫 Facebook Posting Blocked - App Review Required\n\nYour app is in Development mode and Facebook blocks posting to real pages.\n\n📋 QUICK FIX OPTIONS:\n\n1️⃣ **Use Test Users (Fastest for Development)**\n   Step 1: Go to https://developers.facebook.com/apps/${appId}/roles/test-users\n   Step 2: Click "Create Test User"\n   Step 3: Click "Edit" on the test user → "Add Friends" → Add your real Facebook account\n   Step 4: Login as Test User on Facebook\n   Step 5: Make Test User an admin of your page: https://www.facebook.com/${pageId}/settings/roles\n   Step 6: Reconnect Facebook in your app using the Test User account\n   ✅ Posting will work with Test Users!\n\n2️⃣ **Submit for App Review (For Production)**\n   Step 1: Go to https://developers.facebook.com/apps/${appId}/app-review\n   Step 2: Click "Request" for "pages_manage_posts" permission\n   Step 3: Fill out the form:\n     - App Description: "Social media management tool for scheduling posts"\n     - Use Case: "Allow users to schedule and publish posts to their Facebook Pages"\n     - Privacy Policy URL: (required)\n     - Video Demo: (recommended)\n   Step 4: Wait for approval (1-7 days)\n   Step 5: Switch app to "Live" mode\n   ✅ Posting will work for all users!\n\n3️⃣ **Check Page Access**\n   - Verify you're still an admin: https://www.facebook.com/${pageId}/settings/roles\n   - If not admin, ask page owner to add you\n\n📊 Technical Details:\n- Token Type: ${tokenData?.type || 'UNKNOWN'}\n- Permissions: ${tokenData?.scopes?.join(', ') || 'UNKNOWN'}\n- Page ID: ${pageId}\n- Error: ${fbError.message}\n- This is a Facebook policy restriction, not a code issue\n\n💡 Recommendation: Use Test Users for development, submit App Review for production.`;
        }
      }

      throw new InternalServerErrorException(userMessage);
    }
  }

  /**
   * List all Facebook posts/uploads for a given account (for the current user)
   * This returns rows from ScheduledPost table for platform = 'facebook'
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

    if (!account || account.platform !== 'facebook') {
      throw new BadRequestException('Invalid Facebook account');
    }

    if (account.userId !== userId) {
      throw new BadRequestException('Account does not belong to user');
    }

    // Return all scheduledPost rows for this user + account + platform
    const posts = await this.prisma.scheduledPost.findMany({
      where: {
        userId,
        socialAccountId,
        platform: 'facebook',
      },
      orderBy: [
        // Show most recently created / scheduled first
        { createdAt: 'desc' },
      ],
    });

    return posts;
  }

  /**
   * Delete a Facebook post/upload:
   * - Deletes from Facebook Page via Graph API when externalPostId is present
   * - Deletes from ScheduledPost table
   *
   * Works for:
   * - Immediately published posts (status = 'success', externalPostId set)
   * - Facebook-scheduled posts (status = 'scheduled', externalPostId set)
   * - Failed/other rows (we just remove the DB record)
   */
  async deletePostForAccount(params: {
    userId: string;
    socialAccountId: string;
    scheduledPostId: string;
  }) {
    const { userId, socialAccountId, scheduledPostId } = params;

    // Validate account
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });

    if (!account || account.platform !== 'facebook') {
      throw new BadRequestException('Invalid Facebook account');
    }

    if (account.userId !== userId) {
      throw new BadRequestException('Account does not belong to user');
    }

    // Find the scheduledPost row
    const post = await this.prisma.scheduledPost.findFirst({
      where: {
        id: scheduledPostId,
        userId,
        socialAccountId,
        platform: 'facebook',
      },
    });

    if (!post) {
      throw new BadRequestException('Facebook post not found for this account');
    }

    const pageId = account.externalId;
    let fbDeleted = false;
    let fbErrorMessage: string | null = null;

    // If we have an externalPostId, try to delete from Facebook as well
    if (post.externalPostId) {
      try {
        const accessToken =
          await this.socialAccountsService.getValidFacebookAccessToken(
            account.id,
          );

        console.log(
          `🗑️ Deleting Facebook post ${post.externalPostId} for page ${pageId}`,
        );

        const fbRes = await axios.delete(
          `https://graph.facebook.com/v21.0/${post.externalPostId}`,
          {
            params: {
              access_token: accessToken,
            },
          },
        );

        // Facebook returns either { success: true } or boolean true
        fbDeleted = Boolean(
          (fbRes.data && fbRes.data.success) || fbRes.data === true,
        );

        console.log(
          `✅ Facebook Graph delete result for ${post.externalPostId}:`,
          fbRes.data,
        );
      } catch (err: any) {
        const fbError = err.response?.data?.error;
        fbErrorMessage =
          fbError?.message ||
          err.message ||
          'Unknown error while deleting Facebook post';

        console.warn(
          `⚠️ Failed to delete Facebook post ${post.externalPostId}:`,
          fbErrorMessage,
        );

        // Even if Facebook delete fails (already deleted, permissions, etc),
        // we will still remove the record from our database so the UI is clean.
      }
    } else {
      console.log(
        `ℹ️ ScheduledPost ${post.id} has no externalPostId; deleting only from local database.`,
      );
    }

    // Remove from our database
    await this.prisma.scheduledPost.delete({
      where: { id: post.id },
    });

    return {
      success: true,
      fbDeleted,
      message: fbDeleted
        ? 'Post deleted from Facebook and removed from history'
        : post.externalPostId
        ? 'Post removed from history. Facebook delete may have failed or the post was already removed on Facebook.'
        : 'Post removed from history (no Facebook post ID was stored).',
    };
  }
}

