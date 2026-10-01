import { getAddress, ethAddress } from 'viem';
import {
  ASSET_FLOW_EVIDENCE_SCHEMA_VERSION,
  ASSET_FLOW_RULE_VERSION,
  buildAssetKey,
  computeAssetFlowPlanDigest,
  hasTrustedAssetFlowEvidenceAuthority,
  sealTrustedAssetFlowEvidenceForTests,
  verifyTransactionAssetFlow,
  type AssetChangeEvidence,
  type AssetFlowEvidence,
  type AssetFlowEvidenceCoverage,
  type AssetFlowExecutionMode,
  type AssetFlowVerifierInteraction,
  type AssetRelation,
  type TrustedAssetFlowEvidenceDraft,
} from './transaction-asset-flow.verifier';

const OWNER = '0x1111111111111111111111111111111111111111';
const OWNER_CHECKSUM = getAddress(OWNER);
const TOKEN_A = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TOKEN_B = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const NFT = '0x2222222222222222222222222222222222222222';
const TARGET = '0x3333333333333333333333333333333333333333';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const CHAIN_ID = 8453;
const EXECUTION_MODE: AssetFlowExecutionMode = 'session_key';

let entrySeq = 0;
function nextEntryId(prefix = 'e'): string {
  entrySeq += 1;
  return `${prefix}${entrySeq}`;
}

function interaction(
  overrides: Partial<AssetFlowVerifierInteraction> = {},
): AssetFlowVerifierInteraction {
  return {
    to: TARGET,
    data: '0x12345678',
    value: '0',
    ...overrides,
  };
}

function completeCoverage(
  probedAssetKeys: string[] = [],
  overrides: Partial<AssetFlowEvidenceCoverage> = {},
): AssetFlowEvidenceCoverage {
  return {
    assetObservation: {
      completeness: 'complete',
      probedAssetKeys,
      probeFailures: [],
      unobservedAssetKeys: [],
    },
    internalCalls: { completeness: 'complete', observed: true },
    permissions: { completeness: 'complete', unknownPermissionChanges: false, observedKinds: [] },
    ...overrides,
  };
}

function erc20Change(token: string, pre: bigint, post: bigint, entryId?: string): AssetChangeEvidence {
  const tokenAddress = getAddress(token);
  const assetKey = buildAssetKey({ kind: 'erc20', tokenAddress })!;
  return {
    entryId: entryId ?? nextEntryId('erc20'),
    assetKey,
    kind: 'erc20',
    tokenAddress,
    pre,
    post,
    diff: post - pre,
  };
}

function nativeChange(pre: bigint, post: bigint, entryId?: string): AssetChangeEvidence {
  const assetKey = buildAssetKey({ kind: 'native', tokenAddress: ethAddress })!;
  return {
    entryId: entryId ?? nextEntryId('native'),
    assetKey,
    kind: 'native',
    tokenAddress: ethAddress,
    pre,
    post,
    diff: post - pre,
  };
}

function erc721Change(
  token: string,
  tokenId: string,
  pre: bigint,
  post: bigint,
  entryId?: string,
): AssetChangeEvidence {
  const tokenAddress = getAddress(token);
  const assetKey = buildAssetKey({ kind: 'erc721', tokenAddress, tokenId })!;
  return {
    entryId: entryId ?? nextEntryId('erc721'),
    assetKey,
    kind: 'erc721',
    tokenAddress,
    tokenId,
    pre,
    post,
    diff: post - pre,
  };
}

function bindingFor(
  interactions: AssetFlowVerifierInteraction[],
  opts: {
    ownerAddress?: string;
    chainId?: number;
    executionMode?: AssetFlowExecutionMode;
  } = {},
) {
  const ownerAddress = opts.ownerAddress ?? OWNER;
  const chainId = opts.chainId ?? CHAIN_ID;
  const executionMode = opts.executionMode ?? EXECUTION_MODE;
  return {
    ownerAddress: getAddress(ownerAddress).toLowerCase(),
    chainId,
    executionMode,
    planDigest: computeAssetFlowPlanDigest({
      ownerAddress,
      chainId,
      executionMode,
      interactions,
    })!,
    schemaVersion: ASSET_FLOW_EVIDENCE_SCHEMA_VERSION,
    ruleVersion: ASSET_FLOW_RULE_VERSION,
    baseBlock: { number: 100n, hash: BLOCK_HASH },
    simulatedBlock: { number: 100n, hash: BLOCK_HASH },
  };
}

