import {
  Controller,
  Post,
  UseGuards,
  Req,
  Body,
  Param,
  Get,
  Delete,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../../../auth/supabase.guard';
import { FacebookService } from './facebook.service';
import { FacebookPostDto } from './dto/facebook-post.dto';

@Controller('facebook')
export class FacebookController {
  constructor(private readonly facebookService: FacebookService) {}

  @UseGuards(SupabaseAuthGuard)
  @Post('post/:accountId')
  async createPost(
    @Req() req,
    @Param('accountId') accountId: string,
    @Body() body: FacebookPostDto & { mediaUrl?: string; mediaType?: 'photo' | 'video' },
  ) {
    try {
      console.log(`[Facebook Controller] Creating post for account: ${accountId}, user: ${req.user.id}`);
      return await this.facebookService.createPost({
        userId: req.user.id,
        socialAccountId: accountId,
        message: body.message,
        mediaUrl: body.mediaUrl,
        mediaType: body.mediaType,
        scheduledPublishTime: body.scheduledPublishTime,
        collaborator: body.collaborator,
        shareToStory: body.shareToStory,
        privacy: body.privacy,
        privacyValue: body.privacyValue,
        isCarousel: (body as any).isCarousel,
        carouselUrls: (body as any).carouselUrls,
      });
    } catch (error: any) {
      console.error('[Facebook Controller] Error:', error);
      throw error;
    }
  }

  @UseGuards(SupabaseAuthGuard)
  @Get('posts/:accountId')
  async listPosts(@Req() req, @Param('accountId') accountId: string) {
    try {
      console.log(
        `[Facebook Controller] Listing posts for account: ${accountId}, user: ${req.user.id}`,
      );
      return await this.facebookService.listPostsForAccount({
        userId: req.user.id,
        socialAccountId: accountId,
      });
    } catch (error: any) {
      console.error('[Facebook Controller] List posts error:', error);
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
        `[Facebook Controller] Deleting post ${postId} for account: ${accountId}, user: ${req.user.id}`,
      );
      return await this.facebookService.deletePostForAccount({
        userId: req.user.id,
        socialAccountId: accountId,
        scheduledPostId: postId,
      });
    } catch (error: any) {
      console.error('[Facebook Controller] Delete post error:', error);
      throw error;
    }
  }
}

