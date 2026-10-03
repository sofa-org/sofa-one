import { HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AbiFunction } from 'viem';

export type DefiExecutionContext = Readonly<{
  userId: string;
  apiKeyId: string;
  apiKeyPrefix?: string;
  walletId: string;
  chainId: number;
  executionMode: string;
  executionOwner: string;
  allowedCapabilityIds: readonly string[];
}>;

export type DefiProvenance = Readonly<{
  sourceRef: string;
  verifiedAt: string;
  status: 'verified' | 'candidate';
}>;

/** Function-level authority: identity + fixed ABI + provenance, never runtime validators. */
export type DefiFunctionPolicy = Readonly<{
  capabilityId: string;
  type: 'contract_call' | 'typed_data_sign';
  chainId: number;
  contract: string;
  functionName: string;
  signature: string;
  abi: AbiFunction;
  abiHash?: `0x${string}`;
  status: 'active' | 'inactive';
  provenance: DefiProvenance;
  policy?: Readonly<{ ref: string; version: number }>;
  label?: string;
  description?: string;
  protocol?: string;
  operation?: string;
  warnings?: readonly string[];
  inactiveReason?: string;
}>;

export type DefiMatch = Readonly<{
  capabilityId: string;
  type: 'contract_call' | 'typed_data_sign';
  chainId: number;
  contract: string;
  functionSignature: string;
  abiHash: `0x${string}`;
  policy?: Readonly<{ ref: string; version: number }>;
}>;

export type DefiContractPolicy = Readonly<{ address: string; status: 'active' | 'inactive'; functions: readonly DefiFunctionPolicy[] }>;
export type DefiChainPolicy = Readonly<{ chainId: number; status: 'active' | 'inactive'; contracts: readonly DefiContractPolicy[] }>;
export type DefiCatalog = readonly DefiChainPolicy[];

export type DefiInteraction = Readonly<{ to: string; data: string; value?: string | number | bigint }>;
export type DefiAuthorization = Readonly<{
  context: DefiExecutionContext;
  requiredPermission: 'canSendTransaction';
  matches: readonly DefiMatch[];
  interactions: readonly DefiInteraction[];
  manifestHash: `0x${string}`;
  requestCommitment: `0x${string}`;
}>;

export type DefiDeniedAudit = Readonly<{
  context?: DefiExecutionContext;
  code: string;
  capabilityId?: string;
  type?: DefiMatch['type'];
  chainId?: number;
  contract?: string;
  functionSignature?: string;
  functionSelector?: string;
  abiHash?: `0x${string}`;
  policy?: DefiMatch['policy'];
}>;
export class DefiPolicyDenial extends Error {
  constructor(readonly httpException: HttpException, readonly audit: DefiDeniedAudit) { super('DeFi policy denied'); }
}

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

export function defiPauseScopeKeysForCapability(fn: Pick<DefiFunctionPolicy, 'chainId' | 'contract' | 'capabilityId'>): string[] {
  return [
    defiPauseScopeKey({ kind: 'global' }),
    defiPauseScopeKey({ kind: 'chain', chainId: fn.chainId }),
    defiPauseScopeKey({ kind: 'contract', chainId: fn.chainId, address: fn.contract }),
    defiPauseScopeKey({ kind: 'capability', capabilityId: fn.capabilityId }),
  ];
}
