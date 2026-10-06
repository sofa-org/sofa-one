import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeAbiParameters, toFunctionSelector } from 'viem';
import type { DefiExecutionContext, DefiFunctionPolicy } from '../defi.types';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from '../bundles/production-bundles';
import { buildReviewedManifest, functionAbiHash } from './defi-manifest';
import { PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { loadCurrentProductionExpectations } from './__fixtures__/current-production-expectations';
import { validateCatalogDocument } from '../catalog-tooling/catalog-generator';

const TARGETS = [
  '0x1180c114f7fadcb6957670432a3cf8ef08ab5354',
  '0x298f243ad592b6027d4717fbe9decda668e3c3a8',
] as const;
const PRIOR_DFORCE_TARGET = '0x2f956b2f801c6dad74e87e7f45c94f6283bf0f45';
const KEY_ID = '00000000-0000-4000-8000-000000000231';
const USER = 'dforce-iusdt-idai-policy-test';
const MINT_ABI = {
  type: 'function',
  name: 'mint',
  stateMutability: 'nonpayable',
  inputs: [
    { internalType: 'address', name: '_recipient', type: 'address' },
    { internalType: 'uint256', name: '_mintAmount', type: 'uint256' },
  ],
  outputs: [],
} as const;
const REDEEM_ABI = {
  type: 'function',
  name: 'redeem',
  stateMutability: 'nonpayable',
  inputs: [
    { internalType: 'address', name: '_from', type: 'address' },
    { internalType: 'uint256', name: '_redeemiToken', type: 'uint256' },
  ],
  outputs: [],
} as const;
const METHODS = {
  mint: {
    signature: 'mint(address,uint256)',
    selector: '0x40c10f19',
    hash: '0x9fc0f7364ccf5669b21ae3da6d102e41ee47dde89768d65b19550ed745f7fb4a',
    abi: MINT_ABI,
  },
  redeem: {
    signature: 'redeem(address,uint256)',
    selector: '0x1e9a6950',
    hash: '0x7b00a8c11f3db3cc93aec1dbe34ac479746e38ddf47871763ba61e4bf1f93b7a',
    abi: REDEEM_ABI,
  },
} as const;
type Method = keyof typeof METHODS;
type Spec = (typeof SPECIFICATIONS)[number];
const SPECIFICATIONS = TARGETS.flatMap((target) =>
  (Object.keys(METHODS) as Method[]).map((method) => ({
    target,
    method,
    id: `dforce-itoken:v2:1:${target}:${method}`,
    ...METHODS[method],
  })),
);
const ALL_IDS = SPECIFICATIONS.map(({ id }) => id);
const MAX_UINT256 = ((1n << 256n) - 1n).toString();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';
const EXECUTION_OWNER = '0x9999999999999999999999999999999999999999';
const PREVIOUS_CATALOG_PATH = 'data/defi-catalog/updates/dforce-iusdc/catalog.json';
const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
const policy = new DefiPolicyService(db as never, {} as never, catalog);
const functions = new Map(
  SPECIFICATIONS.map((spec) => [
    spec.id,
    PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.capabilityId === spec.id) as DefiFunctionPolicy,
  ]),
);
const previousManifest = buildReviewedManifest([
  validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), PREVIOUS_CATALOG_PATH), 'utf8'))),
]);
const previousCapabilityIds = previousManifest.capabilities.map((candidate) => candidate.capabilityId);

function context(grants: string[] = ALL_IDS, chainId = 1): DefiExecutionContext {
  return {
    userId: USER,
    apiKeyId: KEY_ID,
    walletId: 'wallet',
    chainId,
    executionMode: 'session_key',
    executionOwner: EXECUTION_OWNER,
    allowedCapabilityIds: grants,
  };
}

function calldata(spec: Spec, address: string, amount: string): string {
  const args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [address as `0x${string}`, BigInt(amount)],
  );
  return `${spec.selector}${args.slice(2)}`;
}

function tx(spec: Spec, target: string = spec.target, address = OTHER_ADDRESS, amount = '1', value = '0', data = calldata(spec, address, amount)) {
  return { to: target, value, data };
}

function finalTx(grants: string[], pausedScopeKeys: string[] = [], keyOverrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: {
      findUnique: jest.fn().mockResolvedValue({
        userId: USER,
        revoked: false,
        frozenAt: null,
        expiresAt: null,
        canSendTransaction: true,
        allowedCapabilityIds: grants,
        ...keyOverrides,
      }),
    },
  };
}

