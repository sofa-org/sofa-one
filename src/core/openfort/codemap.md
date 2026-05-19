# Code Map for /src/core/openfort

## Responsibility
Openfort SDK integration for backend wallet creation, embedded wallet verification, signing, and Calibur UserOperation submission.

## Design/Patterns
- Service wrapper around the Openfort client.
- Client constructed from config-provided secrets.
- Errors normalized to Nest HTTP exceptions.

## Flow
- Constructor initializes the SDK client from env-backed config.
- Methods pass wallet/account data to Openfort and return SDK or bundler results.
- Failures are logged and translated to gateway errors.

## Integration
- Consumed by auth, wallet, and transactions services.
- Depends on `@openfort/openfort-node` and `ConfigService`.
