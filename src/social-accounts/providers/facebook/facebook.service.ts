import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import FormData from 'form-data';
import { PrismaService } from '../../../prisma/prisma.service';
import { SocialAccountsService } from '../../social-accounts.service';
import { FacebookPostDto } from './dto/facebook-post.dto';

@Injectable()
export class FacebookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socialAccountsService: SocialAccountsService,
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
  }) {
    const { userId, socialAccountId, message, mediaUrl, mediaType, scheduledPublishTime, collaborator, shareToStory, privacy, privacyValue } = params;

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
          
          // Update stored token
          await this.prisma.socialAccount.update({
            where: { id: account.id },
            data: { accessToken },
          });
        }
      }
      }
    } catch (tokenErr: any) {
      console.warn('Token verification failed:', tokenErr.response?.data?.error?.message || tokenErr.message);
      // Continue with existing token even if verification fails
    }

    let postId: string;

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
      const addPrivacySettings = (data: any, isFormData: boolean = false) => {
        let privacyValue_str = '';
        if (privacy === 'FRIENDS') {
          privacyValue_str = JSON.stringify({ value: 'ALL_FRIENDS' });
        } else if (privacy === 'CUSTOM' && privacyValue) {
          // CUSTOM privacy can be: SELF, ALL_FRIENDS, FRIENDS_OF_FRIENDS, CUSTOM
          // privacyValue can be a friend list ID or comma-separated user IDs
          privacyValue_str = JSON.stringify({ 
            value: 'CUSTOM',
            allow: privacyValue.split(',').map((id: string) => id.trim())
          });
        } else {
          // Default to PUBLIC
          privacyValue_str = JSON.stringify({ value: 'EVERYONE' });
        }
        
        if (isFormData) {
          data.append('privacy', privacyValue_str);
        } else {
          data.privacy = privacyValue_str;
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
      if (mediaType === 'photo' && mediaUrl) {
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
        addPrivacySettings(formData, true);
        // Note: Tags/collaborators not supported for photo posts via FormData
        // Skip addCollaborator for FormData posts

        if (scheduledTimestamp) {
          formData.append('scheduled_publish_time', scheduledTimestamp.toString());
          formData.append('published', 'false');
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
        addPrivacySettings(formData, true);
        // Note: Tags/collaborators not supported for video posts via FormData
        // Skip addCollaborator for FormData posts

        if (scheduledTimestamp) {
          formData.append('scheduled_publish_time', scheduledTimestamp.toString());
          formData.append('published', 'false');
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
        addPrivacySettings(postData);
        addCollaborator(postData);

        if (scheduledTimestamp) {
          postData.scheduled_publish_time = scheduledTimestamp;
          postData.published = false;
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

      await this.prisma.scheduledPost.create({
        data: {
          userId,
          socialAccountId,
          platform: 'facebook',
          type: mediaType || 'text',
          content: message || '',
          mediaUrl: mediaUrl || null,
          scheduledAt,
          status: scheduledPublishTime ? 'scheduled' : 'success',
          postedAt: scheduledPublishTime ? null : new Date(),
          externalPostId: postId ? String(postId) : null, // Save Facebook post ID in dedicated field
          permalink: null, // Facebook API doesn't return permalink in response (would need separate API call to fetch)
          errorMessage: null, // No error for successful posts
        },
      });

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
          type: mediaType || 'text',
          content: message || '',
          mediaUrl: mediaUrl || null,
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
}

