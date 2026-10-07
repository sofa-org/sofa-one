import type { DefiCapability, DefiCapabilityBundle } from '@/lib/api';

export type BundlePreviewSnapshot = {
  mode: 'add' | 'replace';
  target: string;
  bundleId: string;
  version: string;
  fingerprint: string;
  membership: string[];
  baseline: string[];
  ids: string[];
};

export function createBundlePreview(
  mode: BundlePreviewSnapshot['mode'], target: string, baseline: readonly string[], bundle: DefiCapabilityBundle,
): BundlePreviewSnapshot {
  const original = [...baseline];
  return {
    mode, target, bundleId: bundle.bundleId, version: bundle.version, fingerprint: bundle.fingerprint,
    membership: [...bundle.capabilityIds], baseline: original,
    ids: mode === 'add' ? [...new Set([...original, ...bundle.capabilityIds])] : [...bundle.capabilityIds],
  };
}

export function getBundlePreviewDiff(preview: BundlePreviewSnapshot) {
  const before = new Set(preview.baseline);
  const after = new Set(preview.ids);
  return {
    added: preview.ids.filter((id) => !before.has(id)),
    removed: preview.baseline.filter((id) => !after.has(id)),
    unchanged: preview.ids.filter((id) => before.has(id)),
  };
}

export function validateBundlePreview(
  preview: BundlePreviewSnapshot, target: string, currentIds: readonly string[],
  bundles: readonly DefiCapabilityBundle[], capabilities: readonly DefiCapability[],
): string | null {
  if (preview.target !== target) return 'This preview belongs to a different key form. Reopen the preview.';
  if (JSON.stringify(currentIds) !== JSON.stringify(preview.baseline)) return 'The selection changed after this preview. Reopen it to review the current selection.';
  const bundle = bundles.find((item) => item.bundleId === preview.bundleId && item.version === preview.version);
  if (!bundle || bundle.fingerprint !== preview.fingerprint || JSON.stringify(bundle.capabilityIds) !== JSON.stringify(preview.membership)) {
    return 'This bundle changed or is no longer available. Refresh the preview before applying.';
  }
  if (!bundle.available) return 'This bundle is unavailable and cannot be applied.';
  if (!bundle.capabilityIds.every((id) => capabilities.some((item) => item.capabilityId === id && item.status === 'active'))) {
    return 'One or more bundle functions are missing or unavailable in the current catalog. Refresh the preview before applying.';
  }
  return null;
}
