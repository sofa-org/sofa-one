# Deep-work proposal: closed Enso static Weiroll v1

**Advisory only.** This proposal does not implement or admit Enso. Defer any code until current v7 five-source acceptance is coherent and committed. See [`expansion55-enso-v8.md`](../../docs/defi-research/expansion55-enso-v8.md) for source references, the bounded router root, and evidence caveats.

## Authorization shape

Treat `Single((uint8,bytes),bytes)` on Ethereum router `0xf75584ef6673ad213a685a1b58cc0330b8ea22cf` as a mandatory-scope root, never as a null-scope ordinary call. Require canonical decode/re-encode of outer calldata and nested token data. For native token type 0, nested amount must equal root native value. For ERC-20 token type 1, nested `(token,amount)` must decode canonically and root value must be zero. NFT modes 2/3 are outside this initial scope proposal. Root expansion is authorized only when the root capability, scope identity, every literal child capability, exact target/chain/signature/full ABI identity, and canonical child call all match. Recheck all grants, pause, ownership/revocation and the ordered-plan commitment at final authorization under existing lock order. Missing any one element denies.

## Language: `enso-static-weiroll-v1`

Permit only inner selector `executeShortcut(bytes32,bytes32,bytes32[],bytes[])` (`0x95352c9f`), on the specifically bound shortcuts target. No multisend inheritance exists in the reviewed source hierarchy; do not add multisend, fallback, callback, helper or alternate-selector paths.

Parse each command as exactly 32 bytes: selector `[0:4]`, flags `[4]`, six compact state indices `[5:11]`, output `[11]`, and target `[12:32]`. Permit only flags `0x21` (CALL + FLAG_DATA) and `0x23` (VALUECALL + FLAG_DATA); every output must be `0xff`. For CALL require indices `[next,ff,ff,ff,ff,ff]`, consuming the next state item as calldata. For VALUECALL require `[next,next+1,ff,ff,ff,ff]`, consuming an exactly-32-byte uint256 value followed by calldata. Consume state sequentially and exactly, maximum 18 entries. No state writes, output references, gaps, extras, high-bit/index tricks, special indices, or dynamic chaining. Inner calldata selector must equal the selected child ABI selector: the VM uses FLAG_DATA and ignores the command header selector. Decode and re-encode child calldata canonically; enforce ordinary payability.

Reject staticcall, delegatecall, tuple/extended/argument-building commands, every other/reserved flag, non-`0xff` outputs, nested wrappers/recursive executors, and children that are not active, scope-free ordinary exact functions. Each child target/chain/capability ID/signature/full ABI hash is a literal validated against the immutable catalog, not a family/address wildcard.

## Bounds and value accounting

Allow 1–9 commands per root: root plus commands is at most 10 nodes per request. Enforce root, command, grant, approval, and node budgets across aggregate multiroot requests (existing limits include 100 grants, 10 nodes, 23 approvals). Record command count, consumed state count, each child value, sum of child values, and ordered plan commitment without logging calldata/state. Child-value sum is not constrained to root value: shortcuts can retain/recycle funds. Count wallet outflow once at roots, never double-charge children. Explicitly disclose shared/stranded shortcut funds, caller context, and financial/workflow limitations.

Amounts, minimum returns, token/spender/recipient arguments remain what the separately granted ABI permits; this scope is not a financial cap or automatic workflow. An Enso outer router approval is a separate operation and must not be silently paired with a root or auto-granted. Output discard limits data dependencies, not financial risk.

## Proposed initial child literals

- Uniswap V3 Router02 `exactInputSingle`, chain 1, `0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45`, selector `0x04e45aaf`.
- Aave V3 `supply`, chain 1, `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`, selector `0x617ba037`.
- USDC `approve`, chain 1, `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`, selector `0x095ea7b3`.

Derive every child's full ABI hash from the immutable baseline when implementation is undertaken; do not infer or invent hashes. Compute and pin the final language/scope hash only after the exact source-qualified child identities and encoding are validated.

## Likely code boundaries and gates

Potential implementation locations: `defi.types.ts` (closed versioned variant), new pure `execution/enso.ts` decoder, `registry/defi-manifest.ts` (root requires exact scope and validates children), `defi-policy.service.ts` (expansion, initial/final grant/pause checks, ordered-plan commitment). Preserve existing semantics and hashes for old variants, execution budgets, SHARE→UPDATE lock order, transaction protections and signing denial. Do not touch profile/grant defaults.

Required tests include native and ERC-20 meaningful examples; canonical outer, token-data and child codecs; every forbidden flag/index/output mode; selector-header mismatch; root/child target, value, payload and order tampering; missing root and each child grant; grant removal/revocation and pause at initial/final checks; root+9 acceptance/root+10 rejection and aggregate multiroot limits; exact state consumption and maximum; accounting without child-sum≤root-value; plan/scope/ABI identity tampering; no sensitive state/calldata in audit; no automatic grants; legacy scope hashes and profiles unchanged. Until those tests run successfully, and independent funded/database/runtime investigations are performed when appropriate, claim no runtime identity, current code-slot binding, liquidity or funded execution.
