import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import * as express from 'express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  // NOTE: trust proxy 1 assumes exactly one trusted reverse proxy (nginx/ALB) sits in front.
  // Adjust the count if your deployment topology differs — incorrect values allow IP spoofing.
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"] },
      },
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
    : [];
  if (process.env.NODE_ENV === 'production' && !allowedOrigins.length) {
    throw new Error('CORS_ORIGIN must be set in production');
  }
  app.enableCors({
    origin: allowedOrigins.length
      ? allowedOrigins
      : ['http://localhost:3000', 'http://localhost:3100'],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const port = process.env.PORT || 3001;
  await app.listen(port);
  logger.log(`SOFA ONE API running on port ${port}`);
}

bootstrap();
