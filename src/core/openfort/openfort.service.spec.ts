import { BadGatewayException, Logger } from '@nestjs/common';

const backendCreate = jest.fn();

jest.mock('@openfort/openfort-node', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    accounts: {
      evm: {
        backend: {
          create: backendCreate,
          get: jest.fn(),
          sendTransaction: jest.fn(),
          sign: jest.fn(),
        },
      },
    },
  })),
}));

import { OpenfortService } from './openfort.service';
import { RequestContextService } from '../../common/request-context/request-context.service';

describe('OpenfortService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fails Openfort calls that exceed the configured timeout', async () => {
    backendCreate.mockReturnValue(new Promise(() => undefined));
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const service = new OpenfortService(configService as any);

    const promise = service.createBackendWallet();
    jest.advanceTimersByTime(25);

    await expect(promise).rejects.toThrow(BadGatewayException);
  });

  it('logs Openfort failures with requestId and operation context', async () => {
    const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    backendCreate.mockReturnValue(new Promise(() => undefined));
    const configService = {
      getOrThrow: jest.fn(() => 'secret'),
      get: jest.fn(() => 25),
    };
    const requestContext = new RequestContextService();
    const service = new OpenfortService(configService as any, requestContext);

    await requestContext.run({ requestId: 'req-openfort' }, async () => {
      const promise = service.createBackendWallet();
      jest.advanceTimersByTime(25);

      await expect(promise).rejects.toThrow(BadGatewayException);
    });

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Openfort operation failed',
        requestId: 'req-openfort',
        operation: 'createBackendWallet',
      }),
      expect.any(String),
    );

    loggerErrorSpy.mockRestore();
  });
});
