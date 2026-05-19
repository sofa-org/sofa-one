# Frontend Root

## Responsibility
Owns the Vite + React SPA build/runtime configuration: package scripts, dependency graph, dev server, and path aliasing.

## Design/Patterns
- Configuration-as-code via `package.json`, `vite.config.ts`, and `tsconfig.json`
- Vite + React plugin pipeline with Tailwind v4 integration
- `@/` alias for src-root imports

## Flow
- Dev server runs on port 3000 and proxies `/api` to the backend on port 3100
- `src/main.tsx` is the app entry point
- TypeScript builds in strict mode with no emit; production bundles are emitted by Vite

## Integration
- Depends on React 19, React Router 7, Clerk React, Lucide, TypeScript, Tailwind CSS
- Browser consumes the compiled SPA
- Backend API is reached through the Vite proxy in development
