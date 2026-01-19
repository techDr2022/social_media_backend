import {
  Controller,
  Post,
  UseGuards,
  Req,
  Body,
  Param,
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
      });
    } catch (error: any) {
      console.error('[Facebook Controller] Error:', error);
      throw error;
    }
  }
}

