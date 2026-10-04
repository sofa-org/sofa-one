import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector } from 'viem';
import type { Hex } from 'viem';
import { PrismaService } from '../../../core/database/prisma.service';
import { SecurityEventService } from '../../security-events/security-event.service';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import type { DefiExecutionContext } from '../defi.types';
import { ENSO_STATIC_WEIROLL_CHILD_IDENTITIES, ENSO_STATIC_WEIROLL_ROOT_IDENTITY } from './enso-identity';
import { GENERATED_DEFI_REGISTRY } from '../registry/generated/production-catalog';
import { buildReviewedManifest } from '../registry/defi-manifest';

const encodeFn = encodeFunctionData as (parameters: any) => Hex;
const parseDynamicAbi = parseAbi as unknown as (signatures: string[]) => any;
const ROOT_ABI = parseAbi(['function routeSingle((uint8 tokenType, bytes data) tokenIn, bytes data) payable returns (bytes response)']);
const SHORTCUT_ABI = parseAbi(['function executeShortcut(bytes32 accountId, bytes32 requestId, bytes32[] commands, bytes[] state)']);
const MAX = (1n << 256n) - 1n;
const rootId = ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId;
const childIds = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.map((child) => child.capabilityId);
const allGrants = [rootId, ...childIds];
const owner = '0x0000000000000000000000000000000000000002';
const apiKeyId = '00000000-0000-4000-8000-000000000001';
const context: DefiExecutionContext = { userId: 'user', apiKeyId, walletId: 'wallet', chainId: 1, executionMode: 'session_key', executionOwner: owner, allowedCapabilityIds: allGrants };
const manifest = buildReviewedManifest([GENERATED_DEFI_REGISTRY]);
const prismaMock = (pausedScopeKeys: string[] = []) => ({ defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) } });
function makePolicy(pausedScopeKeys: string[] = [], events = { record: jest.fn().mockResolvedValue(undefined) }) {
  const prisma = prismaMock(pausedScopeKeys);
  const catalog = new DefiCatalogService(manifest.chains, prisma as unknown as PrismaService, manifest);
  return { policy: new DefiPolicyService(prisma as unknown as PrismaService, events as unknown as SecurityEventService, catalog), prisma, events };
}

function childData(index: number, overrides: Record<string, unknown> = {}): Hex {
  const child = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[index];
  const abi = parseDynamicAbi([`function ${child.signature}`]);
  if (index === 0) return encodeFn({ abi, functionName: 'exactInputSingle', args: [[
    overrides.tokenIn ?? `0x${'11'.repeat(20)}`, overrides.tokenOut ?? `0x${'22'.repeat(20)}`, overrides.fee ?? 3000,
    overrides.recipient ?? `0x${'33'.repeat(20)}`, overrides.amountIn ?? 1n, overrides.amountOutMinimum ?? 2n, overrides.sqrtPriceLimitX96 ?? 0n,
  ]] });
  if (index === 1) return encodeFn({ abi, functionName: 'supply', args: [overrides.asset ?? `0x${'11'.repeat(20)}`, overrides.amount ?? 2n, overrides.onBehalfOf ?? `0x${'22'.repeat(20)}`, overrides.referralCode ?? 0] });
  return encodeFn({ abi, functionName: 'approve', args: [overrides.spender ?? `0x${'22'.repeat(20)}`, overrides.amount ?? 3n] });
}

