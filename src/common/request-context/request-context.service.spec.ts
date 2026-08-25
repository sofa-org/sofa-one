import { RequestContextService } from './request-context.service';

describe('RequestContextService', () => {
  let service: RequestContextService;

  beforeEach(() => {
    service = new RequestContextService();
  });

  it('exposes requestId inside run callback', () => {
    const result = service.run({ requestId: 'req-1' }, () => service.getRequestId());

    expect(result).toBe('req-1');
  });

  it('preserves async context across an awaited Promise', async () => {
    await service.run({ requestId: 'req-2' }, async () => {
      await Promise.resolve();

      expect(service.getRequestId()).toBe('req-2');
    });
  });

  it('merges requestId with extra fields when context is active', () => {
    const logContext = service.run({ requestId: 'req-3' }, () =>
      service.getLogContext({ userId: 'user-1', operation: 'sign' }),
    );

    expect(logContext).toEqual({
      requestId: 'req-3',
      userId: 'user-1',
      operation: 'sign',
    });
  });

  it('returns only extra fields outside a request context', () => {
    expect(service.getLogContext({ userId: 'user-2' })).toEqual({ userId: 'user-2' });
  });
});
