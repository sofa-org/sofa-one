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

const TARGET = '0x2f956b2f801c6dad74e87e7f45c94f6283bf0f45';
const MINT_ID = `dforce-itoken:v2:1:${TARGET}:mint`;
const REDEEM_ID = `dforce-itoken:v2:1:${TARGET}:redeem`;
const KEY_ID = '00000000-0000-4000-8000-000000000230';
const USER = 'dforce-iusdc-policy-test';
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
const FUNCTIONS = {
  mint: {
    id: MINT_ID,
    signature: 'mint(address,uint256)',
    selector: '0x40c10f19',
    hash: '0x9fc0f7364ccf5669b21ae3da6d102e41ee47dde89768d65b19550ed745f7fb4a',
    abi: MINT_ABI,
  },
  redeem: {
    id: REDEEM_ID,
    signature: 'redeem(address,uint256)',
    selector: '0x1e9a6950',
    hash: '0x7b00a8c11f3db3cc93aec1dbe34ac479746e38ddf47871763ba61e4bf1f93b7a',
    abi: REDEEM_ABI,
  },
} as const;
const MAX_UINT256 = ((1n << 256n) - 1n).toString();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';
const EXECUTION_OWNER = '0x9999999999999999999999999999999999999999';
const PREVIOUS_CATALOG_PATH = 'data/defi-catalog/updates/yieldnest-yneth-deposit/catalog.json';
const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, db as never, PRODUCTION_DEFI_MANIFEST);
const policy = new DefiPolicyService(db as never, {} as never, catalog);
const functions = Object.fromEntries(
  Object.entries(FUNCTIONS).map(([name, spec]) => [
    name,
    PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.capabilityId === spec.id) as DefiFunctionPolicy,
  ]),
) as Record<keyof typeof FUNCTIONS, DefiFunctionPolicy>;
const previousManifest = buildReviewedManifest([
  validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), PREVIOUS_CATALOG_PATH), 'utf8'))),
]);
const previousCapabilityIds = previousManifest.capabilities.map((candidate) => candidate.capabilityId);

function context(grants: string[] = [MINT_ID, REDEEM_ID], chainId = 1): DefiExecutionContext {
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

function calldata(name: keyof typeof FUNCTIONS, address: string, amount: string): string {
  const spec = FUNCTIONS[name];
  const args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [address as `0x${string}`, BigInt(amount)],
  );
  return `${spec.selector}${args.slice(2)}`;
}

function tx(name: keyof typeof FUNCTIONS, address = OTHER_ADDRESS, amount = '1', value = '0', data = calldata(name, address, amount)) {
  return { to: TARGET, value, data };
}

