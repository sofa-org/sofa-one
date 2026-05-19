# Code Map for /src/modules

## Responsibility
Feature-module container for auth, API keys, wallets, transactions, and health checks.

## Design/Patterns
- Standard NestJS module boundary per domain area.
- Controllers delegate to services; services depend on core infrastructure.

## Flow
- Requests route into feature controllers by URL prefix.
- Services execute domain logic and persistence/Openfort calls.

## Integration
- Imported by `AppModule`.
- Shares core services and common guards/decorators.
