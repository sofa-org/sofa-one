import { encodeFunctionData, parseAbi, zeroAddress } from 'viem';
import type { PrismaService } from '../../core/database/prisma.service';
import type { SecurityEventService } from '../security-events/security-event.service';
import { DefiCatalogService } from './defi-catalog.service';
import { DefiPolicyService } from './defi-policy.service';
import type { DefiExecutionContext } from './defi.types';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from './registry/production-registry';

const OWNER = '0x0000000000000000000000000000000000000001';
const TOKEN = '0x0000000000000000000000000000000000000002';
const POOL = '0x0000000000000000000000000000000000000003';
const SOLVER = '0xa1c7a8360eb4049595a24d6919e74e105b409cb5';
const ROUTER = '0x45312ea0eff7e09c83cbe249fa1d7598c4c8cd4e';
const MONAD_ROUTER = '0xff5cb29241f002ffed2eaa224e3e996d24a6e8d1';
const STEP = '(uint256,address,address,address,uint256,uint256,uint256,uint256,uint256)';
const ABI = parseAbi([
  'function exchange(address[11],uint256[5][5],uint256,uint256,address[5]) payable returns (uint256)',
  'function exchange(address[11],uint256[4][5],uint256,uint256) payable returns (uint256)',
  `function execute_linear_exact_in(${STEP}[],address,uint256,address,uint256) payable returns (uint256)`,
  `function execute_split_exact_in((uint256,(uint256,uint256))[],${STEP}[],address,uint256,address,uint256,address) payable returns (uint256)`,
  `function execute_balanced_exact_in((address,address,uint256,uint256,address[8]),((uint256,uint256))[],${STEP}[],uint256,address,uint256,address) payable returns (uint256)`,
]);
const route = [OWNER, POOL, TOKEN, ...Array(8).fill(zeroAddress)];
const step = [0n, POOL, OWNER, TOKEN, 0n, 1n, 0n, 10n, 2n];

function setup(chainId: number, contract: string, functionName: string) {
  const prisma = { defiPolicyState: { findUnique: async () => ({ id: 'global', pausedScopeKeys: [] }) } } as unknown as PrismaService;
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma, PRODUCTION_DEFI_MANIFEST);
  const fn = catalog.activeChain(chainId)!.contracts.find((entry) => entry.address.toLowerCase() === contract)!
    .functions.find((entry) => entry.functionName === functionName)!;
  const context: DefiExecutionContext = {
    userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId,
    executionMode: 'session_key', executionOwner: OWNER, capabilityMode: 'custom', allowedCapabilityIds: [fn.capabilityId],
  };
  return { policy: new DefiPolicyService(prisma, {} as SecurityEventService, catalog), context, fn };
}

// Encode independently of catalog ABI so tuple layout and overload regressions cannot self-validate.
function encode(index: number, args: readonly unknown[]) {
  const abi = ABI[index];
  return encodeFunctionData({ abi: [abi], functionName: abi.name, args: args as never });
}

describe('Curve integration authorization boundaries', () => {
  it('keeps Monad four-column routing separate from five-column routing on other chains', async () => {
    const ethereum = setup(1, ROUTER, 'exchange');
    const monad = setup(143, MONAD_ROUTER, 'exchange');
    const five = encode(0, [route, Array.from({ length: 5 }, () => [0n, 1n, 1n, 10n, 2n]), 100n, 90n, Array(5).fill(zeroAddress)]);
    const four = encode(1, [route, Array.from({ length: 5 }, () => [0n, 1n, 1n, 10n]), 100n, 90n]);
    await expect(ethereum.policy.authorizeContractCalls([{ to: ROUTER, data: five }], ethereum.context))
      .resolves.toMatchObject({ matches: [{ capabilityId: ethereum.fn.capabilityId }] });
    await expect(monad.policy.authorizeContractCalls([{ to: MONAD_ROUTER, data: four, value: '100' }], monad.context))
      .resolves.toMatchObject({ matches: [{ capabilityId: monad.fn.capabilityId }] });
    await expect(ethereum.policy.authorizeContractCalls([{ to: ROUTER, data: four }], ethereum.context))
      .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(monad.policy.authorizeContractCalls([{ to: MONAD_ROUTER, data: five }], monad.context))
      .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });

  it('does not admit the Solver overload without receiver', async () => {
    const { policy, context } = setup(1, SOLVER, 'execute_linear_exact_in');
    const data = encode(2, [[step], OWNER, 100n, TOKEN, 90n]);
    await expect(policy.authorizeContractCalls([{ to: SOLVER, data }], context))
      .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });

  it('authorizes nonempty split branches with nested route spans and receiver', async () => {
    const { policy, context, fn } = setup(42161, SOLVER, 'execute_split_exact_in');
    const data = encode(3, [[[60n, [0n, 1n]], [40n, [1n, 1n]]], [step, step], OWNER, 100n, TOKEN, 90n, OWNER]);
    await expect(policy.authorizeContractCalls([{ to: SOLVER, data }], context))
      .resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
    await expect(policy.authorizeContractCalls([{ to: SOLVER, data }], { ...context, chainId: 1 }))
      .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('authorizes balanced root and one-field branch tuples but rejects trailing calldata', async () => {
    const { policy, context, fn } = setup(1, SOLVER, 'execute_balanced_exact_in');
    const data = encode(4, [[POOL, OWNER, 10n, 2n, [OWNER, TOKEN, ...Array(6).fill(zeroAddress)]], [[[0n, 1n]], [[1n, 1n]]], [step, step], 100n, TOKEN, 90n, OWNER]);
    await expect(policy.authorizeContractCalls([{ to: SOLVER, data }], context))
      .resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
    await expect(policy.authorizeContractCalls([{ to: SOLVER, data: `${data}00` }], context))
      .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });
});
