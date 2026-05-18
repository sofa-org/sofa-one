import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function createHost(exceptionRequest: Record<string, unknown> = {}) {
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const request = {
    method: 'GET',
    url: '/v1/example',
    requestId: 'req-123',
    ...exceptionRequest,
  };

  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as any,
    response,
  };
}

describe('HttpExceptionFilter', () => {
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  it('includes requestId in error responses', () => {
    const { host, response } = createHost();
    const filter = new HttpExceptionFilter();

    filter.catch(new NotFoundException('Missing'), host);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: 'Missing',
        requestId: 'req-123',
        path: '/v1/example',
      }),
    );
  });

  it('formats validation errors with a stable message, code, and details', () => {
    const { host, response } = createHost({ url: '/v1/wallets/sign' });
    const filter = new HttpExceptionFilter();

    filter.catch(
      new BadRequestException({
        message: ['chainId must be an integer', 'message must be a string'],
        error: 'Bad Request',
      }),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: ['chainId must be an integer', 'message must be a string'],
        requestId: 'req-123',
        path: '/v1/wallets/sign',
      }),
    );
  });

  it('logs server errors with requestId context', () => {
    const { host } = createHost();
    const filter = new HttpExceptionFilter();

    filter.catch(new InternalServerErrorException('Boom'), host);

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'HTTP request failed',
        requestId: 'req-123',
        method: 'GET',
        path: '/v1/example',
        statusCode: 500,
      }),
      expect.any(String),
    );
  });
});
