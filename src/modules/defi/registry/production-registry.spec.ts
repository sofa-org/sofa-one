jest.mock('../../security-events/security-event.module', () => ({ SecurityEventModule: class SecurityEventModule {} }));
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyDenial } from '../defi.types';
import { DefiPolicyService } from '../defi-policy.service';
import { encodeAbiParameters, encodeFunctionData, maxUint256, toFunctionSelector } from 'viem';


describe('production DeFi registry assembly', () => {
  it('keeps source-added calls subject to exact capability, chain, target, selector, and ABI matching', async () => {
    const fn = PRODUCTION_DEFI_MANIFEST.capabilities.find((item) => item.capabilityId.startsWith('aave-v3:v3-aave:') && item.functionName === 'supply')!;
    const args = ['0x0000000000000000000000000000000000000001', 1n << 255n, '0x0000000000000000000000000000000000000001', 65535n] as const;
    const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args });
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
    const policy = new DefiPolicyService(prisma as never, {} as never, catalog);
    const context = (chainId: number, allowedCapabilityIds: string[]) => ({ userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key', executionOwner: '0x0000000000000000000000000000000000000001', allowedCapabilityIds });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data }], context(fn.chainId, [fn.capabilityId]))).resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data }], context(fn.chainId, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data }], context(10, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ to: '0x0000000000000000000000000000000000000001', data }], context(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data: '0xdeadbeef' }], context(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `${data}00` }], context(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const noncanonical = `${data.slice(0, 10)}ff${data.slice(12)}`;
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data: noncanonical }], context(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data, value: '1' }], context(fn.chainId, [fn.capabilityId]))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const payableNpm = PRODUCTION_DEFI_MANIFEST.capabilities.find((item) => item.protocol === 'uniswap-v3-position-manager' && item.chainId === 1 && item.functionName === 'mint')!;
    const payableData = encodeFunctionData({ abi: [payableNpm.abi], functionName: payableNpm.functionName, args: [{ token0: '0x0000000000000000000000000000000000000001', token1: '0x0000000000000000000000000000000000000002', fee: 3000, tickLower: -10, tickUpper: 10, amount0Desired: 1n << 255n, amount1Desired: 1n << 254n, amount0Min: 0n, amount1Min: 0n, recipient: '0x0000000000000000000000000000000000000003', deadline: 1n }] });
    await expect(policy.authorizeContractCalls([{ to: payableNpm.contract, data: payableData, value: '17' }], context(1, [payableNpm.capabilityId]))).resolves.toBeDefined();
  });

  it('authorizes every Curve, Pancake V3 and Yearn source entry only under its exact grant and fixed ABI/scope', async () => {
    const additions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => ['curve-3pool-stableswap', 'pancakeswap-v3-position-manager', 'yearn-tokenized-strategy'].includes(fn.protocol ?? ''));
    const curve = additions.filter((fn) => fn.protocol === 'curve-3pool-stableswap');
    const pancake = additions.filter((fn) => fn.protocol === 'pancakeswap-v3-position-manager');
    const yearn = additions.filter((fn) => fn.protocol === 'yearn-tokenized-strategy');

    type AbiParameter = { type: string; name?: string; components?: readonly AbiParameter[] };
    const address = '0x0000000000000000000000000000000000000001';
    const argValue = (parameter: AbiParameter): unknown => {
      const array = parameter.type.match(/^(.*)\[(\d*)\]$/);
      if (array) return Array.from({ length: array[2] ? Number(array[2]) : 1 }, () => argValue({ ...parameter, type: array[1] } as AbiParameter));
      if (parameter.type === 'tuple') return Object.fromEntries((parameter.components ?? []).map((component, index) => [component.name || String(index), argValue(component)]));
      if (parameter.type === 'address') return address;
      if (parameter.type === 'bool') return true;
      if (parameter.type === 'bytes' || parameter.type.startsWith('bytes')) return '0x';
      if (parameter.type.startsWith('int')) return -1n;
      if (parameter.type.startsWith('uint')) return 17n;
      throw new Error(`Unsupported source ABI test parameter ${parameter.type}`);
    };
    const encode = (fn: (typeof additions)[number], overrides?: readonly unknown[]) => encodeFunctionData({
      abi: [fn.abi], functionName: fn.functionName, args: (overrides ?? (fn.abi.inputs as readonly AbiParameter[]).map(argValue)) as never,
    });
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
    const policy = new DefiPolicyService(prisma as never, {} as never, catalog);
    const context = (chainId: number, allowedCapabilityIds: string[]) => ({
      userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId,
      executionMode: 'session_key' as const, executionOwner: address, allowedCapabilityIds,
    });

    for (const fn of additions) {
      const isWrapper = fn.executionScope?.kind === 'same-target-multicall-v1';
      const child = isWrapper ? pancake.find((candidate) => candidate.chainId === fn.chainId && candidate.contract === fn.contract && candidate.signature === 'burn(uint256)')! : undefined;
      const data = child ? encode(fn, [[encode(child)]]) : encode(fn);
      const value = fn.abi.stateMutability === 'payable' ? '17' : undefined;
      const grants = child ? [fn.capabilityId, child.capabilityId] : [fn.capabilityId];
      const exact = await policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, grants)).catch((error: unknown) => {
        const audit = error instanceof DefiPolicyDenial ? error.audit : undefined;
        throw new Error(`${fn.protocol} ${fn.signature} exact grant denied: ${JSON.stringify(audit)}`);
      });
      expect(exact.matches).toEqual(expect.arrayContaining([expect.objectContaining({ capabilityId: fn.capabilityId })]));
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, [])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      const otherChain = additions.find((candidate) => candidate.chainId !== fn.chainId && candidate.contract === fn.contract && candidate.signature === fn.signature);
      if (otherChain) await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(otherChain.chainId, grants)))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ to: address, data, ...(value ? { value } : {}) }], context(fn.chainId, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: '0xdeadbeef' }], context(fn.chainId, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `${data}00`, ...(value ? { value } : {}) }], context(fn.chainId, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      if (fn.abi.stateMutability !== 'payable') {
        await expect(policy.authorizeContractCalls([{ to: fn.contract, data, value: '1' }], context(fn.chainId, [fn.capabilityId])))
          .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
    }

    const curveExchange = curve.find((fn) => fn.functionName === 'exchange')!;
    const curveArgs = [0n, -1n, 0n, 0n] as const;
    await expect(policy.authorizeContractCalls([{ to: curveExchange.contract, data: encode(curveExchange, curveArgs) }], context(1, [curveExchange.capabilityId])))
      .resolves.toMatchObject({ matches: [{ capabilityId: curveExchange.capabilityId }] });
    const curveAdd = curve.find((fn) => fn.functionName === 'add_liquidity')!;
    const malformedFixedArray = `${encode(curveAdd).slice(0, 10)}${encode(curveAdd).slice(10, -64)}`;
    await expect(policy.authorizeContractCalls([{ to: curveAdd.contract, data: malformedFixedArray }], context(1, [curveAdd.capabilityId])))
      .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });

    const withdraw3 = yearn.find((fn) => fn.signature === 'withdraw(uint256,address,address)')!;
    const withdraw4 = yearn.find((fn) => fn.signature === 'withdraw(uint256,address,address,uint256)')!;
    const redeem3 = yearn.find((fn) => fn.signature === 'redeem(uint256,address,address)')!;
    const redeem4 = yearn.find((fn) => fn.signature === 'redeem(uint256,address,address,uint256)')!;
    for (const [threeArg, fourArg] of [[withdraw3, withdraw4], [redeem3, redeem4]]) {
      expect(toFunctionSelector(threeArg.signature)).not.toBe(toFunctionSelector(fourArg.signature));
      await expect(policy.authorizeContractCalls([{ to: fourArg.contract, data: encode(fourArg) }], context(1, [threeArg.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      const maxLossArg = fourArg.abi.inputs.at(-1)!;
      const fourArgs = (fourArg.abi.inputs as readonly AbiParameter[]).map(argValue);
      fourArgs[fourArgs.length - 1] = (1n << 256n) - 1n;
      expect(maxLossArg.type).toBe('uint256');
      await expect(policy.authorizeContractCalls([{ to: fourArg.contract, data: encode(fourArg, fourArgs) }], context(1, [fourArg.capabilityId])))
        .resolves.toMatchObject({ matches: [{ capabilityId: fourArg.capabilityId }] });
    }
    const mint = yearn.find((fn) => fn.functionName === 'mint')!;
    const mintArgs = [ (1n << 256n) - 1n, '0x0000000000000000000000000000000000000002' ] as const;
    await expect(policy.authorizeContractCalls([{ to: mint.contract, data: encode(mint, mintArgs) }], context(1, [mint.capabilityId])))
      .resolves.toMatchObject({ matches: [{ capabilityId: mint.capabilityId }] });

    const wrapper = pancake.find((fn) => fn.chainId === 56 && fn.signature === 'multicall(bytes[])')!;
    if (wrapper.executionScope?.kind !== 'same-target-multicall-v1') throw new Error('Pancake wrapper lacks its finite scope');
    const childFns = wrapper.executionScope.allowedChildren.map((binding) => {
      const child = pancake.find((fn) => fn.capabilityId === binding.capabilityId && fn.signature === binding.signature);
      if (!child) throw new Error(`Pancake child binding missing: ${binding.capabilityId}`);
      return child;
    });
    const childData = childFns.map((fn) => encode(fn));
    const wrapperData = encode(wrapper, [childData]);
    const allIds = [wrapper.capabilityId, ...childFns.map((fn) => fn.capabilityId)];
    const fullContext = context(56, allIds);
    const approved = await policy.authorizeContractCalls([{ to: wrapper.contract, data: wrapperData, value: '17' }], fullContext);
    expect(approved.matches.map((match) => match.capabilityId)).toEqual([wrapper.capabilityId]);
    expect(approved.executionPlan.map((node) => node.path)).toEqual([[0], ...childFns.map((_, index) => [0, index])]);
    expect(approved.executionPlan.slice(1).map((node) => node.match.capabilityId)).toEqual(childFns.map((fn) => fn.capabilityId));
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: wrapperData, value: '17' }], context(56, [wrapper.capabilityId])))
      .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: wrapperData, value: '17' }], context(56, allIds.filter((id) => id !== childFns[3].capabilityId))))
      .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const elevenChildData = encode(wrapper, [Array.from({ length: 11 }, (_, index) => encode(childFns[index % childFns.length]))]);
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: elevenChildData, value: '17' }], fullContext))
      .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const pausedPrisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [`capability:${childFns[0].capabilityId}`] }) } };
    const pausedPolicy = new DefiPolicyService(pausedPrisma as never, {} as never, new DefiCatalogService(PRODUCTION_DEFI_CATALOG, pausedPrisma as never, PRODUCTION_DEFI_MANIFEST));
    await expect(pausedPolicy.authorizeContractCalls([{ to: wrapper.contract, data: wrapperData, value: '17' }], fullContext))
      .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    const recursiveData = encode(wrapper, [[wrapperData]]);
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: recursiveData, value: '17' }], fullContext))
      .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    const otherNpm = PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.protocol === 'uniswap-v3-position-manager' && fn.chainId === 56 && fn.signature === wrapper.signature)!;
    await expect(policy.authorizeContractCalls([{ to: otherNpm.contract, data: wrapperData, value: '17' }], fullContext))
      .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('authorizes source-derived protocol entries through exact grants and the current policy', async () => {
    const addedProtocolIds = ['ambient', 'aura', 'beefy-standard', 'camelot-v2', 'convex', 'dodo-v2', 'dolomite-router', 'etherfi', 'euler-vault', 'euler-evc', 'fluid-lending', 'fluid-vault-t1', 'kelp', 'lfj-liquidity-book', 'maverick-v2', 'moonwell', 'pendle-v3', 'quickswap-v2', 'renzo', 'rocket-pool', 'silo-vault', 'stakewise'];
    const additions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => addedProtocolIds.includes(fn.protocol ?? ''));

    type Param = { type: string; name?: string; components?: readonly Param[] };
    const address = '0x1111111111111111111111111111111111111111';
    const secondAddress = '0x2222222222222222222222222222222222222222';
    const argument = (param: Param): unknown => {
      const array = param.type.match(/^(.*)\[(\d*)\]$/);
      if (array) return Array.from({ length: array[2] ? Number(array[2]) : 1 }, () => argument({ ...param, type: array[1] }));
      if (param.type === 'tuple') return Object.fromEntries((param.components ?? []).map((part, index) => [part.name || String(index), argument(part)]));
      if (param.type === 'address') return address;
      if (param.type === 'bool') return true;
      if (param.type === 'bytes') return '0x';
      if (param.type === 'string') return '';
      if (param.type.startsWith('bytes')) return `0x${'00'.repeat(Number(param.type.slice(5)))}`;
      if (param.type.startsWith('int')) return -1n;
      if (param.type.startsWith('uint')) {
        const bits = Number(param.type.slice(4)) || 256;
        return (1n << BigInt(bits)) - 1n;
      }
      throw new Error(`Unsupported v5 test ABI type ${param.type}`);
    };
    const encode = (fn: (typeof additions)[number], overrides?: readonly unknown[]) => encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: (overrides ?? (fn.abi.inputs as readonly Param[]).map(argument)) as never });
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST));
    const context = (chainId: number, grants: string[]) => ({ userId: 'v5-policy-test', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId, executionMode: 'session_key' as const, executionOwner: address, allowedCapabilityIds: grants });
    const ambient = additions.find((fn) => fn.protocol === 'ambient')!;
    const ambientTypes = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'uint128' }, { type: 'uint16' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint8' }] as const;
    const ambientPayload = encodeAbiParameters(ambientTypes, [address, secondAddress, maxUint256, true, false, (1n << 128n) - 1n, 65535, (1n << 128n) - 1n, 0n, 255]);
    const validAmbientData = encodeFunctionData({ abi: [ambient.abi], functionName: ambient.functionName, args: [1, ambientPayload] });
    const callData = (fn: (typeof additions)[number]) => fn === ambient ? validAmbientData : encode(fn);

    for (const fn of additions) {
      const pendleWrapper = fn.executionScope?.kind === 'pendle-router-multicall-v1';
      const maverickWrapper = fn.executionScope?.kind === 'same-target-financial-multicall-v1';
      const childSignature = pendleWrapper ? 'mintPyFromSy(address,address,uint256,uint256)' : maverickWrapper ? 'exactInputSingle(address,address,bool,uint256,uint256)' : undefined;
      const child = childSignature ? additions.find((candidate) => candidate.chainId === fn.chainId && candidate.contract === fn.contract && candidate.signature === childSignature)! : undefined;
      const data = child ? encode(fn, [pendleWrapper ? [[false, encode(child)]] : [encode(child)]]) : callData(fn);
      // Self-delegatecall preserves msg.value; Pendle's selected SY child is nonpayable.
      const value = fn.abi.stateMutability === 'payable' && !pendleWrapper ? '17' : undefined;
      const grants = child ? [fn.capabilityId, child.capabilityId] : [fn.capabilityId];
      const approved = await policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, grants)).catch((error: unknown) => {
        const audit = error instanceof DefiPolicyDenial ? error.audit : undefined;
        throw new Error(`${fn.protocol} ${fn.chainId} ${fn.signature} exact grants denied: ${JSON.stringify(audit)}`);
      });
      expect(approved.matches).toMatchObject([{ capabilityId: fn.capabilityId }]);
      if (child) {
        expect(approved.executionPlan.map((node) => ({ path: node.path, capabilityId: node.match.capabilityId }))).toEqual([
          { path: [0], capabilityId: fn.capabilityId }, { path: [0, 0], capabilityId: child.capabilityId },
        ]);
        for (const incompleteGrants of [[fn.capabilityId], [child.capabilityId]]) {
          await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, incompleteGrants)))
            .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
        }
      }
      if (pendleWrapper) await expect(policy.authorizeContractCalls([{ to: fn.contract, data, value: '1' }], context(fn.chainId, grants)))
        .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, [])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      const otherChain = additions.find((candidate) => candidate.chainId !== fn.chainId && candidate.contract === fn.contract && candidate.signature === fn.signature);
      if (otherChain) await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(otherChain.chainId, grants)))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([{ to: address, data, ...(value ? { value } : {}) }], context(fn.chainId, grants)))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `0xdeadbeef${data.slice(10)}`, ...(value ? { value } : {}) }], context(fn.chainId, grants)))
        .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `${data}00`, ...(value ? { value } : {}) }], context(fn.chainId, grants)))
        .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      if (fn.abi.stateMutability !== 'payable') {
        await expect(policy.authorizeContractCalls([{ to: fn.contract, data, value: '1' }], context(fn.chainId, grants)))
          .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
      const otherSameTarget = additions.find((other) => other.contract.toLowerCase() === fn.contract.toLowerCase() && other.capabilityId !== fn.capabilityId);
      if (otherSameTarget) await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, [otherSameTarget.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }

    const lpTypes = [{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'int24' }, { type: 'int24' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint8' }, { type: 'address' }] as const;
    const lpCodes = [1, 2, 3, 4, 11, 12, 21, 22, 31, 32, 41, 42];
    for (const code of lpCodes) {
      const payload = encodeAbiParameters(lpTypes, [code, address, secondAddress, maxUint256, -8388608, 8388607, (1n << 128n) - 1n, 0n, (1n << 128n) - 1n, 255, secondAddress]);
      const data = encodeFunctionData({ abi: [ambient.abi], functionName: ambient.functionName, args: [2, payload] });
      await expect(policy.authorizeContractCalls([{ to: ambient.contract, data }], context(1, [ambient.capabilityId]))).resolves.toBeDefined();
    }
  });

});
