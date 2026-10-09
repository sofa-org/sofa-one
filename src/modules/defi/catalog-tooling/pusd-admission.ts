import type { DefiExecutionScope, DefiFunctionPolicy } from '../defi.types';
import { executionScopeHash } from '../execution/scope';
import { POLYMARKET_PUSD_WRAP_IDENTITY, POLYMARKET_PUSD_WRAP_SCOPE, validatePolymarketPusdWrapBinding } from '../execution/pusd-identity';
import { canonicalSourceSha256 } from './catalog-generator';

export const POLYMARKET_PUSD_REVIEWED_SOURCE_PATH = 'data/defi-catalog/updates/polymarket-pusd/sources/polymarket-pusd.json';
export const POLYMARKET_PUSD_REVIEWED_SOURCE_SHA256 = '08acf3612d90a61a3ec4f22022ca063a849a0dba6fd332f1382d1d8ef90cdc81';
const SOURCE_EVIDENCE = [
  { id: 'polymarket-pusd-address-bound-source', kind: 'exact-address source+metadata response', url: 'https://sourcify.dev/server/v2/contract/137/0x93070a847efEf7F70739046A929D47a521F5B8ee?fields=sources,metadata', hashes: ['e3876528e867debfbbb196905c6d2de4d81400333e1e1a104783fdfb7c2c12f6', '98be3707c2bf77b3ad576443fe226a67bc7b9a2db716699ce77ea2463cb344af'] },
  { id: 'polymarket-pusd-contract-response', kind: 'exact-address all-fields full-match response', url: 'https://sourcify.dev/server/v2/contract/137/0x93070a847efEf7F70739046A929D47a521F5B8ee?fields=all', hashes: ['76aab17564b7a07a841ebaa56f2e562e2443b519a98fa50bb1691dc2e1f205f9'] },
  { id: 'polymarket-pusd-full-abi', kind: 'exact-address complete ABI response', url: 'https://sourcify.dev/server/v2/contract/137/0x93070a847efEf7F70739046A929D47a521F5B8ee?fields=abi', hashes: ['0a829eeda0754ded1d1e0a0c2fb5f9ae089e56ec173488c1da22c409cb1e45df', '418bc6e41b0339b3f6bb842fe36a96bfac4aeaf75ed2da0e5afbb3f029761d95'] },
] as const;

/** Closed exception for the sole restricted catalog admission supported by update tooling. */
export function validatePolymarketPusdAdmission(input: {
  familyId: string; familyVersion: string; chainId: number; contract: string; signature: string;
  selector: string; abiHash: string; capabilityId: string; scope: DefiExecutionScope | null; scopeHash: string | null;
  fn: DefiFunctionPolicy; sourcePath: string; sourceDigest: string; sourceDocument: unknown; sourceRefs: readonly string[];
}): asserts input is typeof input & { scope: typeof POLYMARKET_PUSD_WRAP_SCOPE; scopeHash: string } {
  const identity = POLYMARKET_PUSD_WRAP_IDENTITY;
  const source = input.sourceDocument as { families?: unknown[]; sources?: unknown[] };
  const family = source?.families?.[0] as Record<string, unknown> | undefined;
  const contract = (family?.contracts as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  const sourceRecords = source?.sources as Array<Record<string, unknown>> | undefined;
  const expectedIds = SOURCE_EVIDENCE.map((entry) => entry.id).sort();
  const sourceRefs = [...input.sourceRefs].sort();
  const recordsMatch = Array.isArray(sourceRecords) && sourceRecords.length === SOURCE_EVIDENCE.length
    && SOURCE_EVIDENCE.every((expected) => {
    const record = sourceRecords.find((candidate) => candidate.sourceId === expected.id);
      const evidence = record?.evidence;
      return record?.url === expected.url && typeof evidence === 'string' && evidence.includes(`Kind: ${expected.kind}`)
        && expected.hashes.every((hash) => evidence.includes(hash));
    });
  if (input.familyId !== 'polymarket-pusd' || input.familyVersion !== 'collateral-onramp@27700089'
    || input.chainId !== identity.chainId || input.contract.toLowerCase() !== identity.contract
    || input.signature !== identity.signature || input.selector.toLowerCase() !== identity.selector
    || input.abiHash.toLowerCase() !== identity.abiHash || input.capabilityId !== identity.capabilityId
    || !input.scope || input.scope.kind !== 'polymarket-pusd-wrap-v1'
    || input.scope.asset !== identity.asset || input.scope.recipientPolicy !== 'withdrawal-allowlist-v1'
    || input.scopeHash !== executionScopeHash(POLYMARKET_PUSD_WRAP_SCOPE)
    || input.sourcePath !== POLYMARKET_PUSD_REVIEWED_SOURCE_PATH
    || input.sourceDigest !== POLYMARKET_PUSD_REVIEWED_SOURCE_SHA256
    || canonicalSourceSha256(input.sourceDocument) !== POLYMARKET_PUSD_REVIEWED_SOURCE_SHA256
    || !source || source.families?.length !== 1 || family?.familyId !== 'polymarket-pusd' || family.familyVersion !== 'collateral-onramp@27700089'
    || (family.contracts as unknown[] | undefined)?.length !== 1 || contract?.chainId !== 137
    || typeof contract.address !== 'string' || contract.address.toLowerCase() !== identity.contract
    || contract.status !== 'inactive' || !Array.isArray(contract.sourceRefs)
    || JSON.stringify([...contract.sourceRefs].sort()) !== JSON.stringify(expectedIds)
    || !Array.isArray(input.sourceRefs) || JSON.stringify(sourceRefs) !== JSON.stringify(expectedIds)
    || !recordsMatch) {
    throw new Error('Polymarket pUSD admission must match its exact pinned identity, reviewed source evidence, and mandatory scope');
  }
  validatePolymarketPusdWrapBinding({ ...input.fn, capabilityId: input.capabilityId, executionScope: input.scope });
}
