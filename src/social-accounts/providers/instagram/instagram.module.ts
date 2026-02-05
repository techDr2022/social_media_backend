import { Module, forwardRef } from '@nestjs/common';
import { InstagramService } from './instagram.service';
import { InstagramController } from './instagram.controller';
import { SocialAccountsModule } from '../../social-accounts.module';
import { PrismaModule } from '../../../prisma/prisma.module';
import { LogsModule } from '../../../logs/logs.module';
import { PostQueueModule } from '../../../scheduled-posts/queue/post-queue.module';
import { AlertsModule } from '../../../alerts/alerts.module';

@Module({
  imports: [
    SocialAccountsModule, 
    PrismaModule, 
    LogsModule, 
    forwardRef(() => PostQueueModule), // Use forwardRef to break circular dependency
    AlertsModule, // For creating alerts
  ],
  providers: [InstagramService],
  controllers: [InstagramController],
  exports: [InstagramService], // Export for use in other modules
})
export class InstagramModule {}


