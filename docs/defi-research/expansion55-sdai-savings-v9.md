# sDAI Savings v9 — bounded source and policy candidate

## Candidate boundary

Accepted v9 selects exactly four no-referral Ethereum SavingsDai functions on the dated Mainnet role `0x83f20f44975d03b1b09e64809b757c47f942beea`: `deposit`, `mint`, `withdraw`, and `redeem`. Their stable IDs are `sdai-savings:no-referral-v1:1:0x83f20f44975d03b1b09e64809b757c47f942beea:{deposit|mint|withdraw|redeem}`. The raw source snapshot remains inactive; explicit per-function admission makes only these four generated production entries active. The isolated `buildSdaiSavingsRegistry()` helper remains test-only and is not wired into production.

## Dated source and ABI qualification

Maker's official README pinned at `2b7acb95289a9eb3a8844206d5712eabfa206efc` (dated 2023-11-02) documents the Mainnet role and identifies `665879762f8b5df5d234463f45d1d6a49bd4fbeb` as the no-referral generation. At that exact implementation pin (dated 2023-05-30), `src/SavingsDai.sol` declares:

| Function | Full signature | Selector | Full ABI hash |
|---|---|---|---|
| `deposit` | `deposit(uint256,address)` | `0x6e553f65` | `0xd9aa3738e0f53bd8105b8c7e2517c7338d49553e906e80abf32af4c3a38f5997` |
| `mint` | `mint(uint256,address)` | `0x94bf804d` | `0xb8f77e58b52fad3ac88bf14cb752b27c8e41983c8c149319e73db4c84f21e352` |
| `withdraw` | `withdraw(uint256,address,address)` | `0xb460af94` | `0x59b31bf3102e98ba6650eb9794b53143fd4c1b90166242569843084f9d8df901` |
| `redeem` | `redeem(uint256,address,address)` | `0xba087652` | `0x8926ac0e897fc0dab6e7c43a4888021fd1b5270b6fb7e3046f6023c3c637444e` |

All are `external nonpayable`; parameter and return names in the candidate ABIs follow implementation declarations because the pinned interface parameters/returns are unnamed. The ABI snapshot is based on those declarations and is not claimed to be compiler-generated output. The implementation's internal conversion, DAI `transferFrom`, fixed DaiJoin and Pot calls do not add arbitrary wallet calldata. This is dated role/source qualification only—not current target bytecode, proxy/slot, funding, liquidity, or execution evidence.

The official README and implementation/interface were inspected from the accepted cached bare Git repository on `2026-10-04`; source `retrievedAt` fields record that inspection date, not historical commit publication dates. No Etherscan page was retrieved, so none is cited as a dated observation. The new raw candidate's canonical repository snapshot digest is `c1ca1ed92e19a6958b7b5824cf340d82f127605ce0e9e2d531c43dd61258c862` (raw file SHA-256 `80fc52e66e837cf460fa354b7d1c355e9620ca82435d41b8a4e7757c9dedb588`); the focused test pins the canonical digest using the existing helper. Its three source records are the dated official README role and the exact pinned implementation/interface URLs.

## Policy and limits

The four entries are ordinary single-call capabilities, each requiring its exact independent grant. There are no child nodes, default grants, DAI approval members, automatic approval pairing, new scope types, or financial/market/owner restrictions. ABI-valid zero and maximum uint256 values and caller-selected receiver/owner addresses remain accepted by the platform policy; protocol validation/revert behavior is unchanged. Any approval remains a separate capability and operation.

The focused tests check the complete four-function source/ABI/selector/identity/hash mapping, candidate exclusion from the historical v8 669-definition baseline before isolated combination, exact grants, wrong chain/target/selector, malformed calldata, nonpayable value, single-root plan, and final grant/pause/key/commitment/plan rechecks. The baseline exclusion assertion reconstructs an isolated 669-definition view by filtering the four reviewed v9 IDs from the now-v9 production manifest; it is not an independent Git-history absence assertion. The immutable Git v8 catalog/profile comparisons were separately verified in the integrated validation. These mocked policy tests are not database concurrency proof or funded execution. The sDAI selection is not a complete savings workflow, all-market coverage, current runtime identity, liquidity, or safety certification.

## Accepted v9 integration and Gate 5

Gate 5 attempt 1 passed with zero material findings. Accepted v9 contains 673 definitions (650 actions, 23 unchanged approvals), 16 unchanged finite scope hashes, and 69 profiles / 399 unique selected IDs. Exactly four source-qualified scope-free sDAI calls were added; all 669 full v8 function objects and all 68 complete v8 profile objects, order, membership, and fingerprints are preserved. The new four-member profile has fingerprint `sha256:b3bcafb925788872d0f01a236eebd26d1d9d24cd76ba6ac32e533e79f21d2ea4`; it adds no approval or grant. Full Jest validation passed 186 suites / 2,725 tests; the opt-in PostgreSQL pause-concurrency test was skipped because its two environment gates were unset, not DB proof. Source and ABI evidence remains historical role/declaration qualification only; current runtime, referral configuration, DSR state, conversion behavior, eligibility, liquidity, funded execution, complete workflow, and financial safety are not established. This is an extension to the existing savings objective, not a new 55-family admission; 53/55 bounded brands remain and the 90% market objective remains unmet.
