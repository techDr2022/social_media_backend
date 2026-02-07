import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../../auth/supabase.guard';
import { GmbService } from './gmb.service';
import type { Request } from 'express';

@Controller('gmb')
export class GmbController {
  constructor(private readonly gmbService: GmbService) {}

  // Sync locations from GMB
  @UseGuards(SupabaseAuthGuard)
  @Post('locations/sync')
  async syncLocations(
    @Req() req: Request,
    @Body() body: { socialAccountId: string },
  ) {
    const user = (req as any).user;
    return this.gmbService.syncLocations({
      userId: user.id,
      socialAccountId: body.socialAccountId,
    });
  }

  // Get all locations (optionally filtered by account)
  @UseGuards(SupabaseAuthGuard)
  @Get('locations')
  async getLocations(@Req() req: Request, @Query('accountId') accountId?: string) {
    const user = (req as any).user;
    return this.gmbService.getLocations(user.id, accountId);
  }

  // Delete a location (can sync again to re-display)
  @UseGuards(SupabaseAuthGuard)
  @Delete('locations/:locationId')
  async deleteLocation(@Req() req: Request, @Param('locationId') locationId: string) {
    const user = (req as any).user;
    return this.gmbService.deleteLocation(user.id, locationId);
  }

  // Create a scheduled post
  @UseGuards(SupabaseAuthGuard)
  @Post('posts')
  async createPost(
    @Req() req: Request,
    @Body()
    body: {
      locationId: string;
      content: string;
      imageUrl?: string;
      videoUrl?: string;
      scheduledAt: string;
      ctaType?: string;
      ctaUrl?: string;
    },
  ) {
    const user = (req as any).user;
    return this.gmbService.createPost({
      userId: user.id,
      locationId: body.locationId,
      content: body.content,
      imageUrl: body.imageUrl,
      videoUrl: body.videoUrl,
      scheduledAt: new Date(body.scheduledAt),
      ctaType: body.ctaType,
      ctaUrl: body.ctaUrl,
    });
  }

  // Get scheduled GMB posts (for dashboard/upcoming-posts)
  @UseGuards(SupabaseAuthGuard)
  @Get('posts/scheduled')
  async getScheduledPosts(@Req() req: Request) {
    const user = (req as any).user;
    return this.gmbService.getScheduledPostsForUser(user.id);
  }

  // Get all GMB posts for user (for day planner)
  @UseGuards(SupabaseAuthGuard)
  @Get('posts/all')
  async getAllPosts(@Req() req: Request) {
    const user = (req as any).user;
    return this.gmbService.getAllPostsForUser(user.id);
  }

  // Get posts for a location
  @UseGuards(SupabaseAuthGuard)
  @Get('locations/:locationId/posts')
  async getPosts(@Req() req: Request, @Param('locationId') locationId: string) {
    const user = (req as any).user;
    return this.gmbService.getPosts({
      userId: user.id,
      locationId,
    });
  }

  // Update a post
  @UseGuards(SupabaseAuthGuard)
  @Put('posts/:postId')
  async updatePost(
    @Req() req: Request,
    @Param('postId') postId: string,
    @Body()
    body: {
      content?: string;
      imageUrl?: string;
      videoUrl?: string;
      scheduledAt?: string;
      ctaType?: string;
      ctaUrl?: string;
    },
  ) {
    const user = (req as any).user;
    return this.gmbService.updatePost({
      userId: user.id,
      postId,
      content: body.content,
      imageUrl: body.imageUrl,
      videoUrl: body.videoUrl,
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
      ctaType: body.ctaType,
      ctaUrl: body.ctaUrl,
    });
  }

  // Delete a post
  @UseGuards(SupabaseAuthGuard)
  @Delete('posts/:postId')
  async deletePost(@Req() req: Request, @Param('postId') postId: string) {
    const user = (req as any).user;
    return this.gmbService.deletePost({
      userId: user.id,
      postId,
    });
  }

  // Sync reviews from GMB
  @UseGuards(SupabaseAuthGuard)
  @Post('locations/:locationId/reviews/sync')
  async syncReviews(
    @Req() req: Request,
    @Param('locationId') locationId: string,
    @Body() body: { socialAccountId: string },
  ) {
    const user = (req as any).user;
    return this.gmbService.syncReviews({
      userId: user.id,
      locationId,
      socialAccountId: body.socialAccountId,
    });
  }

  // Get reviews for a location
  @UseGuards(SupabaseAuthGuard)
  @Get('locations/:locationId/reviews')
  async getReviews(@Req() req: Request, @Param('locationId') locationId: string) {
    const user = (req as any).user;
    return this.gmbService.getReviews({
      userId: user.id,
      locationId,
    });
  }

  // Reply to a review
  @UseGuards(SupabaseAuthGuard)
  @Post('reviews/:reviewId/reply')
  async replyToReview(
    @Req() req: Request,
    @Param('reviewId') reviewId: string,
    @Body() body: { reply: string; socialAccountId: string; locationId: string },
  ) {
    const user = (req as any).user;
    return this.gmbService.replyToReview({
      userId: user.id,
      reviewId,
      reply: body.reply,
      socialAccountId: body.socialAccountId,
      locationId: body.locationId,
    });
  }

  // Clean up placeholder/fake GMB accounts
  @UseGuards(SupabaseAuthGuard)
  @Delete('accounts/cleanup')
  async cleanupPlaceholderAccounts(@Req() req: Request) {
    const user = (req as any).user;
    return this.gmbService.cleanupPlaceholderAccounts(user.id);
  }

  // Remove ALL GMB accounts (both real and placeholder)
  @UseGuards(SupabaseAuthGuard)
  @Delete('accounts/remove-all')
  async removeAllGmbAccounts(@Req() req: Request) {
    const user = (req as any).user;
    return this.gmbService.removeAllGmbAccounts(user.id);
  }
}
