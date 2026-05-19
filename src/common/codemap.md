# Code Map for /src/common

## Responsibility
Shared NestJS building blocks used across backend modules: decorators, filters, and guards.

## Design/Patterns
- Reusable cross-cutting components grouped by concern.
- Metadata-driven route flags for auth/origin behavior.

## Flow
- Decorators set request/route metadata or extract request user data.
- Guards inspect metadata and headers to allow/deny access.
- Filter standardizes thrown exceptions into HTTP responses.

## Integration
- Imported by controllers and `main.ts`.
- Relies on NestJS core plus ConfigService, Reflector, Clerk, Prisma, and Argon2 where needed.
