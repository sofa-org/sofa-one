# Expansion 55: 0x Native Orders v7 source candidate

## Scope and disposition

This bounded candidate records eight exact Ethereum (chain 1) 0x Exchange Proxy Native Orders methods: four fills (`fillRfqOrder`, `fillOrKillRfqOrder`, `fillLimitOrder`, `fillOrKillLimitOrder`) and four maker cancellation methods (`cancelRfqOrder`, `cancelLimitOrder`, `batchCancelRfqOrders`, `batchCancelLimitOrders`). The source contract is deliberately `inactive`. `registry/zero-x` is an isolated test fixture only; it is not admitted to the production manifest, creates no automatic grants, and makes no current deployment/runtime-identity claim.

The ABI is copied in full, including tuple component names and internal types, output names/types, and mutability, from the compiler output artifact at pinned official 0xProject/protocol commit `2c8e51e36ccbafa39f7c9003f4087710665acb02` (`IZeroEx.json`, SHA-256 `14f307a42a522d8aee78d0ce47c6843c74ca8287737617108b7c84756bb62012`). The pinned official address registry supplies the Ethereum Exchange Proxy role/address `0xdef1c0ded9bec7f1a1670819833240f027b25eff`. The artifact source, address source, and Native Orders feature/settlement/cancellation source are separately cited in the source record.

Selector identity checks cover `fillRfqOrder` `0xaa77476c`, `fillOrKillRfqOrder` `0x438cdfc5`, `fillLimitOrder` `0xf6274f66`, `fillOrKillLimitOrder` `0x9240529c`, `cancelRfqOrder` `0xfe55a3ef`, `cancelLimitOrder` `0x7d49ec1a`, `batchCancelRfqOrders` `0xf6e0f6a5`, and `batchCancelLimitOrders` `0x9baa45a8`. Internal fill entrances, signer registration, transform-related functionality, and other opaque/dynamic-byte selectors are excluded.

## Security and workflow boundaries

The reviewed fill bodies perform fixed ERC20 transfers and protocol signature/order checks; cancellation bodies update maker or registered-signer order state. They do not expose arbitrary wallet callbacks or a wallet multicall. RFQ `txOrigin` is an order-eligibility/workflow condition: the actual submission transaction origin must qualify. It is not an assertion that the platform owner is the only permitted origin. Signature fields are the declared `LibSignature.Signature` tuple and reviewed ECDSA/native-order path, not ERC-1271 arbitrary callback authority.

The exact ABI still exposes caller-controlled token, amount, fee, maker/taker/recipient, pool, expiry, salt, and fill-amount arguments. This candidate imposes no financial caps, recipient/feed rules, amount bounds beyond ABI types, or token-pair restrictions. Token approvals, valid orders/signatures, expiry, balances and any protocol-side order eligibility remain separate prerequisites; approval capabilities are not included or automatically added. Payable fill methods retain their ABI mutability; nonpayable methods reject native value under the generic policy.

This is source qualification only. It does not establish present deployment/code identity, proxy implementation or storage-slot state, runtime wiring, liquidity, a complete trading workflow, funded execution, or financial safety. At baseline `74bb052ec003656e5810d5af42d50a300e94aad3`, production remains 640 definitions (617 actions and 23 independent approvals), 15 scopes, and 62 profiles; this candidate admits nothing and makes no claim about all of expansion 55, all 0x functionality, or 90% market coverage.
