# Code Map for /src/config

## Responsibility
Environment-backed application configuration and validation.

## Design/Patterns
- Config factory for `ConfigModule`.
- Class-validator schema for runtime env validation.

## Flow
- Reads `process.env`, applies defaults, and exposes nested config keys.
- Validates required secrets/URLs before app startup.
- Validates optional outbound webhook URLs such as security-event SIEM export as HTTPS before app startup.

## Integration
- Consumed by `AppModule` through `ConfigModule.forRoot()`.
- Accessed by guards and services through `ConfigService`.
