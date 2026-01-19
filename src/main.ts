import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';
import cookieParser from 'cookie-parser';
import { HttpExceptionFilter } from './common/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter()); // Ensure all errors return JSON, not HTML

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

  // Handle unhandled promise rejections (prevent them from crashing the app or affecting responses)
  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    console.error('⚠️ Unhandled Promise Rejection:', reason);
    // Don't crash - just log it
  });

  process.on('uncaughtException', (error: Error) => {
    console.error('⚠️ Uncaught Exception:', error);
    // Don't crash - just log it (in production, you might want to exit)
  });

  await app.listen(3000);
  console.log(`✅ Nest API running on http://localhost:3000`);
}
bootstrap();
