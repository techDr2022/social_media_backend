import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

/**
 * Custom Application Exception
 * 
 * Provides structured error responses with error codes
 */
export class AppException extends HttpException {
  constructor(
    public readonly errorCode: ErrorCode,
    message: string,
    statusCode: number = HttpStatus.BAD_REQUEST,
    public readonly details?: any,
  ) {
    super(
      {
        errorCode,
        message,
        timestamp: new Date().toISOString(),
        ...(details && { details }),
      },
      statusCode,
    );
  }
}

/**
 * Convenience exception classes
 */
export class NotFoundException extends AppException {
  constructor(message: string, errorCode: ErrorCode = ErrorCode.GENERAL_NOT_FOUND) {
    super(errorCode, message, HttpStatus.NOT_FOUND);
  }
}

export class BadRequestException extends AppException {
  constructor(
    message: string,
    errorCode: ErrorCode = ErrorCode.GENERAL_BAD_REQUEST,
    details?: any,
  ) {
    super(errorCode, message, HttpStatus.BAD_REQUEST, details);
  }
}

export class UnauthorizedException extends AppException {
  constructor(
    message: string,
    errorCode: ErrorCode = ErrorCode.AUTH_UNAUTHORIZED,
  ) {
    super(errorCode, message, HttpStatus.UNAUTHORIZED);
  }
}

export class ForbiddenException extends AppException {
  constructor(
    message: string,
    errorCode: ErrorCode = ErrorCode.AUTH_FORBIDDEN,
  ) {
    super(errorCode, message, HttpStatus.FORBIDDEN);
  }
}

export class RateLimitException extends AppException {
  constructor(
    message: string,
    public readonly resetAt?: Date,
    errorCode: ErrorCode = ErrorCode.RATE_LIMIT_EXCEEDED,
  ) {
    super(
      errorCode,
      message,
      HttpStatus.TOO_MANY_REQUESTS,
      resetAt ? { resetAt: resetAt.toISOString() } : undefined,
    );
  }
}
