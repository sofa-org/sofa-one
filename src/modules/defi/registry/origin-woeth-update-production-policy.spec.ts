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

const TARGET = '0xdcee70654261af21c44c093c300ed3bb97b78192';
const KEY_ID = '00000000-0000-4000-8000-000000000232';
const USER = 'origin-woeth-policy-test';
const ABIS = {
  deposit: {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { internalType: 'uint256', name: 'assets', type: 'uint256' },
      { internalType: 'address', name: 'receiver', type: 'address' },
    ],
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
  },
  mint: {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { internalType: 'uint256', name: 'shares', type: 'uint256' },
      { internalType: 'address', name: 'receiver', type: 'address' },
    ],
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
  },
  withdraw: {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { internalType: 'uint256', name: 'assets', type: 'uint256' },
      { internalType: 'address', name: 'receiver', type: 'address' },
      { internalType: 'address', name: 'owner', type: 'address' },
    ],
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
  },
  redeem: {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      { internalType: 'uint256', name: 'shares', type: 'uint256' },
      { internalType: 'address', name: 'receiver', type: 'address' },
      { internalType: 'address', name: 'owner', type: 'address' },
    ],
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
  },
} as const;
const FUNCTION_IDENTITIES = {
  deposit: {
    signature: 'deposit(uint256,address)',
    selector: '0x6e553f65',
    hash: '0xacc854348209f31ec6382ea494bded763103e2bbb72cd2578ce1b67ad42044da',
  },
  mint: {
    signature: 'mint(uint256,address)',
    selector: '0x94bf804d',
    hash: '0x6bba0dc0de55f693e4d005c0d24062fa3d723c34f88d39a600586539d56a58fe',
  },
  withdraw: {
    signature: 'withdraw(uint256,address,address)',
    selector: '0xb460af94',
    hash: '0x4d73ece13f94d17f5eca74b24410ce392155416a778c2c2907a6adf6fa7d58a1',
  },
  redeem: {
    signature: 'redeem(uint256,address,address)',
    selector: '0xba087652',
    hash: '0x4e30a5bc7aad2410da25c5cb80c93570e3d36436daa197a7b41c656fbad2d3dd',
  },
} as const;
type Method = keyof typeof ABIS;
const SPECIFICATIONS = (Object.keys(ABIS) as Method[]).map((method) => ({
  method,
  target: TARGET,
  id: `origin-woeth:v1:1:${TARGET}:${method}`,
  abi: ABIS[method],
  ...FUNCTION_IDENTITIES[method],
}));
type Spec = (typeof SPECIFICATIONS)[number];
const ALL_IDS = SPECIFICATIONS.map(({ id }) => id);
const MAX_UINT256 = ((1n << 256n) - 1n).toString();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';
const EXECUTION_OWNER = '0x9999999999999999999999999999999999999999';
const KNOWN_OTHER_VAULT = '0x2f956b2f801c6dad74e87e7f45c94f6283bf0f45';
const PREVIOUS_CATALOG_PATH = 'data/defi-catalog/updates/dforce-iusdt-idai/catalog.json';
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

function calldata(spec: Spec, amount: string, receiver: string, owner = OTHER_ADDRESS): string {
  const values = spec.method === 'withdraw' || spec.method === 'redeem'
    ? [BigInt(amount), receiver as `0x${string}`, owner as `0x${string}`]
    : [BigInt(amount), receiver as `0x${string}`];
  const encoded = encodeAbiParameters(spec.abi.inputs as never, values as never);
  return `${spec.selector}${encoded.slice(2)}`;
}

