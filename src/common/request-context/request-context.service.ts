import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

type RequestContext = {
  requestId: string;
};

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run<T>(context: RequestContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  getRequestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  getLogContext(extra: Record<string, unknown> = {}) {
    const requestId = this.getRequestId();
    return requestId ? { requestId, ...extra } : extra;
  }
}
