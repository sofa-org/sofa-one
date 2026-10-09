import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { resolveApiErrorCode } from '../errors/api-error-codes';
import { sanitizeErrorMessage } from '../utils/sanitize';

type ExceptionResponse = {
  code?: string;
  error?: string;
  message?: string | string[];
  retryAfterSeconds?: unknown;
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = request.requestId;

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : 'Internal server error';
    const payload = this.toPayload(status, exceptionResponse);

    if (status === HttpStatus.TOO_MANY_REQUESTS && 'retryAfterSeconds' in payload) {
      response.setHeader?.('Retry-After', String(payload.retryAfterSeconds));
    }

    if (status >= 500) {
      this.logger.error(
        {
          message: 'HTTP request failed',
          requestId,
          method: request.method,
          path: request.url,
          statusCode: status,
        },
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(status).json({
      statusCode: status,
      ...payload,
      requestId,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  private toPayload(status: number, exceptionResponse: string | object) {
    if (typeof exceptionResponse === 'string') {
      return {
        code: resolveApiErrorCode(status, exceptionResponse),
        message: sanitizeErrorMessage(exceptionResponse),
      };
    }

    const response = exceptionResponse as ExceptionResponse;
    const rawMessage = response.message ?? response.error ?? 'Unexpected error';
    const details = Array.isArray(rawMessage) ? rawMessage : undefined;
    const message = details
      ? 'Validation failed'
      : sanitizeErrorMessage(String(rawMessage));
    // Pass the original rawMessage (array or string) to resolveApiErrorCode
    // so it can correctly identify validation errors
    const codeSource: string | string[] = details ?? String(rawMessage);

    const retryAfterSeconds = status === HttpStatus.TOO_MANY_REQUESTS && Number.isFinite(response.retryAfterSeconds) && Number.isInteger(response.retryAfterSeconds) && Number(response.retryAfterSeconds) > 0
      ? Number(response.retryAfterSeconds)
      : undefined;
    return {
      code: response.code ?? resolveApiErrorCode(status, codeSource),
      message,
      ...(details ? { details } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }
}
