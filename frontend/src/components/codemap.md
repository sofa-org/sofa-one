# Shared Components

## Responsibility
Holds reusable auth-gating UI used across the app.

## Design/Patterns
- Wrapper component pattern for route protection
- Conditional rendering for loading, redirect, and success states

## Flow
- Reads Openfort auth state with `useOpenfort`
- Shows a centered spinner while auth status loads
- Redirects unauthenticated users to `/sign-in`
- Renders nested content only when signed in

## Integration
- Depends on Openfort React and React Router
- Consumed by `App.tsx` around dashboard routes
