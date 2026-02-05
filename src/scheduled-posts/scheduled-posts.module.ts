import { Module } from '@nestjs/common';
import { ScheduledPostsService } from './scheduled-posts.service';
import { ScheduledPostsController } from './scheduled-posts.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PostQueueModule } from './queue/post-queue.module';
import { SocialAccountsModule } from '../social-accounts/social-accounts.module';
import { InstagramModule } from '../social-accounts/providers/instagram/instagram.module';
import { FacebookModule } from '../social-accounts/providers/facebook/facebook.module';
import { YoutubeModule } from '../social-accounts/providers/youtube/youtube.module';
import { DatabaseTransactionService } from '../common/database-transaction.service';

@Module({
  imports: [
    PrismaModule,
    PostQueueModule, // ⭐ Add this - provides BullMQ queue
    SocialAccountsModule,
    InstagramModule,
    FacebookModule,
    YoutubeModule,
  ],
  controllers: [ScheduledPostsController],
  providers: [ScheduledPostsService, DatabaseTransactionService],
})
export class ScheduledPostsModule {}
