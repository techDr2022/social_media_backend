import { Module, forwardRef } from '@nestjs/common';
import { SocialAccountsController } from './social-accounts.controller';
import { SocialAccountsService } from './social-accounts.service';
import { TokenExpirationService } from './token-expiration.service';
import { TokenRefreshCronService } from './token-refresh-cron.service';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { YoutubeModule } from './providers/youtube/youtube.module';
import { TokenRefreshService } from '../utils/token-refresh.service';
import { EncryptionService } from '../common/encryption.service';

@Module({
  imports: [PrismaModule, UsersModule, forwardRef(() => YoutubeModule)],
  controllers: [SocialAccountsController],
  providers: [
    SocialAccountsService,
    TokenExpirationService,
    TokenRefreshCronService,
    TokenRefreshService,
    EncryptionService,
  ],
  exports: [
    SocialAccountsService,
    TokenExpirationService,
    TokenRefreshService,
    EncryptionService,
  ],
})
export class SocialAccountsModule {}