function tx(spec: Spec, target = spec.target, amount = '1', receiver = OTHER_ADDRESS, owner = OTHER_ADDRESS, value = '0', data = calldata(spec, amount, receiver, owner)) {
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

describe('Origin WOETH inherited ERC4626 ordinary methods', () => {
  it('preserves all prior function objects and admits exactly four full ABI identities', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    const currentById = new Map(PRODUCTION_DEFI_MANIFEST.capabilities.map((candidate) => [candidate.capabilityId, candidate]));
    for (const priorFunction of previousManifest.capabilities) {
      expect(currentById.get(priorFunction.capabilityId)).toEqual(priorFunction);
    }
    const saved = validateCatalogDocument(
      JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/origin-woeth/catalog.json'), 'utf8')),
    );
    const savedManifest = buildReviewedManifest([saved]);
    expect(savedManifest.capabilities).toHaveLength(previousManifest.capabilities.length + SPECIFICATIONS.length);
    expect(savedManifest.capabilities.filter(({ capabilityId }) => ALL_IDS.includes(capabilityId))).toHaveLength(SPECIFICATIONS.length);

    for (const spec of SPECIFICATIONS) {
      const fn = functions.get(spec.id)!;
      expect(fn).toMatchObject({
        capabilityId: spec.id,
        chainId: 1,
        contract: TARGET,
        functionName: spec.method,
        signature: spec.signature,
        status: 'active',
        provenance: { status: 'verified' },
        type: 'contract_call',
      });
      expect(fn.abi).toEqual(spec.abi);
      expect(fn.abi.stateMutability).toBe('nonpayable');
      expect(fn.abi.outputs).toEqual([{ internalType: 'uint256', name: '', type: 'uint256' }]);
      expect(toFunctionSelector(fn.signature)).toBe(spec.selector);
      expect(functionAbiHash(fn)).toBe(spec.hash);
      expect(fn.executionScope).toBeUndefined();
    }
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter(({ executionScope, capabilityId }) => executionScope && capabilityId !== 'polymarket-pusd:v1:137:0x93070a847efef7f70739046a929d47a521f5b8ee:wrap')).toEqual(
      previousManifest.capabilities.filter(({ executionScope }) => executionScope),
    );
    const profileIds = PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap(({ capabilityIds }) => capabilityIds);
    expect(new Set(profileIds).size).toBe(profileIds.length);
    for (const id of ALL_IDS) expect(profileIds).not.toContain(id);

    for (const spec of SPECIFICATIONS) {
      for (const amount of ['0', '1', MAX_UINT256]) {
        for (const receiver of [ZERO_ADDRESS, OTHER_ADDRESS]) {
          const owners = spec.method === 'withdraw' || spec.method === 'redeem' ? [ZERO_ADDRESS, OTHER_ADDRESS] : [OTHER_ADDRESS];
          for (const owner of owners) {
            const authorization = await policy.authorizeContractCalls(
              [tx(spec, spec.target, amount, receiver, owner)],
              context([spec.id]),
            );
            expect(authorization.matches).toEqual([
              expect.objectContaining({
                capabilityId: spec.id,
                chainId: 1,
                contract: TARGET,
                functionSignature: spec.signature,
                abiHash: spec.hash,
              }),
            ]);
            expect(receiver).not.toBe(EXECUTION_OWNER);
            if (spec.method === 'withdraw' || spec.method === 'redeem') expect(owner).not.toBe(EXECUTION_OWNER);
            await expect(policy.assertStillAuthorized(finalTx([spec.id]) as never, authorization)).resolves.toBeUndefined();
          }
        }
      }
    }
  });

  it('requires an independent exact grant and rejects other methods, old grants, wrong targets/chains, and malformed calls', async () => {
    for (const spec of SPECIFICATIONS) {
      const otherSpecs = SPECIFICATIONS.filter(({ id }) => id !== spec.id);
      for (const grants of [[], ['unrelated'], ...otherSpecs.map(({ id }) => [id]), previousCapabilityIds]) {
        await expect(policy.authorizeContractCalls([tx(spec)], context(grants))).rejects.toMatchObject({
          audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
        });
      }
      for (const other of otherSpecs) {
        await expect(policy.authorizeContractCalls([tx(other)], context([spec.id]))).rejects.toMatchObject({
          audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
        });
      }
      await expect(policy.authorizeContractCalls([tx(spec)], context([spec.id], 10))).rejects.toMatchObject({
        audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' },
      });
      await expect(policy.authorizeContractCalls([tx(spec, KNOWN_OTHER_VAULT)], context([spec.id]))).rejects.toMatchObject({
        audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' },
      });
      await expect(policy.authorizeContractCalls([tx(spec, '0x1111111111111111111111111111111111111111')], context([spec.id]))).rejects.toMatchObject({
        audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' },
      });

      const validData = calldata(spec, '1', OTHER_ADDRESS, OTHER_ADDRESS);
      const words = validData.slice(10).match(/.{64}/g)!;
      words[1] = `01${'00'.repeat(31)}`;
      const malformedAddress = `${spec.selector}${words.join('')}`;
      for (const data of ['0x', '0xdeadbeef', '0x12345678']) {
        await expect(policy.authorizeContractCalls([tx(spec, TARGET, '1', OTHER_ADDRESS, OTHER_ADDRESS, '0', data)], context([spec.id]))).rejects.toMatchObject({
          audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' },
        });
      }
      for (const data of [spec.selector, `${spec.selector}${'00'.repeat(31)}`, `${validData}00`, malformedAddress]) {
        await expect(policy.authorizeContractCalls([tx(spec, TARGET, '1', OTHER_ADDRESS, OTHER_ADDRESS, '0', data)], context([spec.id]))).rejects.toMatchObject({
          audit: { code: 'DEFI_INVALID_PARAMETERS' },
        });
      }
      await expect(policy.authorizeContractCalls([tx(spec, TARGET, '1', OTHER_ADDRESS, OTHER_ADDRESS, '1')], context([spec.id]))).rejects.toMatchObject({
        audit: { code: 'DEFI_INVALID_PARAMETERS' },
      });
    }
  });

  it('rechecks every method under ordered tagged SQL locks and rejects grant, pause, key, and binding mutations', async () => {
    for (const spec of SPECIFICATIONS) {
      const otherId = SPECIFICATIONS.find(({ id }) => id !== spec.id)!.id;
      const authorization = await policy.authorizeContractCalls(
        [tx(spec, TARGET, MAX_UINT256, OTHER_ADDRESS, OTHER_ADDRESS)],
        context([spec.id]),
      );
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
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: KNOWN_OTHER_VAULT }] },
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
