# Code Map for /src/common/decorators

## Responsibility
Route and parameter decorators for auth-related controller behavior.

## Design/Patterns
- NestJS decorator + metadata pattern.
- Thin helpers: no business logic, only request extraction/route flags.

## Flow
- `CurrentUser` reads `request.user` and optional property access.
- `Public` and `FrontendOnly` stamp route metadata for guards.

## Integration
- Used by controllers and inspected by guards via `Reflector`.