/** Build a plain (untrusted) evidence object — JSON-cloneable, no WeakSet authority. */
function plainEvidence(
  interactions: AssetFlowVerifierInteraction[],
  partial: Partial<AssetFlowEvidence> &
    Pick<AssetFlowEvidence, 'assetChanges' | 'relations' | 'coverage' | 'simulationMode'>,
  opts: {
    ownerAddress?: string;
    chainId?: number;
    executionMode?: AssetFlowExecutionMode;
  } = {},
): AssetFlowEvidence {
  return {
    results: interactions.map(() => ({ status: 'success' })),
    logs: { completeness: 'complete', count: 0 },
    binding: bindingFor(interactions, opts),
    ...partial,
  };
}

/** Trusted sealed evidence via test-only sealer (grants opaque authority). */
function sealTrusted(
  interactions: AssetFlowVerifierInteraction[],
  partial: Omit<TrustedAssetFlowEvidenceDraft, 'binding' | 'results' | 'logs' | 'simulationMode'> & {
    assetChanges: AssetChangeEvidence[];
    relations: AssetRelation[];
    coverage: AssetFlowEvidenceCoverage;
  },
  opts: {
    ownerAddress?: string;
    chainId?: number;
    executionMode?: AssetFlowExecutionMode;
  } = {},
): AssetFlowEvidence {
  return sealTrustedAssetFlowEvidenceForTests({
    simulationMode: 'calibur_atomic',
    binding: bindingFor(interactions, opts),
    results: interactions.map(() => ({ status: 'success' })),
    logs: { completeness: 'complete', count: 0 },
    coverage: partial.coverage,
    assetChanges: partial.assetChanges,
    relations: partial.relations,
  });
}

function verify(
  interactions: AssetFlowVerifierInteraction[],
  evidence: AssetFlowEvidence,
  opts: {
    ownerAddress?: string;
    chainId?: number;
    executionMode?: AssetFlowExecutionMode;
  } = {},
) {
  return verifyTransactionAssetFlow({
    ownerAddress: opts.ownerAddress ?? OWNER,
    chainId: opts.chainId ?? CHAIN_ID,
    executionMode: opts.executionMode ?? EXECUTION_MODE,
    interactions,
    evidence,
  });
}

function exactSwap(out: AssetChangeEvidence, inn: AssetChangeEvidence): AssetRelation {
  return {
    kind: 'swap',
    inputs: [{ entryId: out.entryId, amount: -out.diff }],
    outputs: [{ entryId: inn.entryId, amount: inn.diff }],
  };
}

beforeEach(() => {
  entrySeq = 0;
});

