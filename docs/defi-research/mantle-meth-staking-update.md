# Mantle mETH staking update

This ordinary update adds exactly one unscoped payable Ethereum binding: `stake(uint256 minMETHAmount)` on the documented Staking role at `0xe3cbd06d7dadb3f4e6557bab7edd924cd1489e8f`. Stable ID: `mantle-meth-staking:v1:1:0xe3cbd06d7dadb3f4e6557bab7edd924cd1489e8f:stake`. The contract is the staking role, not the mETH token. Unstake requests, permit, queue/withdraw, admin, token, helper, and other initial-subset functions are excluded.

The inactive source snapshot and exact plan are in `data/defi-catalog/updates/mantle-meth-staking/`. Family/version is `mantle-meth-staking` / `staking@b3698f2d`. Immutable baseline is the accepted Ankr catalog: raw SHA-256 `e5baf29f70c6183a20f26717d35d5601c13e9cd049bf2e1700c4ee1221e58138`; manifest hash `0xee6afb400468e92f8752cd60982a1886bdb3079a90d9c4bd6693d11337cd9b27`. Source canonical SHA-256 `595974ae7f4ef98cd937aa6c87ad81172c615a133456ef4d3efebb6203abb6a8`.

## Role, source, and ABI evidence

Official Mantle documentation identifies the Ethereum Staking role and `stake(uint256)`. Pinned `mantle-lsp/contracts` commit `bbc4e8bf7d3e3b4ca0c5be07aba409ac66611c76` (published 2026-05-22) contains `.mainnet.env` with the same role address. The official repository `Staking.sol` carrier SHA-256 is `446670f9a21ac536fa01e9a381e935564dd4d4615fd72ee1e96a404801252772`. It differs from the address-bound verified `Staking.sol`; this qualification uses only the verified target body and does not assert source equivalence.

Retained official repository carriers: `official-staking-addresses.md` SHA-256 `ea368a28a52c7dc4c51d1548d8371d03781abe3b06eb46c6d0d2abef3924b87f`; `.mainnet.env` SHA-256 `3a14da2cc6917ca71ad796ba45b89e81f51d7d5e2fabf05d94652a6170aa2b95`. Their repository pin/publication date is distinct from the 2026-10-06 carrier inspection. Etherscan proxy and implementation HTML are also retained with hashes below; their dated implementation association does not establish current proxy storage or runtime.

Etherscan's dated proxy-page association identifies implementation `0x01a360392c74b5b8bf4973f438ff3983507a06a2`; that association is not proof of current proxy implementation or storage. Address-bound carrier hashes: verified `Staking.sol` `b3698f2db4860792f87622abfce1004230c49a0f361b87f664b2bcbb6778f445`; full implementation ABI `25352d7a32971ebf6e4caa8560d54b21bc77e97d0860c68fd19ac0e4fb57788c`; selected `stake` ABI `084cb1e85719366ae23da9e63850a0ed93bf0a22370ab1d98a5c435a100bcf03`; proxy HTML `02579d6c8cf21be3ce1e6d4eff13f199b583da9161abe89f70d78612bf1cb401`; implementation HTML `f28fb3c970888854be8f2b6138fab4262d076edaffa16785e2f8e67c2c3a91ae`.

Exact ABI: `{"type":"function","name":"stake","stateMutability":"payable","inputs":[{"internalType":"uint256","name":"minMETHAmount","type":"uint256"}],"outputs":[]}`. Selector `0xa694fc3a`; ABI identity hash `0xd857f8e77b2a09ddb4af1db1478231b84d33c94d8edf2a6c98b7da3ec9d19b76`.

## Inspected call behavior and limits

The address-bound verified body checks protocol pause, optional protocol allowlist, and configured `minimumStakeBound`; computes `mETHMintAmount` with `ethToMETH(msg.value)`; checks configured maximum supply and caller-supplied `minMETHAmount`; accounts `msg.value` as unallocated ETH; then calls the fixed configured `mETH.mint(msg.sender, mETHMintAmount)`. Protocol allowlist, minimum/maximum, fee/oracle/accounting, token, or governance state may reject a call. The initializer's 0.1 ETH value is not a verified live bound.

The caller controls ordinary payable root value and the ABI `minMETHAmount` argument; both remain freely policy-authorized from zero through uint256 maximum. The platform adds no amount/category allowlist, minimum-output cap, price-feed, balance, or recipient gate. Caller-only minting is protocol behavior, not a new platform recipient restriction. Dated implementation association and verified source do not prove current proxy/storage/token configuration, funding, execution success, or financial safety.
