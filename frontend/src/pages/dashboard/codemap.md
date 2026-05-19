# Dashboard Pages

## Responsibility
Contains the authenticated dashboard screens for wallet state, API key management, and API docs.

## Design/Patterns
- Container-style pages with local React state and effects
- Controlled forms for key creation and withdrawals
- Shared layout with nested routing via `Outlet`

## Flow
- `DashboardLayout.tsx` renders the sidebar/mobile drawer and sign-out action
- `Wallet.tsx` initializes the account, shows balances, and submits withdrawals
- `ApiKeys.tsx` lists keys, creates named keys, revokes keys, and rotates all keys
- `Docs.tsx` is static reference content for the public API

## Integration
- Depends on Clerk auth, React Router, Lucide icons, and `@/lib/api`
- Mounted by `App.tsx` under `/dashboard/*`
- Calls backend endpoints for wallet and key operations
