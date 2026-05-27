# Code Map for /src/modules

## Responsibility
Feature-module container for auth, API keys, wallets, transactions, EOA execution policy, security events, and health checks.

## Design/Patterns
- Standard NestJS module boundary per domain area.
- Controllers delegate to services; services depend on core infrastructure.

## Flow
- Requests route into feature controllers by URL prefix.
- Services execute domain logic and persistence/Openfort calls; wallet withdrawal policy and transaction calldata/approval/fanout policy are isolated in dedicated services before Openfort submission.
- EOA execution policy is isolated in its own module and imported by wallet/transaction modules before any backend EOA signing or sending path proceeds.
- Cross-cutting security telemetry uses `security-events` instead of ad-hoc event writes in controllers; API-key lifecycle, public API auth, transaction-policy denies, and withdrawal policy/high-value/address lifecycle events are recorded there.

## Integration
- Imported by `AppModule`.
- Shares core services and common guards/decorators.
