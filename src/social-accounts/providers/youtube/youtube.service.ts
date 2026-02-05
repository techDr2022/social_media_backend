import { Injectable, BadRequestException, InternalServerErrorException, Inject, forwardRef } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import FormData from 'form-data';
import { PrismaService } from '../../../prisma/prisma.service';
import { SocialAccountsService } from '../../social-accounts.service';
import { AlertsService } from '../../../alerts/alerts.service';

@Injectable()
export class YoutubeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socialAccountsService: SocialAccountsService,
    @Inject(forwardRef(() => AlertsService))
    private readonly alertsService: AlertsService,
  ) {}

  async uploadVideo(params: {
    userId: string;
    socialAccountId: string;
    filePath: string;
    thumbnailPath?: string;
    title: string;
    description?: string;
    privacyStatus: 'private' | 'unlisted' | 'public';
    categoryId?: string;
    publishAt?: string;
    madeForKids?: boolean;
    language?: string;
    license?: string;
    tags?: string[];
    commentsEnabled?: boolean;
    ageRestricted?: boolean;
  }) {
    const {
      userId,
      socialAccountId,
      filePath,
      thumbnailPath,
      title,
      description,
      privacyStatus,
      categoryId,
      publishAt,
      madeForKids,
      language,
      license,
      tags,
      commentsEnabled,
      ageRestricted,
    } = params;

    // 🔐 OWNERSHIP CHECK
    const account = await this.prisma.socialAccount.findFirst({
      where: {
        id: socialAccountId,
        userId,
        platform: 'youtube',
        isActive: true,
      },
    });

    if (!account) {
      throw new BadRequestException('YouTube account not found or access denied');
    }

    if (!fs.existsSync(filePath)) {
      throw new BadRequestException('Uploaded video file not found');
    }

    // Helper function to save upload record to database
    const saveToDatabase = async (
      status: 'success' | 'failed',
      videoId?: string,
      errorMessage?: string,
    ) => {
      try {
        const now = new Date();
        const scheduledAt = publishAt ? new Date(publishAt) : now;

        // Store all metadata in content as JSON string
        const contentData = {
          title,
          description: description || '',
          privacyStatus,
          categoryId: categoryId || '22',
          tags: tags || [],
          language: language || 'en',
          license: license || 'youtube',
          madeForKids: madeForKids || false,
          commentsEnabled: commentsEnabled !== undefined ? commentsEnabled : true,
          ageRestricted: ageRestricted || false,
          ...(videoId && { videoId, channelId: account.externalId }),
        };

        return await this.prisma.scheduledPost.create({
          data: {
            userId,
            socialAccountId,
            platform: 'youtube',
            type: 'video',
            content: JSON.stringify(contentData),
            mediaUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
            scheduledAt,
            status,
            errorMessage: errorMessage || videoId || null,
            postedAt: status === 'success' ? now : null,
          },
        });
      } catch (dbErr: any) {
        // Log but don't fail the upload if database save fails
        console.error('Failed to save upload to database:', dbErr.message);
        return null;
      }
    };

    // 🔄 TOKEN (AUTO REFRESH)
    const accessToken =
      await this.socialAccountsService.getValidYoutubeAccessToken(account.id);

    const form = new FormData();

    // ✅ METADATA (VERY IMPORTANT)
    const metadata: any = {
      snippet: {
        title,
        description: description ?? '',
        // Use category from frontend if provided, otherwise fall back to 22 (People & Blogs)
        categoryId: categoryId ?? '22',
      },
      status: {
        privacyStatus,
      },
    };

    // Optional: schedule publish time (YouTube expects RFC3339 / ISO string)
    if (publishAt) {
      metadata.status.publishAt = publishAt;
      // For scheduled publish, YouTube expects privacyStatus to start as 'private'
      if (metadata.status.privacyStatus !== 'private') {
        metadata.status.privacyStatus = 'private';
      }
    }

    // Optional: audience flag
    if (typeof madeForKids === 'boolean') {
      // YouTube v3 uses selfDeclaredMadeForKids on the status object
      metadata.status.selfDeclaredMadeForKids = madeForKids;
    }

    // Optional: language
    if (language) {
      metadata.snippet.defaultLanguage = language;
    }

    // Optional: license
    if (license) {
      // Map our simple choices to YouTube's expected values
      // 'youtube' -> 'youtube', 'creativeCommon' -> 'creativeCommon'
      metadata.status.license = license;
    }

    // Optional: tags
    if (tags && tags.length > 0) {
      metadata.snippet.tags = tags;
    }

    form.append('metadata', JSON.stringify(metadata), {
      contentType: 'application/json',
    });

    // 🎥 VIDEO FILE
    form.append('media', fs.createReadStream(filePath));

    try {
      const res = await axios.post(
        'https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status',
        form,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...form.getHeaders(),
          },
          maxBodyLength: Infinity,
        },
      );

      const videoId = res.data.id;

      // After upload, apply additional settings that require separate API calls
      // These operations may fail due to scope limitations - we handle gracefully
      if (videoId && (commentsEnabled !== undefined || ageRestricted !== undefined)) {
        try {
          // Track which settings are being updated for better error messages
          const settingsBeingUpdated: string[] = [];
          if (commentsEnabled !== undefined) {
            settingsBeingUpdated.push(`comments (${commentsEnabled ? 'enabled' : 'disabled'})`);
          }
          if (ageRestricted !== undefined) {
            settingsBeingUpdated.push(`age restriction (${ageRestricted ? 'restricted' : 'not restricted'})`);
          }

          // First, get current video details to preserve existing settings
          const getRes = await axios.get(
            `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoId}`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            },
          );

          const currentContentDetails = getRes.data.items?.[0]?.contentDetails || {};
          
          // Build update payload
          const contentDetails: any = {
            ...currentContentDetails,
          };

          // Update comment settings
          // YouTube API expects: "allowed", "moderated", or "heldForReview"
          if (commentsEnabled !== undefined) {
            contentDetails.commentSettings = {
              ...(currentContentDetails.commentSettings || {}),
              commentsAllowed: commentsEnabled ? 'allowed' : 'heldForReview',
            };
          }

          // Update age restriction (contentRating)
          // Note: Comments are now set during upload, so we only handle age restriction here
          // Note: Age restriction may require special permissions/verification
          if (ageRestricted !== undefined && ageRestricted) {
            contentDetails.contentRating = {
              ...(currentContentDetails.contentRating || {}),
              ytRating: 'ytAgeRestricted',
            };
          } else if (ageRestricted !== undefined && !ageRestricted) {
            // Remove age restriction if explicitly set to false
            contentDetails.contentRating = {
              ...(currentContentDetails.contentRating || {}),
              ytRating: undefined,
            };
          }

          // Update video with new settings
          await axios.put(
            `https://www.googleapis.com/youtube/v3/videos?part=contentDetails`,
            {
              id: videoId,
              contentDetails,
            },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
            },
          );
        } catch (updateErr: any) {
          // Extract which settings failed and provide detailed error message
          const failedSettings: string[] = [];
          if (commentsEnabled !== undefined) {
            failedSettings.push('comments');
          }
          if (ageRestricted !== undefined) {
            failedSettings.push('age restriction');
          }

          const errorMessage = updateErr.response?.data?.error?.message || updateErr.message || 'Unknown error';
          const statusCode = updateErr.response?.status || 'N/A';
          
          let errorDetails: string;
          if (statusCode === 403) {
            errorDetails = `Failed to update ${failedSettings.join(' and ')} settings: Insufficient permissions (403). Please reconnect your YouTube account to grant video settings permissions. YouTube error: ${errorMessage}`;
          } else {
            errorDetails = `Failed to update ${failedSettings.join(' and ')} settings: ${errorMessage} (Status: ${statusCode})`;
          }
          
          // Log detailed error but don't fail the upload if settings update fails
          console.error(errorDetails);
          // Continue - video upload succeeded, settings update is optional
        }
      }

      // Upload thumbnail if provided
      if (thumbnailPath && fs.existsSync(thumbnailPath) && videoId) {
        try {
          const thumbnailForm = new FormData();
          thumbnailForm.append('media', fs.createReadStream(thumbnailPath));
          
          await axios.post(
            `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`,
            thumbnailForm,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                ...thumbnailForm.getHeaders(),
              },
              maxBodyLength: Infinity,
            },
          );
        } catch (thumbnailErr: any) {
          // Log but don't fail the upload if thumbnail upload fails
          const errorMsg = thumbnailErr.response?.data?.error?.message || thumbnailErr.message || 'Unknown error';
          const statusCode = thumbnailErr.response?.status || 'N/A';
          
          if (statusCode === 403) {
            console.warn(`⚠️ Thumbnail upload skipped: Insufficient permissions. Video uploaded successfully, but thumbnail was not set. To enable thumbnails, reconnect your YouTube account with full permissions.`);
          } else {
            console.warn(`⚠️ Thumbnail upload failed: ${errorMsg} (Status: ${statusCode}). Video uploaded successfully.`);
          }
        }
      }

      // Save to ScheduledPost table after successful upload
      const scheduledPost = await saveToDatabase('success', videoId);

      // Create alert for scheduled post (YouTube uses native scheduling)
      if (publishAt && scheduledPost) {
        try {
          const accountName = account.displayName || account.username || 'YouTube Channel';
          const scheduledAt = new Date(publishAt);
          const formattedDate = scheduledAt.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          });
          const message = `Your video post for ${accountName} is scheduled for ${formattedDate}. Post scheduled through the app.`;

          await this.alertsService.create({
            userId,
            socialAccountId,
            scheduledPostId: scheduledPost.id,
            type: 'scheduled',
            platform: 'youtube',
            title: 'Scheduled Successfully',
            message,
            accountName,
            postType: 'video',
            scheduledAt,
          });
        } catch (alertError: any) {
          // Don't fail the request if alert creation fails
          console.error('Failed to create alert for scheduled YouTube post:', alertError.message);
        }
      }

      // Clean up uploaded files
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
          fs.unlinkSync(thumbnailPath);
        }
      } catch (cleanupErr: any) {
        console.error('Failed to cleanup uploaded files:', cleanupErr.message);
        // Don't fail the request if cleanup fails
      }

      return {
        videoId,
        channelId: account.externalId,
      };
    } catch (uploadError: any) {
      // Extract error message from YouTube API response
      let errorMessage = 'Unknown error';
      let statusCode = 500;

      if (uploadError.response?.data?.error) {
        // YouTube API error format
        const youtubeError = uploadError.response.data.error;
        errorMessage = youtubeError.message || 'YouTube API error';
        statusCode = youtubeError.code || uploadError.response.status || 400;
      } else if (uploadError.response?.data) {
        // Generic API error
        errorMessage = uploadError.response.data.message || JSON.stringify(uploadError.response.data);
        statusCode = uploadError.response.status || 500;
      } else if (uploadError.message) {
        errorMessage = uploadError.message;
      }

      // Save failed upload to database
      try {
        await saveToDatabase('failed', undefined, errorMessage);
      } catch (dbErr: any) {
        // Log but don't fail if database save fails
        console.error('Failed to save failed upload to database:', dbErr.message);
      }

      // Clean up uploaded files even on failure
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
          fs.unlinkSync(thumbnailPath);
        }
      } catch (cleanupErr: any) {
        console.error('Failed to cleanup uploaded files:', cleanupErr.message);
        // Don't fail the request if cleanup fails
      }

      // Throw appropriate NestJS exception
      if (statusCode >= 400 && statusCode < 500) {
        throw new BadRequestException({
          message: errorMessage,
          statusCode,
          error: uploadError.response?.data?.error || 'Bad Request',
        });
      } else {
        throw new InternalServerErrorException({
          message: errorMessage,
          statusCode,
          error: 'Internal Server Error',
        });
      }
    }
  }

  async getYoutubeStatistics(params: {
    userId: string;
    socialAccountId: string;
  }) {
    const { userId, socialAccountId } = params;

    // 🔐 OWNERSHIP CHECK
    const account = await this.prisma.socialAccount.findFirst({
      where: {
        id: socialAccountId,
        userId,
        platform: 'youtube',
        isActive: true,
      },
    });

    if (!account) {
      throw new BadRequestException('YouTube account not found or access denied');
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Count videos published (status = 'success')
    const videosPublished = await this.prisma.scheduledPost.count({
      where: {
        userId,
        socialAccountId,
        platform: 'youtube',
        type: 'video',
        status: 'success',
      },
    });

    // Count scheduled videos (status = 'success' and scheduledAt > now)
    const scheduled = await this.prisma.scheduledPost.count({
      where: {
        userId,
        socialAccountId,
        platform: 'youtube',
        type: 'video',
        status: 'success',
        scheduledAt: {
          gt: now,
        },
      },
    });

    // Count videos published this month
    const thisMonth = await this.prisma.scheduledPost.count({
      where: {
        userId,
        socialAccountId,
        platform: 'youtube',
        type: 'video',
        status: 'success',
        postedAt: {
          gte: startOfMonth,
        },
      },
    });

    return {
      videosPublished,
      scheduled,
      thisMonth,
    };
  }

  async getRecentYoutubeVideos(params: {
    userId: string;
    socialAccountId: string;
    page?: number;
    limit?: number;
  }) {
    const { userId, socialAccountId, page = 1, limit = 10 } = params;

    // 🔐 OWNERSHIP CHECK
    const account = await this.prisma.socialAccount.findFirst({
      where: {
        id: socialAccountId,
        userId,
        platform: 'youtube',
        isActive: true,
      },
    });

    if (!account) {
      throw new BadRequestException('YouTube account not found or access denied');
    }

    // Get access token for YouTube API calls
    const accessToken =
      await this.socialAccountsService.getValidYoutubeAccessToken(account.id);

    // Fetch recent successful uploads from database
    const skip = (page - 1) * limit;
    const posts = await this.prisma.scheduledPost.findMany({
      where: {
        userId,
        socialAccountId,
        platform: 'youtube',
        type: 'video',
        status: 'success',
      },
      orderBy: {
        postedAt: 'desc',
      },
      skip,
      take: limit,
    });

    // Enrich with YouTube API data
    const enrichedVideos = await Promise.all(
      posts.map(async (post) => {
        try {
          // Parse content to extract video details
          const contentData = JSON.parse(post.content || '{}');
          const videoId = contentData.videoId || post.errorMessage; // errorMessage stores videoId on success

          if (!videoId) {
            return {
              id: post.id,
              title: contentData.title || 'Untitled',
              description: contentData.description || '',
              privacy: contentData.privacyStatus || 'private',
              restrictions: contentData.ageRestricted ? 'Age Restricted' : 'None',
              date: post.postedAt || post.scheduledAt,
              views: 0,
              comments: 0,
              likes: 0,
              thumbnail: null,
              videoUrl: post.mediaUrl,
              studioUrl: `https://studio.youtube.com/video/${videoId}/edit`,
            };
          }

          // Fetch video statistics and thumbnail from YouTube API
          try {
            const videoRes = await axios.get(
              `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoId}`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
              },
            );

            const video = videoRes.data.items?.[0];
            if (video) {
              return {
                id: post.id,
                title: video.snippet?.title || contentData.title || 'Untitled',
                description: video.snippet?.description || contentData.description || '',
                privacy: contentData.privacyStatus || video.status?.privacyStatus || 'private',
                restrictions: contentData.ageRestricted ? 'Age Restricted' : 'None',
                date: post.postedAt || post.scheduledAt,
                views: parseInt(video.statistics?.viewCount || '0', 10),
                comments: parseInt(video.statistics?.commentCount || '0', 10),
                likes: parseInt(video.statistics?.likeCount || '0', 10),
                thumbnail: video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.default?.url || null,
                videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
                studioUrl: `https://studio.youtube.com/video/${videoId}/edit`,
              };
            }
          } catch (apiErr: any) {
            console.error(`Failed to fetch YouTube API data for video ${videoId}:`, apiErr.message);
          }

          // Fallback if API call fails
          return {
            id: post.id,
            title: contentData.title || 'Untitled',
            description: contentData.description || '',
            privacy: contentData.privacyStatus || 'private',
            restrictions: contentData.ageRestricted ? 'Age Restricted' : 'None',
            date: post.postedAt || post.scheduledAt,
            views: 0,
            comments: 0,
            likes: 0,
            thumbnail: null,
            videoUrl: post.mediaUrl,
            studioUrl: `https://studio.youtube.com/video/${videoId}/edit`,
          };
        } catch (parseErr: any) {
          console.error(`Failed to parse content for post ${post.id}:`, parseErr.message);
          return {
            id: post.id,
            title: 'Untitled',
            description: '',
            privacy: 'private',
            restrictions: 'None',
            date: post.postedAt || post.scheduledAt,
            views: 0,
            comments: 0,
            likes: 0,
            thumbnail: null,
            videoUrl: post.mediaUrl,
            studioUrl: null,
          };
        }
      }),
    );

    return enrichedVideos;
  }
}
