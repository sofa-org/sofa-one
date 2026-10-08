import { describe, expect, it } from 'vitest';
import type { DefiCapability, DefiCapabilityBundle } from '@/lib/api';
import { createBundlePreview, getBundlePreviewDiff, validateBundlePreview } from './capability-bundle-preview';

const bundle = (overrides: Partial<DefiCapabilityBundle> = {}): DefiCapabilityBundle => ({
  bundleId: 'sample', version: '1.0.0', label: 'Sample', chainIds: [8453], capabilityIds: ['active-a', 'active-b'],
  fingerprint: 'sha256:one', warnings: [], limitations: [], available: true, unavailableCapabilityIds: [], ...overrides,
});
const capability = (capabilityId: string, status: DefiCapability['status'] = 'active'): DefiCapability => ({
  capabilityId, type: 'contract_call', chainId: 8453, contract: '0x0000000000000000000000000000000000000001',
  label: capabilityId, description: '', status, policy: { ref: 'test', version: 1 },
});
const catalog = [capability('active-a'), capability('active-b')];

describe('capability bundle preview logic', () => {
  it('adds as an exact union and retains unknown or paused existing IDs', () => {
    const preview = createBundlePreview('add', 'create', ['unknown', 'paused'], bundle());
    expect(preview.ids).toEqual(['unknown', 'paused', 'active-a', 'active-b']);
    expect(validateBundlePreview(preview, 'create', ['unknown', 'paused'], [bundle()], catalog)).toBeNull();
  });

  it('reports exact replacement removals, including unknown IDs and overlap', () => {
    const preview = createBundlePreview('replace', 'key:k1', ['active-a', 'old-paused', 'unknown'], bundle());
    expect(getBundlePreviewDiff(preview)).toEqual({ added: ['active-b'], removed: ['old-paused', 'unknown'], unchanged: ['active-a'] });
    const same = createBundlePreview('replace', 'key:k1', ['active-a', 'active-b'], bundle());
    expect(getBundlePreviewDiff(same).removed).toEqual([]);
  });

  it('allows more than 100 grants without truncation', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const fullBundle = bundle({ capabilityIds: ids, fingerprint: 'sha256:full' });
    const caps = ids.map((id) => capability(id));
    const preview = createBundlePreview('replace', 'create', [], fullBundle);
    expect(preview.ids).toHaveLength(101);
    expect(validateBundlePreview(preview, 'create', [], [fullBundle], caps)).toBeNull();
  });

  it('rejects changed targets, baselines, versions, fingerprints, availability, and inactive members', () => {
    const original = bundle();
    const preview = createBundlePreview('add', 'key:k1', ['existing'], original);
    expect(validateBundlePreview(preview, 'key:k2', ['existing'], [original], catalog)).toMatch(/different key form/);
    expect(validateBundlePreview(preview, 'key:k1', ['changed'], [original], catalog)).toMatch(/selection changed/);
    expect(validateBundlePreview(preview, 'key:k1', ['existing'], [bundle({ version: '2.0.0' })], catalog)).toMatch(/changed or is no longer available/);
    expect(validateBundlePreview(preview, 'key:k1', ['existing'], [bundle({ fingerprint: 'sha256:two' })], catalog)).toMatch(/changed or is no longer available/);
    expect(validateBundlePreview(preview, 'key:k1', ['existing'], [bundle({ available: false })], catalog)).toMatch(/unavailable/);
    expect(validateBundlePreview(preview, 'key:k1', ['existing'], [original], [capability('active-a'), capability('active-b', 'paused')])).toMatch(/missing or unavailable/);
  });

  it('rejects applying a custom bundle while all-capabilities mode is active', () => {
    const original = bundle();
    const preview = createBundlePreview('add', 'create', [], original);
    expect(validateBundlePreview(preview, 'create', [], [original], catalog, 'all')).toMatch(/only available for custom/);
  });

  it('keeps same bundle IDs at different versions distinct and never adds approvals implicitly', () => {
    const one = bundle({ capabilityIds: ['active-a'], fingerprint: 'sha256:v1' });
    const two = bundle({ version: '2.0.0', capabilityIds: ['active-b'], fingerprint: 'sha256:v2' });
    const preview = createBundlePreview('add', 'create', [], two);
    expect(validateBundlePreview(preview, 'create', [], [one, two], catalog)).toBeNull();
    expect(preview.ids).toEqual(['active-b']);
    expect(preview.ids).not.toContain('approve-anything');
  });
});
