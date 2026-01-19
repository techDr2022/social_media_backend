// src/dev/dev.controller.ts (temporary, remove later)
import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase.guard';
import { PrismaService } from '../prisma/prisma.service';
import type { Request } from 'express';

@Controller('dev')
export class DevController {
  constructor(private prisma: PrismaService) {}

  @UseGuards(SupabaseAuthGuard)
  @Post('create-social-account')
  async create(@Req() req: Request, @Body() body: { platform: string; displayName?: string }) {
    const user = (req as any).user;
    return this.prisma.socialAccount.create({
      data: {
        userId: user.id,
        platform: body.platform,
        externalId: `dev-${Date.now()}`,
        accessToken: 'dev-token',
        displayName: body.displayName ?? 'Dev Account',
      },
    });
  }
}
