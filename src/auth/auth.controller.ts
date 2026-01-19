import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from './supabase.guard';
import { UsersService } from '../users/users.service';
import type { Request } from 'express';

@Controller('auth')
export class AuthController {
  constructor(private readonly users: UsersService) {}

  /**
   * POST /auth/sync
   * Authorization: Bearer <supabase_access_token>
   */
  @UseGuards(SupabaseAuthGuard)
  @Post('sync')
  async sync(@Req() req: Request) {
    const supabaseUser = (req as any).user;

    const user = await this.users.createIfNotExists({
      id: supabaseUser.id,
      email: supabaseUser.email,
      name: supabaseUser.user_metadata?.full_name,
    });

    return { user };
  }
}
