import { HttpException } from '@nestjs/common';
import type { AbiFunction } from 'viem';
import type { Prisma } from '@prisma/client';

export type DefiExecutionContext = {
  userId: string; apiKeyId: string; apiKeyPrefix?: string; walletId: string;
  chainId: number; executionMode: string; executionOwner: string;
  allowedCapabilityIds: string[];
};
export type DefiMatch = {
  capabilityId: string; type: 'contract_call' | 'typed_data_sign'; chainId: number;
  contract: string; functionSignature?: string; policy: { ref: string; version: number };
  status?: 'active' | 'inactive';
};
export type DefiFunctionPolicy = DefiMatch & {
  functionName: string;
  signature: string;
  abi: AbiFunction;
  validate(args: readonly unknown[], context: DefiExecutionContext): boolean;
};
export type DefiContractPolicy = { address: string; status: 'active' | 'inactive'; functions: readonly DefiFunctionPolicy[] };
export type DefiChainPolicy = { chainId: number; status: 'active' | 'inactive'; contracts: readonly DefiContractPolicy[] };
export type DefiCatalog = readonly DefiChainPolicy[];
export type DefiAuthorization = { context: DefiExecutionContext; requiredPermission: 'canSendTransaction' | 'canSign'; matches: readonly DefiMatch[] };
export type DefiDeniedAudit = { context?: DefiExecutionContext; code: string; capabilityId?: string; type?: DefiMatch['type']; chainId?: number; contract?: string; functionSignature?: string; functionSelector?: string; policy?: DefiMatch['policy'] };
export class DefiPolicyDenial extends Error {
  constructor(readonly httpException: HttpException, readonly audit: DefiDeniedAudit) { super('DeFi policy denied'); }
}
export type DefiInteraction = { to: string; data: string; value?: string | number | bigint };
export type DefiDbClient = Prisma.TransactionClient;

export type DefiPauseScope =
  | { kind: 'global' }
  | { kind: 'chain'; chainId: number }
  | { kind: 'contract'; chainId: number; address: string }
  | { kind: 'capability'; capabilityId: string };
export type DefiPauseOperator = { operatorId: string; reason: string; reference: string };

export function defiPauseScopeKey(scope: DefiPauseScope): string {
  if (scope.kind === 'global') return 'global';
  if (scope.kind === 'chain') {
    if (!Number.isSafeInteger(scope.chainId) || scope.chainId <= 0) throw new TypeError('Invalid DeFi pause scope');
    return `chain:${scope.chainId}`;
  }
  if (scope.kind === 'contract') {
    if (!Number.isSafeInteger(scope.chainId) || scope.chainId <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(scope.address)) throw new TypeError('Invalid DeFi pause scope');
    return `contract:${scope.chainId}:${scope.address.toLowerCase()}`;
  }
  if (!/^[A-Za-z0-9:._-]{1,160}$/.test(scope.capabilityId)) throw new TypeError('Invalid DeFi pause scope');
  return `capability:${scope.capabilityId}`;
}

export function defiPauseScopeKeysForCapability(fn: DefiFunctionPolicy): string[] {
  return [
    defiPauseScopeKey({ kind: 'global' }),
    defiPauseScopeKey({ kind: 'chain', chainId: fn.chainId }),
    defiPauseScopeKey({ kind: 'contract', chainId: fn.chainId, address: fn.contract }),
    defiPauseScopeKey({ kind: 'capability', capabilityId: fn.capabilityId }),
  ];
}
