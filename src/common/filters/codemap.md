# Code Map for /src/common/filters

## Responsibility
Global HTTP exception formatting and server-error logging.

## Design/Patterns
- NestJS exception filter.
- Structured response envelope with selective 5xx logging.

## Flow
- Catches thrown exceptions from request handlers.
- Derives status/message, logs 5xx cases, returns JSON with timestamp and path.

## Integration
- Installed in `main.ts`.
- Applies across all controllers and services.
