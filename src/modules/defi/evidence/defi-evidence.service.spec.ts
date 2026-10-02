import { encodeFunctionData, keccak256 } from 'viem';
import { DefiPolicyService, buildDefiPolicyIdentityHash, buildDefiRequestCommitment } from '../defi-policy.service';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiEvidenceService } from './defi-evidence.service';
import { buildProspectiveEthereumUsdcWeth500, PRODUCTION_DEFI_MANIFEST, PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS } from '../registry/production-registry';
import type { DefiAuthorization, DefiFunctionPolicy } from '../defi.types';
import type { ReviewedManifest } from '../registry/defi-manifest.types';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const owner = addr(1), usdc = addr(2), weth = addr(3), router = addr(4), poolAddress = addr(5), factory = addr(6);
const usdcImpl = '0x43506849D7C04F9138D1A2050bbF3A0c054402dd' as const;
const feedIn = addr(7), feedOut = addr(8), aggIn = addr(9), aggOut = addr(10);
const sequencerAddress = addr(11), sequencerRef = 'feed:8453:sequencer';
const proxyCode = '0x6001600055' as const, runtimeCode = '0x6002600055' as const, implementationCode = '0x6003600055' as const;
const hash = (code: `0x${string}`) => keccak256(code);
const manifestHash = `0x${'a'.repeat(64)}` as const;
const ethereumRuntimeFixture = require('./__fixtures__/ethereum-runtime-code.json') as { chainId: number; blockNumber: string; blockHash: `0x${string}`; code: Record<string, `0x${string}`> };
const poolRef = 'pool:8453:usdc-weth';
const reversePoolRef = 'pool:8453:weth-usdc';
const refs = {
  assetIn: 'asset:8453:usdc', assetOut: 'asset:8453:weth', depIn: 'token:8453:usdc', depOut: 'token:8453:weth',
  router: 'uniswap-v3-router:8453', pool: poolRef, factory: 'uniswap-v3-factory:8453', feedIn: 'feed:8453:usdc-usd', feedOut: 'feed:8453:eth-usd',
  aggIn: 'feed-aggregator:8453:usdc', aggOut: 'feed-aggregator:8453:eth',
};
const abiApprove = { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] } as const;
const abiSwap = { type: 'function', name: 'exactInputSingle', stateMutability: 'payable', inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint256' }, { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }] }], outputs: [{ type: 'uint256' }] } as const;

function makeFixture(withSequencer = false) {
  const functions: DefiFunctionPolicy[] = [
    { capabilityId: 'cap:approve:usdc:v1', type: 'contract_call', chainId: 8453, contract: usdc, functionSignature: 'approve(address,uint256)', functionName: 'approve', signature: 'approve(address,uint256)', abi: abiApprove, policy: { ref: 'finite-approval', version: 1 }, status: 'active', approval: { tokenRef: refs.assetIn, spenderRefs: [refs.router] }, manifestRefs: { assets: [refs.assetIn], deployments: [refs.depIn] }, validate: () => true, describe: (args, _context, index) => ({ kind: 'approval', index, token: usdc, spender: String(args[0]), amount: BigInt(String(args[1])) }) },
    { capabilityId: 'cap:approve:weth:v1', type: 'contract_call', chainId: 8453, contract: weth, functionSignature: 'approve(address,uint256)', functionName: 'approve', signature: 'approve(address,uint256)', abi: abiApprove, policy: { ref: 'finite-approval', version: 1 }, status: 'active', approval: { tokenRef: refs.assetOut, spenderRefs: [refs.router] }, manifestRefs: { assets: [refs.assetOut], deployments: [refs.depOut] }, validate: () => true, describe: (args, _context, index) => ({ kind: 'approval', index, token: weth, spender: String(args[0]), amount: BigInt(String(args[1])) }) },
      { capabilityId: 'cap:swap:usdc-weth:v1', type: 'contract_call', chainId: 8453, contract: router, functionSignature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', functionName: 'exactInputSingle', signature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', abi: abiSwap, policy: { ref: 'exact-input', version: 1 }, status: 'active', protocol: 'uniswap-v3', operation: 'exact-input-single', manifestRefs: { assets: [refs.assetIn, refs.assetOut], deployments: [refs.router, refs.factory, refs.pool], pools: [refs.pool, reversePoolRef], priceFeeds: [refs.feedIn, refs.feedOut] }, validate: () => true, describe: (args, _context, index) => { const x = args[0] as any; const inputAddress = String(x.tokenIn ?? x[0]); const outputAddress = String(x.tokenOut ?? x[1]); return { kind: 'action', index, operation: 'swap', deploymentRef: refs.router, token: inputAddress, amount: BigInt(String(x.amountIn ?? x[5])), funding: { token: inputAddress, spender: router, amount: BigInt(String(x.amountIn ?? x[5])) }, swap: { tokenOut: outputAddress, minOut: BigInt(String(x.amountOutMinimum ?? x[6])), deadline: BigInt(String(x.deadline ?? x[4])), poolRef: inputAddress.toLowerCase() === weth.toLowerCase() ? reversePoolRef : poolRef } }; } },
  ];
  const manifest = deepFreeze({
    assets: [
      { ref: refs.assetIn, chainId: 8453, address: usdc, symbol: 'USDC', decimals: 6, maxOperationRaw: 10_000_000n, deploymentRef: refs.depIn, priceFeedRef: refs.feedIn },
      { ref: refs.assetOut, chainId: 8453, address: weth, symbol: 'WETH', decimals: 18, maxOperationRaw: 10n ** 18n, deploymentRef: refs.depOut, priceFeedRef: refs.feedOut },
    ],
    deployments: [
      { ref: refs.depIn, chainId: 8453, address: usdc, status: 'verified', sourceRef: 'source-reviewed USDC proxy', abiHash: hash(runtimeCode), runtimeCodeHash: hash(proxyCode), proxy: { kind: 'zeppelinos', implementation: usdcImpl, implementationCodeHash: hash(implementationCode) }, identityChecks: [{ getter: 'decimals()', expected: '6' }], verificationRef: 'source-pinned-usdc' },
      { ref: refs.depOut, chainId: 8453, address: weth, status: 'verified', sourceRef: 'source-reviewed WETH', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [{ getter: 'decimals()', expected: '18' }], verificationRef: 'source-pinned-weth' },
      { ref: refs.router, chainId: 8453, address: router, status: 'verified', sourceRef: 'source-reviewed router', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [{ getter: 'factory()', expected: factory }, { getter: 'WETH9()', expected: weth }], verificationRef: 'source-pinned-router' },
      { ref: refs.pool, chainId: 8453, address: poolAddress, status: 'verified', sourceRef: 'source-reviewed pool', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [], verificationRef: 'source-pinned-pool' },
      { ref: refs.factory, chainId: 8453, address: factory, status: 'verified', sourceRef: 'source-reviewed factory', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [
        { getter: 'getPool(address,address,uint24)', expected: poolAddress, args: [usdc, weth, 3000] },
        { getter: 'getPool(address,address,uint24)', expected: poolAddress, args: [weth, usdc, 3000] },
      ] as any, verificationRef: 'source-pinned-factory' },
      { ref: refs.feedIn, chainId: 8453, address: feedIn, status: 'verified', sourceRef: 'source-reviewed feed proxy', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [{ getter: 'aggregator()', expected: aggIn }], verificationRef: 'source-pinned-feed' },
      { ref: refs.feedOut, chainId: 8453, address: feedOut, status: 'verified', sourceRef: 'source-reviewed feed proxy', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [{ getter: 'aggregator()', expected: aggOut }], verificationRef: 'source-pinned-feed' },
      { ref: refs.aggIn, chainId: 8453, address: aggIn, status: 'verified', sourceRef: 'source-reviewed aggregator', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [{ getter: 'decimals()', expected: '8' }], verificationRef: 'source-pinned-aggregator' },
      { ref: refs.aggOut, chainId: 8453, address: aggOut, status: 'verified', sourceRef: 'source-reviewed aggregator', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [{ getter: 'decimals()', expected: '8' }], verificationRef: 'source-pinned-aggregator' },
      ...(withSequencer ? [{ ref: sequencerRef, chainId: 8453, address: sequencerAddress, status: 'verified', sourceRef: 'source-pinned sequencer', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [{ getter: 'decimals()', expected: '8' }], verificationRef: 'source-pinned-sequencer' }] : []),
    ],
    priceFeeds: [
      { ref: refs.feedIn, chainId: 8453, asset: refs.assetIn, feed: feedIn, decimals: 8, maxAgeSeconds: 3600, deploymentRef: refs.feedIn, sourceRef: 'source-pinned', ...(withSequencer ? { sequencerCheckRef: sequencerRef } : {}) },
      { ref: refs.feedOut, chainId: 8453, asset: refs.assetOut, feed: feedOut, decimals: 8, maxAgeSeconds: 3600, deploymentRef: refs.feedOut, sourceRef: 'source-pinned' },
      ...(withSequencer ? [{ ref: sequencerRef, chainId: 8453, asset: refs.assetIn, feed: sequencerAddress, decimals: 8, maxAgeSeconds: 3600, deploymentRef: sequencerRef, sourceRef: 'source-pinned sequencer' }] : []),
    ],
    pools: [
      { ref: refs.pool, chainId: 8453, deploymentRef: refs.pool, assetRefs: [refs.assetIn, refs.assetOut], routerRef: refs.router, poolRef: refs.pool, factoryRef: refs.factory, tokenInRef: refs.assetIn, tokenOutRef: refs.assetOut, fee: 3000, runtimeCodeHash: hash(runtimeCode) },
      { ref: reversePoolRef, chainId: 8453, deploymentRef: refs.pool, assetRefs: [refs.assetIn, refs.assetOut], routerRef: refs.router, poolRef: refs.pool, factoryRef: refs.factory, tokenInRef: refs.assetOut, tokenOutRef: refs.assetIn, fee: 3000, runtimeCodeHash: hash(runtimeCode) },
    ],
    markets: [], capabilities: functions, chains: [{ chainId: 8453, status: 'active', contracts: [
      { address: usdc, status: 'active', functions: [functions[0]] }, { address: weth, status: 'active', functions: [functions[1]] }, { address: router, status: 'active', functions: [functions[2]] },
    ] }], manifestHash,
  }) as unknown as ReviewedManifest;

  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const rounds = new Map<string, [bigint,bigint,bigint,bigint,bigint]>([
    [feedIn, [1n, 100_000_000n, timestamp - 50n, timestamp, 1n]],
    [feedOut, [1n, 200_000_000_000n, timestamp - 50n, timestamp, 1n]],
  ]);
  let sequencerRound: [bigint,bigint,bigint,bigint,bigint] = [1n, 0n, timestamp - 4000n, timestamp - 4000n, 1n];
  const client: any = {
    getChainId: jest.fn().mockResolvedValue(8453),
    getBlock: jest.fn().mockImplementation(async ({ blockTag }: any) => ({ number: 99n, hash: `0x${'b'.repeat(64)}`, timestamp })),
    getCode: jest.fn().mockImplementation(async ({ address }: any) => address.toLowerCase() === usdc.toLowerCase() ? proxyCode : address.toLowerCase() === usdcImpl.toLowerCase() ? implementationCode : runtimeCode),
    getStorageAt: jest.fn().mockImplementation(async ({ address, slot }: any) => {
      if (address.toLowerCase() === usdc.toLowerCase() && slot === '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3') return `0x${usdcImpl.slice(2).padStart(64, '0')}`;
      return `0x${'0'.repeat(64)}`;
    }),
    readContract: jest.fn().mockImplementation(async ({ address, functionName }: any) => {
      const a = address.toLowerCase();
      if (functionName === 'decimals') return a === usdc.toLowerCase() ? 6 : a === weth.toLowerCase() ? 18 : 8;
      if (functionName === 'description') return a === feedIn.toLowerCase() ? 'USDC / USD' : 'ETH / USD';
      if (functionName === 'aggregator') return a === feedIn.toLowerCase() ? aggIn : aggOut;
      if (functionName === 'latestRoundData') return address.toLowerCase() === sequencerAddress.toLowerCase() ? sequencerRound : rounds.get(address) ?? [1n, 0n, timestamp, timestamp, 1n];
      if (functionName === 'factory') return factory;
      if (functionName === 'WETH9') return weth;
      if (functionName === 'getPool') return poolAddress;
      if (functionName === 'token0') return usdc;
      if (functionName === 'token1') return weth;
      if (functionName === 'fee') return 3000;
      if (functionName === 'liquidity') return 100n;
      if (functionName === 'balanceOf') return 20n * 10n ** 18n;
      if (functionName === 'allowance') return 0n;
      throw new Error(`unconfigured fixture getter ${functionName}`);
    }),
  };
  const config = { get: jest.fn().mockReturnValue('https://rpc.example.invalid') };
  const makeAuth = (inputPrice = 100_000_000n, outputPrice = 200_000_000_000n, minOut = 495_000_000_000_000n, reverse = false): DefiAuthorization => {
    rounds.set(feedIn, [1n, inputPrice, timestamp - 50n, timestamp, 1n]);
    rounds.set(feedOut, [1n, outputPrice, timestamp - 50n, timestamp, 1n]);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
    const input = reverse ? weth : usdc, output = reverse ? usdc : weth;
    const inputRef = reverse ? refs.assetOut : refs.assetIn;
    const approvalId = reverse ? 'cap:approve:weth:v1' : 'cap:approve:usdc:v1';
    const amountIn = reverse ? 10n ** 18n : 1_000_000n;
    const quoteMinOut = reverse ? 1_980_000_000n : minOut;
    const activePoolRef = reverse ? reversePoolRef : poolRef;
    const interactions = [
      { to: input, data: encodeFunctionData({ abi: [abiApprove], functionName: 'approve', args: [router, amountIn] }), value: '0' },
      { to: router, data: encodeFunctionData({ abi: [abiSwap], functionName: 'exactInputSingle', args: [{ tokenIn: input, tokenOut: output, fee: 3000, recipient: owner, deadline, amountIn, amountOutMinimum: quoteMinOut, sqrtPriceLimitX96: 0n }] }), value: '0' },
      { to: input, data: encodeFunctionData({ abi: [abiApprove], functionName: 'approve', args: [router, 0n] }), value: '0' },
    ];
    const matches: any[] = [
      { capabilityId: approvalId, type: 'contract_call', chainId: 8453, contract: input, functionSignature: 'approve(address,uint256)', policy: { ref: 'finite-approval', version: 1 } },
      { capabilityId: 'cap:swap:usdc-weth:v1', type: 'contract_call', chainId: 8453, contract: router, functionSignature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', policy: { ref: 'exact-input', version: 1 } },
      { capabilityId: approvalId, type: 'contract_call', chainId: 8453, contract: input, functionSignature: 'approve(address,uint256)', policy: { ref: 'finite-approval', version: 1 } },
    ];
    const context: any = { userId: 'u', apiKeyId: 'k', walletId: 'w', chainId: 8453, executionMode: 'session_key', executionOwner: owner, allowedCapabilityIds: ['cap:approve:usdc:v1', 'cap:approve:weth:v1', 'cap:swap:usdc-weth:v1'] };
    const effects: any[] = [
      { kind: 'approval', index: 0, token: input, spender: router, amount: amountIn },
      { kind: 'action', index: 1, operation: 'swap', deploymentRef: refs.router, token: input, amount: amountIn, funding: { token: input, spender: router, amount: amountIn }, swap: { tokenOut: output, minOut: quoteMinOut, deadline, poolRef: activePoolRef } },
      { kind: 'approval', index: 2, token: input, spender: router, amount: 0n },
    ];
    return { context, requiredPermission: 'canSendTransaction', matches, interactions, batchPlan: { effects, fundingTotals: { [input]: amountIn } }, manifestHash, requestCommitment: buildDefiRequestCommitment(interactions, context, manifestHash), policyIdentityHash: buildDefiPolicyIdentityHash(matches) };
  };
  return { manifest, client, config, makeAuth, rounds, timestamp, setSequencerRound: (round: [bigint,bigint,bigint,bigint,bigint]) => { sequencerRound = round; } };
}

function makeAaveFixture(operation: 'supply' | 'withdraw' | 'repay') {
  const marketAddress = addr(20), assetAddress = addr(21), aTokenAddress = addr(22), variableDebtAddress = addr(23), providerAddress = addr(24);
  const assetRef = 'asset:8453:aave-test', marketRef = 'market:8453:aave-test', poolDeploymentRef = 'aave:8453:test-pool';
  const assetDeploymentRef = 'token:8453:aave-test', aTokenRef = 'aave-atoken:8453:test', variableDebtRef = 'aave-variable-debt:8453:test';
  const amount = 1_000_000n;
  const abi = operation === 'supply'
    ? { type: 'function', name: 'supply', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }], outputs: [] } as const
    : operation === 'withdraw'
      ? { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [{ type: 'uint256' }] } as const
      : { type: 'function', name: 'repay', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'interestRateMode', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }], outputs: [{ type: 'uint256' }] } as const;
  const signature = operation === 'supply' ? 'supply(address,uint256,address,uint16)' : operation === 'withdraw' ? 'withdraw(address,uint256,address)' : 'repay(address,uint256,uint256,address)';
  const fn: any = { capabilityId: `cap:aave:${operation}`, type: 'contract_call', chainId: 8453, contract: marketAddress, functionSignature: signature, functionName: operation, signature, abi, policy: { ref: 'aave-v3', version: 1 }, status: 'active', protocol: 'Aave V3', operation, manifestRefs: { assets: [assetRef], deployments: [poolDeploymentRef, assetDeploymentRef] }, validate: () => true, describe: (args: readonly unknown[], _ctx: any, index: number) => ({ kind: 'action', index, operation, deploymentRef: poolDeploymentRef, token: assetAddress, amount: BigInt(String(args[1])) }) };
  const manifest = deepFreeze({
    assets: [{ ref: assetRef, chainId: 8453, address: assetAddress, symbol: 'USDC', decimals: 6, maxOperationRaw: 10_000_000n, deploymentRef: assetDeploymentRef }],
    deployments: [
      { ref: assetDeploymentRef, chainId: 8453, address: assetAddress, status: 'verified', sourceRef: 'aave test asset', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [{ getter: 'decimals()', expected: '6' }], verificationRef: 'aave-asset-source' },
      { ref: poolDeploymentRef, chainId: 8453, address: marketAddress, status: 'verified', sourceRef: 'aave test pool', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [{ getter: 'getAddressesProvider()', expected: providerAddress }], verificationRef: 'aave-pool-source' },
      { ref: aTokenRef, chainId: 8453, address: aTokenAddress, status: 'verified', sourceRef: 'aave test aToken', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [{ getter: 'decimals()', expected: '6' }], verificationRef: 'aave-atoken-source' },
      { ref: variableDebtRef, chainId: 8453, address: variableDebtAddress, status: 'verified', sourceRef: 'aave test variable debt', abiHash: hash(runtimeCode), runtimeCodeHash: hash(runtimeCode), identityChecks: [{ getter: 'decimals()', expected: '6' }], verificationRef: 'aave-debt-source' },
    ], priceFeeds: [], pools: [], markets: [{ ref: marketRef, chainId: 8453, deploymentRef: poolDeploymentRef, marketRef: marketAddress, assetRefs: [assetRef] }], capabilities: [fn], chains: [{ chainId: 8453, status: 'active', contracts: [{ address: marketAddress, status: 'active', functions: [fn] }] }], manifestHash,
  }) as unknown as ReviewedManifest;
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  let configWord = (1n << 56n) | (1000n << 116n);
  let debtBase = 0n;
  let variableDebt = 2_000_000n;
  let ownerBalance = 2_000_000n;
  const client: any = {
    getChainId: jest.fn().mockResolvedValue(8453), getBlock: jest.fn().mockResolvedValue({ number: 99n, hash: `0x${'b'.repeat(64)}`, timestamp }),
    getCode: jest.fn().mockResolvedValue(runtimeCode), getStorageAt: jest.fn().mockResolvedValue(`0x${'0'.repeat(64)}`),
    readContract: jest.fn().mockImplementation(async ({ address, functionName, args }: any) => {
      const a = address.toLowerCase();
      if (functionName === 'decimals') return 6;
      if (functionName === 'getAddressesProvider') return providerAddress;
      if (functionName === 'getReserveData') return [{ data: configWord }, 0n, 0n, 0n, 0n, 0n, 0n, 0n, aTokenAddress, addr(25), variableDebtAddress, addr(26), 0n, 0n, 0n];
      if (functionName === 'getUserAccountData') return [0n, debtBase, 0n, 0n, 0n, 0n];
      if (functionName === 'balanceOf') {
        if (a === assetAddress.toLowerCase() && args[0] === owner) return ownerBalance;
        if (a === assetAddress.toLowerCase() && args[0] === aTokenAddress) return 5_000_000n;
        if (a === aTokenAddress.toLowerCase() && args[0] === owner) return 5_000_000n;
        if (a === variableDebtAddress.toLowerCase() && args[0] === owner) return variableDebt;
      }
      if (functionName === 'allowance') return 2_000_000n;
      if (functionName === 'totalSupply') return 100_000_000n;
      throw new Error(`unconfigured lending getter ${functionName}`);
    }),
  };
  const context: any = { userId: 'u', apiKeyId: 'k', walletId: 'w', chainId: 8453, executionMode: 'session_key', executionOwner: owner, allowedCapabilityIds: [fn.capabilityId] };
  const args: any[] = operation === 'supply' ? [assetAddress, amount, owner, 0] : operation === 'withdraw' ? [assetAddress, amount, owner] : [assetAddress, amount, 2, owner];
  const interaction = { to: marketAddress, data: encodeFunctionData({ abi: [abi], functionName: operation, args: args as never }), value: '0' };
  const matches: any[] = [{ capabilityId: fn.capabilityId, type: 'contract_call', chainId: 8453, contract: marketAddress, functionSignature: signature, policy: fn.policy }];
  const effects: any[] = [{ kind: 'action', index: 0, operation, deploymentRef: poolDeploymentRef, token: assetAddress, amount }];
  const authorization: any = { context, requiredPermission: 'canSendTransaction', matches, interactions: [interaction], batchPlan: { effects, fundingTotals: {} }, manifestHash, requestCommitment: buildDefiRequestCommitment([interaction], context, manifestHash), policyIdentityHash: buildDefiPolicyIdentityHash(matches) };
  return { manifest, client, config: { get: () => 'https://rpc.example.invalid' }, authorization, setReserve: (word: bigint) => { configWord = word; }, setDebtBase: (debt: bigint) => { debtBase = debt; }, setVariableDebt: (debt: bigint) => { variableDebt = debt; }, setOwnerBalance: (balance: bigint) => { ownerBalance = balance; } };
}

