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

  it('trims an inbound X-Request-Id before storing and returning it', () => {
    const request = { headers: { 'x-request-id': '  req-trimmed  ' } } as any;
    const response = { setHeader: jest.fn() } as any;
    const next = jest.fn();

    middleware.use(request, response, next);

    expect(request.requestId).toBe('req-trimmed');
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', 'req-trimmed');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses the first value when X-Request-Id is received as an array header', () => {
    const request = {
      headers: { 'x-request-id': ['req-first', 'req-second'] },
    } as any;
    const response = { setHeader: jest.fn() } as any;
    const next = jest.fn();

    middleware.use(request, response, next);

    expect(request.requestId).toBe('req-first');
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', 'req-first');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('generates a new request id when the inbound header is blank', () => {
    const request = { headers: { 'x-request-id': '   ' } } as any;
    const response = { setHeader: jest.fn() } as any;
    const next = jest.fn();

    middleware.use(request, response, next);

    expect(request.requestId).toEqual(expect.any(String));
    expect(request.requestId).not.toHaveLength(0);
    expect(request.requestId).not.toBe('');
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', request.requestId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('generates a new request id when the inbound header is too long', () => {
    const tooLongRequestId = 'r'.repeat(129);
    const request = { headers: { 'x-request-id': tooLongRequestId } } as any;
    const response = { setHeader: jest.fn() } as any;
    const next = jest.fn();

    middleware.use(request, response, next);

    expect(request.requestId).toEqual(expect.any(String));
    expect(request.requestId).not.toBe(tooLongRequestId);
    expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', request.requestId);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
