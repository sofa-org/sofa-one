# Code Map for /src/core

## Responsibility
Infrastructure layer for database access and Openfort wallet operations.

## Design/Patterns
- Global NestJS modules for shared providers.
- Service wrappers around PrismaClient and Openfort SDK.

## Flow
- Prisma connects/disconnects with Nest lifecycle.
- Openfort client is configured from env values and used for wallet, signing, and transaction operations.

## Integration
- Imported by feature modules needing persistence or wallet services.
- Depends on Prisma, Openfort SDK, and ConfigService.
