# Public Pages

## Responsibility
Implements the public landing and Clerk auth pages.

## Design/Patterns
- Mostly presentational components with static copy and branding
- Router links for in-app navigation
- Embedded Clerk sign-in/sign-up widgets with custom styling

## Flow
- `Landing.tsx` promotes the product and links to sign-up/external docs
- `SignIn.tsx` and `SignUp.tsx` render Clerk flows and redirect to `/dashboard`
- Public pages share the same visual language and responsive split-layout auth shell

## Integration
- Depends on React Router and Clerk React components
- Routed from `App.tsx` as `/`, `/sign-in/*`, and `/sign-up/*`
