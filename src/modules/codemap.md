# Code Map for /src/modules

## Responsibility
Feature-module container for auth, API keys, wallets, transactions, security events, and health checks.

## Design/Patterns
- Standard NestJS module boundary per domain area.
- Controllers delegate to services; services depend on core infrastructure.

## Flow
- Requests route into feature controllers by URL prefix.
- Services execute domain logic and persistence/Openfort calls; wallet withdrawal policy is isolated in a dedicated service before Openfort submission.
- Cross-cutting security telemetry uses `security-events` instead of ad-hoc event writes in controllers; public API modules import it so API-key auth can record suspicious-use and freeze events.

## Integration
- Imported by `AppModule`.
- Shares core services and common guards/decorators.
