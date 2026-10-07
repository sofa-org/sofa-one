import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DefiCatalogService } from './defi-catalog.service';
import { DefiDbClient, defiPauseScopeKeysForCapability } from './defi.types';

@Injectable()
export class DefiGrantService {
  constructor(private readonly catalog: DefiCatalogService) {}
  normalizeIds(ids?: string[] | null): string[] {
    if (ids === undefined) ids = [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim() || id.length > 160) || new Set(ids).size !== ids.length) throw new BadRequestException({ code: 'DEFI_INVALID_PARAMETERS', message: 'Invalid DeFi capability grants' });
    return [...ids].sort();
  }
  async assertGrantableInTx(tx: DefiDbClient, ids?: string[] | null) {
    const normalized = this.normalizeIds(ids);
    let state;
    try {
      await tx.$queryRaw`SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE`;
      state = await tx.defiPolicyState.findUnique({ where: { id: 'global' } });
    } catch {
      throw new ServiceUnavailableException({ code: 'DEFI_POLICY_UNAVAILABLE', message: 'DeFi policy is unavailable' });
    }
    if (!state) throw new ServiceUnavailableException({ code: 'DEFI_POLICY_UNAVAILABLE', message: 'DeFi policy is unavailable' });
    const paused = new Set<string>(state.pausedScopeKeys);
    for (const id of normalized) {
      const fn = this.catalog.functionForCapability(id);
      if (!fn || fn.type !== 'contract_call' || fn.status !== 'active') throw new BadRequestException({ code: 'DEFI_CAPABILITY_NOT_FOUND', message: 'Capability is not grantable' });
      const chain = this.catalog.chains().find((item) => item.chainId === fn.chainId);
      const contract = chain?.contracts.find((item) => item.address.toLowerCase() === fn.contract.toLowerCase());
      if (!chain || chain.status !== 'active' || !contract || contract.status !== 'active') throw new BadRequestException({ code: 'DEFI_CAPABILITY_NOT_FOUND', message: 'Capability is not grantable' });
      if (defiPauseScopeKeysForCapability(fn).some((scopeKey) => paused.has(scopeKey))) throw new BadRequestException({ code: 'DEFI_CAPABILITY_PAUSED', message: 'Capability is not grantable while paused' });
    }
    return normalized;
  }
}
