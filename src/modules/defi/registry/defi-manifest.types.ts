import type { DefiCatalog, DefiFunctionPolicy } from '../defi.types';

export type ReviewedManifest = Readonly<{
  chains: DefiCatalog;
  capabilities: readonly DefiFunctionPolicy[];
  manifestHash: `0x${string}`;
}>;

export type DefiRegistryFragment = Readonly<{ chains: DefiCatalog }>;
