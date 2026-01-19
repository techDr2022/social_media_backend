import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Check if response headers have already been sent (response already sent)
    if (response.headersSent) {
      console.warn('[HttpExceptionFilter] Response headers already sent, cannot send error response');
      return;
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            message: exception instanceof Error ? exception.message : 'Internal server error',
            error: 'Internal Server Error',
          };

    // Always return JSON, never HTML
    try {
      const errorResponse = typeof message === 'string' 
        ? { message, timestamp: new Date().toISOString(), path: request.url }
        : { ...message, timestamp: new Date().toISOString(), path: request.url };
      
      // Explicitly set Content-Type header to ensure JSON response
      response.setHeader('Content-Type', 'application/json');
      response.status(status).json(errorResponse);
      
      console.log(`[HttpExceptionFilter] Sent error response: ${status}, path: ${request.url}`);
    } catch (sendError: any) {
      // If sending response fails (e.g., headers already sent), log but don't crash
      console.error('[HttpExceptionFilter] Failed to send error response:', sendError.message);
      console.error('[HttpExceptionFilter] Error details:', {
        headersSent: response.headersSent,
        statusCode: response.statusCode,
        error: sendError,
      });
    }
  }
}

