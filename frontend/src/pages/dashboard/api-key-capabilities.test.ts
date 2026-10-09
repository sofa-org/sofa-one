import { describe, expect, it } from 'vitest';
import type { ApiKeyRecord, DefiCapability } from '@/lib/api';
import {
  applyCapabilityUpdate,
  capabilityFieldsForMode,
  capabilityUpdateForMode,
  getCapabilityTechnicalLabel,
  previewForCapabilityModeChange,
} from './api-key-capabilities';

const key: ApiKeyRecord = {
  id: 'key-1', displayPrefix: 'sk_test', name: 'backend', revoked: false, frozenAt: null,
  frozenReason: null, expiresAt: null, createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null,
  lastUsedIp: null, lastUsedUserAgent: null,
  permissions: { canSign: true, canSendTransaction: true, canReadTransactionStatus: false, canUseEoaExecution: true },
  capabilityMode: 'custom', allowedCapabilityIds: [], dailySpendLimit: null, monthlySpendLimit: null,
};

describe('API-key capability modes', () => {
  it('creates keys with dynamic all access without materializing catalog IDs', () => {
    expect(capabilityFieldsForMode('all', ['ignored'])).toEqual({ capabilityMode: 'all' });
  });

  it('supports custom selections including an explicit empty deny-all selection', () => {
    expect(capabilityFieldsForMode('custom', [])).toEqual({ capabilityMode: 'custom', allowedCapabilityIds: [] });
    expect(capabilityUpdateForMode('custom', ['chain:fn'])).toEqual({ capabilityMode: 'custom', allowedCapabilityIds: ['chain:fn'] });
  });

  it('resets a key to all mode and keeps endpoint permissions unchanged', () => {
    const updated = applyCapabilityUpdate(key, { id: key.id, capabilityMode: 'all', allowedCapabilityIds: [] });
    expect(capabilityUpdateForMode('all', [])).toEqual({ capabilityMode: 'all' });
    expect(updated.capabilityMode).toBe('all');
    expect(updated.allowedCapabilityIds).toEqual([]);
    expect(updated.permissions).toEqual(key.permissions);
  });

  it('clears bundle previews when changing mode but retains them for the same mode', () => {
    const preview = { bundleId: 'bundle' };
    expect(previewForCapabilityModeChange(preview, 'custom', 'all')).toBeNull();
    expect(previewForCapabilityModeChange(preview, 'custom', 'custom')).toBe(preview);
  });

  it('labels contractless typed-data capabilities accurately', () => {
    const typedData: Pick<DefiCapability, 'type' | 'functionSignature'> = { type: 'typed_data_sign' };
    const contractCall: Pick<DefiCapability, 'type' | 'functionSignature'> = { type: 'contract_call' };
    expect(getCapabilityTechnicalLabel(typedData)).toBe('Typed-data signing');
    expect(getCapabilityTechnicalLabel(contractCall)).toBe('Contract call');
    expect(getCapabilityTechnicalLabel({ ...contractCall, functionSignature: 'deposit(uint256)' })).toBe('deposit(uint256)');
  });
});
