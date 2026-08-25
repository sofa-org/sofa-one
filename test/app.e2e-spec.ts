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

  it('/v1/wallets/deposit-info (POST) should require API key', () => {
    return request(app.getHttpServer()).post('/v1/wallets/deposit-info').expect(401);
  });

  it('/auth/social (POST) should require authorization', () => {
    return request(app.getHttpServer()).post('/auth/social').expect(401);
  });

  it('rejects unknown request fields like the production bootstrap', async () => {
    const res = await request(app.getHttpServer())
      .post('/test/validation/probe')
      .send({ name: 'alice', unexpected: 'value' })
      .expect(400);

    expect(res.body.message).toContain('property unexpected should not exist');
  });
});
