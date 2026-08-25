# Code Map for /src

## Responsibility
Backend root for bootstrapping NestJS, composing global infrastructure, and wiring feature modules.

## Design/Patterns
- NestJS module composition with DI across core and feature modules.
- Centralized config loading/validation via `ConfigModule.forRoot()`.
- Cross-cutting middleware via global validation pipe, exception filter, and throttling guard.

## Flow
- `main.ts` creates the HTTP app, sets security/CORS/body limits, installs global validation/filter behavior, and starts the server.
- `app.module.ts` loads env config, registers throttling, and imports core + feature modules including `SecurityEventModule` (with rule-based risk scoring and optional SIEM export) and `SecurityNotificationModule`.

## Integration
- Entry points: `main.ts`, `app.module.ts`.
- Connects config, core services, guards/filters, and all feature modules.
