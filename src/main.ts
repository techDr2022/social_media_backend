import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { TimeoutInterceptor } from './common/timeout.interceptor';
import { LogsService } from './logs/logs.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Security middleware - must be before other middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
    crossOriginEmbedderPolicy: false, // Allow iframe embeds if needed
  }));
  
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

  // Swagger/OpenAPI Documentation
  const config = new DocumentBuilder()
    .setTitle('Social Media API')
    .setDescription('API for managing social media posts and accounts across Instagram, Facebook, and YouTube')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth', // This name here is important for matching up with @ApiBearerAuth() in your controller!
    )
    .addTag('auth', 'Authentication endpoints')
    .addTag('users', 'User management')
    .addTag('social-accounts', 'Social account management')
    .addTag('scheduled-posts', 'Post scheduling and management')
    .addTag('health', 'Health check endpoints')
    .addTag('logs', 'Logging endpoints')
    .build();
  
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true, // Keep auth token in browser
    },
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`✅ Nest API running on http://localhost:${port}`);
  console.log(`📊 Health check: http://localhost:${port}/api/v1/health`);
  console.log(`📚 API Documentation: http://localhost:${port}/api/docs`);
}
bootstrap();
