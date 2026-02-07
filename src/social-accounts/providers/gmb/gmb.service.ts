import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../../prisma/prisma.service';
import { SocialAccountsService } from '../../social-accounts.service';
import { AlertsService } from '../../../alerts/alerts.service';

@Injectable()
export class GmbService {
  private readonly logger = new Logger(GmbService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly socialAccountsService: SocialAccountsService,
    @Inject(forwardRef(() => AlertsService))
    private readonly alertsService: AlertsService,
  ) {}

  /**
   * Fetch and sync GMB locations for a user
   */
  async syncLocations(params: { userId: string; socialAccountId: string }) {
    const { userId, socialAccountId } = params;

    // Verify account ownership
    const account = await this.prisma.socialAccount.findFirst({
      where: {
        id: socialAccountId,
        userId,
        platform: 'gmb',
        isActive: true,
      },
    });

    if (!account) {
      throw new BadRequestException('GMB account not found or access denied');
    }

    const accessToken =
      await this.socialAccountsService.getValidGmbAccessToken(account.id);

    try {
      // Fetch accounts with pagination
      const allAccounts: any[] = [];
      let nextPageToken: string | undefined = undefined;
      let pageCount = 0;
      const maxPages = 100; // Safety limit

      do {
        const params: any = {};
        if (nextPageToken) {
          params.pageToken = nextPageToken;
        }

        const accountsRes = await axios.get(
          'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            params,
            timeout: 30000, // 30 second timeout
          },
        );

        const accounts = accountsRes.data.accounts || [];
        allAccounts.push(...accounts);
        nextPageToken = accountsRes.data.nextPageToken;
        pageCount++;

        if (pageCount >= maxPages) {
          this.logger.warn(`Reached max pages limit (${maxPages}) for accounts`);
          break;
        }
      } while (nextPageToken);

      let totalProcessed = 0;

      // Only sync locations for the Google account that matches THIS SocialAccount (externalId).
      // Each "GMB" card = one Google location group; each gets only its own locations.
      const ourExternalId = account.externalId || '';
      const isPlaceholder = ourExternalId.startsWith('pending-sync-') || ourExternalId.startsWith('gmb-');

      // Match this card to a Google account (LOCATION_GROUP or PERSONAL - both can have locations)
      const matchingGmbAccount = allAccounts.find(
        (a: any) => a.name && a.name.split('/').pop() === ourExternalId && (a.type === 'LOCATION_GROUP' || a.type === 'PERSONAL'),
      );
      const matchingAccountName = matchingGmbAccount?.name || null;

      // Unlink locations that were previously synced to this account but belong to a different Google group
      if (matchingAccountName) {
        await this.prisma.gmbLocation.updateMany({
          where: {
            userId,
            socialAccountId,
            NOT: { accountName: matchingAccountName },
          },
          data: { socialAccountId: null },
        });
      }

      for (const gmbAccount of allAccounts) {
        // LOCATION_GROUP and PERSONAL accounts can both have locations (Google returns PERSONAL for single-owner businesses)
        const isProcessableType = gmbAccount.type === 'LOCATION_GROUP' || gmbAccount.type === 'PERSONAL';
        if (isProcessableType) {
          const accountId = gmbAccount.name.split('/').pop();
          if (!accountId) continue;

          if (!isPlaceholder && ourExternalId && accountId !== ourExternalId) continue;

          try {
            // Fetch locations for this account with pagination
            const allLocations: any[] = [];
            let locationsNextPageToken: string | undefined = undefined;
            let locationsPageCount = 0;

            do {
              const locationsParams: any = {
                readMask: 'name,storefrontAddress,title,websiteUri,phoneNumbers',
                pageSize: 100,
              };
              if (locationsNextPageToken) {
                locationsParams.pageToken = locationsNextPageToken;
              }

              const locationsRes = await axios.get(
                `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${accountId}/locations`,
                {
                  headers: { Authorization: `Bearer ${accessToken}` },
                  params: locationsParams,
                  timeout: 30000, // 30 second timeout
                },
              ).catch((err: any) => {
                const status = err.response?.status;
                const msg = err.response?.data?.error?.message || err.message;
                this.logger.warn(`Locations API failed for account ${accountId}: ${status} ${msg}`);
                if (status === 403) {
                  throw new BadRequestException(
                    'Cannot fetch locations. Enable "My Business Business Information API" in Google Cloud Console for this project, then try Sync again.'
                  );
                }
                throw err;
              });

              const locations = locationsRes.data.locations || [];
              allLocations.push(...locations);
              locationsNextPageToken = locationsRes.data.nextPageToken;
              locationsPageCount++;

              this.logger.log(
                `Fetched locations page ${locationsPageCount} for account ${accountId}: ${locations.length} locations (total so far: ${allLocations.length})`
              );

              if (locationsPageCount >= maxPages) {
                this.logger.warn(`Reached max pages limit (${maxPages}) for locations`);
                break;
              }
            } while (locationsNextPageToken);

            this.logger.log(
              `Total locations found for account ${accountId}: ${allLocations.length}`
            );

            // Store locations in database
            for (const location of allLocations) {
              const locationId = location.name.split('/').pop();
              if (!locationId) continue;

              const locationName =
                location.title || location.storefrontAddress?.addressLines?.[0] || 'Unnamed Location';
              const phoneNumber = location.phoneNumbers?.primaryPhone || null;
              const address = location.storefrontAddress
                ? `${location.storefrontAddress.addressLines?.join(', ') || ''} ${location.storefrontAddress.locality || ''} ${location.storefrontAddress.administrativeArea || ''} ${location.storefrontAddress.postalCode || ''}`.trim()
                : null;

              // Try to find existing location for this account
              const existingLocation = await this.prisma.gmbLocation.findFirst({
                where: {
                  userId,
                  socialAccountId: socialAccountId,
                  gmbLocationId: locationId,
                },
              });

              if (existingLocation) {
                // Update existing location
                await this.prisma.gmbLocation.update({
                  where: { id: existingLocation.id },
                  data: {
                    name: locationName,
                    phoneNumber,
                    address,
                    accountName: gmbAccount.name,
                    socialAccountId: socialAccountId,
                  },
                });
              } else {
                // Check if location exists without account (for migration)
                const orphanLocation = await this.prisma.gmbLocation.findFirst({
                  where: {
                    userId,
                    gmbLocationId: locationId,
                    socialAccountId: null,
                  },
                });

                if (orphanLocation) {
                  // Create a new location for this account (same location can be in multiple accounts)
                  await this.prisma.gmbLocation.create({
                    data: {
                      userId,
                      socialAccountId: socialAccountId,
                      gmbLocationId: locationId,
                      name: locationName,
                      phoneNumber,
                      address,
                      accountName: gmbAccount.name,
                    },
                  });
                } else {
                  // Create new location
                  await this.prisma.gmbLocation.create({
                    data: {
                      userId,
                      socialAccountId: socialAccountId,
                      gmbLocationId: locationId,
                      name: locationName,
                      phoneNumber,
                      address,
                      accountName: gmbAccount.name,
                    },
                  });
                }
              }

              totalProcessed++;
            }
          } catch (error: any) {
            console.error(`Error processing account ${accountId}:`, error.message);
            continue;
          }
        }
      }

      this.logger.log(
        `Location sync completed: ${totalProcessed} locations processed across ${allAccounts.filter((a: any) => a.type === 'LOCATION_GROUP' || a.type === 'PERSONAL').length} accounts`
      );

      // Update SocialAccount label with location count / first location name so cards are easy to tell apart
      if (totalProcessed > 0) {
        const locationsForThisAccount = await this.prisma.gmbLocation.findMany({
          where: { userId, socialAccountId },
          orderBy: { name: 'asc' },
          take: 1,
        });
        const firstLocationName = locationsForThisAccount[0]?.name;
        const count = await this.prisma.gmbLocation.count({
          where: { userId, socialAccountId },
        });
        const newLabel =
          count === 1
            ? firstLocationName || account.displayName || `Location group (${account.externalId})`
            : firstLocationName
              ? `${firstLocationName} + ${count - 1} more`
              : `${account.displayName || 'Location group'} (${count} locations)`;
        await this.prisma.socialAccount.update({
          where: { id: socialAccountId },
          data: { displayName: newLabel },
        });
      }

      return {
        success: true,
        processed: totalProcessed,
        accountsProcessed: allAccounts.filter((a: any) => a.type === 'LOCATION_GROUP' || a.type === 'PERSONAL').length,
      };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to sync locations: ${error.message}`,
      );
    }
  }

  /**
   * Get all locations for a user, optionally filtered by account
   */
  async getLocations(userId: string, socialAccountId?: string) {
    if (socialAccountId) {
      // Return locations for this specific account
      return this.prisma.gmbLocation.findMany({
        where: {
          userId,
          socialAccountId: socialAccountId,
        },
        orderBy: { name: 'asc' },
      });
    } else {
      // Return all locations for the user (including orphaned ones without account)
      return this.prisma.gmbLocation.findMany({
        where: { userId },
        orderBy: { name: 'asc' },
      });
    }
  }

  /**
   * Delete a location (user can sync again to re-display)
   */
  async deleteLocation(userId: string, locationId: string) {
    const location = await this.prisma.gmbLocation.findFirst({
      where: { id: locationId, userId },
    });

    if (!location) {
      throw new BadRequestException('Location not found or access denied');
    }

    await this.prisma.gmbPost.deleteMany({ where: { locationId } });
    await this.prisma.gmbReview.deleteMany({ where: { locationId } });
    await this.prisma.gmbLocation.delete({ where: { id: locationId } });

    return { success: true, message: 'Location deleted. Sync again to re-display.' };
  }

  /**
   * Parse GMB account ID from account resource name. Must match sync logic:
   * for "accounts/123/locationGroups/456" we need 456 (used in locations API).
   */
  private parseGmbAccountId(accountName: string | null): string | null {
    if (!accountName) return null;
    const parts = accountName.split('/').filter(Boolean);
    return parts.length >= 2 && parts[0] === 'accounts' ? parts[parts.length - 1]! : null;
  }

  /**
   * Map our CTA type to Google's ActionType
   */
  private mapCtaToGoogle(ctaType: string): string {
    const map: Record<string, string> = {
      LEARN_MORE: 'LEARN_MORE',
      BOOK: 'BOOK',
      ORDER: 'ORDER',
      BUY: 'SHOP',
      SHOP: 'SHOP',
      SIGN_UP: 'SIGN_UP',
      CALL: 'CALL',
    };
    return map[ctaType] || 'LEARN_MORE';
  }

  /**
   * Publish a GMB post to Google via localPosts API
   */
  async publishPostToGoogle(postId: string): Promise<void> {
    const post = await this.prisma.gmbPost.findUnique({
      where: { id: postId },
      include: { location: true },
    });

    if (!post || post.status === 'posted') return;
    if (!post.location.socialAccountId) {
      await this.prisma.gmbPost.update({
        where: { id: postId },
        data: { status: 'failed', errorMessage: 'Location has no linked GMB account. Sync locations first.' },
      });
      return;
    }

    const gmbAccountId = this.parseGmbAccountId(post.location.accountName);
    if (!gmbAccountId) {
      await this.prisma.gmbPost.update({
        where: { id: postId },
        data: { status: 'failed', errorMessage: 'Invalid account. Sync locations again.' },
      });
      return;
    }

    const accessToken = await this.socialAccountsService.getValidGmbAccessToken(
      post.location.socialAccountId,
    );

    // Media: only PHOTO supported reliably; VIDEO often returns INVALID_ARGUMENT
    const media: Array<{ mediaFormat: string; sourceUrl: string }> = [];
    if (post.imageUrl) media.push({ mediaFormat: 'PHOTO', sourceUrl: post.imageUrl });
    else if (post.videoUrl) media.push({ mediaFormat: 'VIDEO', sourceUrl: post.videoUrl });

    // Use STANDARD for all posts – OFFER requires event object (Google API)
    const topicType = 'STANDARD';
    const body: Record<string, unknown> = {
      languageCode: 'en-US',
      summary: post.content,
      topicType,
    };
    if (media.length > 0) body.media = media;

    if (post.ctaType) {
      body.callToAction = {
        actionType: this.mapCtaToGoogle(post.ctaType),
        ...(post.ctaType !== 'CALL' && post.ctaUrl && { url: post.ctaUrl }),
      };
    }

    const url = `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${post.location.gmbLocationId}/localPosts`;
    this.logger.debug(`GMB publish: ${url} body=${JSON.stringify(body)}`);
    try {
      const res = await axios.post(url, body, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
      });

      const created = res.data;
      const externalPostId = created.name?.split('/').pop() || null;
      const searchUrl = created.searchUrl || null;

      await this.prisma.gmbPost.update({
        where: { id: postId },
        data: {
          status: 'posted',
          externalPostId,
          searchUrl,
          postedAt: new Date(),
          errorMessage: null,
        },
      });
      this.logger.log(`GMB post ${postId} published to Google. externalPostId=${externalPostId}`);
    } catch (err: any) {
      const errData = err.response?.data;
      const msg = errData?.error?.message || err.message;
      const details = errData?.error?.details ? JSON.stringify(errData.error.details) : '';
      this.logger.error(
        `GMB publish failed for post ${postId}: ${msg}${details ? ` details=${details}` : ''}`,
      );
      await this.prisma.gmbPost.update({
        where: { id: postId },
        data: { status: 'failed', errorMessage: msg },
      });
      throw new InternalServerErrorException(`Failed to publish to Google: ${msg}`);
    }
  }

  /**
   * Create a GMB post. If scheduledAt is now (or within 1 min), publish immediately. Otherwise save as scheduled.
   */
  async createPost(params: {
    userId: string;
    locationId: string;
    content: string;
    imageUrl?: string;
    videoUrl?: string;
    scheduledAt: Date;
    ctaType?: string;
    ctaUrl?: string;
  }) {
    const { userId, locationId, content, imageUrl, videoUrl, scheduledAt, ctaType, ctaUrl } = params;

    const location = await this.prisma.gmbLocation.findFirst({
      where: { id: locationId, userId },
    });

    if (!location) {
      throw new BadRequestException('Location not found or access denied');
    }

    if (ctaType && ctaType !== 'CALL' && !ctaUrl) {
      throw new BadRequestException(
        'CTA URL is required when CTA type is provided (except for Call now)',
      );
    }

    if (ctaUrl && !ctaUrl.match(/^(https?:\/\/)/)) {
      throw new BadRequestException('CTA URL must start with http:// or https://');
    }

    const post = await this.prisma.gmbPost.create({
      data: {
        userId,
        locationId,
        content,
        imageUrl: imageUrl || null,
        videoUrl: videoUrl || null,
        scheduledAt,
        status: 'scheduled',
        ctaType: ctaType || null,
        ctaUrl: ctaType === 'CALL' ? null : ctaUrl || null,
      },
    });

    const now = Date.now();
    const scheduleTime = scheduledAt.getTime();
    const oneMin = 60 * 1000;
    if (scheduleTime <= now + oneMin) {
      await this.publishPostToGoogle(post.id);
      return this.prisma.gmbPost.findUnique({ where: { id: post.id } })!;
    }

    return post;
  }

  /**
   * Get all scheduled GMB posts (status=scheduled, future) for dashboard/upcoming
   */
  async getScheduledPostsForUser(userId: string) {
    const now = new Date();
    return this.prisma.gmbPost.findMany({
      where: {
        userId,
        status: 'scheduled',
        scheduledAt: { gt: now },
      },
      include: {
        location: { select: { id: true, name: true, address: true, socialAccountId: true } },
      },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  /**
   * Get all GMB posts for the user (scheduled + posted) for day planner
   */
  async getAllPostsForUser(userId: string) {
    return this.prisma.gmbPost.findMany({
      where: { userId },
      include: {
        location: { select: { id: true, name: true, address: true, socialAccountId: true } },
      },
      orderBy: { scheduledAt: 'desc' },
    });
  }

  /**
   * Get posts for a location
   */
  async getPosts(params: { userId: string; locationId: string }) {
    const { userId, locationId } = params;

    // Verify location ownership
    const location = await this.prisma.gmbLocation.findFirst({
      where: {
        id: locationId,
        userId,
      },
    });

    if (!location) {
      throw new BadRequestException('Location not found or access denied');
    }

    return this.prisma.gmbPost.findMany({
      where: { locationId },
      orderBy: { scheduledAt: 'desc' },
    });
  }

  /**
   * Update a GMB post
   */
  async updatePost(params: {
    userId: string;
    postId: string;
    content?: string;
    imageUrl?: string;
    videoUrl?: string;
    scheduledAt?: Date;
    ctaType?: string;
    ctaUrl?: string;
  }) {
    const { userId, postId, content, imageUrl, videoUrl, scheduledAt, ctaType, ctaUrl } = params;

    // Verify post ownership
    const post = await this.prisma.gmbPost.findFirst({
      where: {
        id: postId,
        userId,
      },
    });

    if (!post) {
      throw new BadRequestException('Post not found or access denied');
    }

    const updateData: any = {};
    if (content !== undefined) updateData.content = content;
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
    if (videoUrl !== undefined) updateData.videoUrl = videoUrl;
    if (scheduledAt !== undefined) updateData.scheduledAt = scheduledAt;
    if (ctaType !== undefined) updateData.ctaType = ctaType;
    if (ctaUrl !== undefined) updateData.ctaUrl = ctaType === 'CALL' ? null : ctaUrl;

    return this.prisma.gmbPost.update({
      where: { id: postId },
      data: updateData,
    });
  }

  /**
   * Delete a GMB post from DB and from Google (if posted)
   */
  async deletePost(params: { userId: string; postId: string }) {
    const { userId, postId } = params;

    const post = await this.prisma.gmbPost.findFirst({
      where: { id: postId, userId },
      include: { location: true },
    });

    if (!post) {
      throw new BadRequestException('Post not found or access denied');
    }

    if (post.externalPostId && post.location.socialAccountId && post.location.accountName) {
      const gmbAccountId = this.parseGmbAccountId(post.location.accountName);
      if (gmbAccountId) {
        try {
          const accessToken =
            await this.socialAccountsService.getValidGmbAccessToken(post.location.socialAccountId);
          const url = `https://mybusiness.googleapis.com/v4/accounts/${gmbAccountId}/locations/${post.location.gmbLocationId}/localPosts/${post.externalPostId}`;
          await axios.delete(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000,
          });
          this.logger.log(`GMB post ${post.externalPostId} deleted from Google`);
        } catch (err: any) {
          this.logger.warn(`Failed to delete GMB post from Google: ${err.message}`);
          // Continue to delete from DB
        }
      }
    }

    await this.prisma.gmbPost.delete({ where: { id: postId } });
    return { success: true };
  }

  /**
   * Sync reviews from GMB API
   */
  async syncReviews(params: { userId: string; locationId: string; socialAccountId: string }) {
    const { userId, locationId, socialAccountId } = params;

    // Verify location ownership
    const location = await this.prisma.gmbLocation.findFirst({
      where: {
        id: locationId,
        userId,
      },
    });

    if (!location) {
      throw new BadRequestException('Location not found or access denied');
    }

    const account = await this.prisma.socialAccount.findFirst({
      where: {
        id: socialAccountId,
        userId,
        platform: 'gmb',
        isActive: true,
      },
    });

    if (!account) {
      throw new BadRequestException('GMB account not found');
    }

    const accessToken =
      await this.socialAccountsService.getValidGmbAccessToken(account.id);

    try {
      // Get account ID from externalId
      const accountId = account.externalId;

      // Fetch reviews for this location with timeout
      const reviewsRes = await axios.get(
        `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${location.gmbLocationId}/reviews`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 30000, // 30 second timeout
        },
      );

      const reviews = reviewsRes.data.reviews || [];
      let totalProcessed = 0;

      for (const review of reviews) {
        const reviewId = review.reviewId || review.name?.split('/').pop();
        if (!reviewId) continue;

        await this.prisma.gmbReview.upsert({
          where: { gmbReviewId: reviewId },
          update: {
            name: review.reviewer?.displayName || null,
            comment: review.comment || null,
            rating: review.starRating?.toLowerCase() === 'five' ? 5 :
                   review.starRating?.toLowerCase() === 'four' ? 4 :
                   review.starRating?.toLowerCase() === 'three' ? 3 :
                   review.starRating?.toLowerCase() === 'two' ? 2 :
                   review.starRating?.toLowerCase() === 'one' ? 1 : 0,
            externalReviewId: review.name || null,
          },
          create: {
            userId,
            locationId,
            gmbReviewId: reviewId,
            name: review.reviewer?.displayName || null,
            comment: review.comment || null,
            rating: review.starRating?.toLowerCase() === 'five' ? 5 :
                   review.starRating?.toLowerCase() === 'four' ? 4 :
                   review.starRating?.toLowerCase() === 'three' ? 3 :
                   review.starRating?.toLowerCase() === 'two' ? 2 :
                   review.starRating?.toLowerCase() === 'one' ? 1 : 0,
            externalReviewId: review.name || null,
            responded: !!review.reply,
            reply: review.reply?.comment || null,
          },
        });

        totalProcessed++;
      }

      return {
        success: true,
        processed: totalProcessed,
      };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to sync reviews: ${error.message}`,
      );
    }
  }

  /**
   * Get reviews for a location
   */
  async getReviews(params: { userId: string; locationId: string }) {
    const { userId, locationId } = params;

    // Verify location ownership
    const location = await this.prisma.gmbLocation.findFirst({
      where: {
        id: locationId,
        userId,
      },
    });

    if (!location) {
      throw new BadRequestException('Location not found or access denied');
    }

    return this.prisma.gmbReview.findMany({
      where: { locationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Reply to a review
   */
  async replyToReview(params: {
    userId: string;
    reviewId: string;
    reply: string;
    socialAccountId: string;
    locationId: string;
  }) {
    const { userId, reviewId, reply, socialAccountId, locationId } = params;

    // Verify review ownership
    const review = await this.prisma.gmbReview.findFirst({
      where: {
        id: reviewId,
        userId,
        locationId,
      },
    });

    if (!review) {
      throw new BadRequestException('Review not found or access denied');
    }

    if (!review.externalReviewId) {
      throw new BadRequestException('Review does not have external ID');
    }

    const account = await this.prisma.socialAccount.findFirst({
      where: {
        id: socialAccountId,
        userId,
        platform: 'gmb',
        isActive: true,
      },
    });

    if (!account) {
      throw new BadRequestException('GMB account not found');
    }

    const location = await this.prisma.gmbLocation.findUnique({
      where: { id: locationId },
    });

    if (!location) {
      throw new BadRequestException('Location not found');
    }

    const accessToken =
      await this.socialAccountsService.getValidGmbAccessToken(account.id);

    try {
      // Post reply to GMB API with timeout
      const accountId = account.externalId;
      await axios.post(
        `https://mybusiness.googleapis.com/v4/${review.externalReviewId}/reply`,
        {
          reply: {
            comment: reply,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000, // 30 second timeout
        },
      );

      // Update review in database
      return this.prisma.gmbReview.update({
        where: { id: reviewId },
        data: {
          reply,
          responded: true,
        },
      });
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to post reply: ${error.message}`,
      );
    }
  }

  /**
   * Clean up placeholder/fake GMB accounts (those with externalId starting with 'pending-sync-' or 'gmb-')
   */
  async cleanupPlaceholderAccounts(userId: string) {
    // Find all placeholder accounts for this user
    const placeholderAccounts = await this.prisma.socialAccount.findMany({
      where: {
        userId,
        platform: 'gmb',
        OR: [
          { externalId: { startsWith: 'pending-sync-' } },
          { externalId: { startsWith: 'gmb-' } },
        ],
      },
    });

    if (placeholderAccounts.length === 0) {
      return {
        success: true,
        message: 'No placeholder accounts found',
        deleted: 0,
      };
    }

    // Delete all placeholder accounts
    const deleted = await this.prisma.socialAccount.deleteMany({
      where: {
        userId,
        platform: 'gmb',
        OR: [
          { externalId: { startsWith: 'pending-sync-' } },
          { externalId: { startsWith: 'gmb-' } },
        ],
      },
    });

    return {
      success: true,
      message: `Deleted ${deleted.count} placeholder account(s)`,
      deleted: deleted.count,
      accountIds: placeholderAccounts.map((a) => a.id),
    };
  }

  /**
   * Remove ALL GMB accounts for a user (both real and placeholder)
   */
  async removeAllGmbAccounts(userId: string) {
    // Find all GMB accounts for this user
    const allAccounts = await this.prisma.socialAccount.findMany({
      where: {
        userId,
        platform: 'gmb',
      },
    });

    if (allAccounts.length === 0) {
      return {
        success: true,
        message: 'No GMB accounts found',
        deleted: 0,
      };
    }

    // Delete all GMB accounts
    const deleted = await this.prisma.socialAccount.deleteMany({
      where: {
        userId,
        platform: 'gmb',
      },
    });

    return {
      success: true,
      message: `Deleted ${deleted.count} GMB account(s)`,
      deleted: deleted.count,
      accountIds: allAccounts.map((a) => a.id),
    };
  }
}
