import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // adapter-pg normalizes timestamptz offsets as UTC; every pooled connection
    // must return UTC wall time, even when the server defaults to another zone.
    const connection = new URL(process.env.DATABASE_URL!);
    connection.searchParams.set('options', `${connection.searchParams.get('options') ?? ''} -c timezone=UTC`.trim());
    super({ adapter: new PrismaPg(connection.toString()) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
