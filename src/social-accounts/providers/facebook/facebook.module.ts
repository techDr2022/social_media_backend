import { Module } from '@nestjs/common';
import { FacebookService } from './facebook.service';
import { FacebookController } from './facebook.controller';
import { SocialAccountsModule } from '../../social-accounts.module';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AlertsModule } from '../../../alerts/alerts.module';

@Module({
  imports: [SocialAccountsModule, PrismaModule, AlertsModule],
  providers: [FacebookService],
  controllers: [FacebookController],
  exports: [FacebookService], // Export for use in other modules
})
export class FacebookModule {}







