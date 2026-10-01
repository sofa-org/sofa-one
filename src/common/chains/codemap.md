# src/common/chains/

## Responsibility

Single source of truth for the blockchain networks SOFA ONE supports. It statically
registers every chain the backend can operate on (wallet creation, transaction
submission, billing/USDC settlement, session-key policies) along with the per-chain
metadata needed by those features: the viem `Chain` object, native currency symbol,
and canonical USDC/USDT token addresses.

It also provides the lookup/validation helpers used across the codebase to resolve a
`chainId` into a `SupportedChain` (throwing a `BadRequestException` for unknown ids)
and to detect Monad chains (which use a different bundler/paymaster path).

The module is intentionally **static and dependency-free** (only NestJS's
`BadRequestException` and viem). There is no runtime config, no DB, and no I/O — it is
a pure registry + pure functions, so it can be imported anywhere without side effects.

## Design / Patterns

- **Static registry (data-driven):** `SUPPORTED_CHAINS` is a `Record<number, SupportedChain>`
  keyed by numeric `chainId`. Adding a chain is a one-line data addition, not a code path.
- **Typed metadata:** `SupportedChain` is an exported type with `chainId`, `name`,
  `chain: Chain` (viem), `nativeCurrencySymbol`, and optional `usdcAddress` /
  `usdtAddress` (typed as `` `0x${string}` ``). Token addresses are optional because not
  every chain has both (e.g. Monad has neither).
- **Derived constants:** `SUPPORTED_CHAIN_IDS` is derived from the registry keys
  (`Object.keys(...).map(Number)`), so it can never drift from `SUPPORTED_CHAINS`.
- **Fail-fast lookup:** `getSupportedChain` throws `BadRequestException` on unknown ids
  rather than returning `undefined`, forcing callers to handle invalid chains explicitly.
- **Single default:** `DEFAULT_CHAIN_ID = 84532` (Base Sepolia) is the dev default,
  mirrored by `src/config/configuration.ts` and validated against `SUPPORTED_CHAIN_IDS`
  in `src/config/env.validation.ts`.

## Flow

1. Consumers import the registry or helpers directly (no DI, no provider).
2. `getSupportedChain(chainId)` looks up `SUPPORTED_CHAINS[chainId]`; on a hit it
   returns the `SupportedChain` (whose `.chain` is the viem `Chain` used for RPC/contract
   calls), on a miss it throws `BadRequestException('Chain <id> is not supported')`.
3. `isMonadChain(chainId)` returns `true` only for `143` (Monad) and `10143` (Monad
   Testnet); used to select the Pimlico bundler/paymaster path in Openfort calls.
4. `SUPPORTED_CHAIN_IDS` feeds DTO validation (`@IsIn`) and env validation so invalid
   chain ids are rejected at the boundary before reaching service logic.

## Integration

Consumed across the backend (all via `../../common/chains/supported-chains`):

- **`src/core/openfort/openfort.service.ts`** — resolves `chain` for wallet/transaction
  Openfort SDK calls; uses `isMonadChain` to pick the Pimlico bundler path.
- **`src/modules/wallet/wallet.service.ts`** — validates `chainId` and builds wallet
  operations from the resolved `SupportedChain`.
- **`src/modules/transactions/`** — `transactions.service.ts` and
  `transaction-simulation.service.ts` resolve the chain for send/simulation;
  `dto/list-transactions-query.dto.ts` uses `SUPPORTED_CHAIN_IDS` in `@IsIn`.
- **`src/modules/session-key/session-key-policy.service.ts`** — resolves chain for
  session-key policy construction.
- **`src/modules/billing/`** — `billing-pricing.ts` and `billing-reconciliation.service.ts`
  iterate `SUPPORTED_CHAINS` / look up token addresses; `onchain/usdc-payment.service.ts`
  and `onchain/usdc-receipt.provider.ts` resolve the chain for USDC settlement.
- **`src/config/env.validation.ts`** — validates `DEFAULT_CHAIN_ID` against
  `SUPPORTED_CHAIN_IDS`; `src/config/configuration.ts` reads the default chain id.

**Boundary / invariants:** token addresses must come from this registry, never from the
client (see `src/modules/billing/onchain/usdc.constants.ts`). Adding a chain here
immediately makes it valid for env validation, DTO validation, and all downstream
services — so changes are high-blast-radius and should be reviewed against every
consumer above.

## Files

- `supported-chains.ts` — the only production file: `SupportedChain` type,
  `DEFAULT_CHAIN_ID`, `SUPPORTED_CHAINS` registry (14 chains), `SUPPORTED_CHAIN_IDS`,
  `getSupportedChain`, `isMonadChain`.
- `supported-chains.spec.ts` — unit tests (not part of production surface).
- `codemap.md` — this file.
