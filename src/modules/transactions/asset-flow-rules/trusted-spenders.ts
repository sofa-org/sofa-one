/**
 * Chain-scoped spender/operator addresses trusted for *revoke-only* authorization
 * classification (approve amount=0 / setApprovalForAll false).
 *
 * Populated from the same audited Aave V3 Pool + Uniswap V2/V3 router registries
 * used by retained-protocol rules. Not a general approval allowlist — non-zero
 * approvals and unknown spenders remain unknown.
 */
export const TRUSTED_SPENDERS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  1: Object.freeze([
    '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', // Aave V3 Pool
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // Uni V3 SwapRouter02
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uni V2 Router02
  ]),
  10: Object.freeze([
    '0x794a61358d6845594f94dc1db02a252b5b4814ad',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    '0x4a7b5da61326a6379179b40d00f57e5bbdc962c2',
  ]),
  56: Object.freeze([
    '0x6807dc923806fe8fd134338eabca509979a7e0cb',
    '0xb971ef87ede563556b2ed4b1c0b0019111dd85d2',
    '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
  ]),
  137: Object.freeze([
    '0x794a61358d6845594f94dc1db02a252b5b4814ad',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    '0xedf6066a2b290c185783862c7f4776a2c8077ad1',
  ]),
  143: Object.freeze([
    '0x69a5f9ad4f96ebf0a0c792dd42a01cc5c0102fef',
    '0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900',
  ]),
  8453: Object.freeze([
    '0xa238dd80c259a72e81d7e4664a9801593f98d1c5',
    '0x2626664c2603336e57b271c5c0b26f421741e481',
    '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
  ]),
  42161: Object.freeze([
    '0x794a61358d6845594f94dc1db02a252b5b4814ad',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
  ]),
  84532: Object.freeze([
    '0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27',
    '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4',
    '0x1689e7b1f10000ae47ebfe339a4f69decd19f602',
  ]),
  11155111: Object.freeze([
    '0x6ae43d3271ff6888e7fc43fd7321a503ff738951',
    '0x3bfa4769fb09eefc5a80d6e87c3b9c650f7ae48e',
    '0xee567fe1712faf6149d80da1e6934e354124cfe3',
  ]),
  11155420: Object.freeze([
    '0xb50201558b00496a145fe76f7424749556e326d8',
    '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4',
  ]),
} as const);
