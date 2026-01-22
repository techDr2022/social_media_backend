import { Module, forwardRef } from '@nestjs/common';
import { YoutubeService } from './youtube.service';
import { YoutubeController } from './youtube.controller';
import { SocialAccountsModule } from '../../social-accounts.module';
import { PrismaModule } from '../../../prisma/prisma.module';

@Module({
  imports: [forwardRef(() => SocialAccountsModule), PrismaModule],
  providers: [YoutubeService],
  controllers: [YoutubeController],
  exports: [YoutubeService], // Export for use in other modules
})
export class YoutubeModule {}
