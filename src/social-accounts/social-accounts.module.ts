import { Module, forwardRef } from '@nestjs/common';
import { SocialAccountsController } from './social-accounts.controller';
import { SocialAccountsService } from './social-accounts.service';
import { TokenExpirationService } from './token-expiration.service';
import { TokenRefreshCronService } from './token-refresh-cron.service';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { YoutubeModule } from './providers/youtube/youtube.module';
import { TokenRefreshService } from '../utils/token-refresh.service';

@Module({
  imports: [PrismaModule, UsersModule, forwardRef(() => YoutubeModule)],
  controllers: [SocialAccountsController],
  providers: [
    SocialAccountsService,
    TokenExpirationService, // ⭐ New: Token expiration tracking
    TokenRefreshCronService, // ⭐ New: Scheduled token refresh
    TokenRefreshService, // ⭐ New: Enhanced token refresh service
  ],
  exports: [
    SocialAccountsService,
    TokenExpirationService,
    TokenRefreshService,
  ],
})
export class SocialAccountsModule {}
