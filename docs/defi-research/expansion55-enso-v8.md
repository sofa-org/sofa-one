# Expansion 55 — Enso v8 static Weiroll scope (advisory; deferred)

**Status:** source-qualified advisory only, not a phase-gate attempt or implementation. Enso remains deferred until the current v7 five-source set has coherent acceptance and is committed. This document makes no claim of implemented code, v8 candidate/admission, profile selection, or runtime support. Baseline `74bb052640` (15 finite scopes / 62 profiles) is not changed here.

## Address-bound source evidence

- Deployer record: [`EnsoBuild/shortcuts-client-contracts`, commit `483408a3219451858abcd92c2f7b19a9783c14cc`, `broadcast/EnsoRouterDeployer.s.sol/1/run-1743724671.json`](https://github.com/EnsoBuild/shortcuts-client-contracts/tree/483408a3219451858abcd92c2f7b19a9783c14cc/broadcast/EnsoRouterDeployer.s.sol/1). It records Ethereum router `0xf75584ef6673ad213a685a1b58cc0330b8ea22cf`, successful tx `0x868fb3283d1c970dc3f5a3eeb163ab55e6ad950fd41d196aab7fa9c1563864f5`, block 22191812, timestamp `2025-04-03T23:57:51Z`, generation `6f012e9`. The generation is a short SHA and is disclosed as such; it is not asserted to equal the latest repository revision or as a live runtime check.
- [Etherscan router source](https://etherscan.io/address/0xf75584ef6673ad213a685a1b58cc0330b8ea22cf#code): verified router body SHA-256 `c032c8f9fa1af179fbac8f6a6a052bd711e8d4bd879bb37d6681e6704c9dc7ef`; full 11-entry ABI SHA-256 `5fd35015a8160702cd4770640e26f7a508cdda4d7143dccea86cff5d58d52e50`. Source and ABI were retained as `src_router_EnsoRouter.sol` and `enso-router-verified-abi.json` in the research evidence set; the public explorer URL, rather than a temporary path, is the durable reference.
- Oracle VM and CommandBuilder source: [`EnsoBuild/enso-weiroll`, pinned commit `900250114203727ff236d3f6313673c17c2d90dd`](https://github.com/EnsoBuild/enso-weiroll/tree/900250114203727ff236d3f6313673c17c2d90dd). SHA-256 identities for the reviewed VM and CommandBuilder source were `6fac2b3700991e1b21c4e9ef4fd134ba5d1d5ae9ea6554898cdce5bbef8ce04a` and `9182d3fc05dea57d41f6b995050951a7786c25326f31cac4bc8978b3fe07cbbb`. Oracle comparison says these source bodies byte-match verified dependencies. This is a pinned-source comparison, not runtime bytecode proof.

## Precisely bounded root proposal

The only initially proposed root is payable `Single((uint8,bytes),bytes)` (source ABI name `Single`, Solidity canonical tuple signature `Single((uint8,bytes),bytes)`), selector `0xb94c3609`, full ABI hash `0xe3045106c2f667460faa9d5d67104b5f7f70c24186421cf1dbc7a2f03624c5c9`. Inputs are `tokenIn` (`struct Token`, components `enum TokenType tokenType`/`uint8`, `bytes data`) and `data` (`bytes`); output is `bytes response`. The other three router methods are not selected, which is an initial-scope boundary, not a blanket protocol prohibition.

The router constructor creates `new EnsoShortcuts(address(this))`; the immutable executor regards the router as its caller. Shortcut child calls therefore originate from the shortcuts contract, not the wallet. `accountId` and `requestId` are event metadata and are not authorization. A separately broadcast address beginning `0x4fe93…` is not claimed to be the wallet, root target, or current shortcut identity. No wrapping or automatic approval is implied.

For the selected root's token tuple, only native (`TokenType` 0) and ERC-20 (`TokenType` 1) modes are proposed:

- Native: canonical nested `data` decodes to `uint256 amount`, and `amount == root.value`.
- ERC-20: canonical nested `data` decodes to `(address token, uint256 amount)`, root value is zero, and the fixed transferFrom path moves from wallet to shortcuts.

Both outer root calldata and nested token data must decode and re-encode byte-for-byte canonically. NFT modes 2/3 are outside this proposed initial scope; they are not asserted to be platform-wide forbidden. The selected root forwards arbitrary `data` to shortcuts, so it requires a mandatory closed scope; it must never be authorized as an unscoped/null-scope function.

## Closed `enso-static-weiroll-v1` proposal

The only proposed inner selector is `executeShortcut(bytes32 accountId,bytes32 requestId,bytes32[] commands,bytes[] state)`, selector `0x95352c9f`. Reviewed verified-source hierarchy does **not** inherit `AbstractMultiSend`; no multisend, fallback, holder callback, or other inner selector is included.

Each 32-byte command is interpreted as selector bytes `[0:4]`, flags byte `[4]`, six indices `[5:11]`, output index `[11]`, and target bytes `[12:32]`. Only exact flags `0x21` (CALL + FLAG_DATA) and `0x23` (VALUECALL + FLAG_DATA) are proposed. Output must be `0xff` (discard): VM output writes otherwise mutate state. Reject static/delegate calls, tuple/extended/argument-building commands, reserved modes, non-discard outputs, and all unsupported flags.

Scope is sequential only. Every command consumes the next literal calldata state item at its declared index. `CALL` indices are `[next,ff,ff,ff,ff,ff]`; `VALUECALL` indices are `[next,next+1,ff,ff,ff,ff]`, where the first item is exactly 32 bytes of uint256 value and the second is calldata. Each command target, chain, capability ID, signature, and full ABI identity must bind an active, scope-free ordinary child function. Child calldata must decode and re-encode canonically and satisfy ordinary payability checks. Child wrappers/recursive executors are forbidden. The selector in each calldata payload must match the selected child ABI; checking only the command header selector is insufficient because runtime FLAG_DATA ignores that header.

Require 1–9 commands per root; one root plus commands is at most 10 nodes per request, and aggregate multiroot limits must be enforced across the entire request. State consumption is exact, at most 18 items, with no extra state, high-bit/index tricks, special indices, state-output references, or rewriting. No command produces a state value under this language.

The three proposed existing literal child identities are:

1. `uniswap-v3-router02:v3:1:0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45:exact-input-single`, selector `0x04e45aaf`.
2. `aave-v3:1:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:supply`, selector `0x617ba037`.
3. `erc20:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:approve`, selector `0x095ea7b3`.

These identify candidate existing literals only. Their exact full ABI hashes and any scope hash must be derived from the immutable baseline at implementation time; they are deliberately not guessed or supplied here. Example meaning: a USDC input transfer may be followed by separately granted approval and caller-chosen Aave supply; this does not pair the wallet's approval to Enso's outer call, and does not authorize or create automatic approval. Ordinary ABI-valid amounts, spenders and recipients remain caller-controlled. Approval-only use remains possible with its explicit grant. Discarded outputs prevent dynamic chaining; they are not a financial cap.

Record each child's value and the BigInt sum for audit/plan integrity, but do **not** require child-value sum ≤ root value: shortcuts may hold or recycle funds, so such a check can incorrectly reject legitimate execution. Root wallet outflow budgets apply once to roots, not again to children. Shared/stranded shortcut funds and caller context are explicit workflow risks.

## Deferred implementation / acceptance requirements

If reconsidered after the v7 acceptance/commit prerequisite, likely touchpoints are `defi.types.ts`, a new `execution/enso.ts` pure decoder, `registry/defi-manifest.ts` exact mandatory root-scope and child validation, and `defi-policy.service.ts` expansion plus ordered plan commitment. Preserve old scope hashes, grants, profiles, pause SHARE → key UPDATE locking, final rechecks, TEE/signing denial, and existing transaction safeguards (100-grant / 10-node / 23-approval limits). Do not implement from this advisory alone.

Acceptance must cover valid native and ERC-20 roots with meaningful swap/lending children; canonical nested decode/re-encode; invalid flags, indices, output modes, selector-header mismatch, payload/target/value/order tampering; root+9 versus root+10 and aggregate multiroot limits; root-only grants, every missing child grant, root removal, and initially/finally paused or revoked grants. Test ordered-plan commitment and all source/ABI/scope identities. Assert calldata/state never leak into audit metadata, no automatic grants occur, and legacy hashes/profiles remain unchanged. No database, funded execution, current code-slot, current runtime, or liquidity claim should be made until independently and actually tested.
