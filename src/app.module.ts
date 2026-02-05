import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ScheduleModule } from '@nestjs/schedule';
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
import { DatabaseTransactionService } from './common/database-transaction.service';
import { RateLimiterService } from './common/rate-limiter.service';
import { CircuitBreakerService } from './common/circuit-breaker.service';
import { CacheService } from './common/cache.service';
import { QueryOptimizerService } from './common/query-optimizer.service';
import { PostQueueModule } from './scheduled-posts/queue/post-queue.module';
import { AlertsModule } from './alerts/alerts.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Make config available throughout the app
      envFilePath: ['.env.local', '.env'], // Load .env.local first, then .env
    }),
    ScheduleModule.forRoot(), // ⭐ Enable cron jobs
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'),
      serveRoot: '/uploads', // static files served at /uploads/*
    }),
    PrismaModule,
    UsersModule,
    AuthModule,
    ScheduledPostsModule,
    PostQueueModule, // ⭐ Import PostQueueModule to access RedisConnectionService
    SocialAccountsModule,
    YoutubeModule,
    FacebookModule,
    InstagramModule,
    LogsModule,
    HealthModule,
    AlertsModule, // ⭐ Alerts/notifications module
  ],
  controllers: [AppController],
  providers: [
    AppService,
    DatabaseTransactionService, // ⭐ New: Database transactions
    RateLimiterService, // ⭐ New: Rate limiting
    CircuitBreakerService, // ⭐ New: Circuit breaker
    CacheService, // ⭐ New: Caching
    QueryOptimizerService, // ⭐ New: Query optimization
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
  ],
  exports: [
    DatabaseTransactionService,
    RateLimiterService,
    CircuitBreakerService,
    CacheService,
    QueryOptimizerService,
  ],
})
export class AppModule {}
