# StakeDAO v6 source candidate: Ethereum CRV Depositor

## Qualified target and source

The selected Ethereum chain-1 CRV Depositor is `0xc1e3Ca8A3921719bE0aE3690A0e036feB4f69191`, sourced from official `StakeDAO/AddressBook` commit `bef55ecaff94eb06dd7057c6423b5f81bd83bff6`, `src/AddressBook.sol`. Its `CRV_DEPOSITOR` constant identifies this user-facing role.

The exact-match Sourcify record for this address was verified 2024-08-08 and identifies `contracts/locking/CrvDepositor.sol`, Solidity `0.8.7+commit.e28d00a7`. The fetched record contains the full 24-entry verified ABI; this fixture retains only the two selected ordinary entrypoints below. The dated verification is source/ABI evidence, not current runtime-code identity. No fabricated Git commit is assigned to the Sourcify record.

## Selected ordinary entrypoints

Both are `nonpayable`, return no values, and preserve Sourcify's primitive `internalType` and parameter names:

* `deposit(uint256 _amount,bool _lock,bool _stake,address _user)` → `stakedao:crv-depositor-v1:1:0xc1e3ca8a3921719be0ae3690a0e036feb4f69191:deposit`.
* `depositAll(bool _lock,bool _stake,address _user)` → `stakedao:crv-depositor-v1:1:0xc1e3ca8a3921719be0ae3690a0e036feb4f69191:deposit-all`.

At the pinned verified source, `deposit` is `public` and `depositAll` is `external`; neither has a caller restriction modifier nor checks `_user == msg.sender`. `depositAll` reads the caller's CRV balance then delegates to `deposit`. `deposit` transfers CRV from `msg.sender`; lock/stake selection and beneficiary are supplied by the caller. CRV allowance and locker/minter/gauge dependencies are intrinsic protocol conditions, not platform approval coupling or financial filters. Caller-selected ABI-valid amount, flags, and nonzero user remain unrestricted by platform policy; the implementation itself requires positive amount and nonzero beneficiary.

The AddressBook also identifies SDCRV gauge `0x7f50786A0b15723D741727882ee99a0BF34e3466`; its Sourcify shell is proxy-admin-only evidence, not an ordinary-user target qualification. It is not included as a capability.

## Exclusions and limits

No gauge target, receipt-token target, old veCurve vault, admin, permit, general executor, or guessed claim/withdraw method is included. These two deposit operations are not a complete StakeDAO workflow, exit/reward-claim grant, whole-protocol coverage, current-runtime attestation, liquidity proof, or funded-execution certification. The raw v6 candidate is inactive; the separate active builder exists only for isolated offline tests and does not wire runtime or grant users capabilities.
