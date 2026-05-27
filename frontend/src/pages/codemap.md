# Public Pages

## Responsibility
Implements the public landing and Openfort auth pages.

## Design/Patterns
- Mostly presentational components with static copy and branding
- Router links for in-app navigation
- Embedded Openfort email OTP sign-in with custom styling

## Flow
- `Landing.tsx` promotes the product and links to sign-up/external docs
- `SignIn.tsx` renders Openfort email OTP flow and redirects to `/dashboard`
- Public pages share the same visual language and responsive split-layout auth shell

## Integration
- Depends on React Router and Openfort React components
- Routed from `App.tsx` as `/`, `/sign-in/*`, and `/sign-up/*`
