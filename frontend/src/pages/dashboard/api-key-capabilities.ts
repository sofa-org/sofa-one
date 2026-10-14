import type {
  ApiKeyCapabilityMode,
  ApiKeyRecord,
  DefiCapability,
  UpdateApiKeyCapabilitiesRequest,
  UpdateApiKeyCapabilitiesResponse,
} from '@/lib/api';

export function getCapabilityTechnicalLabel(capability: Pick<DefiCapability, 'type' | 'functionSignature'>): string {
  return capability.type === 'typed_data_sign' ? 'Typed-data signing' : capability.functionSignature || 'Contract call';
}

export function capabilityFieldsForMode(mode: ApiKeyCapabilityMode, ids: string[]) {
  return mode === 'all'
    ? { capabilityMode: 'all' as const }
    : { capabilityMode: 'custom' as const, allowedCapabilityIds: ids };
}

export function capabilityUpdateForMode(
  mode: ApiKeyCapabilityMode,
  ids: string[],
): UpdateApiKeyCapabilitiesRequest {
  return capabilityFieldsForMode(mode, ids);
}

export function applyCapabilityUpdate(
  key: ApiKeyRecord,
  update: UpdateApiKeyCapabilitiesResponse,
): ApiKeyRecord {
  return key.id === update.id
    ? { ...key, capabilityMode: update.capabilityMode, allowedCapabilityIds: update.allowedCapabilityIds }
    : key;
}

export function previewForCapabilityModeChange<T>(preview: T | null, current: ApiKeyCapabilityMode, next: ApiKeyCapabilityMode): T | null {
  return current === next ? preview : null;
}