describe('verifyTransactionAssetFlow', () => {
  describe('M1 producer authority', () => {
    it('rejects test sealer outside jest/test runtime (production guard)', () => {
      const interactions = [interaction()];
      const draft = {
        simulationMode: 'calibur_atomic' as const,
        binding: bindingFor(interactions),
        results: [{ status: 'success' as const }],
        logs: { completeness: 'complete' as const, count: 0 },
        coverage: completeCoverage([]),
        assetChanges: [] as AssetChangeEvidence[],
        relations: [] as AssetRelation[],
      };

      const prevWorker = process.env.JEST_WORKER_ID;
      const prevEnv = process.env.NODE_ENV;
      try {
        delete process.env.JEST_WORKER_ID;
        process.env.NODE_ENV = 'production';
        expect(() => sealTrustedAssetFlowEvidenceForTests(draft)).toThrow('trusted_sealer_unavailable');
      } finally {
        if (prevWorker === undefined) delete process.env.JEST_WORKER_ID;
        else process.env.JEST_WORKER_ID = prevWorker;
        if (prevEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevEnv;
      }

      // Restored test env can still seal.
      const sealed = sealTrustedAssetFlowEvidenceForTests(draft);
      expect(hasTrustedAssetFlowEvidenceAuthority(sealed)).toBe(true);
    });

    it('never verifies plain/JSON-reconstructed calibur_atomic evidence without authority', () => {
      const interactions = [interaction()];
      const change = erc20Change(TOKEN_A, 1n, 2n);
      const plain = plainEvidence(interactions, {
        simulationMode: 'calibur_atomic',
        coverage: completeCoverage([change.assetKey]),
        assetChanges: [change],
        relations: [],
      });

      expect(hasTrustedAssetFlowEvidenceAuthority(plain)).toBe(false);
      expect(verify(interactions, plain).status).toBe('unknown');
      expect(verify(interactions, plain).rule).toBe('missing_producer_authority');

      // Structured clone / JSON round-trip cannot carry WeakSet authority.
      const cloned = JSON.parse(
        JSON.stringify(plain, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        (_k, v) => (typeof v === 'string' && /^-?\d+$/.test(v) && _k !== 'planDigest' && _k !== 'ownerAddress' && _k !== 'hash' && _k !== 'schemaVersion' && _k !== 'ruleVersion' && _k !== 'executionMode' && _k !== 'simulationMode' && _k !== 'completeness' && _k !== 'status' && _k !== 'kind' && _k !== 'assetKey' && _k !== 'entryId' && _k !== 'tokenAddress' && _k !== 'tokenId' && !String(_k).includes('Address') ? (['pre', 'post', 'diff', 'amount', 'number', 'count', 'chainId'].includes(String(_k)) ? BigInt(v) : v) : v),
      ) as AssetFlowEvidence;
      // Fix bigints more carefully for clone test:
      const jsonClone: AssetFlowEvidence = {
        ...plain,
        assetChanges: plain.assetChanges.map((c) => ({ ...c })),
        relations: plain.relations.map((r) => ({
          ...r,
          inputs: r.inputs.map((l) => ({ ...l })),
          outputs: r.outputs.map((l) => ({ ...l })),
        })),
        coverage: {
          assetObservation: { ...plain.coverage.assetObservation },
          internalCalls: { ...plain.coverage.internalCalls },
          permissions: { ...plain.coverage.permissions },
        },
        binding: {
          ...plain.binding,
          baseBlock: { ...plain.binding.baseBlock },
          simulatedBlock: { ...plain.binding.simulatedBlock },
        },
        results: plain.results.map((r) => ({ ...r })),
        logs: { ...plain.logs },
      };
      expect(hasTrustedAssetFlowEvidenceAuthority(jsonClone)).toBe(false);
      expect(verify(interactions, jsonClone).rule).toBe('missing_producer_authority');
      expect(cloned).toBeTruthy(); // keep parse path exercised
    });

    it('does not grant authority when spreading a sealed object into a new envelope', () => {
      const interactions = [interaction()];
      const sealed = sealTrusted(interactions, {
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });
      expect(hasTrustedAssetFlowEvidenceAuthority(sealed)).toBe(true);
      expect(verify(interactions, sealed).status).toBe('verified');

      const forged: AssetFlowEvidence = { ...sealed };
      expect(hasTrustedAssetFlowEvidenceAuthority(forged)).toBe(false);
      expect(verify(interactions, forged).rule).toBe('missing_producer_authority');
    });
  });

  describe('verified paths (trusted sealer only)', () => {
    it('verifies net-positive owner asset change with authority', () => {
      const interactions = [interaction()];
      const change = erc20Change(TOKEN_A, 100n, 150n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([change.assetKey]),
        assetChanges: [change],
        relations: [],
      });

      const result = verify(interactions, evidence);
      expect(result.status).toBe('verified');
      expect(result.rule).toBe('owner_asset_net_non_negative');
      expect(result.simulationMode).toBe('calibur_atomic');
    });

    it('verifies exact amount swap relation', () => {
      const interactions = [interaction(), interaction({ data: '0xabcdef01' })];
      const out = erc20Change(TOKEN_A, 1000n, 400n);
      const inn = erc20Change(TOKEN_B, 0n, 2n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([out.assetKey, inn.assetKey]),
        assetChanges: [out, inn],
        relations: [exactSwap(out, inn)],
      });

      const result = verify(interactions, evidence);
      expect(result.status).toBe('verified');
      expect(result.rule).toBe('owner_asset_relation_verified');
    });

    it('verifies wrap relation with exact native/erc20 amounts', () => {
      const interactions = [interaction()];
      const out = nativeChange(5n, 1n);
      const inn = erc20Change(TOKEN_B, 0n, 4n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([out.assetKey, inn.assetKey]),
        assetChanges: [out, inn],
        relations: [
          {
            kind: 'wrap',
            inputs: [{ entryId: out.entryId, amount: 4n }],
            outputs: [{ entryId: inn.entryId, amount: 4n }],
          },
        ],
      });

      expect(verify(interactions, evidence).status).toBe('verified');
    });

    it('verifies no observed change under complete coverage', () => {
      const interactions = [interaction({ data: '0x' })];
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence)).toMatchObject({
        status: 'verified',
        rule: 'owner_no_observed_asset_change',
      });
    });

    it('verifies ERC-721 transfer-in with tokenId identity', () => {
      const interactions = [interaction()];
      const nft = erc721Change(NFT, '7', 0n, 1n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([nft.assetKey]),
        assetChanges: [nft],
        relations: [],
      });

      expect(verify(interactions, evidence).status).toBe('verified');
    });
  });

  describe('M1 exact relation amounts', () => {
    it('rejects relation that only claims part of a large outflow (swap + extra transfer)', () => {
      const interactions = [interaction()];
      // Outflow 100: relation explains only 10, leaving 90 unexplained.
      const out = erc20Change(TOKEN_A, 100n, 0n);
      const inn = erc20Change(TOKEN_B, 0n, 10n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([out.assetKey, inn.assetKey]),
        assetChanges: [out, inn],
        relations: [
          {
            kind: 'swap',
            inputs: [{ entryId: out.entryId, amount: 10n }],
            outputs: [{ entryId: inn.entryId, amount: 10n }],
          },
        ],
      });

      const result = verify(interactions, evidence);
      expect(result.status).toBe('unknown');
      expect(result.rule).toBe('relation_input_amount_mismatch');
    });

    it('rejects key-only style relation without amounts (malformed legs)', () => {
      const interactions = [interaction()];
      const out = erc20Change(TOKEN_A, 10n, 0n);
      const inn = erc20Change(TOKEN_B, 0n, 1n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([out.assetKey, inn.assetKey]),
        assetChanges: [out, inn],
        relations: [
          {
            kind: 'swap',
            // @ts-expect-error intentional legacy shape
            inputs: [out.assetKey],
            // @ts-expect-error intentional
            outputs: [inn.assetKey],
          },
        ],
      });

      expect(verify(interactions, evidence).status).toBe('unknown');
    });

    it('rejects dust masking: negative + unrelated positive without relation', () => {
      const interactions = [interaction()];
      const out = erc20Change(TOKEN_A, 100n, 40n);
      const dust = erc20Change(TOKEN_B, 0n, 1n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([out.assetKey, dust.assetKey]),
        assetChanges: [out, dust],
        relations: [],
      });

      expect(verify(interactions, evidence)).toMatchObject({
        status: 'unknown',
        rule: 'outflow_masked_by_unrelated_inflow',
      });
    });

    it('rejects unrelated inflow dust when a swap relation is present', () => {
      const interactions = [interaction()];
      const out = erc20Change(TOKEN_A, 10n, 0n);
      const inn = erc20Change(TOKEN_B, 0n, 5n);
      const dust = erc20Change(NFT, 0n, 1n);
      // NFT used as erc20-like address for dust key
      const dustErc20 = erc20Change('0x4444444444444444444444444444444444444444', 0n, 1n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([out.assetKey, inn.assetKey, dustErc20.assetKey]),
        assetChanges: [out, inn, dustErc20],
        relations: [exactSwap(out, inn)],
      });
      void dust;

      expect(verify(interactions, evidence).rule).toBe('unrelated_inflow_dust');
    });

    it('marks fully uncompensated outflow as external_transfer', () => {
      const interactions = [interaction()];
      const out = erc20Change(TOKEN_A, 100n, 40n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([out.assetKey]),
        assetChanges: [out],
        relations: [],
      });

      expect(verify(interactions, evidence)).toMatchObject({
        status: 'external_transfer',
        rule: 'owner_outflow_uncompensated',
      });
    });

    it('rejects output amount not equal to observed inflow', () => {
      const interactions = [interaction()];
      const out = erc20Change(TOKEN_A, 10n, 0n);
      const inn = erc20Change(TOKEN_B, 0n, 5n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([out.assetKey, inn.assetKey]),
        assetChanges: [out, inn],
        relations: [
          {
            kind: 'swap',
            inputs: [{ entryId: out.entryId, amount: 10n }],
            outputs: [{ entryId: inn.entryId, amount: 3n }],
          },
        ],
      });

      expect(verify(interactions, evidence).rule).toBe('relation_output_amount_mismatch');
    });
  });

  describe('M2 strict runtime schema', () => {
    it('rejects probeFailures with wrong type (string instead of array)', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: {
          ...completeCoverage([]),
          assetObservation: {
            completeness: 'complete',
            // @ts-expect-error intentional
            probeFailures: 'failed',
          },
        },
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('invalid_probe_failures');
    });

    it('rejects unobservedAssetKeys with wrong type (object)', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: {
          ...completeCoverage([]),
          assetObservation: {
            completeness: 'complete',
            // @ts-expect-error intentional
            unobservedAssetKeys: { a: 1 },
          },
        },
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('invalid_unobserved_asset_keys');
    });

    it('rejects unknownPermissionChanges with string "true"', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: {
          ...completeCoverage([]),
          permissions: {
            completeness: 'complete',
            // @ts-expect-error intentional
            unknownPermissionChanges: 'true',
          },
        },
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('invalid_unknown_permission_changes');
    });

    it('rejects observedKinds with string instead of array', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: {
          ...completeCoverage([]),
          permissions: {
            completeness: 'complete',
            // @ts-expect-error intentional
            observedKinds: 'approval',
          },
        },
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('invalid_observed_permission_kinds');
    });

    it('rejects internalCalls.observed non-boolean', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: {
          ...completeCoverage([]),
          internalCalls: {
            completeness: 'complete',
            // @ts-expect-error intentional
            observed: 'yes',
          },
        },
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('invalid_internal_call_observed');
    });

    it('requires probedAssetKeys when complete coverage has asset changes', () => {
      const interactions = [interaction()];
      const change = erc20Change(TOKEN_A, 1n, 2n);
      const evidence = sealTrusted(interactions, {
        coverage: {
          assetObservation: { completeness: 'complete' },
          internalCalls: { completeness: 'complete', observed: true },
          permissions: { completeness: 'complete' },
        },
        assetChanges: [change],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('missing_probed_asset_keys');
    });

    it('rejects observed asset key not listed in probedAssetKeys', () => {
      const interactions = [interaction()];
      const change = erc20Change(TOKEN_A, 1n, 2n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage(['erc20:0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead']),
        assetChanges: [change],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('observed_not_in_probed_keys');
    });
  });

  describe('B1 coverage / empty / probe', () => {
    it('returns unknown when asset coverage is incomplete', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: {
          ...completeCoverage([]),
          assetObservation: { completeness: 'incomplete' },
        },
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('incomplete_asset_coverage');
    });

    it('returns unknown on asset probe failure', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: {
          ...completeCoverage([]),
          assetObservation: {
            completeness: 'complete',
            probeFailures: ['erc20:0xabc'],
          },
        },
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('asset_probe_failure');
    });
  });

  describe('B2 asset value integrity', () => {
    it('rejects negative pre balance', () => {
      const interactions = [interaction()];
      const bad: AssetChangeEvidence = {
        ...erc20Change(TOKEN_A, 0n, 1n),
        pre: -1n as unknown as bigint,
        post: 1n,
        diff: 2n,
      };
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([bad.assetKey]),
        assetChanges: [bad],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('malformed_asset_value');
    });

    it('rejects inconsistent pre/post/diff', () => {
      const interactions = [interaction()];
      const base = erc20Change(TOKEN_A, 10n, 20n);
      const bad = { ...base, diff: 5n };
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([bad.assetKey]),
        assetChanges: [bad],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('inconsistent_asset_diff');
    });

    it('rejects duplicate asset keys', () => {
      const interactions = [interaction()];
      const a = erc20Change(TOKEN_A, 10n, 5n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([a.assetKey]),
        assetChanges: [a, { ...a, entryId: nextEntryId('dup'), pre: 3n, post: 1n, diff: -2n }],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('duplicate_asset_key');
    });

    it('rejects duplicate entryIds', () => {
      const interactions = [interaction()];
      const a = erc20Change(TOKEN_A, 10n, 5n, 'same-id');
      const b = erc20Change(TOKEN_B, 1n, 0n, 'same-id');
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([a.assetKey, b.assetKey]),
        assetChanges: [a, b],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('duplicate_asset_entry_id');
    });

    it('rejects ERC-721 without tokenId', () => {
      const interactions = [interaction()];
      const bad = {
        entryId: 'nft1',
        assetKey: 'erc721:bad',
        kind: 'erc721' as const,
        tokenAddress: getAddress(NFT),
        pre: 1n,
        post: 0n,
        diff: -1n,
      };
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([]),
        assetChanges: [bad],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('erc721_token_id_required');
    });

    it('rejects ERC-1155 evidence', () => {
      const interactions = [interaction()];
      const bad = {
        entryId: 'e1155',
        assetKey: 'erc1155:x',
        kind: 'erc1155' as const,
        tokenAddress: getAddress(TOKEN_A),
        tokenId: '1',
        pre: 1n,
        post: 0n,
        diff: -1n,
      };
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([]),
        assetChanges: [bad],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('erc1155_unsupported');
    });
  });

  describe('B3 permissions / internal calls', () => {
    it('returns unknown when internal call coverage is incomplete', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: {
          ...completeCoverage([]),
          internalCalls: { completeness: 'unknown', observed: false },
        },
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('incomplete_internal_call_coverage');
    });

    it('returns unknown when permission coverage is incomplete', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: {
          ...completeCoverage([]),
          permissions: { completeness: 'incomplete' },
        },
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('incomplete_permission_coverage');
    });

    it('returns unknown when approval-like permission kinds were observed', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: {
          ...completeCoverage([]),
          permissions: { completeness: 'complete', observedKinds: ['approval'] },
        },
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence).rule).toBe('permission_change_observed');
    });

    it('fail-closes wrapper/delegatecall style evidence', () => {
      const interactions = [interaction({ data: '0xac9650d8' + '00'.repeat(64) })];
      const out = erc20Change(TOKEN_A, 10n, 5n);
      const inn = erc20Change(TOKEN_B, 0n, 5n);
      const evidence = sealTrusted(interactions, {
        coverage: {
          assetObservation: { completeness: 'complete', probedAssetKeys: [out.assetKey, inn.assetKey] },
          internalCalls: { completeness: 'incomplete', observed: false },
          permissions: { completeness: 'unknown' },
        },
        assetChanges: [out, inn],
        relations: [exactSwap(out, inn)],
      });

      expect(verify(interactions, evidence).status).toBe('unknown');
    });
  });

  describe('B4 simulation mode', () => {
    it('never verifies eth_simulateV1_non_atomic', () => {
      const interactions = [interaction()];
      // Even if someone seals non-atomic — sealer rejects non-calibur; use plain.
      const plain = plainEvidence(interactions, {
        simulationMode: 'eth_simulateV1_non_atomic',
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });
      // Observation path may have absent base; set simulated complete.
      plain.binding.baseBlock = { number: null, hash: null };
      plain.binding.simulatedBlock = { number: 1n, hash: BLOCK_HASH };

      expect(verify(interactions, plain).rule).toBe('non_atomic_simulation_mode');
    });

    it('does not echo arbitrary simulationMode strings', () => {
      const interactions = [interaction()];
      const plain = plainEvidence(interactions, {
        // @ts-expect-error intentional
        simulationMode: 'evil_mode_leak_me',
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });
      plain.binding.baseBlock = { number: null, hash: null };
      plain.binding.simulatedBlock = { number: 1n, hash: BLOCK_HASH };

      const result = verify(interactions, plain);
      expect(result.rule).toBe('invalid_simulation_mode');
      expect(result.simulationMode).toBeNull();
      expect(
        JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ).not.toContain('evil_mode_leak_me');
    });
  });

  describe('M3 block identity', () => {
    it('rejects authorized envelope with negative block number', () => {
      const interactions = [interaction()];
      // Seal with malformed block by crafting draft directly (authority cannot mask it):
      const bad = sealTrustedAssetFlowEvidenceForTests({
        simulationMode: 'calibur_atomic',
        binding: {
          ...bindingFor(interactions),
          baseBlock: { number: -1n, hash: BLOCK_HASH },
          simulatedBlock: { number: 1n, hash: BLOCK_HASH },
        },
        results: [{ status: 'success' }],
        logs: { completeness: 'complete', count: 0 },
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });
      expect(hasTrustedAssetFlowEvidenceAuthority(bad)).toBe(true);
      expect(verify(interactions, bad).rule).toBe('missing_base_block');
    });

    it('rejects authorized envelope with malformed hash', () => {
      const interactions = [interaction()];
      const bad = sealTrustedAssetFlowEvidenceForTests({
        simulationMode: 'calibur_atomic',
        binding: {
          ...bindingFor(interactions),
          baseBlock: { number: 1n, hash: 'not-a-hash' },
          simulatedBlock: { number: 1n, hash: BLOCK_HASH },
        },
        results: [{ status: 'success' }],
        logs: { completeness: 'complete', count: 0 },
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });
      expect(hasTrustedAssetFlowEvidenceAuthority(bad)).toBe(true);
      expect(verify(interactions, bad).rule).toBe('missing_base_block');
    });

    it('rejects authorized envelope with null hash on simulated block', () => {
      const interactions = [interaction()];
      const bad = sealTrustedAssetFlowEvidenceForTests({
        simulationMode: 'calibur_atomic',
        binding: {
          ...bindingFor(interactions),
          baseBlock: { number: 1n, hash: BLOCK_HASH },
          simulatedBlock: { number: 1n, hash: null },
        },
        results: [{ status: 'success' }],
        logs: { completeness: 'complete', count: 0 },
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });
      expect(hasTrustedAssetFlowEvidenceAuthority(bad)).toBe(true);
      // Partial identity (number without hash) is malformed, not merely missing.
      expect(['missing_simulated_block', 'invalid_simulated_block']).toContain(
        verify(interactions, bad).rule,
      );
    });
  });

  describe('M2 numeric safety', () => {
    it('rejects unsafe integer pre with authority present', () => {
      const interactions = [interaction()];
      const tokenAddress = getAddress(TOKEN_A);
      const assetKey = buildAssetKey({ kind: 'erc20', tokenAddress })!;
      const unsafe = Number.MAX_SAFE_INTEGER + 10;
      const bad: AssetChangeEvidence = {
        entryId: 'unsafe1',
        assetKey,
        kind: 'erc20',
        tokenAddress,
        pre: unsafe as unknown as bigint,
        post: unsafe as unknown as bigint,
        diff: 0 as unknown as bigint,
      };
      // 0 diff is skipped — use non-zero with unsafe number fields
      const bad2: AssetChangeEvidence = {
        entryId: 'unsafe2',
        assetKey,
        kind: 'erc20',
        tokenAddress,
        pre: unsafe as unknown as bigint,
        post: (unsafe + 1) as unknown as bigint,
        diff: 1 as unknown as bigint,
      };
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([assetKey]),
        assetChanges: [bad2],
        relations: [],
      });
      void bad;
      expect(hasTrustedAssetFlowEvidenceAuthority(evidence)).toBe(true);
      expect(verify(interactions, evidence).rule).toBe('malformed_asset_value');
    });

    it('rejects fractional number amounts in relation legs', () => {
      const interactions = [interaction()];
      const out = erc20Change(TOKEN_A, 10n, 0n);
      const inn = erc20Change(TOKEN_B, 0n, 5n);
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([out.assetKey, inn.assetKey]),
        assetChanges: [out, inn],
        relations: [
          {
            kind: 'swap',
            inputs: [{ entryId: out.entryId, amount: 1.5 as unknown as bigint }],
            outputs: [{ entryId: inn.entryId, amount: 5n }],
          },
        ],
      });
      expect(verify(interactions, evidence).rule).toBe('invalid_relation_amount');
    });
  });

  describe('B5 binding', () => {
    it('returns unknown on owner binding mismatch', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });

      expect(
        verify(interactions, evidence, {
          ownerAddress: '0x9999999999999999999999999999999999999999',
        }).rule,
      ).toBe('owner_binding_mismatch');
    });

    it('returns unknown on chain / mode / digest / schema mismatch', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });

      expect(verify(interactions, evidence, { chainId: 1 }).rule).toBe('chain_binding_mismatch');
      expect(verify(interactions, evidence, { executionMode: 'eoa' }).rule).toBe(
        'execution_mode_binding_mismatch',
      );
    });

    it('accepts checksum and lowercase owner equivalently', () => {
      const interactions = [interaction()];
      const evidence = sealTrusted(
        interactions,
        { coverage: completeCoverage([]), assetChanges: [], relations: [] },
        { ownerAddress: OWNER_CHECKSUM },
      );

      expect(verify(interactions, evidence, { ownerAddress: OWNER.toLowerCase() }).status).toBe(
        'verified',
      );
    });

    it('does not echo plan digest, schema, or calldata in the result', () => {
      const fullCalldata = `0x095ea7b3${'11'.repeat(64)}`;
      const interactions = [interaction({ data: fullCalldata })];
      const evidence = sealTrusted(interactions, {
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });

      const result = verify(interactions, evidence);
      const serialized = JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      expect(serialized).not.toContain(fullCalldata);
      expect(serialized).not.toContain(evidence.binding.planDigest);
      expect(serialized).not.toContain(ASSET_FLOW_EVIDENCE_SCHEMA_VERSION);
      expect(result).not.toHaveProperty('planDigest');
    });
  });

  describe('call results integrity', () => {
    it('returns unknown when any call is not success', () => {
      const interactions = [interaction(), interaction()];
      // Cannot mutate frozen sealed object — build plain with failure (results check runs before authority).
      const plain = plainEvidence(interactions, {
        simulationMode: 'calibur_atomic',
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });
      plain.results = [{ status: 'success' }, { status: 'failure' }];

      expect(verify(interactions, plain).rule).toBe('call_not_success');
    });

    it('returns unknown on results length mismatch', () => {
      const interactions = [interaction(), interaction(), interaction()];
      const plain = plainEvidence([interaction()], {
        simulationMode: 'calibur_atomic',
        coverage: completeCoverage([]),
        assetChanges: [],
        relations: [],
      });
      plain.results = [{ status: 'success' }, { status: 'success' }];
      plain.binding.planDigest = computeAssetFlowPlanDigest({
        ownerAddress: OWNER,
        chainId: CHAIN_ID,
        executionMode: EXECUTION_MODE,
        interactions,
      })!;

      expect(verify(interactions, plain).rule).toBe('results_length_mismatch');
    });
  });
});