function cmd(index: number, flag: 0x21 | 0x23, stateIndex: number, overrides: { target?: string; signature?: string; header?: string; output?: number; indices?: number[] } = {}): Hex {
  const child = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[index];
  const header = overrides.header ?? `0x${selector(overrides.signature ?? child.signature).slice(2)}`;
  const fields = overrides.indices ?? (flag === 0x21 ? [stateIndex, 255, 255, 255, 255, 255] : [stateIndex, stateIndex + 1, 255, 255, 255, 255]);
  return `0x${header.slice(2)}${flag.toString(16)}${fields.map((item) => item.toString(16).padStart(2, '0')).join('')}${(overrides.output ?? 255).toString(16).padStart(2, '0')}${(overrides.target ?? child.contract).slice(2)}` as Hex;
}
function selector(signature: string): Hex { return toFunctionSelector(signature); }
function shortcut(commands: Hex[], state: Hex[]): Hex { return encodeFn({ abi: SHORTCUT_ABI, functionName: 'executeShortcut', args: [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, commands, state] }); }
function root(tokenType: 0 | 1, commands: Hex[], state: Hex[], amount = 0n, value = 0n): { to: string; data: Hex; value: string } {
  const tokenData = tokenType === 0
    ? encodeAbiParameters(parseAbiParameters('uint256'), [amount])
    : encodeAbiParameters(parseAbiParameters('address, uint256'), [`0x${'44'.repeat(20)}`, amount]);
  return { to: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.contract, data: encodeFn({ abi: ROOT_ABI, functionName: 'routeSingle', args: [{ tokenType, data: tokenData }, shortcut(commands, state)] }), value: value.toString() };
}
function finalTx(grants = allGrants, pausedScopeKeys: string[] = []) {
  return {
    $queryRaw: jest.fn(),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: 'user', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants }) },
  };
}