function finalTx(
  grants: string[],
  pausedScopeKeys: string[] = [],
  keyOverrides: Record<string, unknown> = {},
) {
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

describe('dForce mainnet iUSDC iTokenV2BLP ordinary mint/redeem additions', () => {
  it('preserves all prior full function objects and admits only the two exact nonpayable ABIs', async () => {
    const expected = loadCurrentProductionExpectations(process.cwd());
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(expected.definitions);
    const currentById = new Map(PRODUCTION_DEFI_MANIFEST.capabilities.map((candidate) => [candidate.capabilityId, candidate]));
    for (const priorFunction of previousManifest.capabilities) {
      expect(currentById.get(priorFunction.capabilityId)).toEqual(priorFunction);
    }

    const savedUpdate = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/updates/dforce-iusdc/catalog.json'), 'utf8')));
    const savedUpdateManifest = buildReviewedManifest([savedUpdate]);
    expect(savedUpdateManifest.capabilities).toHaveLength(previousManifest.capabilities.length + 2);
    expect(savedUpdateManifest.capabilities.filter((candidate) => [MINT_ID, REDEEM_ID].includes(candidate.capabilityId)).map((candidate) => candidate.capabilityId)).toEqual([MINT_ID, REDEEM_ID]);

    for (const name of Object.keys(FUNCTIONS) as (keyof typeof FUNCTIONS)[]) {
      const spec = FUNCTIONS[name];
      const fn = functions[name];
      expect(fn).toMatchObject({
        capabilityId: spec.id,
        chainId: 1,
        contract: TARGET,
        functionName: name,
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

    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((candidate) => candidate.executionScope && candidate.capabilityId !== 'polymarket-pusd:v1:137:0x93070a847efef7f70739046a929d47a521f5b8ee:wrap')).toEqual(
      previousManifest.capabilities.filter((candidate) => candidate.executionScope),
    );
    const profileMembers = PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap((profile) => profile.capabilityIds);
    expect(new Set(profileMembers).size).toBe(profileMembers.length);
    expect(profileMembers).not.toContain(MINT_ID);
    expect(profileMembers).not.toContain(REDEEM_ID);

    for (const name of Object.keys(FUNCTIONS) as (keyof typeof FUNCTIONS)[]) {
      const otherName = name === 'mint' ? 'redeem' : 'mint';
      const spec = FUNCTIONS[name];
      for (const address of [ZERO_ADDRESS, OTHER_ADDRESS]) {
        for (const amount of ['0', '1', MAX_UINT256]) {
          const authorization = await policy.authorizeContractCalls([tx(name, address, amount)], context([spec.id]));
          expect(authorization.matches).toEqual([
            expect.objectContaining({
              capabilityId: spec.id,
              chainId: 1,
              contract: TARGET,
              functionSignature: spec.signature,
              abiHash: spec.hash,
            }),
          ]);
          expect(address).not.toBe(EXECUTION_OWNER);
          await expect(policy.assertStillAuthorized(finalTx([spec.id]) as never, authorization)).resolves.toBeUndefined();
        }
      }
      expect(otherName).not.toBe(name);
    }
  });

  it('requires independent exact grants and rejects wrong chain/targets, other methods, and malformed calls', async () => {
    for (const name of Object.keys(FUNCTIONS) as (keyof typeof FUNCTIONS)[]) {
      const spec = FUNCTIONS[name];
      const otherName = name === 'mint' ? 'redeem' : 'mint';
      const otherId = FUNCTIONS[otherName].id;
      const address = OTHER_ADDRESS;
      for (const grants of [[], ['unrelated'], [otherId], previousCapabilityIds]) {
        await expect(policy.authorizeContractCalls([tx(name)], context(grants))).rejects.toMatchObject({
          audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
        });
      }
      const otherMethodCall = tx(otherName, address, '1');
      await expect(policy.authorizeContractCalls([otherMethodCall], context([spec.id]))).rejects.toMatchObject({
        audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
      });

      await expect(policy.authorizeContractCalls([tx(name)], context([spec.id], 10))).rejects.toMatchObject({
        audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' },
      });
      await expect(policy.authorizeContractCalls([{ ...tx(name), to: '0x1180c114f7fadcb6957670432a3cf8ef08ab5354' }], context([spec.id]))).rejects.toMatchObject({
        audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' },
      });
      await expect(policy.authorizeContractCalls([{ ...tx(name), to: '0x1111111111111111111111111111111111111111' }], context([spec.id]))).rejects.toMatchObject({
        audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' },
      });

      const validData = calldata(name, address, '1');
      const malformedAddress = `${spec.selector}01${'00'.repeat(31)}${'00'.repeat(32)}`;
      const otherSignatureSelector = toFunctionSelector(name === 'mint' ? 'redeemUnderlying(address,uint256)' : 'mintForSelfAndEnterMarket(uint256)');
      for (const data of ['0x', '0xdeadbeef', otherSignatureSelector]) {
        await expect(policy.authorizeContractCalls([tx(name, address, '1', '0', data)], context([spec.id]))).rejects.toMatchObject({
          audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' },
        });
      }
      for (const data of [
        spec.selector,
        `${spec.selector}${'00'.repeat(31)}`,
        `${validData}00`,
        malformedAddress,
      ]) {
        await expect(policy.authorizeContractCalls([tx(name, address, '1', '0', data)], context([spec.id]))).rejects.toMatchObject({
          audit: { code: 'DEFI_INVALID_PARAMETERS' },
        });
      }
      await expect(policy.authorizeContractCalls([tx(name, address, '1', '1')], context([spec.id]))).rejects.toMatchObject({
        audit: { code: 'DEFI_INVALID_PARAMETERS' },
      });
    }
  });

  it('rechecks both methods under ordered tagged SQL locks and rejects grant, pause, key, and binding changes', async () => {
    for (const name of Object.keys(FUNCTIONS) as (keyof typeof FUNCTIONS)[]) {
      const spec = FUNCTIONS[name];
      const otherId = name === 'mint' ? REDEEM_ID : MINT_ID;
      const authorization = await policy.authorizeContractCalls([tx(name, OTHER_ADDRESS, MAX_UINT256)], context([spec.id]));
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

      const altered = [
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: '0x1180c114f7fadcb6957670432a3cf8ef08ab5354' }] },
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
        {
          ...authorization,
          matches: authorization.matches.map((match) => ({ ...match, abiHash: `0x${'00'.repeat(32)}` })),
        },
      ];
      for (const changed of altered) {
        await expect(policy.assertStillAuthorized(finalTx([spec.id]) as never, changed as never)).rejects.toMatchObject({
          audit: { code: 'DEFI_POLICY_UNAVAILABLE' },
        });
      }
    }
  });
});
