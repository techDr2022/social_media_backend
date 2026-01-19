// src/social-accounts/social-accounts.controller.ts
import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Req,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase.guard';
import { SocialAccountsService } from './social-accounts.service';
import type { Request, Response } from 'express';

@Controller('social-accounts')
export class SocialAccountsController {
  constructor(private readonly socialAccounts: SocialAccountsService) {}

  // START YOUTUBE OAUTH
  @UseGuards(SupabaseAuthGuard)
  @Get('connect/youtube')
  connectYoutube(@Req() req: Request, @Res() res: Response) {
    const user = (req as any).user;
    const url = this.socialAccounts.buildYoutubeOAuthUrl(user.id);
    return res.redirect(url);
  }

  // YOUTUBE CALLBACK
  @Get('callback/youtube')
  async youtubeCallback(@Req() req: Request, @Res() res: Response) {
    const { code, state: userId } = req.query as any;
    if (!code || !userId) {
      throw new BadRequestException('Invalid OAuth callback');
    }

    await this.socialAccounts.handleYoutubeOAuthCallback({
      code,
      userId,
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    return res.redirect(`${frontendUrl}/schedule`);
  }

  // TEST UPLOAD (DEV ONLY)
  @UseGuards(SupabaseAuthGuard)
  @Post('youtube/test-upload')
  async testUpload(@Req() req: Request) {
    const user = (req as any).user;
    return this.socialAccounts.testYoutubeUpload(user.id);
  }

  // START FACEBOOK OAUTH
  @UseGuards(SupabaseAuthGuard)
  @Get('connect/facebook')
  connectFacebook(@Req() req: Request, @Res() res: Response) {
    const user = (req as any).user;
    const url = this.socialAccounts.buildFacebookOAuthUrl(user.id);
    return res.redirect(url);
  }

  // FACEBOOK CALLBACK
  @Get('callback/facebook')
  async facebookCallback(@Req() req: Request, @Res() res: Response) {
    const { code, state: userId } = req.query as any;
    if (!code || !userId) {
      throw new BadRequestException('Invalid OAuth callback');
    }

    await this.socialAccounts.handleFacebookOAuthCallback({
      code,
      userId,
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    return res.redirect(`${frontendUrl}/facebook`);
  }

  // START INSTAGRAM OAUTH
  @UseGuards(SupabaseAuthGuard)
  @Get('connect/instagram')
  connectInstagram(@Req() req: Request, @Res() res: Response) {
    const user = (req as any).user;
    const url = this.socialAccounts.buildInstagramOAuthUrl(user.id);
    
    // Store userId in a cookie as backup (in case Instagram doesn't return state)
    // Cookie expires in 10 minutes (OAuth should complete faster)
    res.cookie('instagram_oauth_user_id', user.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes
    });
    
    return res.redirect(url);
  }

  // INSTAGRAM CALLBACK
  @Get('callback/instagram')
  async instagramCallback(@Req() req: Request, @Res() res: Response) {
    try {
      const { code, state: userIdFromState } = req.query as any;
      
      // Log all query parameters for debugging
      console.log(`[Instagram Callback Controller] Full request URL:`, req.url);
      console.log(`[Instagram Callback Controller] Query params:`, req.query);
      
      // Try to get userId from state parameter first, then from cookie
      let userId = userIdFromState;
      if (!userId) {
        // Instagram Login sometimes doesn't return state parameter
        // Try to get userId from cookie (set when initiating OAuth)
        userId = req.cookies?.instagram_oauth_user_id;
        if (userId) {
          console.log(`[Instagram Callback Controller] State parameter missing, using userId from cookie: ${userId}`);
          // Clear the cookie after using it
          res.clearCookie('instagram_oauth_user_id');
        } else {
          console.error(`[Instagram Callback Controller] ERROR: State parameter is missing AND no cookie found!`);
        }
      }
      
      console.log(`[Instagram Callback Controller] Received callback - userId: ${userId || 'MISSING'}, has code: ${!!code}`);
      
      if (!code) {
        const frontendUrl = process.env.INSTAGRAM_FRONTEND_URL || process.env.FRONTEND_URL || 'http://localhost:3001';
        return res.redirect(`${frontendUrl}/instagram?error=${encodeURIComponent('Invalid OAuth callback - missing code parameter')}`);
      }
      
      if (!userId) {
        console.error(`[Instagram Callback Controller] ERROR: Cannot identify user - both state parameter and cookie are missing!`);
        console.error(`[Instagram Callback Controller] Instagram Login may not have returned the state parameter.`);
        const frontendUrl = process.env.INSTAGRAM_FRONTEND_URL || process.env.FRONTEND_URL || 'http://localhost:3001';
        return res.redirect(`${frontendUrl}/instagram?error=${encodeURIComponent('Invalid OAuth callback - cannot identify user. Please try connecting again while logged in.')}`);
      }

      console.log(`[Instagram Callback Controller] Processing OAuth callback for user: ${userId}`);
      const createdAccounts = await this.socialAccounts.handleInstagramOAuthCallback({
        code,
        userId,
      });

      console.log(`[Instagram Callback Controller] OAuth callback completed. Created/updated ${createdAccounts.length} Instagram accounts`);
      const frontendUrl = process.env.INSTAGRAM_FRONTEND_URL || process.env.FRONTEND_URL || 'http://localhost:3001';
      return res.redirect(`${frontendUrl}/instagram`);
    } catch (error: any) {
      console.error('[Instagram Callback Controller] Error:', error);
      console.error('[Instagram Callback Controller] Error stack:', error.stack);
      const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
      const frontendUrl = process.env.INSTAGRAM_FRONTEND_URL || process.env.FRONTEND_URL || 'http://localhost:3001';
      return res.redirect(`${frontendUrl}/instagram?error=${encodeURIComponent(`OAuth callback failed: ${errorMessage}`)}`);
    }
  }

  // LIST ACCOUNTS
  @UseGuards(SupabaseAuthGuard)
  @Get()
  list(@Req() req: Request) {
    const user = (req as any).user;
    return this.socialAccounts.listForUser(user.id);
  }

  // DELETE ACCOUNT
  @UseGuards(SupabaseAuthGuard)
  @Delete(':accountId')
  async deleteAccount(@Req() req: Request, @Param('accountId') accountId: string) {
    const user = (req as any).user;
    return this.socialAccounts.deleteAccount(accountId, user.id);
  }
}
