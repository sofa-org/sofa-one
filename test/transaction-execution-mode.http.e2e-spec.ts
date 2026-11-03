/** HTTP DTO regression only: real route/validation, no database, provider, or auth network. */
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { ApiKeyAuthGuard } from '../src/common/guards/api-key-auth.guard';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { TransactionsController } from '../src/modules/transactions/transactions.controller';
import { TransactionsService } from '../src/modules/transactions/transactions.service';

jest.mock('../src/core/openfort/openfort.service', () => ({ OpenfortService: class OpenfortService {} }));

const USER_ID = 'execution-mode-http-user';
const API_KEY = { id: 'execution-mode-http-key', canSendTransaction: true, canUseEoaExecution: true };

function payload() {
  return {
    chainId: 84532,
    idempotencyKey: 'execution-mode-http-request',
    interactions: [{ to: '0x2222222222222222222222222222222222222222', data: '0x', value: '0' }],
  };
}

describe('transaction execution mode HTTP contract (no database)', () => {
  let app: INestApplication;
  const send = jest.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [{ provide: TransactionsService, useValue: { send } }],
    })
      .overrideGuard(ApiKeyAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          req.user = { id: USER_ID };
          req.apiKeyRecord = API_KEY;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  beforeEach(() => send.mockClear());
  afterAll(async () => { await app?.close(); });

  it.each(['eoa', 'legacy', 'EOA', null, 0, { mode: 'session_key' }])(
    'rejects unsupported executionMode=%j before service dispatch',
    async (executionMode) => {
      const res = await request(app.getHttpServer())
        .post('/v1/transactions')
        .send({ ...payload(), executionMode })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details).toEqual(expect.arrayContaining([expect.stringContaining('executionMode')]));
      expect(send).not.toHaveBeenCalled();
    },
  );
});
