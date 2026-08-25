import {
  BadRequestException,
  BadGatewayException,
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

  it('sanitizes hex values from error messages', () => {
    const { host, response } = createHost();
    const filter = new HttpExceptionFilter();

    filter.catch(
      new BadGatewayException({
        code: 'USER_OPERATION_REJECTED',
        message:
          'UserOperation rejected by bundler. Reason: execution reverted at 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      }),
      host,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.not.stringContaining('0xabcdef1234567890'),
      }),
    );
  });

  it('sanitizes internal URLs from error messages', () => {
    const { host, response } = createHost();
    const filter = new HttpExceptionFilter();

    filter.catch(
      new BadGatewayException({
        code: 'WALLET_SERVICE_UNAVAILABLE',
        message: 'Connection refused to http://localhost:5432/postgres',
      }),
      host,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.not.stringContaining('localhost'),
      }),
    );
  });

  it('returns generic message for non-HttpException errors', () => {
    const { host, response } = createHost();
    const filter = new HttpExceptionFilter();

    filter.catch(new Error('Database connection failed at /usr/src/app/db.ts:42'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        message: 'Internal server error',
      }),
    );
  });
});
