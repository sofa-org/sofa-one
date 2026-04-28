import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';

type HealthResponse = {
  status: 'ok';
  timestamp: string;
};

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  live(): HealthResponse {
    return this.ok();
  }

  async ready(): Promise<HealthResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return this.ok();
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        timestamp: new Date().toISOString(),
        checks: { database: 'unavailable' },
      });
    }
  }

  private ok(): HealthResponse {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
