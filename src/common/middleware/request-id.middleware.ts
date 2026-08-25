import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { RequestContextService } from '../request-context/request-context.service';

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 128;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(private readonly requestContext: RequestContextService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = this.resolveRequestId(request.headers[REQUEST_ID_HEADER]);

    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);

    this.requestContext.run({ requestId, clientIp: request.ip }, next);
  }

  private resolveRequestId(header: string | string[] | undefined): string {
    const value = Array.isArray(header) ? header[0] : header;
    const requestId = value?.trim();

    if (requestId && requestId.length <= MAX_REQUEST_ID_LENGTH) {
      return requestId;
    }

    return randomUUID();
  }
}