describe('Enso static Weiroll policy integration', () => {
  it('authorizes exact canonical native and ERC-20 roots with granted swap, lending, and approval children', async () => {
    const allCalls = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.map((_, index) => childData(index));
    const commands = allCalls.map((_, index) => cmd(index, 0x21, index));
    const native = root(0, commands, allCalls, 7n, 7n);
    const { policy } = makePolicy();
    const authorization = await policy.authorizeContractCalls([native], context);
    expect(authorization.executionPlan.map((node) => node.match.capabilityId)).toEqual([rootId, ...childIds]);
    expect(authorization.executionPlan.map((node) => node.path)).toEqual([[0], [0, 0], [0, 1], [0, 2]]);
    await expect(policy.assertStillAuthorized(finalTx() as never, authorization)).resolves.toBeUndefined();
    const erc20 = root(1, commands, allCalls, 999n, 0n);
    const erc20Authorization = await policy.authorizeContractCalls([erc20], context);
    expect(erc20Authorization.executionPlan.map((node) => node.match.capabilityId)).toEqual([rootId, ...childIds]);
    await expect(policy.assertStillAuthorized(finalTx() as never, erc20Authorization)).resolves.toBeUndefined();
  });

  it('accepts CALL/VALUECALL through payable children and preserves full uint256 values and sums above root value', async () => {
    const state = [encodeAbiParameters(parseAbiParameters('uint256'), [MAX]), childData(0), childData(1), childData(2)];
    const commands = [cmd(0, 0x23, 0), cmd(1, 0x21, 2), cmd(2, 0x21, 3)];
    const { policy } = makePolicy();
    const authorization = await policy.authorizeContractCalls([root(1, commands, state, 1n, 0n)], context);
    expect(authorization.executionPlan.slice(1).map((node) => node.match.nativeValue)).toEqual([MAX.toString(), '0', '0']);
    const overRoot = root(1, [cmd(0, 0x23, 0)], [encodeAbiParameters(parseAbiParameters('uint256'), [1n]), childData(0)], 2n, 0n);
    await expect(policy.authorizeContractCalls([overRoot], context)).resolves.toBeDefined();
    const allMax = root(1, [cmd(0, 0x23, 0), cmd(0, 0x23, 2)], [encodeAbiParameters(parseAbiParameters('uint256'), [MAX]), childData(0), encodeAbiParameters(parseAbiParameters('uint256'), [MAX]), childData(0)], 2n, 0n);
    const maxAuthorization = await policy.authorizeContractCalls([allMax], context);
    expect(maxAuthorization.executionPlan.slice(1).map((node) => node.match.nativeValue)).toEqual([MAX.toString(), MAX.toString()]);
    await expect(policy.assertStillAuthorized(finalTx() as never, maxAuthorization)).resolves.toBeUndefined();
    const events = { record: jest.fn().mockResolvedValue(undefined) };
    await makePolicy([], events).policy.recordAllowedInTx({} as never, maxAuthorization);
    expect(events.record.mock.calls[0][0].metadata.ensoRoots[0].childValueSum).toBe((MAX * 2n).toString());
  });

  it('accepts caller-chosen full-width ABI values and arbitrary recipient, spender, and on-behalf-of addresses', async () => {
    const maxUint24 = (1 << 24) - 1;
    const maxUint16 = (1 << 16) - 1;
    const maxUint160 = (1n << 160n) - 1n;
    const uniswap = childData(0, { tokenIn: `0x${'99'.repeat(20)}`, tokenOut: `0x${'88'.repeat(20)}`, fee: maxUint24, recipient: `0x${'77'.repeat(20)}`, amountIn: MAX, amountOutMinimum: MAX, sqrtPriceLimitX96: maxUint160 });
    const aave = childData(1, { asset: `0x${'66'.repeat(20)}`, amount: MAX, onBehalfOf: `0x${'55'.repeat(20)}`, referralCode: maxUint16 });
    const approval = childData(2, { spender: `0x${'44'.repeat(20)}`, amount: MAX });
    const commands = [0, 1, 2].map((index) => cmd(index, 0x21, index));
    const { policy } = makePolicy();
    const authorization = await policy.authorizeContractCalls([root(1, commands, [uniswap, aave, approval], 1n)], context);
    expect(authorization.executionPlan).toHaveLength(4);
    await expect(policy.assertStillAuthorized(finalTx() as never, authorization)).resolves.toBeUndefined();
  });

  it('requires independent grants and applies active catalog, pause, and payability checks to each child', async () => {
    const data = root(1, ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.map((_, index) => cmd(index, 0x21, index)), [0, 1, 2].map((index) => childData(index)), 1n, 0n);
    const { policy } = makePolicy();
    for (const id of allGrants) {
      await expect(policy.authorizeContractCalls([data], { ...context, allowedCapabilityIds: allGrants.filter((grant) => grant !== id) })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
    for (const index of [1, 2]) {
      const nonPayable = root(1, [cmd(index, 0x23, 0)], [encodeAbiParameters(parseAbiParameters('uint256'), [1n]), childData(index)], 1n, 0n);
      await expect(policy.authorizeContractCalls([nonPayable], context)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
    for (const id of allGrants) {
      const pausedPolicy = makePolicy([`capability:${id}`]).policy;
      await expect(pausedPolicy.authorizeContractCalls([data], context)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    }
    await expect(policy.authorizeContractCalls([data], { ...context, allowedCapabilityIds: [] })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([data], { ...context, allowedCapabilityIds: ['unrelated:grant'] })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('enforces root plus child node budgets across single and aggregate roots without constraining child value sums', async () => {
    const commands9 = Array.from({ length: 9 }, (_, index) => cmd(0, 0x21, index));
    const state9 = Array.from({ length: 9 }, () => childData(0));
    const { policy } = makePolicy();
    const maxSingle = await policy.authorizeContractCalls([root(1, commands9, state9, 1n)], context);
    expect(maxSingle.executionPlan).toHaveLength(10);
    expect(maxSingle.executionPlan.map((node) => node.path)).toEqual([[0], ...Array.from({ length: 9 }, (_, index) => [0, index])]);
    const commands10 = [...commands9, cmd(0, 0x21, 9)];
    await expect(policy.authorizeContractCalls([root(1, commands10, [...state9, childData(0)], 1n)], context)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const four = root(1, commands9.slice(0, 4), state9.slice(0, 4), 1n);
    const exactlyTen = await policy.authorizeContractCalls([four, four], context);
    expect(exactlyTen.executionPlan).toHaveLength(10);
    const five = root(1, commands9.slice(0, 5), state9.slice(0, 5), 1n);
    await expect(policy.authorizeContractCalls([five, four], context)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const ordinaryApproval = { to: ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[2].contract, data: childData(2) };
    const rootFiveNodes = root(1, commands9.slice(0, 4), state9.slice(0, 4), 1n);
    const withFiveSiblings = await policy.authorizeContractCalls([rootFiveNodes, ordinaryApproval, ordinaryApproval, ordinaryApproval, ordinaryApproval, ordinaryApproval], context);
    expect(withFiveSiblings.executionPlan).toHaveLength(10);
    await expect(policy.authorizeContractCalls([rootFiveNodes, ordinaryApproval, ordinaryApproval, ordinaryApproval, ordinaryApproval, ordinaryApproval, ordinaryApproval], context)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('rechecks all root and child grants, pause, key state, and ordered plan under final locks', async () => {
    const interaction = root(1, ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.map((_, index) => cmd(index, 0x21, index)), [0, 1, 2].map((index) => childData(index)), 1n);
    const { policy } = makePolicy();
    const authorization = await policy.authorizeContractCalls([interaction], context);
    const tx = finalTx();
    await expect(policy.assertStillAuthorized(tx as never, authorization)).resolves.toBeUndefined();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    const lockQueries = tx.$queryRaw.mock.calls.map(([strings]) => strings.join(' ').replace(/\s+/g, ' ').trim());
    expect(lockQueries[0]).toContain('defi_policy_state');
    expect(lockQueries[0]).toContain('FOR SHARE');
    expect(lockQueries[1]).toContain('api_keys');
    expect(lockQueries[1]).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.calls[1][1]).toBe(apiKeyId);
    for (const id of allGrants) {
      const changed = finalTx(allGrants.filter((grant) => grant !== id));
      await expect(policy.assertStillAuthorized(changed as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
    for (const id of allGrants) {
      const fn = manifest.capabilities.find((candidate) => candidate.capabilityId === id)!;
      const scopeKey = `capability:${id}`;
      const changed = finalTx(allGrants, [scopeKey]);
      await expect(policy.assertStillAuthorized(changed as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
      expect(fn).toBeDefined();
    }
    const revoked = finalTx();
    revoked.apiKey.findUnique.mockResolvedValue({ userId: 'user', revoked: true, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: allGrants });
    await expect(policy.assertStillAuthorized(revoked as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const frozen = finalTx();
    frozen.apiKey.findUnique.mockResolvedValue({ userId: 'user', revoked: false, frozenAt: new Date(), expiresAt: null, canSendTransaction: true, allowedCapabilityIds: allGrants });
    await expect(policy.assertStillAuthorized(frozen as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const expired = finalTx();
    expired.apiKey.findUnique.mockResolvedValue({ userId: 'user', revoked: false, frozenAt: null, expiresAt: new Date(0), canSendTransaction: true, allowedCapabilityIds: allGrants });
    await expect(policy.assertStillAuthorized(expired as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const wrongOwner = finalTx();
    wrongOwner.apiKey.findUnique.mockResolvedValue({ userId: 'other', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: allGrants });
    await expect(policy.assertStillAuthorized(wrongOwner as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const noSend = finalTx();
    noSend.apiKey.findUnique.mockResolvedValue({ userId: 'user', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: false, allowedCapabilityIds: allGrants });
    await expect(policy.assertStillAuthorized(noSend as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(policy.assertStillAuthorized(tx as never, { ...authorization, executionPlan: authorization.executionPlan.slice(0, -1) })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const grantNativeValue = async (childIndex: number) => {
      const oneChild = root(1, [cmd(childIndex, 0x21, 0)], [childData(childIndex)], 1n);
      const allowed = await policy.authorizeContractCalls([oneChild], context);
      const nonpayableChild = { ...allowed, executionPlan: allowed.executionPlan.map((node, index) => index === 1 ? { ...node, match: { ...node.match, nativeValue: '1' } } : node) };
      await expect(policy.assertStillAuthorized(finalTx() as never, nonpayableChild)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    };
    await grantNativeValue(1);
    await grantNativeValue(2);
  });

  it('rejects malformed/noncanonical roots, forbidden grammar, bad values, and commitment or scope tampering', async () => {
    const child = childData(2);
    const interaction = root(1, ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.map((_, index) => cmd(index, 0x21, index)), [0, 1, 2].map((index) => childData(index)), 1n);
    const { policy } = makePolicy();
    const mutations = [
      { ...interaction, data: `${interaction.data}00` },
      { ...interaction, data: `0x00000000${interaction.data.slice(10)}` },
      { ...interaction, value: (1n << 256n).toString() },
      root(0, [cmd(2, 0x21, 0)], [child], 1n, 0n),
      root(1, [cmd(2, 0x23, 0)], [encodeAbiParameters(parseAbiParameters('uint256'), [1n]), child], 1n, 0n),
      root(1, [cmd(2, 0x21, 0, { header: '0x00000000' })], [child], 1n),
      root(1, [cmd(2, 0x21, 0, { target: `0x${'00'.repeat(20)}` })], [child], 1n),
    ];
    for (const [index, mutation] of mutations.entries()) {
      const code = index === 1 ? 'DEFI_FUNCTION_NOT_ALLOWED' : 'DEFI_INVALID_PARAMETERS';
      await expect(policy.authorizeContractCalls([mutation], context)).rejects.toMatchObject({ audit: { code } });
    }
    const valid = await policy.authorizeContractCalls([interaction], context);
    await expect(policy.authorizeContractCalls([interaction], context, `0x${'00'.repeat(32)}`)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const alteredData = { ...valid, executionPlan: valid.executionPlan.map((node, index) => index === 1 ? { ...node, data: `${node.data}00` as Hex } : node) };
    await expect(policy.assertStillAuthorized(finalTx() as never, alteredData)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const alteredValue = { ...valid, executionPlan: valid.executionPlan.map((node, index) => index === 1 ? { ...node, match: { ...node.match, nativeValue: '1' } } : node) };
    await expect(policy.assertStillAuthorized(finalTx() as never, alteredValue)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const tamperedPlans = [
      { ...valid, executionPlan: [valid.executionPlan[0], valid.executionPlan[2], valid.executionPlan[1]] },
      { ...valid, executionPlan: valid.executionPlan.map((node, index) => index === 1 ? { ...node, path: [0, 8] } : node) },
      { ...valid, executionPlan: valid.executionPlan.map((node, index) => index === 1 ? { ...node, match: { ...node.match, capabilityId: 'enso:spoofed-child' } } : node) },
      { ...valid, executionPlan: valid.executionPlan.map((node, index) => index === 1 ? { ...node, match: { ...node.match, abiHash: `0x${'00'.repeat(32)}` as Hex } } : node) },
      { ...valid, executionPlan: valid.executionPlan.map((node, index) => index === 0 ? { ...node, match: { ...node.match, executionScopeHash: `0x${'00'.repeat(32)}` as Hex } } : node) },
      { ...valid, executionPlan: valid.executionPlan.map((node, index) => index === 0 ? { ...node, match: { ...node.match, capabilityId: 'enso:spoofed-root' } } : node) },
      { ...valid, executionPlan: valid.executionPlan.map((node, index) => index === 0 ? { ...node, match: { ...node.match, nativeValue: '1' } } : node) },
      { ...valid, requestCommitment: `0x${'00'.repeat(32)}` as Hex },
      { ...valid, interactions: [root(1, [cmd(2, 0x21, 0)], [childData(2, { amount: 99n })], 1n)] },
    ];
    for (const tampered of tamperedPlans) await expect(policy.assertStillAuthorized(finalTx() as never, tampered)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const rootFn = manifest.capabilities.find((candidate) => candidate.capabilityId === rootId)!;
    const expand = (policy as any).expandExecution.bind(policy);
    expect(() => expand(interaction, { ...rootFn, executionScope: undefined }, context, [0], 0)).toThrow();
    expect(() => expand(interaction, { ...rootFn, executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: 1 } }, context, [0], 0)).toThrow();
    const ensoScope = rootFn.executionScope;
    const corruptedChildren = ensoScope?.kind === 'enso-static-weiroll-v1'
      ? { ...ensoScope, allowedChildren: ensoScope.allowedChildren.map((child, index) => index === 0 ? { ...child, abiHash: `0x${'00'.repeat(32)}` as Hex } : child) }
      : ensoScope;
    expect(() => expand(interaction, { ...rootFn, executionScope: corruptedChildren }, context, [0], 0)).toThrow();
    expect(() => expand(interaction, { ...rootFn, chainId: 10 }, context, [0], 0)).toThrow();
    expect(() => expand(interaction, { ...rootFn, contract: `0x${'00'.repeat(20)}` }, context, [0], 0)).toThrow();
    expect(() => expand(interaction, { ...rootFn, capabilityId: 'enso:wrong-capability' }, context, [0], 0)).toThrow();
    expect(() => expand(interaction, { ...rootFn, abi: { ...rootFn.abi, outputs: [{ type: 'uint8' }] } }, context, [0], 0)).toThrow();
  });

  it('rejects malformed child payloads, selectors, and targets for each literal while the outer root remains canonical', async () => {
    const { policy } = makePolicy();
    for (let index = 0; index < ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.length; index++) {
      const child = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[index];
      const canonical = childData(index);
      const invalidCases = [
        { command: cmd(index, 0x21, 0), state: [`${canonical}00` as Hex] },
        { command: cmd(index, 0x21, 0), state: [canonical.slice(0, -2) as Hex] },
        { command: cmd(index, 0x21, 0, { header: '0xdeadbeef' }), state: [canonical] },
        { command: cmd(index, 0x21, 0, { target: `0x${'00'.repeat(20)}` }), state: [canonical] },
      ];
      for (const invalid of invalidCases) {
        const wrapped = root(1, [invalid.command], invalid.state, 1n);
        await expect(policy.authorizeContractCalls([wrapped], context)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
      expect(childIds).toContain(child.capabilityId);
    }
  });

  it('does not accept a runtime child whose current full ABI hash differs from the reviewed literal', async () => {
    const { policy } = makePolicy();
    const catalog = (policy as any).catalog as DefiCatalogService;
    const originalActiveChain = catalog.activeChain.bind(catalog);
    jest.spyOn(catalog, 'activeChain').mockImplementation((chainId: number) => {
      const chain = originalActiveChain(chainId);
      if (!chain) return chain;
      return {
        ...chain,
        contracts: chain.contracts.map((contract) => contract.address.toLowerCase() !== ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[1].contract ? contract : {
          ...contract,
          functions: contract.functions.map((fn) => fn.capabilityId !== childIds[1] ? fn : { ...fn, abi: { ...fn.abi, outputs: [...fn.abi.outputs, { type: 'uint8' }] } }),
        }),
      };
    });
    const aave = root(1, [cmd(1, 0x21, 0)], [childData(1)], 1n);
    await expect(policy.authorizeContractCalls([aave], context)).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });

  it('audits only derived Enso counts/value totals and capability identities, never calldata or Weiroll metadata/state', async () => {
    const events = { record: jest.fn().mockResolvedValue(undefined) };
    const { policy } = makePolicy([], events);
    const state = [encodeAbiParameters(parseAbiParameters('uint256'), [5n]), childData(0)];
    const interaction = root(0, [cmd(0, 0x23, 0)], state, 5n, 5n);
    const authorization = await policy.authorizeContractCalls([interaction], context);
    await policy.recordAllowedInTx({} as never, authorization);
    const metadata = events.record.mock.calls[0][0].metadata;
    expect(metadata.ensoRoots).toEqual([{ path: [0], commandCount: 1, stateCount: 2, childValueSum: '5' }]);
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(interaction.data);
    expect(serialized).not.toContain(state[0]);
    expect(serialized).not.toContain(state[1]);
    expect(serialized).not.toContain('1111111111111111111111111111111111111111111111111111111111111111');
    expect(serialized).not.toContain('2222222222222222222222222222222222222222222222222222222222222222');
  });
});
