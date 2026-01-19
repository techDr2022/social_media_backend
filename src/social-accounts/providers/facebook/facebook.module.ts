import { Module } from '@nestjs/common';
import { FacebookService } from './facebook.service';
import { FacebookController } from './facebook.controller';
import { SocialAccountsModule } from '../../social-accounts.module';
import { PrismaModule } from '../../../prisma/prisma.module';

@Module({
  imports: [SocialAccountsModule, PrismaModule],
  providers: [FacebookService],
  controllers: [FacebookController],
  exports: [FacebookService], // Export for use in other modules
})
export class FacebookModule {}







