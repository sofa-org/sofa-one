# Code Map for /src/core/database

## Responsibility
Prisma-based persistence service and database connection lifecycle management.

## Design/Patterns
- Injectable service extending `PrismaClient`.
- Nest lifecycle hooks for connect/disconnect.

## Flow
- Connects on module init, disconnects on shutdown.
- Exposes generated Prisma methods to callers.

## Integration
- Used by feature services for all database reads/writes.
- Depends on `@prisma/client`.
