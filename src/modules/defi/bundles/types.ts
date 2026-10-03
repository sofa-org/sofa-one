export const MAX_CAPABILITY_GRANTS = 100;

/** Static, versioned membership only; never a family selector or grant. */
export type DefiCapabilityBundle = Readonly<{
  bundleId: string;
  version: string;
  label: string;
  chainIds: readonly number[];
  capabilityIds: readonly string[];
  fingerprint: string;
  warnings: readonly string[];
  limitations: readonly string[];
}>;

export type DefiCapabilityBundleMetadata = DefiCapabilityBundle & Readonly<{
  available: boolean;
  unavailableCapabilityIds: readonly string[];
}>;

export type DefiCapabilityBundlesResponse = Readonly<{
  schemaVersion: 1;
  maxGrants: typeof MAX_CAPABILITY_GRANTS;
  currentCatalogManifestHash: string;
  bundles: readonly DefiCapabilityBundleMetadata[];
}>;
