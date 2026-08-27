# Code Map for /src/core/database

## Responsibility
Central persistence layer for the SOFA ONE backend. Owns the single Prisma client instance and its database connection lifecycle, exposing generated Prisma data-access methods to every feature module. No business logic lives here — it is a thin infrastructure wrapper around `@prisma/client`.

## Files

### prisma.service.ts
- **Symbols**: `PrismaService` (class, `@Injectable`, `extends PrismaClient`, implements `OnModuleInit`, `OnModuleDestroy`).
- **Responsibility**: Instantiate and manage the Prisma client bound to Postgres via the `@prisma/adapter-pg` driver adapter.
- **Constructor**: `super({ adapter: new PrismaPg(process.env.DATABASE_URL!) })` — reads `DATABASE_URL` directly from the environment (non-null asserted; validated upstream by `src/config/env.validation.ts`).
- **Inputs**: `process.env.DATABASE_URL` (Postgres connection string).
- **Outputs**: Full generated Prisma client API (models, queries, transactions) inherited from `PrismaClient`; lifecycle hooks `$connect`/`$disconnect`.
- **Lifecycle**: `onModuleInit()` → `await this.$connect()`; `onModuleDestroy()` → `await this.$disconnect()`.
- **Dependencies**: `@nestjs/common` (`Injectable`, `OnModuleInit`, `OnModuleDestroy`), `@prisma/client` (`PrismaClient`), `@prisma/adapter-pg` (`PrismaPg`).

### prisma.module.ts
- **Symbols**: `PrismaModule` (class, `@Global()`, `@Module`).
- **Responsibility**: Declare and export `PrismaService` as a global provider.
- **Providers**: `[PrismaService]`; **Exports**: `[PrismaService]`.
- **Dependencies**: `@nestjs/common` (`Global`, `Module`), `./prisma.service` (`PrismaService`).

## Design/Patterns
- **Global module**: `@Global()` makes `PrismaService` injectable anywhere without re-importing `PrismaModule` in each feature module.
- **Inheritance over composition**: `PrismaService extends PrismaClient`, so all generated model/query/transaction methods are exposed directly on the injected service.
- **Driver adapter**: Uses `@prisma/adapter-pg` (Prisma driver adapter) rather than the default engine connection, keeping the client decoupled from a hardcoded connection URL at module definition time.
- **Lifecycle hooks**: Nest `OnModuleInit`/`OnModuleDestroy` drive connect/disconnect so the pool is opened on boot and closed cleanly on shutdown.
- **Single shared instance**: One client is shared app-wide (no per-request clients), enabling transaction reuse via `Prisma.TransactionClient`.

## Flow
1. Nest bootstraps `AppModule`, which imports `PrismaModule` (see `src/app.module.ts`).
2. `PrismaService` is constructed with the `PrismaPg` adapter bound to `DATABASE_URL`.
3. On module init, `onModuleInit()` calls `$connect()` to open the connection pool.
4. Feature services inject `PrismaService` and call generated methods (e.g. `prisma.user.findUnique`, `prisma.$transaction`) for all DB reads/writes.
5. On shutdown, `onModuleDestroy()` calls `$disconnect()` to close the pool.

## Integration
- **Imported by**: `src/app.module.ts` (root module, `imports: [PrismaModule]`).
- **Consumed by** (inject `PrismaService`): `auth`, `api-key`, `wallet` (incl. `withdrawal-policy`), `transactions` (incl. `transaction-policy`), `session-key`, `eoa-execution`, `mfa`, `step-up`, `security-events`, `security-notifications`, `billing` (incl. `stripe`, `onchain/usdc-payment`, `billing-reconciliation`, `billing-entitlement`), `health`, and guards `api-key-auth`, `openfort-user`, `either-auth`.
- **Transaction reuse**: `wallet.service.ts` and `withdrawal-policy.service.ts` accept `PrismaService | Prisma.TransactionClient` so the same client participates in `$transaction` scopes.
- **Health**: `health.service.ts` uses `PrismaService` for DB liveness checks.
- **Tests**: Widely mocked via `{ provide: PrismaService, useValue: ... }` across `*.spec.ts` files.
- **Schema coupling**: Data model defined in `prisma/schema.prisma`; regenerate client via `npm run prisma:generate` after schema changes.
