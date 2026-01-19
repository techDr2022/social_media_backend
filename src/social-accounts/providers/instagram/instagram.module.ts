import { Module } from '@nestjs/common';
import { InstagramService } from './instagram.service';
import { InstagramController } from './instagram.controller';
import { SocialAccountsModule } from '../../social-accounts.module';
import { PrismaModule } from '../../../prisma/prisma.module';
import { LogsModule } from '../../../logs/logs.module';

@Module({
  imports: [SocialAccountsModule, PrismaModule, LogsModule],
  providers: [InstagramService],
  controllers: [InstagramController],
  exports: [InstagramService], // Export for use in other modules
})
export class InstagramModule {}


