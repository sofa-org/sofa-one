import { RequestIdMiddleware } from './request-id.middleware';
import { RequestContextService } from '../request-context/request-context.service';

describe('RequestIdMiddleware', () => {
  let context: RequestContextService;
  let middleware: RequestIdMiddleware;

  beforeEach(() => {
    context = new RequestContextService();
    middleware = new RequestIdMiddleware(context);
  });

  it('reuses an inbound X-Request-Id and exposes it in async request context', () => {
    const request = { headers: { 'x-request-id': 'req-existing' } } as any;
    const response = { setHeader: jest.fn() } as any;
    const next = jest.fn(() => {
      expect(context.getRequestId()).toBe('req-existing');
    });

    middleware.use(request, response, next);

    expect(request.requestId).toBe('req-existing');
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', 'req-existing');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('generates and returns a request id when the inbound header is absent', () => {
    const request = { headers: {} } as any;
    const response = { setHeader: jest.fn() } as any;
    const next = jest.fn();

    middleware.use(request, response, next);

    expect(request.requestId).toEqual(expect.any(String));
    expect(request.requestId).not.toHaveLength(0);
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', request.requestId);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
