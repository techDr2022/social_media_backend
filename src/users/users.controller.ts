import { Controller, Get, Param, Put, Body, UseGuards, Req } from '@nestjs/common';
import { UsersService } from './users.service';
import { SupabaseAuthGuard } from '../auth/supabase.guard';
import type { Request } from 'express';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // Public: get user by id (for debugging)
  @Get(':id')
  async getUser(@Param('id') id: string) {
    return this.users.findById(id);
  }

  /**
   * PUT /users/profile
   * Authorization: Bearer <supabase_access_token>
   * Updates the current user's profile
   */
  @UseGuards(SupabaseAuthGuard)
  @Put('profile')
  async updateProfile(@Body() body: { name?: string }, @Req() req: Request) {
    const supabaseUser = (req as any).user;
    
    const updatedUser = await this.users.updateProfile(supabaseUser.id, {
      name: body.name || undefined,
    });

    return { user: updatedUser };
  }
}