describe('dForce iUSDT/iDAI ordinary inherited mint/redeem additions', () => {
  it('preserves the selected prior catalog and admits exactly four exact nonpayable ABIs', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    const currentById = new Map(PRODUCTION_DEFI_MANIFEST.capabilities.map((candidate) => [candidate.capabilityId, candidate]));
    for (const priorFunction of previousManifest.capabilities) {
      expect(currentById.get(priorFunction.capabilityId)).toEqual(priorFunction);
    }
    const saved = validateCatalogDocument(
      JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/dforce-iusdt-idai/catalog.json'), 'utf8')),
    );
    const savedManifest = buildReviewedManifest([saved]);
    expect(savedManifest.capabilities).toHaveLength(previousManifest.capabilities.length + SPECIFICATIONS.length);
    expect(savedManifest.capabilities.filter(({ capabilityId }) => ALL_IDS.includes(capabilityId))).toHaveLength(SPECIFICATIONS.length);

    for (const spec of SPECIFICATIONS) {
      const fn = functions.get(spec.id)!;
      expect(fn).toMatchObject({
        capabilityId: spec.id,
        chainId: 1,
        contract: spec.target,
        functionName: spec.method,
        signature: spec.signature,
        status: 'active',
        provenance: { status: 'verified' },
        type: 'contract_call',
      });
      expect(fn.abi).toEqual(spec.abi);
      expect(fn.abi.stateMutability).toBe('nonpayable');
      expect(fn.abi.outputs).toEqual([]);
      expect(toFunctionSelector(fn.signature)).toBe(spec.selector);
      expect(functionAbiHash(fn)).toBe(spec.hash);
      expect(fn.executionScope).toBeUndefined();
    }
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter(({ executionScope }) => executionScope)).toEqual(
      previousManifest.capabilities.filter(({ executionScope }) => executionScope),
    );
    const profileIds = PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap(({ capabilityIds }) => capabilityIds);
    expect(new Set(profileIds).size).toBe(profileIds.length);
    for (const id of ALL_IDS) expect(profileIds).not.toContain(id);

    for (const spec of SPECIFICATIONS) {
      for (const address of [ZERO_ADDRESS, OTHER_ADDRESS]) {
        for (const amount of ['0', '1', MAX_UINT256]) {
          const authorization = await policy.authorizeContractCalls([tx(spec, spec.target, address, amount)], context([spec.id]));
          expect(authorization.matches).toEqual([
            expect.objectContaining({
              capabilityId: spec.id,
              chainId: 1,
              contract: spec.target,
              functionSignature: spec.signature,
              abiHash: spec.hash,
            }),
          ]);
          expect(address).not.toBe(EXECUTION_OWNER);
          await expect(policy.assertStillAuthorized(finalTx([spec.id]) as never, authorization)).resolves.toBeUndefined();
        }
      }
    }
  });

  it('requires independent exact grants and rejects peer markets, wrong chains, and malformed/nonpayable calls', async () => {
    for (const spec of SPECIFICATIONS) {
      const peerTarget = TARGETS.find((target) => target !== spec.target)!;
      const otherMethod: Method = spec.method === 'mint' ? 'redeem' : 'mint';
      const sameMarketPeer = SPECIFICATIONS.find(({ target, method }) => target === spec.target && method === otherMethod)!;
      const otherMarketSameMethod = SPECIFICATIONS.find(({ target, method }) => target === peerTarget && method === spec.method)!;
      for (const grants of [[], ['unrelated'], [sameMarketPeer.id], [otherMarketSameMethod.id], previousCapabilityIds]) {
        await expect(policy.authorizeContractCalls([tx(spec)], context(grants))).rejects.toMatchObject({
          audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
        });
      }
      await expect(policy.authorizeContractCalls([tx(sameMarketPeer)], context([spec.id]))).rejects.toMatchObject({
        audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
      });
      for (const wrongTarget of [...TARGETS.filter((target) => target !== spec.target), PRIOR_DFORCE_TARGET]) {
        await expect(policy.authorizeContractCalls([tx(spec, wrongTarget)], context([spec.id]))).rejects.toMatchObject({
          audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
        });
      }
      for (const wrongTarget of ['0x1111111111111111111111111111111111111111']) {
        await expect(policy.authorizeContractCalls([tx(spec, wrongTarget)], context([spec.id]))).rejects.toMatchObject({
          audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' },
        });
      }
      await expect(policy.authorizeContractCalls([tx(spec)], context([spec.id], 10))).rejects.toMatchObject({
        audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' },
      });

      const validData = calldata(spec, OTHER_ADDRESS, '1');
      const malformedAddress = `${spec.selector}01${'00'.repeat(31)}${'00'.repeat(32)}`;
      const unknownSelector = toFunctionSelector(
        spec.method === 'mint' ? 'redeemUnderlying(address,uint256)' : 'mintForSelfAndEnterMarket(uint256)',
      );
      for (const data of ['0x', '0xdeadbeef', unknownSelector]) {
        await expect(policy.authorizeContractCalls([tx(spec, spec.target, OTHER_ADDRESS, '1', '0', data)], context([spec.id]))).rejects.toMatchObject({
          audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' },
        });
      }
      for (const data of [spec.selector, `${spec.selector}${'00'.repeat(31)}`, `${validData}00`, malformedAddress]) {
        await expect(policy.authorizeContractCalls([tx(spec, spec.target, OTHER_ADDRESS, '1', '0', data)], context([spec.id]))).rejects.toMatchObject({
          audit: { code: 'DEFI_INVALID_PARAMETERS' },
        });
      }
      await expect(policy.authorizeContractCalls([tx(spec, spec.target, OTHER_ADDRESS, '1', '1')], context([spec.id]))).rejects.toMatchObject({
        audit: { code: 'DEFI_INVALID_PARAMETERS' },
      });
    }
  });

  it('rechecks all four methods under ordered tagged SQL locks and rejects grant, pause, key, and commitment mutations', async () => {
    for (const spec of SPECIFICATIONS) {
      const otherId = SPECIFICATIONS.find(({ target, method }) => target === spec.target && method !== spec.method)!.id;
      const authorization = await policy.authorizeContractCalls([tx(spec, spec.target, OTHER_ADDRESS, MAX_UINT256)], context([spec.id]));
      const liveTx = finalTx([spec.id]);
      await expect(policy.assertStillAuthorized(liveTx as never, authorization)).resolves.toBeUndefined();
      const locks = liveTx.$queryRaw.mock.calls;
      expect(locks).toHaveLength(2);
      expect(locks[0][0].join('')).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
      expect(locks[1][0].join('')).toContain('SELECT id FROM api_keys WHERE id = ');
      expect(locks[1][0].join('')).toContain('FOR UPDATE');
      expect(locks[1][1]).toBe(KEY_ID);

      await expect(policy.assertStillAuthorized(finalTx([otherId]) as never, authorization)).rejects.toMatchObject({
        audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
      });
      await expect(policy.assertStillAuthorized(finalTx([spec.id], ['global']) as never, authorization)).rejects.toMatchObject({
        audit: { code: 'DEFI_CAPABILITY_PAUSED' },
      });
      await expect(policy.assertStillAuthorized(finalTx([spec.id], [`capability:${spec.id}`]) as never, authorization)).rejects.toMatchObject({
        audit: { code: 'DEFI_CAPABILITY_PAUSED' },
      });
      for (const keyState of [
        { revoked: true },
        { frozenAt: new Date() },
        { expiresAt: new Date(Date.now() - 60_000) },
        { canSendTransaction: false },
      ]) {
        await expect(policy.assertStillAuthorized(finalTx([spec.id], [], keyState) as never, authorization)).rejects.toMatchObject({
          audit: { code: 'DEFI_POLICY_UNAVAILABLE' },
        });
      }

      const changed = [
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: TARGETS.find((target) => target !== spec.target)! }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], data: '0xdeadbeef' }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
        { ...authorization, manifestHash: `0x${'00'.repeat(32)}` },
        { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
        {
          ...authorization,
          executionPlan: authorization.executionPlan.map((node) => ({
            ...node,
            match: { ...node.match, capabilityId: otherId },
          })),
        },
        {
          ...authorization,
          executionPlan: authorization.executionPlan.map((node) => ({
            ...node,
            match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` },
          })),
        },
        { ...authorization, matches: authorization.matches.map((match) => ({ ...match, abiHash: `0x${'00'.repeat(32)}` })) },
      ];
      for (const mutated of changed) {
        await expect(policy.assertStillAuthorized(finalTx([spec.id]) as never, mutated as never)).rejects.toMatchObject({
          audit: { code: 'DEFI_POLICY_UNAVAILABLE' },
        });
      }
    }
  });
});
