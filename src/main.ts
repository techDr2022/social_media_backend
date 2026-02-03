import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';
import cookieParser from 'cookie-parser';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { TimeoutInterceptor } from './common/timeout.interceptor';
import { LogsService } from './logs/logs.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Global prefix for API versioning
  app.setGlobalPrefix('api/v1');
  
  // Validation pipe with enhanced options
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip unknown properties
      transform: true, // Auto-transform payloads
      forbidNonWhitelisted: true, // Throw error on unknown properties
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );
  
  // Global exception filter
  app.useGlobalFilters(new HttpExceptionFilter());
  
  // Global timeout interceptor
  app.useGlobalInterceptors(new TimeoutInterceptor());

  // Enable cookie parsing (needed for Instagram OAuth state fallback)
  app.use(cookieParser());

  // Increase body size limit for video uploads (1GB)
  app.use(express.json({ limit: '1024mb' }));
  app.use(express.urlencoded({ limit: '1024mb', extended: true }));

  // CORS configuration - allow both localhost and ngrok/production domains
  const allowedOrigins = [
    'http://localhost:3001', // Next dev
    process.env.FRONTEND_URL, // Production/ngrok frontend
  ].filter(Boolean); // Remove undefined values

  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : ['http://localhost:3001'],
    credentials: true,
  });

  // Graceful shutdown handler
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n${signal} received - starting graceful shutdown...`);
    
    try {
      // Stop accepting new requests
      await app.close();
      
      // Flush logs
      const logsService = app.get(LogsService);
      await logsService.forceFlush();
      
      console.log('✅ Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    console.error('⚠️ Unhandled Promise Rejection:', reason);
    // In production, you might want to log to external service
  });

  process.on('uncaughtException', (error: Error) => {
    console.error('⚠️ Uncaught Exception:', error);
    // In production, exit and let process manager restart
    if (process.env.NODE_ENV === 'production') {
      gracefulShutdown('UNCAUGHT_EXCEPTION');
    }
  });

  // Graceful shutdown signals
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  await app.listen(3000);
  console.log(`✅ Nest API running on http://localhost:3000`);
  console.log(`📊 Health check: http://localhost:3000/api/v1/health`);
}
bootstrap();
