# Contributing

## 1. Development principles

- Keep changes small and responsibility-focused.
- Prefer explicit validation over implicit assumptions.
- Do not add speculative abstractions or future-only features.
- Preserve the access-control split between public API-key routes and dashboard frontend routes.
- Keep private-key and API-key handling rules non-negotiable.

## 2. Before coding

- Read `codemap.md` before deep work.
- For a touched subtree, read that subtree's `codemap.md`.
- Check `REQUIREMENTS.md`, `ARCHITECTURE.md`, and `SECURITY.md` for relevant invariants.

## 3. Backend guidelines

- Keep feature ownership inside the appropriate NestJS module.
- Do not fold `TransactionsModule` into `WalletModule`.
- Use DTOs and class-validator decorators for request validation.
- Preserve global validation behavior: unknown fields should be 400s.
- Do not expose frontend-only routes in `openapi.yaml`.
- Keep public status responses safe.

## 4. Frontend guidelines

- Use existing API helpers in `frontend/src/lib/api.ts`.
- Use Openfort IAM/bearer flows for dashboard routes.
- Use API-key calls only in public API examples or explicit API-client contexts.
- Do not expose backend secrets through frontend environment variables.

## 5. Database guidelines

- Update `prisma/schema.prisma` as the source of truth.
- Run Prisma generation after schema changes.
- Use migrations for persistent schema changes.
- Preserve audit snapshots for mutable related metadata.

## 6. Documentation rules

Update docs in the same change when behavior changes:

- API/auth boundary change → `API.md`, `ARCHITECTURE.md`, `SECURITY.md`, maybe `openapi.yaml`.
- New env var/deploy requirement → `DEPLOYMENT.md`, `.env.example`, maybe `RUNBOOK.md`.
- Schema change → `DATABASE.md`, `ARCHITECTURE.md`.
- Product scope change → `REQUIREMENTS.md`.

## 7. Verification

Run the narrowest useful checks first, then broader checks when appropriate:

```bash
npm run test
npm run build
npm run lint
```

Frontend checks:

```bash
cd frontend
npm run build
npm run lint
```

E2E tests require reachable database/Redis services:

```bash
npm run test:e2e
```
