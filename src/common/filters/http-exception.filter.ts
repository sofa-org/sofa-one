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

type ExceptionResponse = {
  code?: string;
  error?: string;
  message?: string | string[];
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : 'Internal server error';
    const payload = this.toPayload(status, exceptionResponse);

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} — ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(status).json({
      statusCode: status,
      ...payload,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  private toPayload(status: number, exceptionResponse: string | object) {
    if (typeof exceptionResponse === 'string') {
      return {
        code: resolveApiErrorCode(status, exceptionResponse),
        message: exceptionResponse,
      };
    }

    const response = exceptionResponse as ExceptionResponse;
    const rawMessage = response.message ?? response.error ?? 'Unexpected error';
    const details = Array.isArray(rawMessage) ? rawMessage : undefined;
    const message = details ? 'Validation failed' : rawMessage;

    return {
      code: response.code ?? resolveApiErrorCode(status, rawMessage),
      message,
      ...(details ? { details } : {}),
    };
  }
}