const deepFreeze = (value: any, seen = new Set<object>()): any => {
  if (value && typeof value === 'object' && !seen.has(value)) { seen.add(value); Object.values(value).forEach((child) => deepFreeze(child, seen)); Object.freeze(value); }
  return value;
};
const cloneMutable = <T>(value: T): T => Array.isArray(value) ? value.map(cloneMutable) as T : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneMutable(child)])) as T : value;

const realEthereumFixture = () => {
  const manifest = buildProspectiveEthereumUsdcWeth500({ activate: true });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const pinnedCode = new Map(Object.entries(ethereumRuntimeFixture.code).map(([address, code]) => [address.toLowerCase(), code]));
  const readImpl = async ({ address, functionName, args }: any): Promise<any> => {
    const a = String(address).toLowerCase();
    if (functionName === 'getPool') return '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
    if (functionName === 'factory') return '0x1F98431c8aD98523631AE4a59f267346ea31F984';
    if (functionName === 'token0') return '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    if (functionName === 'token1') return '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    if (functionName === 'fee') return 500;
    if (functionName === 'liquidity') return 3_029_780_437_576_225_178n;
    if (functionName === 'WETH9') return '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      if (functionName === 'decimals') return a === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' ? 6 : a === '0x43506849d7c04f9138d1a2050bbf3a0c054402dd' ? 0 : a === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' ? 18 : 8;
    if (functionName === 'symbol') return a === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' ? 'WETH' : 'USDC';
    if (functionName === 'aggregator') return a === '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419' ? '0x7d4E742018fb52E48b08BE73d041C18B21de6Fb5' : '0x54bCC589d9743E521c64233706FC8cB36D275b07';
    if (functionName === 'description') return a === '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419' ? 'ETH / USD' : 'USDC / USD';
    if (functionName === 'latestRoundData') return a === '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419' ? [129127208515966895557n, 2_000n * 10n ** 8n, now - 20n, now - 15n, 129127208515966895557n] : [73786976294838206483n, 1n * 10n ** 8n, now - 20n, now - 15n, 73786976294838206483n];
    if (functionName === 'balanceOf') return 10n ** 30n;
    if (functionName === 'allowance') return 0n;
    throw new Error(`unconfigured fixture getter ${functionName} at ${a} ${String(args ?? '')}`);
  };
  const readContract = jest.fn(readImpl);
  const client: any = {
    getChainId: jest.fn().mockResolvedValue(1),
    getBlock: jest.fn().mockImplementation(async ({ blockTag }: any) => blockTag === 'latest' ? { number: BigInt(ethereumRuntimeFixture.blockNumber) + 10n, hash: `0x${'a'.repeat(64)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)) } : { number: BigInt(ethereumRuntimeFixture.blockNumber) + 10n, hash: `0x${'a'.repeat(64)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getCode: jest.fn().mockImplementation(async ({ address }: any) => pinnedCode.get(String(address).toLowerCase())),
    getStorageAt: jest.fn().mockImplementation(async ({ address, slot }: any) => address.toLowerCase() === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' && slot === '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3' ? '0x00000000000000000000000043506849d7c04f9138d1a2050bbf3a0c054402dd' : `0x${'0'.repeat(64)}`),
    readContract,
  };
  const prisma: any = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ pausedScopeKeys: [] }) } };
  const catalog = new DefiCatalogService(manifest.chains, prisma, manifest);
  const policy = new DefiPolicyService(prisma, { record: jest.fn() } as any, catalog);
  const config = { get: jest.fn().mockReturnValue('https://rpc.example.invalid') };
  const evidence = new DefiEvidenceService(config as any, manifest);
  jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(client);
  return { manifest, client, policy, evidence, config, prisma, readContract: readImpl };
};

