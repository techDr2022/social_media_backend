import { Module } from '@nestjs/common';
import { join } from 'path';
import { ServeStaticModule } from '@nestjs/serve-static';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ScheduledPostsModule } from './scheduled-posts/scheduled-posts.module';
import { SocialAccountsModule } from './social-accounts/social-accounts.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { YoutubeModule } from './social-accounts/providers/youtube/youtube.module';
import { FacebookModule } from './social-accounts/providers/facebook/facebook.module';
import { InstagramModule } from './social-accounts/providers/instagram/instagram.module';
import { LogsModule } from './logs/logs.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LoggingInterceptor } from './logs/logging.interceptor';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'),
      serveRoot: '/uploads', // static files served at /uploads/*
    }),
    PrismaModule,
    UsersModule,
    AuthModule,
    ScheduledPostsModule,
    SocialAccountsModule,
    YoutubeModule,
    FacebookModule,
    InstagramModule,
    LogsModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
})
export class AppModule {}
