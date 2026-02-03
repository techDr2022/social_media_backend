import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  RequestTimeoutException,
} from '@nestjs/common';
import { Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';

/**
 * Timeout Interceptor
 * 
 * Prevents long-running requests from hanging:
 * - Sets request timeout (default 30s)
 * - Throws RequestTimeoutException on timeout
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  private readonly timeout = parseInt(
    process.env.REQUEST_TIMEOUT || '30000',
    10,
  ); // 30 seconds default

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      timeout(this.timeout),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(
            () =>
              new RequestTimeoutException(
                `Request timeout after ${this.timeout}ms`,
              ),
          );
        }
        return throwError(() => err);
      }),
    );
  }
}