describe('DefiEvidenceService adversarial reviewed-mainnet evidence', () => {
  let f: ReturnType<typeof makeFixture>;
  let service: DefiEvidenceService;
  beforeEach(() => { f = makeFixture(); service = new DefiEvidenceService(f.config as any, f.manifest); jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(f.client); });
  afterEach(() => jest.restoreAllMocks());
  const denied = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' }, httpException: { status: 503 } });

  it('accepts a canonical exact-input batch with reviewed ZeppelinOS USDC, verified feeds/pool, and same-block evidence', async () => {
    const auth = f.makeAuth();
    const evidence = await service.verify(auth);
    expect(evidence).toMatchObject({ requestCommitment: auth.requestCommitment, manifestHash, chainId: 8453, blockNumber: 99n, executionOwner: owner });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(f.client.getStorageAt).toHaveBeenCalledWith(expect.objectContaining({ address: usdc, slot: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3', blockNumber: 99n }));
    expect(f.client.getBlock).toHaveBeenLastCalledWith({ blockNumber: 99n });
    for (const call of [...f.client.getCode.mock.calls, ...f.client.getStorageAt.mock.calls, ...f.client.readContract.mock.calls]) expect(call[0].blockNumber).toBe(99n);
  });

  it('accepts the reviewed pool in the reverse token direction with the same exact-in quote safeguards', async () => {
    const auth = f.makeAuth(200_000_000_000n, 100_000_000n, 0n, true);
    await expect(service.verify(auth)).resolves.toMatchObject({ requestCommitment: auth.requestCommitment, blockNumber: 99n });
  });

  it('rejects a stale or future latest head even when its feed rounds are internally fresh', async () => {
    const auth = f.makeAuth();
    f.client.getBlock.mockImplementation(async ({ blockTag }: any) => ({ number: 99n, hash: `0x${'b'.repeat(64)}`, timestamp: blockTag === 'latest' ? f.timestamp - 86_400n : f.timestamp }));
    await denied(service.verify(auth));
    f = makeFixture(); service = new DefiEvidenceService(f.config as any, f.manifest); jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(f.client);
    f.client.getBlock.mockImplementation(async ({ blockTag }: any) => ({ number: 99n, hash: `0x${'b'.repeat(64)}`, timestamp: blockTag === 'latest' ? BigInt(Math.floor(Date.now() / 1000) + 16) : f.timestamp }));
    await denied(service.verify(f.makeAuth()));
  });

  it('accepts a latest head at the freshness boundary and rejects a head just beyond it', async () => {
    const auth = f.makeAuth();
    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    // With second-resolution timestamps this is the nearest non-stale value to the 30s boundary.
    f.rounds.set(feedIn, [1n, 100_000_000n, BigInt(seconds - 30), BigInt(seconds - 29), 1n]);
    f.rounds.set(feedOut, [1n, 200_000_000_000n, BigInt(seconds - 30), BigInt(seconds - 29), 1n]);
    f.client.getBlock.mockImplementation(async ({ blockTag }: any) => ({ number: 99n, hash: `0x${'b'.repeat(64)}`, timestamp: blockTag === 'latest' ? BigInt(seconds - 29) : f.timestamp }));
    await expect(service.verify(auth)).resolves.toBeDefined();
    f = makeFixture(); service = new DefiEvidenceService(f.config as any, f.manifest); jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(f.client);
    f.client.getBlock.mockImplementation(async ({ blockTag }: any) => ({ number: 99n, hash: `0x${'b'.repeat(64)}`, timestamp: blockTag === 'latest' ? BigInt(Math.floor(Date.now() / 1000) - 31) : f.timestamp }));
    await denied(service.verify(f.makeAuth()));
  });

  it('attributes generic verifier denials to trusted auth context without exposing provider details', async () => {
    f.client.getCode.mockResolvedValue('0xdead');
    const error = await service.verify(f.makeAuth()).then(() => undefined, (caught) => caught as any);
    expect(error.audit).toMatchObject({ code: 'DEFI_POLICY_UNAVAILABLE', context: { userId: 'u', apiKeyId: 'k', walletId: 'w', chainId: 8453 } });
    expect(error.httpException.getStatus()).toBe(503);
    expect(error.httpException.getResponse()).toEqual({ code: 'DEFI_POLICY_UNAVAILABLE', message: 'DeFi policy denied' });
    expect(JSON.stringify(error.audit)).not.toMatch(/provider|dead|calldata|secret/i);
  });

  it('denies ZeppelinOS implementation drift, unpinned implementations, and unsupported proxy kinds', async () => {
    let auth = f.makeAuth();
    f.client.getStorageAt.mockImplementation(async ({ address, slot }: any) => address.toLowerCase() === usdc.toLowerCase() && slot === '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3' ? `0x${addr(777).slice(2).padStart(64, '0')}` : `0x${'0'.repeat(64)}`);
    await denied(service.verify(auth));

    f = makeFixture();
    f.client.getCode.mockImplementation(async ({ address }: any) => address.toLowerCase() === usdc.toLowerCase() ? proxyCode : address.toLowerCase() === usdcImpl.toLowerCase() ? '0xdead' : runtimeCode);
    await denied(new DefiEvidenceService(f.config as any, f.manifest).verify(f.makeAuth()));

    f = makeFixture();
    const manifest = cloneMutable(f.manifest);
    (manifest.deployments.find((d: any) => d.ref === refs.depIn)!.proxy as any).implementationCodeHash = undefined;
    service = new DefiEvidenceService(f.config as any, deepFreeze(manifest));
    await denied(service.verify(f.makeAuth()));

    f = makeFixture();
    const unknown = cloneMutable(f.manifest);
    (unknown.deployments.find((d: any) => d.ref === refs.depIn)!.proxy as any).kind = 'custom-slot';
    service = new DefiEvidenceService(f.config as any, deepFreeze(unknown));
    await denied(service.verify(f.makeAuth()));
  });

  it('computes the quote floor exactly across different decimals, depegged prices, and tiny rounding boundaries', async () => {
    const depegged = f.makeAuth(99_000_001n, 201_000_000_000n, 487_611_945_223_881n);
    await expect(service.verify(depegged)).resolves.toBeDefined();
    const under = f.makeAuth(99_000_001n, 201_000_000_000n, 487_611_945_223_880n);
    await denied(service.verify(under));
    const atStandardPriceMinusOne = f.makeAuth(100_000_000n, 200_000_000_000n, 494_999_999_999_999n);
    await denied(service.verify(atStandardPriceMinusOne));
  });

  it.each([
    ['zero answer', 0n, 200_000_000_000n, 495_000_000_000_000n],
    ['negative answer', -1n, 200_000_000_000n, 495_000_000_000_000n],
    ['malformed round', 100_000_000n, 200_000_000_000n, 495_000_000_000_000n],
  ])('rejects %s without falling back to pool spot data', async (label, pIn, pOut, minOut) => {
    const auth = f.makeAuth(pIn as bigint, pOut as bigint, minOut as bigint);
    if (label === 'malformed round') f.rounds.set(feedIn, [0n, pIn as bigint, f.timestamp, f.timestamp, 0n]);
    await denied(service.verify(auth));
  });

  it('denies stale/future feed rounds, wrong description or decimals, and changed aggregator identity/code', async () => {
    const auth = f.makeAuth();
    f.rounds.set(feedIn, [1n, 100_000_000n, f.timestamp, f.timestamp - 3601n, 1n]);
    await denied(service.verify(auth));
    f = makeFixture(); service = new DefiEvidenceService(f.config as any, f.manifest); jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(f.client);
    const future = f.makeAuth(); f.rounds.set(feedOut, [1n, 200_000_000_000n, f.timestamp + 1n, f.timestamp, 1n]);
    await denied(service.verify(future));
    f = makeFixture(); service = new DefiEvidenceService(f.config as any, f.manifest); jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(f.client);
    f.client.readContract.mockImplementation(async ({ address, functionName }: any) => functionName === 'decimals' ? (address.toLowerCase() === feedIn ? 18 : 8) : functionName === 'description' ? 'USDC / USD' : functionName === 'aggregator' ? aggIn : functionName === 'latestRoundData' ? [1n, 1n, f.timestamp, f.timestamp, 1n] : 0n);
    await denied(service.verify(f.makeAuth()));
  });

  it('accepts a feed at its exact heartbeat boundary and rejects a wrong description or changed aggregator pin', async () => {
    const auth = f.makeAuth();
    f.rounds.set(feedIn, [1n, 100_000_000n, f.timestamp - 4000n, f.timestamp - 3600n, 1n]);
    await expect(service.verify(auth)).resolves.toBeDefined();

    f = makeFixture(); service = new DefiEvidenceService(f.config as any, f.manifest); jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(f.client);
    const baseRead = f.client.readContract.getMockImplementation()!;
    f.client.readContract.mockImplementation(async (params: any) => params.functionName === 'description' && params.address === feedIn ? 'USDC / EUR' : baseRead(params));
    await denied(service.verify(f.makeAuth()));

    f = makeFixture(); service = new DefiEvidenceService(f.config as any, f.manifest); jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(f.client);
    f.client.getCode.mockImplementation(async ({ address }: any) => address.toLowerCase() === aggIn.toLowerCase() ? '0xdead' : address.toLowerCase() === usdc.toLowerCase() ? proxyCode : address.toLowerCase() === usdcImpl.toLowerCase() ? implementationCode : runtimeCode);
    await denied(service.verify(f.makeAuth()));
  });

  it('rejects a same-height block hash change during the pinned read sequence', async () => {
    let blockReads = 0;
    f.client.getBlock.mockImplementation(async ({ blockTag }: any) => ({ number: 99n, hash: `0x${(++blockReads === 1 ? 'b' : 'c').repeat(64)}`, timestamp: f.timestamp }));
    await denied(service.verify(f.makeAuth()));
  });

  it('requires an L2 sequencer to be up and past the complete recovery grace period', async () => {
    f = makeFixture(true); service = new DefiEvidenceService(f.config as any, f.manifest); jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(f.client);
    const auth = f.makeAuth();
    await expect(service.verify(auth)).resolves.toBeDefined();
    f.setSequencerRound([1n, 1n, f.timestamp - 5000n, f.timestamp - 4000n, 1n]);
    await denied(service.verify(f.makeAuth()));
    f.setSequencerRound([1n, 0n, f.timestamp - 3600n, f.timestamp - 3600n, 1n]);
    await denied(service.verify(f.makeAuth()));
    f.setSequencerRound([1n, 0n, f.timestamp + 1n, f.timestamp, 1n]);
    await denied(service.verify(f.makeAuth()));
  });

  it('validates Aave withdraw debt, position, liquidity, and current reserve state', async () => {
    const aave = makeAaveFixture('withdraw');
    const aaveService = new DefiEvidenceService(aave.config as any, aave.manifest);
    jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(aave.client);
    await expect(aaveService.verify(aave.authorization)).resolves.toMatchObject({ chainId: 8453, blockNumber: 99n });
    aave.setDebtBase(1n);
    await denied(aaveService.verify(aave.authorization));
    aave.setDebtBase(0n); aave.setReserve((1n << 56n) | (1n << 57n) | (1000n << 116n));
    await denied(aaveService.verify(aave.authorization));
  });

  it('validates Aave supply balance, active reserve, cap headroom, and aToken deployment pin', async () => {
    const aave = makeAaveFixture('supply');
    const aaveService = new DefiEvidenceService(aave.config as any, aave.manifest);
    jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(aave.client);
    await expect(aaveService.verify(aave.authorization)).resolves.toBeDefined();
    aave.setOwnerBalance(0n);
    await denied(aaveService.verify(aave.authorization));
    aave.setOwnerBalance(2_000_000n); aave.setReserve((1n << 56n) | (1n << 60n) | (1000n << 116n));
    await denied(aaveService.verify(aave.authorization));
  });

  it('requires positive bounded current Aave variable debt for repay; unsupported market families fail closed', async () => {
    const aave = makeAaveFixture('repay');
    const aaveService = new DefiEvidenceService(aave.config as any, aave.manifest);
    jest.spyOn(require('viem'), 'createPublicClient').mockReturnValue(aave.client);
    await expect(aaveService.verify(aave.authorization)).resolves.toBeDefined();
    aave.setVariableDebt(0n);
    await denied(aaveService.verify(aave.authorization));
  });

  it('denies changed pool factory, token identities, fee, getPool identity, missing pins, and code mismatch', async () => {
    const auth = f.makeAuth();
    f.client.readContract.mockImplementation(async ({ functionName }: any) => functionName === 'decimals' ? 6 : functionName === 'description' ? 'USDC / USD' : functionName === 'aggregator' ? aggIn : functionName === 'latestRoundData' ? [1n, 100_000_000n, f.timestamp, f.timestamp, 1n] : functionName === 'factory' ? addr(111) : functionName === 'WETH9' ? weth : functionName === 'getPool' ? poolAddress : functionName === 'token0' ? usdc : functionName === 'token1' ? weth : functionName === 'fee' ? 3000 : functionName === 'liquidity' ? 1n : 0n);
    await denied(service.verify(auth));
    f.client.getCode.mockResolvedValue('0xdead');
    await denied(service.verify(auth));
  });

  it('executes only exact reviewed getPool identity shapes, pinned to the same block', async () => {
    await expect(service.verify(f.makeAuth())).resolves.toBeDefined();
    const calls = f.client.readContract.mock.calls.filter(([call]: any[]) => call.functionName === 'getPool');
    expect(calls.slice(0, 2).map(([call]: any[]) => call.args)).toEqual([[usdc, weth, 3000], [weth, usdc, 3000]]);
    expect(calls.every(([call]: any[]) => call.blockNumber === 99n)).toBe(true);
    const invalid = cloneMutable(f.manifest);
    const factoryRow = invalid.deployments.find((d: any) => d.ref === refs.factory)!;
    (factoryRow.identityChecks[0] as any).args = [usdc, weth];
    service = new DefiEvidenceService(f.config as any, deepFreeze(invalid));
    await denied(service.verify(f.makeAuth()));
  });

  it('rejects missing swap descriptors, wrong owner/manifest/request/policy commitments, and falsified funding totals', async () => {
    const auth = f.makeAuth();
    (auth.batchPlan.effects[1] as any).swap = undefined;
    await denied(service.verify(auth));
    const valid = f.makeAuth();
    await denied(service.verify({ ...valid, context: { ...valid.context, executionOwner: addr(99) } }));
    await denied(service.verify({ ...valid, requestCommitment: `0x${'f'.repeat(64)}` }));
    await denied(service.verify({ ...valid, policyIdentityHash: `0x${'e'.repeat(64)}` }));
    await denied(service.verify({ ...valid, batchPlan: { ...valid.batchPlan, fundingTotals: {} } }));
  });

  it('fails closed on incomplete finite approval metadata and insufficient initial owner balance', async () => {
    f.client.readContract.mockImplementation(async ({ functionName, args }: any) => functionName === 'balanceOf' ? (args[0] === owner ? 999_999n : 0n) : functionName === 'decimals' ? 6 : functionName === 'description' ? 'USDC / USD' : functionName === 'aggregator' ? aggIn : functionName === 'latestRoundData' ? [1n, 100_000_000n, f.timestamp, f.timestamp, 1n] : functionName === 'factory' ? factory : functionName === 'WETH9' ? weth : functionName === 'getPool' ? poolAddress : functionName === 'token0' ? usdc : functionName === 'token1' ? weth : functionName === 'fee' ? 3000 : functionName === 'liquidity' ? 1n : 0n);
    await denied(service.verify(f.makeAuth()));
  });

  it('requires the USDT-style zero-first allowance reset before any positive approval when initial allowance is nonzero', async () => {
    const auth = f.makeAuth();
    const effects: any[] = auth.batchPlan.effects.map((effect, index) => ({ ...effect, index: index + 1 }));
    effects.unshift({ kind: 'approval', index: 0, token: usdc, spender: router, amount: 0n });
    const matches = [auth.matches[0], ...auth.matches];
    const interactions = [
      { to: usdc, data: encodeFunctionData({ abi: [abiApprove], functionName: 'approve', args: [router, 0n] }), value: '0' },
      ...auth.interactions,
    ];
    const prepared = { ...auth, matches, interactions, batchPlan: { ...auth.batchPlan, effects }, policyIdentityHash: buildDefiPolicyIdentityHash(matches), requestCommitment: buildDefiRequestCommitment(interactions, auth.context, manifestHash) };
    const baseRead = f.client.readContract.getMockImplementation()!;
    f.client.readContract.mockImplementation(async (params: any) => params.functionName === 'allowance' ? 1n : baseRead(params));
    await expect(service.verify(prepared)).resolves.toBeDefined();
    await denied(service.verify(auth));
  });

  it('denies after a delayed evidence read instead of refreshing the observedAt clock', async () => {
    const auth = f.makeAuth();
    jest.spyOn(Date, 'now').mockReturnValueOnce(1_000_000).mockReturnValue(1_030_001);
    await denied(service.verify(auth));
  });
});

describe('prospective Ethereum real-manifest policy/evidence composition', () => {
  afterEach(() => jest.restoreAllMocks());
  const ownerAddress = '0x1111111111111111111111111111111111111111';
  const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const routerAddress = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
  const selected = PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS;
  const makeInteractions = (f: ReturnType<typeof realEthereumFixture>, reverse: boolean, overrides: { fee?: number; spender?: string } = {}) => {
    const input = reverse ? wethAddress : usdcAddress;
    const output = reverse ? usdcAddress : wethAddress;
    const amount = reverse ? 10n ** 15n : 1_000_000n;
    const minOut = reverse ? 1_980_000n : 495_000_000_000_000n;
    const approval = f.manifest.capabilities.find((fn) => fn.capabilityId === selected[reverse ? 2 : 1])!;
    const action = f.manifest.capabilities.find((fn) => fn.capabilityId === selected[0])!;
    const approvalArgs = [overrides.spender ?? routerAddress, amount] as const;
    const params = { tokenIn: input, tokenOut: output, fee: overrides.fee ?? 500, recipient: ownerAddress, deadline: BigInt(Math.floor(Date.now() / 1000) + 60), amountIn: amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n };
    return [
      { to: input, data: encodeFunctionData({ abi: [approval.abi], functionName: approval.functionName, args: approvalArgs as never }), value: '0' },
      { to: routerAddress, data: encodeFunctionData({ abi: [action.abi], functionName: action.functionName, args: [params] as never }), value: '0' },
      { to: input, data: encodeFunctionData({ abi: [approval.abi], functionName: approval.functionName, args: [routerAddress, 0n] as never }), value: '0' },
    ];
  };
  const context = (grants: readonly string[] = selected) => ({ userId: 'composition-user', apiKeyId: 'composition-key', walletId: 'composition-wallet', chainId: 1, executionMode: 'session_key' as const, executionOwner: ownerAddress, allowedCapabilityIds: [...grants] });

  it('imports the actual activated prospective builder; only its three authorities are active and production stays inactive', async () => {
    const f = realEthereumFixture();
    expect(f.manifest.capabilities.filter((fn) => fn.status === 'active').map((fn) => fn.capabilityId).sort()).toEqual([...selected].sort());
    expect(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.status === 'active').map((fn) => fn.capabilityId).sort()).toEqual([...selected].sort());
    const expectedDeploymentRefs = new Map([
      ['0xe592427a0aece92de3edee1f18e0157c05861564', 'dex:uniswap-v3:1:0xe592427a0aece92de3edee1f18e0157c05861564'],
      ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'token:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
      ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 'token:1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'],
      ['0x1f98431c8ad98523631ae4a59f267346ea31f984', 'factory:uniswap-v3:1:0x1f98431c8ad98523631ae4a59f267346ea31f984'],
      ['0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', 'pool-deployment:1:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'],
      ['0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419', 'feed-proxy:1:0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419'],
      ['0x7d4e742018fb52e48b08be73d041c18b21de6fb5', 'feed-aggregator:1:0x7d4e742018fb52e48b08be73d041c18b21de6fb5'],
      ['0x8fffffd4afb6115b954bd326cbe7b4ba576818f6', 'feed-proxy:1:0x8fffffd4afb6115b954bd326cbe7b4ba576818f6'],
      ['0x54bcc589d9743e521c64233706fc8cb36d275b07', 'feed-aggregator:1:0x54bcc589d9743e521c64233706fc8cb36d275b07'],
      ['0x43506849d7c04f9138d1a2050bbf3a0c054402dd', 'token-implementation:1:0x43506849d7c04f9138d1a2050bbf3a0c054402dd'],
    ]);
    for (const [address, code] of Object.entries(ethereumRuntimeFixture.code)) {
      const dep = f.manifest.deployments.find((row) => row.ref === expectedDeploymentRefs.get(address.toLowerCase()));
      expect(dep?.runtimeCodeHash).toBe(keccak256(code));
    }
    for (const reverse of [false, true]) {
      const auth = await f.policy.authorizeContractCalls(makeInteractions(f, reverse) as any, context());
      const evidence = await f.evidence.verify(auth);
      expect(evidence).toMatchObject({ chainId: 1, requestCommitment: auth.requestCommitment, manifestHash: auth.manifestHash });
      expect(auth.matches.map((m) => m.capabilityId)).toContain(selected[0]);
      expect(auth.batchPlan.effects).toHaveLength(3);
    }
    const factoryQueries = f.client.readContract.mock.calls.filter(([row]: any[]) => row.functionName === 'getPool').map(([row]: any[]) => row.args);
    expect(factoryQueries).toEqual(expect.arrayContaining([[usdcAddress, wethAddress, 500], [wethAddress, usdcAddress, 500]]));
    expect(f.client.readContract.mock.calls.filter(([row]: any[]) => ['getPool', 'token0', 'token1', 'fee', 'factory'].includes(row.functionName)).every(([row]: any[]) => row.blockNumber === BigInt(ethereumRuntimeFixture.blockNumber) + 10n)).toBe(true);
  });

  it('rejects unsupported pool/fee, wrong spender, and missing action or approval grants through actual policy', async () => {
    const f = realEthereumFixture();
    for (const [reverse, override] of [[false, { fee: 3000 }], [false, { spender: ownerAddress }]] as const) {
      await expect(f.policy.authorizeContractCalls(makeInteractions(f, reverse, override) as any, context())).rejects.toMatchObject({ audit: { context: { userId: 'composition-user' } } });
    }
    await expect(f.policy.authorizeContractCalls(makeInteractions(f, false) as any, context([selected[1], selected[2]]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(f.policy.authorizeContractCalls(makeInteractions(f, false) as any, context([selected[0], selected[2]]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const action = f.manifest.capabilities.find((fn) => fn.capabilityId === selected[0])!;
    const unsupportedUsdtParams = [{ tokenIn: '0xdAC17F958D2ee523a2206206994597C13D831ec7', tokenOut: wethAddress, fee: 500, recipient: ownerAddress, deadline: BigInt(Math.floor(Date.now() / 1000) + 60), amountIn: 1_000_000n, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }];
    expect(action.validate(unsupportedUsdtParams, context())).toBe(false);
  });

  it.each(['runtime', 'proxy', 'impl-decimals', 'proxy-decimals', 'aggregator', 'factory', 'reorg', 'stale'])('denies %s drift with safe trusted-context audit metadata', async (drift) => {
    const f = realEthereumFixture();
    const auth = await f.policy.authorizeContractCalls(makeInteractions(f, false) as any, context());
    if (drift === 'runtime') f.client.getCode.mockImplementation(async ({ address }: any) => address.toLowerCase() === routerAddress.toLowerCase() ? '0xdead' : ethereumRuntimeFixture.code[address.toLowerCase()]);
    if (drift === 'proxy') f.client.getStorageAt.mockResolvedValue(`0x${'0'.repeat(24)}${'12'.repeat(20)}`);
    if (drift === 'impl-decimals') f.client.readContract.mockImplementation(async (args: any) => args.functionName === 'decimals' && args.address.toLowerCase() === '0x43506849d7c04f9138d1a2050bbf3a0c054402dd' ? 6 : realRead(f, args));
    if (drift === 'proxy-decimals') f.client.readContract.mockImplementation(async (args: any) => args.functionName === 'decimals' && args.address.toLowerCase() === usdcAddress.toLowerCase() ? 8 : realRead(f, args));
    if (drift === 'aggregator') f.client.readContract.mockImplementation(async (args: any) => args.functionName === 'aggregator' ? ownerAddress : realRead(f, args));
    if (drift === 'factory') f.client.readContract.mockImplementation(async (args: any) => args.functionName === 'getPool' ? ownerAddress : realRead(f, args));
    if (drift === 'reorg') {
      let n = 0;
      f.client.getBlock.mockImplementation(async () => ({ number: BigInt(ethereumRuntimeFixture.blockNumber) + 10n, hash: `0x${(++n === 1 ? 'a' : 'b').repeat(64)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)) }));
    }
    if (drift === 'stale') f.client.getBlock.mockImplementation(async ({ blockTag }: any) => ({ number: BigInt(ethereumRuntimeFixture.blockNumber) + 10n, hash: `0x${'a'.repeat(64)}`, timestamp: blockTag === 'latest' ? BigInt(Math.floor(Date.now() / 1000) - 86400) : BigInt(Math.floor(Date.now() / 1000)) }));
    const error = await f.evidence.verify(auth).then(() => undefined, (caught) => caught as any);
    expect(error.audit).toMatchObject({ code: 'DEFI_POLICY_UNAVAILABLE', context: { userId: 'composition-user', apiKeyId: 'composition-key', walletId: 'composition-wallet', chainId: 1 } });
    expect(error.httpException.getStatus()).toBe(503);
    expect(error.httpException.getResponse()).toEqual({ code: 'DEFI_POLICY_UNAVAILABLE', message: 'DeFi policy denied' });
    expect(JSON.stringify(error.audit)).not.toMatch(/calldata|provider|secret|0xdead/i);
  });

  it('does not extend the 30-second evidence lifetime across slow reads', async () => {
    const f = realEthereumFixture();
    const auth = await f.policy.authorizeContractCalls(makeInteractions(f, false) as any, context());
    const started = Date.now();
    jest.spyOn(Date, 'now').mockReturnValueOnce(started).mockReturnValue(started + 30_001);
    const error = await f.evidence.verify(auth).then(() => undefined, (caught) => caught as any);
    expect(error.audit).toMatchObject({ code: 'DEFI_POLICY_UNAVAILABLE', context: { userId: 'composition-user' } });
    expect(error.httpException.getStatus()).toBe(503);
  });

  function realRead(f: ReturnType<typeof realEthereumFixture>, args: any) {
    return f.readContract(args);
  }
});
