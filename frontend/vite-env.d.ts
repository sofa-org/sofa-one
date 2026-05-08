/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENFORT_PUBLISHABLE_KEY: string;
  readonly VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY: string;
  readonly VITE_OPENFORT_FEE_SPONSORSHIP_ID?: string;
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
