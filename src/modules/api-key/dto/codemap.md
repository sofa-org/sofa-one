# Code Map for /src/modules/api-key/dto

## Responsibility
Validated input shape for API-key creation.

## Design/Patterns
- NestJS DTO with class-validator rules.

## Flow
- Request body is transformed into `CreateApiKeyDto` and validated before reaching the service.

## Integration
- Used by `ApiKeyController` create endpoint.
