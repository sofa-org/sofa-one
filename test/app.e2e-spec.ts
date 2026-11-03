import { Test, TestingModule } from '@nestjs/testing';
import { Body, Controller, INestApplication, Post, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { IsString } from 'class-validator';

jest.mock('../src/core/openfort/openfort.service', () => ({
  OpenfortService: jest.fn().mockImplementation(() => ({})),
}));

import { AppModule } from '../src/app.module';

class ValidationProbeDto {
  @IsString()
  name: string;
}

@Controller('test/validation')
class ValidationProbeController {
  @Post('probe')
  validate(@Body() body: ValidationProbeDto) {
    return body;
  }
}

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ValidationProbeController],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('dashboard deposits uses only the unversioned IAM-protected GET route', async () => {
    await request(app.getHttpServer()).get('/wallets/deposits').expect(401);
    await request(app.getHttpServer()).get('/wallets/deposit-info').expect(404);
    await request(app.getHttpServer()).post('/wallets/deposits').expect(404);
  });

  it('removes the /auth/social alias and keeps /auth/session IAM-protected', async () => {
    await request(app.getHttpServer()).post('/auth/social').expect(404);
    await request(app.getHttpServer()).post('/auth/session').expect(401);
  });

  it('rejects unknown request fields like the production bootstrap', async () => {
    const res = await request(app.getHttpServer())
      .post('/test/validation/probe')
      .send({ name: 'alice', unexpected: 'value' })
      .expect(400);

    expect(res.body.message).toContain('property unexpected should not exist');
  });
});
