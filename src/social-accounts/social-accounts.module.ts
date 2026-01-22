import { Module, forwardRef } from '@nestjs/common';
import { SocialAccountsController } from './social-accounts.controller';
import { SocialAccountsService } from './social-accounts.service';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { YoutubeModule } from './providers/youtube/youtube.module';

@Module({
  imports: [PrismaModule, UsersModule, forwardRef(() => YoutubeModule)],
  controllers: [SocialAccountsController],
  providers: [SocialAccountsService],
  exports: [SocialAccountsService],
})
export class SocialAccountsModule {}
