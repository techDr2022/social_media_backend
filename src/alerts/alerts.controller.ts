import {
  Controller,
  Get,
  Put,
  Delete,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { SupabaseAuthGuard } from '../auth/supabase.guard';
import type { Request } from 'express';

@Controller('alerts')
@UseGuards(SupabaseAuthGuard)
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  /**
   * Get alerts for the current user
   * Query params:
   * - limit: number of alerts (default: 10)
   * - cursor: pagination cursor (alert ID)
   * - unreadOnly: only return unread alerts (default: false)
   */
  @Get()
  async getAlerts(
    @Req() req: Request,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    const user = (req as any).user;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const unreadOnlyBool = unreadOnly === 'true';

    return this.alertsService.findForUser(
      user.id,
      limitNum,
      cursor,
      unreadOnlyBool,
    );
  }

  /**
   * Get unread count
   */
  @Get('unread-count')
  async getUnreadCount(@Req() req: Request) {
    const user = (req as any).user;
    const count = await this.alertsService.getUnreadCount(user.id);
    return { count };
  }

  /**
   * Mark alert as read
   */
  @Put(':id/read')
  async markAsRead(@Req() req: Request, @Param('id') id: string) {
    const user = (req as any).user;
    await this.alertsService.markAsRead(user.id, id);
    return { success: true };
  }

  /**
   * Mark all alerts as read
   */
  @Put('read-all')
  async markAllAsRead(@Req() req: Request) {
    const user = (req as any).user;
    await this.alertsService.markAllAsRead(user.id);
    return { success: true };
  }

  /**
   * Delete alert
   */
  @Delete(':id')
  async delete(@Req() req: Request, @Param('id') id: string) {
    const user = (req as any).user;
    await this.alertsService.delete(user.id, id);
    return { success: true };
  }
}
