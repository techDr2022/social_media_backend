import { Module, forwardRef } from '@nestjs/common';
import { GmbController } from './gmb.controller';
import { GmbService } from './gmb.service';
import { GmbSchedulerService } from './gmb-scheduler.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { SocialAccountsModule } from '../../social-accounts.module';
import { AlertsModule } from '../../../alerts/alerts.module';

@Module({
  imports: [
    PrismaModule,
    SocialAccountsModule,
    forwardRef(() => AlertsModule),
  ],
  controllers: [GmbController],
  providers: [GmbService, GmbSchedulerService],
  exports: [GmbService],
})
export class GmbModule {}
