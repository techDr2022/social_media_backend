import {
  Controller,
  Post,
  Get,
  Delete,
  UseGuards,
  Req,
  Body,
  Param,
  HttpException,
  HttpStatus,
  HttpCode,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { SupabaseAuthGuard } from '../../../auth/supabase.guard';
import { InstagramService } from './instagram.service';
import { InstagramPostDto } from './dto/instagram-post.dto';

@Controller('instagram')
export class InstagramController {
  constructor(private readonly instagramService: InstagramService) {}

  @UseGuards(SupabaseAuthGuard)
  @Post('post/:accountId')
  async createPost(
    @Req() req,
    @Res() res: Response,
    @Param('accountId') accountId: string,
    @Body() body: any,
  ) {
    try {
      console.log(`[Instagram Controller] Creating post for account: ${accountId}, user: ${req.user.id}`);
      console.log(`[Instagram Controller] Body carouselItems:`, body.carouselItems);
      const result = await this.instagramService.createPost({
        userId: req.user.id,
        socialAccountId: accountId,
        caption: body.caption,
        mediaUrl: body.mediaUrl,
        mediaType: body.mediaType,
        scheduledPublishTime: body.scheduledPublishTime,
        locationId: body.locationId,
        userTags: body.userTags,
        carouselUrls: body.carouselUrls,
        carouselItems: body.carouselItems,
      });
      console.log(`[Instagram Controller] Post created successfully:`, {
        postId: result.postId,
        hasPostUrl: !!result.postUrl,
        resultType: typeof result,
        resultKeys: Object.keys(result || {}),
      });
      
      // Build response object - create completely plain object with only primitive values
      const cleanResponse: Record<string, string | boolean> = {
        success: true,
        postId: result.postId ? String(result.postId) : '',
        message: result.message || (body.scheduledPublishTime ? 'Post scheduled successfully' : 'Post published successfully'),
      };
      
      // Only include postUrl if it exists and is a valid non-empty string
      if (result.postUrl && typeof result.postUrl === 'string' && result.postUrl.trim().length > 0) {
        cleanResponse.postUrl = String(result.postUrl);
      }
      
      // Final validation - serialize to ensure it's completely valid JSON
      try {
        JSON.stringify(cleanResponse);
        console.log(`[Instagram Controller] Response validated successfully`);
      } catch (validateError: any) {
        console.error(`[Instagram Controller] ❌ Response validation failed:`, validateError);
        // Return minimal safe response if validation fails
        return res.status(200).json({
          success: true,
          postId: String(result.postId || ''),
          message: 'Post published successfully',
        });
      }
      
      // Explicitly send JSON response - this prevents NestJS from returning HTML error pages
      console.log(`[Instagram Controller] ✅ Sending JSON response`);
      return res.status(200).json(cleanResponse);
    } catch (error: any) {
      console.error('[Instagram Controller] Error caught:', {
        message: error.message,
        status: error.status || error.statusCode,
        response: error.response,
        stack: error.stack?.substring(0, 500),
      });
      
      // Always return JSON error response - never HTML
      const statusCode = error.status || error.statusCode || HttpStatus.INTERNAL_SERVER_ERROR;
      const errorResponse = {
        success: false,
        error: 'Failed to create Instagram post',
        message: error.message || 'Unknown error occurred',
        ...(error.response?.data && { details: error.response.data }),
      };
      
      return res.status(statusCode).json(errorResponse);
    }
  }

  @UseGuards(SupabaseAuthGuard)
  @Get('posts/:accountId')
  async listPosts(@Req() req, @Param('accountId') accountId: string) {
    try {
      console.log(
        `[Instagram Controller] Listing posts for account: ${accountId}, user: ${req.user.id}`,
      );
      return await this.instagramService.listPostsForAccount({
        userId: req.user.id,
        socialAccountId: accountId,
      });
    } catch (error: any) {
      console.error('[Instagram Controller] List posts error:', error);
      throw error;
    }
  }

  @UseGuards(SupabaseAuthGuard)
  @Delete('posts/:accountId/:postId')
  async deletePost(
    @Req() req,
    @Param('accountId') accountId: string,
    @Param('postId') postId: string,
  ) {
    try {
      console.log(
        `[Instagram Controller] Deleting post ${postId} for account: ${accountId}, user: ${req.user.id}`,
      );
      return await this.instagramService.deletePostForAccount({
        userId: req.user.id,
        socialAccountId: accountId,
        scheduledPostId: postId,
      });
    } catch (error: any) {
      console.error('[Instagram Controller] Delete post error:', error);
      throw error;
    }
  }
}


