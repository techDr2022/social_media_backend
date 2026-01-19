import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError, finalize } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { LogsService } from './logs.service';
import { Request } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly logsService: LogsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method, url, body, headers, ip } = request;
    const startTime = Date.now();

    // Extract user ID from request if available (from auth guard)
    const userId = (request as any).user?.id;
    
    // Extract account ID from params if available
    const accountId = request.params?.accountId || request.params?.id;

    // Get IP address (check various headers for real IP)
    const ipAddress = 
      headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
      headers['x-real-ip']?.toString() ||
      ip ||
      request.socket?.remoteAddress ||
      'unknown';

    // Get user agent
    const userAgent = headers['user-agent'] || 'unknown';

    // Get screen size from custom header if available (frontend should send this)
    const screenSize = headers['x-screen-size']?.toString() || undefined;

    // Determine service name from path
    const service = this.getServiceFromPath(url);

    // Skip logging for health checks and static files
    if (this.shouldSkipLogging(url)) {
      return next.handle();
    }

    // Store response data for logging (captured after response is sent)
    let capturedResponse: any = null;
    
    return next.handle().pipe(
      tap((response) => {
        // When using @Res() decorator with res.json(), NestJS returns the Response object
        // which has circular references. We need to detect and skip it.
        try {
          if (response === null || response === undefined) {
            // Response was sent via @Res() - nothing to capture
            capturedResponse = null;
            return;
          }
          
          // Check if it's a Response object with circular references
          if (typeof response === 'object') {
            // Express Response objects have these characteristics:
            // - Has 'req' property (circular reference)
            // - Has 'status' method
            // - Has 'json' method
            if ('req' in response || (typeof (response as any).status === 'function' && typeof (response as any).json === 'function')) {
              // This is likely an Express Response object - don't capture it (has circular refs)
              capturedResponse = null;
              return;
            }
          }
          
          // Otherwise, it's actual response data - capture it
          capturedResponse = response;
        } catch (e) {
          // If capturing fails, just skip it - don't break the response
          capturedResponse = null;
        }
      }),
      catchError((error) => {
        // Log error response AFTER error is handled (use setImmediate)
        setImmediate(() => {
          try {
            const responseTime = Date.now() - startTime;
            const statusCode = error.status || error.statusCode || 500;

            // Try to sanitize error data safely
            let sanitizedErrorData: any = null;
            try {
              sanitizedErrorData = this.sanitizeResponseData(error.response?.data || error.message);
            } catch (sanitizeError: any) {
              console.warn('[LoggingInterceptor] Failed to sanitize error data:', sanitizeError.message);
              sanitizedErrorData = { _error: 'Failed to sanitize error data', _message: String(error.message || 'Unknown error') };
            }

            // Log (this is already async/buffered, so it won't block)
            this.logsService.log({
              level: 'error',
              service,
              message: `${method} ${url} - ${statusCode}`,
              method,
              path: url,
              ipAddress,
              userAgent,
              screenSize,
              requestData: this.sanitizeRequestBody(body),
              responseData: sanitizedErrorData,
              statusCode,
              responseTime,
              errorStack: error.stack || (error instanceof Error ? error.stack : String(error)),
              userId,
              accountId,
            });
          } catch (logError: any) {
            // Log error but don't break anything
            console.warn('[LoggingInterceptor] Failed to log error (non-critical):', logError.message);
          }
        });

        return throwError(() => error);
      }),
      finalize(() => {
        // Log successful response AFTER response is fully sent (finalize runs after response is sent)
        // This ensures logging never interferes with the response
        // Use setImmediate to defer even further, ensuring response is completely sent
        setImmediate(() => {
          try {
            const responseTime = Date.now() - startTime;
            
            // Get status code from context (now safe since response is already sent)
            let statusCode = 200;
            try {
              const httpResponse = context.switchToHttp().getResponse();
              statusCode = (httpResponse as any).statusCode || 200;
            } catch (e) {
              // If we can't get status code, default to 200
              statusCode = 200;
            }

            // Try to sanitize response data safely
            // If capturedResponse is null (was a Response object), use a placeholder
            let sanitizedResponseData: any = null;
            try {
              if (capturedResponse !== null && capturedResponse !== undefined) {
                // Check if it's a circular Response object
                if (typeof capturedResponse === 'object' && 'req' in capturedResponse && 'socket' in (capturedResponse as any).req) {
                  // This is a Response object with circular refs - skip it
                  sanitizedResponseData = { _note: 'Response object captured (circular references skipped)' };
                } else {
                  sanitizedResponseData = this.sanitizeResponseData(capturedResponse);
                }
              } else {
                // No response data captured (probably used @Res() decorator)
                // Response was sent directly, we can't capture it safely
                sanitizedResponseData = { _note: 'Response sent via @Res() decorator - data not captured' };
              }
            } catch (sanitizeError: any) {
              console.warn('[LoggingInterceptor] Failed to sanitize response data:', sanitizeError.message);
              sanitizedResponseData = { _error: 'Failed to sanitize response', _message: sanitizeError.message };
            }

            // Log (this is already async/buffered, so it won't block)
            this.logsService.log({
              level: 'info',
              service,
              message: `${method} ${url} - ${statusCode}`,
              method,
              path: url,
              ipAddress,
              userAgent,
              screenSize,
              requestData: this.sanitizeRequestBody(body),
              responseData: sanitizedResponseData,
              statusCode,
              responseTime,
              userId,
              accountId,
            });
          } catch (logError: any) {
            // Log error but don't break anything - response already sent
            console.warn('[LoggingInterceptor] Failed to log response (non-critical):', logError.message);
          }
        });
      }),
    );
  }

  private getServiceFromPath(path: string): string {
    // Extract service name from path
    if (path.includes('/instagram')) return 'instagram';
    if (path.includes('/facebook')) return 'facebook';
    if (path.includes('/youtube')) return 'youtube';
    if (path.includes('/social-accounts')) return 'social-accounts';
    if (path.includes('/scheduled-posts')) return 'scheduled-posts';
    if (path.includes('/users')) return 'users';
    if (path.includes('/auth')) return 'auth';
    return 'api';
  }

  private shouldSkipLogging(path: string): boolean {
    // Skip logging for health checks, favicon, etc.
    const skipPaths = ['/health', '/favicon.ico', '/metrics'];
    return skipPaths.some((skipPath) => path.startsWith(skipPath));
  }

  private sanitizeRequestBody(body: any): any {
    if (!body) return null;
    
    // Create a copy to avoid modifying the original
    const sanitized = { ...body };
    
    // Remove sensitive fields
    const sensitiveFields = ['password', 'accessToken', 'refreshToken', 'token', 'secret', 'apiKey'];
    sensitiveFields.forEach((field) => {
      if (sanitized[field]) {
        sanitized[field] = '***REDACTED***';
      }
    });
    
    // Limit size to prevent huge logs
    const bodyStr = JSON.stringify(sanitized);
    if (bodyStr.length > 10000) {
      return { ...sanitized, _truncated: true, _originalLength: bodyStr.length };
    }
    
    return sanitized;
  }

  private sanitizeResponseData(data: any): any {
    if (!data) return null;
    
    // Check if data is a Response object with circular references
    // Express Response objects have 'req' property which creates circular references
    if (typeof data === 'object' && ('req' in data || (data.constructor && data.constructor.name === 'ServerResponse'))) {
      // This is a Response object - don't try to serialize it
      return { _note: 'Response object (circular references skipped - sent via @Res() decorator)' };
    }
    
    try {
      // Try to serialize to check if it's valid JSON
      // Use a replacer function to handle circular references
      const seen = new WeakSet();
      const cleaned = JSON.parse(JSON.stringify(data, (key, value) => {
        // Skip circular references
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular Reference]';
          }
          seen.add(value);
        }
        // Remove undefined values
        if (value === undefined) {
          return null;
        }
        return value;
      }));
      
      // Limit response size
      const dataStr = JSON.stringify(cleaned);
      if (dataStr.length > 10000) {
        return { _truncated: true, _originalLength: dataStr.length, _preview: dataStr.substring(0, 1000) };
      }
      
      return cleaned;
    } catch (error: any) {
      // If serialization fails (likely circular reference), return a safe representation
      if (error.message?.includes('circular') || error.message?.includes('Converting circular structure')) {
        return { _note: 'Response contains circular references (likely sent via @Res() decorator)' };
      }
      console.warn('[LoggingInterceptor] Failed to sanitize response data:', error.message);
      return { _error: 'Failed to serialize response data', _type: typeof data, _message: error.message?.substring(0, 100) };
    }
  }
}

