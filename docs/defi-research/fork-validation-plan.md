# Local Anvil + viem protocol validation plan

Research date: 2026-10-02. Read-only research; no Anvil node started and no files outside this note changed. Purpose: implementation recipe for fixer/parent, not test result. Use only local child-fork mutations; never submit transactions to the upstream RPC.

## Repository semantics checked

Read `src/common/calibur/calibur.ts` and `src/common/calibur/codemap.md`.

- `CALIBUR_ADDRESS = 0x000000005c84F8Fd50b21CAC312528A64437030e`; legacy address also defined. `getCaliburDelegationCode()` yields EIP-7702 designator `0xef0100 || implementation-address`.
- `encodeCaliburExecuteUserOpCalls(calls)` encodes selector `0x8dd7712f` + `abi.encode((Call[], bool))`, with each `(to,value,data)` and `revertOnFailure = true`. The source explicitly says this is the **EntryPoint executeUserOp/PackedUserOperation path**, and it differs from the public direct `execute(...)` ABI used for browser registration.
- Follow-up source resolution (below) closed the direct ABI/caller unknown for the deployment version listed in the official deployment manifest. This does not remove the parent’s requirement to verify exact deployed code at its selected fork block.

## Docs consulted (official)

- Context7-resolved Foundry docs: [Anvil CLI](https://github.com/foundry-rs/book/blob/master/src/pages/reference/anvil/anvil.mdx), [forking](https://github.com/foundry-rs/book/blob/master/src/pages/anvil/forking.mdx), [RPC methods](https://github.com/foundry-rs/book/blob/master/src/pages/anvil/rpc-methods.mdx), [custom methods](https://github.com/foundry-rs/book/blob/master/src/pages/anvil/custom-methods.mdx), [EIP-7702 delegation](https://github.com/foundry-rs/book/blob/master/src/pages/cast/eip-7702-delegation.mdx).
- Context7-resolved viem docs: [public client](https://github.com/wevm/viem/blob/main/site/pages/docs/clients/public.md), [simulateContract](https://github.com/wevm/viem/blob/main/site/pages/docs/contract/simulateContract.md), [EIP-7702 signing](https://github.com/wevm/viem/blob/main/site/pages/docs/eip7702/signAuthorization.md), [sendTransaction](https://github.com/wevm/viem/blob/main/site/pages/docs/actions/wallet/sendTransaction.md), [encoding](https://github.com/wevm/viem/blob/main/site/pages/docs/contract/encodeFunctionData.md).
- Aave V3 official Pool docs via Context7: [Pool](https://aave.com/docs/aave-v3/smart-contracts/pool), including `supply`, `withdraw`, `repay`, approval and repayment caveat.

## Safe harness invocation

Use a fresh public RPC URL supplied by the test environment (not committed, not echoed into logs), known fixed block numbers chosen by parent after confirming contracts exist there, and OS-assigned unused loopback port. Example shell recipe (port selection must be race-safe: reserve/bind then hand off, or use harness launcher that binds a socket; do not hardcode 8545):

```bash
ANVIL=/Users/dev/.foundry/bin/anvil
FORK_RPC_URL="$READ_ONLY_PUBLIC_RPC_URL"  # environment only; never print
PORT="$LOCALLY_RESERVED_PORT"
FORK_BLOCK="$PARENT_VERIFIED_BLOCK"
"$ANVIL" --host 127.0.0.1 --port "$PORT" \
  --fork-url "$FORK_RPC_URL" --fork-block-number "$FORK_BLOCK" \
  --chain-id 31337 --hardfork prague --no-mining
```

Wait until local JSON-RPC responds. Verify, before any write, all of: `eth_chainId == 0x7a69` (31337), local `eth_blockNumber` is the fork block, local `eth_getBlockByNumber(0x0).hash` is not treated as upstream identity, upstream endpoint reports expected chain ID (e.g. 1), and `eth_getCode` for protocol/Calibur/token addresses is nonempty on the **local fork**. Verify pinned fork height is expected and all target contracts' code hashes or explorer-verified implementations match parent manifest. Stop if chain ID/provider checks disagree. Local RPC only at `http://127.0.0.1:$PORT`; never pass its unlocked `from` to upstream.

Anvil's unlocked JSON-RPC accounts are test identities, not keys to export/use elsewhere. Better use ephemeral address that has no real-person association. On fork only: `anvil_setCode` can install Calibur's EIP-7702 designator at an ephemeral owner address, but that is local state mutation and does not prove a production delegation/auth path. Do not import/derive production wallet private keys. Impersonate whale solely on fork for local ERC20 `transfer` if needed; `anvil_impersonateAccount`, send `eth_sendTransaction` to local endpoint only, then `anvil_stopImpersonatingAccount`. Do not use auto-impersonation. `anvil_setStorageAt` is a last resort only when exact token storage layout/slot has been independently verified; prefer a real token transfer from an impersonated fork-only whale. WETH can be acquired with local native value only if canonical WETH deposit code is verified and call is on local endpoint.

## Viem call/execution recipe

Construct `defineChain({ id: 31337, ... })`, `createPublicClient({chain,transport:http(localUrl)})`, and `createWalletClient({chain,transport:http(localUrl)})`. Use an Anvil JSON-RPC account address (not a private-key `LocalAccount`); viem permits `account` to be an address for JSON-RPC wallet transport. If direct sender request is not accepted, use local `eth_sendTransaction`/Cast `--unlocked` only against loopback. `encodeFunctionData({abi,functionName,args})` gives exact calldata; prefer `simulateContract` on local client before `writeContract` and assert transaction receipt status. `writeContract` with unlocked JSON-RPC address uses `eth_sendTransaction`; check selected viem version's RPC account support in the repo lockfile before fixer implementation.

Do **not** assume generic ERC-4337 UserOperation helper signs safely without session key; existing smart account path signs UserOps with signer and real protocol integration, which is outside this ephemeral unlock path. The local simulation should explicitly run the root/direct path only after Calibur direct ABI/auth has been verified as above.

### Atomic batch assertions

Once the exact Calibur direct ABI is verified, construct a batch with `revertOnFailure=true` and include only target-verified calls. Example intended group:

1. USDC `approve(router, finiteAmount)`;
2. reviewed exact-router swap with fixed tokens/recipient=owner, bounded amount/minOut and deadline;
3. USDC `approve(router, 0)`.

Assert owner token balances before/after, output token delta, and `allowance(owner,router)==0`. On expected failing router leg, assert reverted receipt and that allowance, token balances, and router state all match pre-batch state. A failed transaction still consumes local nonce/gas, but EVM call state rolls back. Verify the actual deployed router, pool, token, ABI, and route at same pinned block; no generic router/multicall allowance. Only synthetic/test account funds are at risk.

For Aave, successful non-borrowing fixture can locally acquire canonical underlying from fork whale, call exact finite approve then `supply(asset, amount, owner, 0)`; assert aToken increase and allowance behavior, then `withdraw(asset, amount, owner)` and assert balances. Repay is not validated by a no-debt no-op. To exercise repay, create a local-only debt fixture by a separately approved test setup borrow against fork-only collateral (never production authorization) or use a pre-existing fork state with real matching debt owned by ephemeral fixture; repay finite explicit amount with variable mode 2 and `onBehalfOf=owner`, assert debt-token reduction. If no safely constructible debt fixture, report repay untested—do not report a successful zero-repay as proof. Production borrowing remains separate risk approval; fixture borrowing is confined to fork and does not authorize production borrowing.

## Cleanup and evidence

Use `try/finally`: stop any impersonated accounts, terminate Anvil process, remove temporary RPC/config/log artifacts (never store fork URL or config containing keys in repo), and ensure no background server remains. Keep Anvil port/firewall loopback-only. Log test chain ID, fork block/hash, pinned protocol address/code hash, calldata selector (not secrets), tx hash local-only, before/after balances and assertions. Never publish account keys, RPC URLs, impersonation details that expose third-party activity, or signed raw tx. Tests must fail closed if fork data is stale/unavailable, target code absent, ABI/source mismatch, wrong chain, wrong code hash, or state assumptions fail.

## Calibur source and root execution semantics (resolved from official pinned release)

Repository `src/common/calibur/calibur.ts` declares `CALIBUR_ADDRESS = 0x000000005c84F8Fd50b21CAC312528A64437030e` and designator prefix `0xef0100`. The official [Uniswap/calibur README deployment table](https://github.com/Uniswap/calibur/blob/d7dbc80b373067ebe07ab145767dc4677d7e9f94/README.md) maps that exact address to mainnet/Base/Optimism/BNB/Arbitrum at commit `d7dbc80b373067ebe07ab145767dc4677d7e9f94`, v1.1.0. The pinned release has [`src/CaliburEntry.sol`](https://github.com/Uniswap/calibur/blob/d7dbc80b373067ebe07ab145767dc4677d7e9f94/src/CaliburEntry.sol) which says `contract CaliburEntry ... is Calibur {}`; the exact deployed address is verified on [Etherscan](https://etherscan.io/address/0x000000005c84F8Fd50b21CAC312528A64437030e#code), explorer page reports verified contract `CaliburEntry` (checked 2026-10-02). Etherscan verified source/compiler page and the upstream deploy manifest corroborate the implementation family/version; parent should still check local-fork `eth_getCode` and code hash at its chosen pinned block.

Pinned source: [`Calibur.sol`](https://github.com/Uniswap/calibur/blob/d7dbc80b373067ebe07ab145767dc4677d7e9f94/src/Calibur.sol), [`ICalibur.sol`](https://github.com/Uniswap/calibur/blob/d7dbc80b373067ebe07ab145767dc4677d7e9f94/src/interfaces/ICalibur.sol), [`BatchedCallLib.sol`](https://github.com/Uniswap/calibur/blob/d7dbc80b373067ebe07ab145767dc4677d7e9f94/src/libraries/BatchedCallLib.sol), [`CallLib.sol`](https://github.com/Uniswap/calibur/blob/d7dbc80b373067ebe07ab145767dc4677d7e9f94/src/libraries/CallLib.sol). Relevant exact source facts:

- `Calibur.execute(BatchedCall memory batchedCall)` derives `keyHash = msg.sender.toKeyHash()`, requires `_isOwnerOrValidKey(keyHash)`, then `_processBatch`. `ICalibur` documents “Execute entrypoint for trusted callers” and says “only callable by this account or an admin key.”
- `KeyLib.toKeyHash(caller)` returns root sentinel `bytes32(0)` if `caller == address(this)`; otherwise it hashes the caller's secp256k1 key. `KeyManagement._isOwnerOrValidKey` unconditionally allows root key. Thus a **direct owner-self-call** (`tx.from = owner`, `tx.to = owner` where owner locally delegates to Calibur) runs under root without a signature or registered session key. An unrelated unlocked caller is not root; it is rejected unless registered and unexpired.
- `BatchedCallLib.sol` defines `BatchedCall { Call[] calls; bool revertOnFailure; }`; `CallLib.sol` defines each call as `{ address to; uint256 value; bytes data; }`.
- `_processBatch` loops calls; if low-level call returns failure and `revertOnFailure` is true, it reverts `ICalibur.CallFailed(output)`. The transaction-level revert atomically rolls back earlier EVM state changes. Hook reverts always revert the whole operation. With `revertOnFailure=false`, failed low-level calls are tolerated and later calls continue.
- `_process` invokes `to.call{value}(data)` and treats EVM low-level `success` as success. A token function that returns ABI `false` without reverting still has EVM success=true; Calibur will not detect that ERC-20 semantic failure. For approve/action/cleanup tests, assert post-state allowance and balances (and decode/require return values in an independent test where relevant); don't treat batch success receipt as proof each ERC-20 operation semantically succeeded.
- `execute(SignedBatchedCall,bytes)` is a distinct relayed path; it checks executor, verifies the signed batch, nonce/deadline, then processes with the signed key hash. It is not required for a local owner-root-self-call test.
- `executeUserOp(PackedUserOperation,bytes32)` has `onlyEntryPoint`, derives root when signature is raw (after EntryPoint validation) or the session key hash from wrapped signature, then decodes `userOp.callData` after selector as `BatchedCall`. Current helper's `0x8dd7712f + abi.encode(BatchedCall)` is that UserOp path, **not** the public direct overload below. Production session-key/EntryPoint authorization stays intact; do not use a fabricated direct root call to claim session-key security tests passed.

### Exact viem ABI shape and local-only root test

Use exact canonical tuple ABI and overload signature; viem tuple component names/order follow source structs:

```ts
const caliburAbi = [{
  type: 'function', name: 'execute', stateMutability: 'payable',
  inputs: [{ name: 'batchedCall', type: 'tuple', components: [
    { name: 'calls', type: 'tuple[]', components: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ] },
    { name: 'revertOnFailure', type: 'bool' },
  ] }],
  outputs: [],
}] as const

const data = encodeFunctionData({
  abi: caliburAbi,
  functionName: 'execute',
  args: [{ calls: [
    { to: token, value: 0n, data: approveData },
    { to: reviewedAction, value: 0n, data: reviewedActionData },
    { to: token, value: 0n, data: approveZeroData },
  ], revertOnFailure: true }],
})
// send only to local Anvil: { account: ownerAddress, to: ownerAddress, data }
```

`encodeFunctionData` derives selector from `execute(((address,uint256,bytes)[],bool))`. The overload is one tuple argument as specified by `ICalibur.execute(BatchedCall)`; do not hand-type a guessed selector. Local setup may use `anvil_setCode(owner, 0xef0100 || CALIBUR_ADDRESS)` at an ephemeral unlocked owner address, then invoke `eth_sendTransaction`/viem wallet request with **from=owner, to=owner** on the loopback Anvil endpoint. This is exactly the source-proven root condition `msg.sender == address(this)`. Do not invoke through another EOA, because that is not root and may be unauthorized. Verify after `anvil_setCode` that local `eth_getCode(owner)` is exactly the designator and the implementation `eth_getCode(CALIBUR_ADDRESS)` is nonempty. Set only local EIP-7702 state on Prague hardfork. This harness proves Calibur batch behavior under forced local root delegation; it does not prove the authorization transaction lifecycle, user's real EIP-7702 signature, Openfort signing, session-key policy, or production userOp flow.

Safe validation expectations: a successful `approve -> exact reviewed action -> approve(0)` batch with `revertOnFailure=true` has allowance zero and expected owner asset deltas; a deliberately reverting middle call must revert the whole tx and preserve pre-batch allowance/balances. Also test an ERC20 `approve` implementation returning false without revert (or mock a return-false token locally) to demonstrate that outer EVM success is insufficient and state assertions are necessary. Use only fork-funded ephemeral local fixture; no external transaction. Fork parent must choose deployed compatible chain/block and verify exact implementation and target code before invoking.

No Anvil node was started and no transaction was submitted during this research. The direct public ABI and root caller semantics are now source-resolved; local execution, code-hash matching at parent-selected fork height, token/router behavior, and all empirical assertions remain unrun.
