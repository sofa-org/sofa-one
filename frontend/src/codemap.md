# Application Core

## Responsibility
Bootstraps the SPA and defines the top-level routing/authentication shell.

## Design/Patterns
- Provider composition in `main.tsx` for `BrowserRouter` + `OpenfortProvider`
- Declarative route tree with a nested dashboard layout
- Auth redirects for signed-in users and guarded dashboard access

## Flow
- `main.tsx` validates `VITE_OPENFORT_PUBLISHABLE_KEY` before rendering
- `App.tsx` routes `/`, `/sign-in/*`, `/sign-up/*`, and `/dashboard/*`
- Signed-in users are redirected from `/` to `/dashboard`
- `ProtectedRoute` blocks dashboard access until Openfort auth is loaded and signed in

## Integration
- Depends on Openfort React and React Router
- Uses shared components and page modules for route targets
- Global styling comes from `index.css`
