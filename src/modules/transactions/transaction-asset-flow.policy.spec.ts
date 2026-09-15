import { encodeFunctionData, type Address, type Hex } from 'viem';
import {
  classifyTransactionAssetFlow,
  RETAINED_PROTOCOL_RULES,
  type AssetFlowInteractionInput,
} from './transaction-asset-flow.policy';

const OWNER = '0x1111111111111111111111111111111111111111';
const OWNER_CHECKSUM = '0x1111111111111111111111111111111111111111';
const EXTERNAL = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const CHAIN_ID = 84532;

// Official registry addresses used by the policy (lowercase).
const AAVE_POOL_84532 = '0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27';
const AAVE_POOL_1 = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const UNI_V3_ROUTER_84532 = '0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4';
const UNI_V3_ROUTER_1 = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45';
const UNI_V2_ROUTER_1 = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
const UNI_V2_ROUTER_84532 = '0x1689e7b1f10000ae47ebfe339a4f69decd19f602';
const FAKE_ROUTER = '0x9999999999999999999999999999999999999999';

function classify(
  interactions: AssetFlowInteractionInput[],
  ownerAddress: string = OWNER,
  chainId: number = CHAIN_ID,
) {
  return classifyTransactionAssetFlow({ interactions, ownerAddress, chainId });
}

function padAddress(address: string): string {
  return address.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

function padUint(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, '0');
}

function erc20Transfer(to: string, amount: bigint = 1n): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'transfer',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'transfer',
    args: [to as Address, amount],
  });
}

function transferFrom(from: string, to: string, amount: bigint = 1n): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'transferFrom',
        inputs: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'amountOrTokenId', type: 'uint256' },
        ],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'transferFrom',
    args: [from as Address, to as Address, amount],
  });
}

function erc721SafeTransferFrom(from: string, to: string, tokenId: bigint = 1n): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'safeTransferFrom',
        inputs: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'tokenId', type: 'uint256' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'safeTransferFrom',
    args: [from as Address, to as Address, tokenId],
  });
}

function erc721SafeTransferFromData(
  from: string,
  to: string,
  tokenId: bigint = 1n,
  data: Hex = '0x',
): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'safeTransferFrom',
        inputs: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'tokenId', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'safeTransferFrom',
    args: [from as Address, to as Address, tokenId, data],
  });
}

function erc1155SafeTransferFrom(
  from: string,
  to: string,
  id: bigint = 1n,
  amount: bigint = 1n,
): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'safeTransferFrom',
        inputs: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'id', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'safeTransferFrom',
    args: [from as Address, to as Address, id, amount, '0x'],
  });
}

function erc1155SafeBatchTransferFrom(from: string, to: string): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'safeBatchTransferFrom',
        inputs: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'ids', type: 'uint256[]' },
          { name: 'amounts', type: 'uint256[]' },
          { name: 'data', type: 'bytes' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'safeBatchTransferFrom',
    args: [from as Address, to as Address, [1n, 2n], [10n, 20n], '0x'],
  });
}

function erc20Approve(spender: string, amount: bigint = 1n): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'approve',
        inputs: [
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'approve',
    args: [spender as Address, amount],
  });
}

function aaveSupply(onBehalfOf: string, amount: bigint = 1n): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'supply',
        inputs: [
          { name: 'asset', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'onBehalfOf', type: 'address' },
          { name: 'referralCode', type: 'uint16' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'supply',
    args: [TOKEN as Address, amount, onBehalfOf as Address, 0],
  });
}

function aaveSupplyWithPermit(onBehalfOf: string): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'supplyWithPermit',
        inputs: [
          { name: 'asset', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'onBehalfOf', type: 'address' },
          { name: 'referralCode', type: 'uint16' },
          { name: 'deadline', type: 'uint256' },
          { name: 'permitV', type: 'uint8' },
          { name: 'permitR', type: 'bytes32' },
          { name: 'permitS', type: 'bytes32' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'supplyWithPermit',
    args: [
      TOKEN as Address,
      1n,
      onBehalfOf as Address,
      0,
      9999999999n,
      27,
      ('0x' + '11'.repeat(32)) as Hex,
      ('0x' + '22'.repeat(32)) as Hex,
    ],
  });
}

function aaveWithdraw(to: string): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'withdraw',
        inputs: [
          { name: 'asset', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'to', type: 'address' },
        ],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'withdraw',
    args: [TOKEN as Address, 1n, to as Address],
  });
}

function uniV3ExactInputSingle(recipient: string): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'exactInputSingle',
        stateMutability: 'payable',
        inputs: [
          {
            name: 'params',
            type: 'tuple',
            components: [
              { name: 'tokenIn', type: 'address' },
              { name: 'tokenOut', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'recipient', type: 'address' },
              { name: 'amountIn', type: 'uint256' },
              { name: 'amountOutMinimum', type: 'uint256' },
              { name: 'sqrtPriceLimitX96', type: 'uint160' },
            ],
          },
        ],
        outputs: [{ name: 'amountOut', type: 'uint256' }],
      },
    ],
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: TOKEN as Address,
        tokenOut: WETH as Address,
        fee: 3000,
        recipient: recipient as Address,
        amountIn: 1n,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

function uniV3ExactInput(recipient: string): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'exactInput',
        stateMutability: 'payable',
        inputs: [
          {
            name: 'params',
            type: 'tuple',
            components: [
              { name: 'path', type: 'bytes' },
              { name: 'recipient', type: 'address' },
              { name: 'amountIn', type: 'uint256' },
              { name: 'amountOutMinimum', type: 'uint256' },
            ],
          },
        ],
        outputs: [{ name: 'amountOut', type: 'uint256' }],
      },
    ],
    functionName: 'exactInput',
    args: [
      {
        path: '0xabcd' as Hex,
        recipient: recipient as Address,
        amountIn: 1n,
        amountOutMinimum: 0n,
      },
    ],
  });
}

function uniV2SwapExactTokensForTokens(to: string): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'swapExactTokensForTokens',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'address[]' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
        outputs: [{ name: 'amounts', type: 'uint256[]' }],
      },
    ],
    functionName: 'swapExactTokensForTokens',
    args: [1n, 0n, [TOKEN as Address, WETH as Address], to as Address, 9999999999n],
  });
}

function uniV2SwapExactETHForTokens(to: string): string {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'swapExactETHForTokens',
        stateMutability: 'payable',
        inputs: [
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'address[]' },
          { name: 'to', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
        outputs: [{ name: 'amounts', type: 'uint256[]' }],
      },
    ],
    functionName: 'swapExactETHForTokens',
    args: [0n, [WETH as Address, TOKEN as Address], to as Address, 9999999999n],
  });
}

describe('classifyTransactionAssetFlow', () => {
  describe('owner / execution-mode address semantics', () => {
    it('treats session-key owner (walletAddress) as the retention boundary for audited protocols', () => {
      const result = classify(
        [{ to: AAVE_POOL_84532, data: aaveSupply(OWNER), value: '0' }],
        OWNER,
      );
      expect(result.classification).toBe('retained_protocol');
      expect(result.interactions[0].rule).toBe('aave_v3_supply_to_owner');
    });

    it('treats EOA owner (agentWalletAddress) as the retention boundary for audited protocols', () => {
      const agent = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
      const result = classify(
        [{ to: AAVE_POOL_84532, data: aaveSupply(agent), value: '0' }],
        agent,
      );
      expect(result.classification).toBe('retained_protocol');
      expect(result.interactions[0].recipient).toBe(agent.toLowerCase());
    });

    it('compares recipient addresses case-insensitively for external denial', () => {
      const mixedExternal = '0x2222222222222222222222222222222222222222';
      const upperRecipientCalldata =
        '0xa9059cbb' + padAddress(mixedExternal).toUpperCase() + padUint(1n);
      const result = classify([{ to: TOKEN, data: upperRecipientCalldata, value: '0' }], OWNER);
      expect(result.classification).toBe('external_transfer');
      expect(result.interactions[0].recipient).toBe(mixedExternal.toLowerCase());
    });

    it('returns unknown for an invalid owner address', () => {
      const result = classify(
        [{ to: TOKEN, data: erc20Transfer(EXTERNAL), value: '0' }],
        'not-an-address',
      );
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('invalid_owner_address');
    });
  });

  describe('standard ERC20 transfer', () => {
    it('classifies transfer to external as external_transfer', () => {
      const result = classify([{ to: TOKEN, data: erc20Transfer(EXTERNAL), value: '0' }]);
      expect(result.classification).toBe('external_transfer');
      expect(result.rule).toBe('erc20_transfer_external');
      expect(result.decisiveIndex).toBe(0);
      expect(result.interactions[0]).toMatchObject({
        classification: 'external_transfer',
        selector: '0xa9059cbb',
        recipient: EXTERNAL.toLowerCase(),
      });
    });

    it('does not retain transfer to owner on an arbitrary target (token unverifiable)', () => {
      const result = classify([{ to: TOKEN, data: erc20Transfer(OWNER_CHECKSUM), value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.interactions[0].rule).toBe('erc20_transfer_recipient_owner_unverifiable');
      expect(result.interactions[0].recipient).toBe(OWNER.toLowerCase());
    });

    it('does not use interaction.to (token contract) as the beneficiary', () => {
      const result = classify([{ to: OWNER, data: erc20Transfer(EXTERNAL), value: '0' }]);
      expect(result.classification).toBe('external_transfer');
      expect(result.interactions[0].recipient).toBe(EXTERNAL.toLowerCase());
    });
  });

  describe('transferFrom / safeTransferFrom family', () => {
    it('classifies ERC20/ERC721 transferFrom to external as external_transfer', () => {
      const result = classify([{ to: TOKEN, data: transferFrom(OWNER, EXTERNAL), value: '0' }]);
      expect(result.classification).toBe('external_transfer');
      expect(result.interactions[0].rule).toBe('erc20_erc721_transfer_from_external');
      expect(result.interactions[0].selector).toBe('0x23b872dd');
    });

    it('does not retain transferFrom to owner on an arbitrary target', () => {
      const result = classify([{ to: TOKEN, data: transferFrom(OTHER, OWNER), value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.interactions[0].rule).toBe(
        'erc20_erc721_transfer_from_recipient_owner_unverifiable',
      );
    });

    it('classifies ERC721 safeTransferFrom (3-arg) external vs owner-unverifiable', () => {
      const external = classify([
        { to: TOKEN, data: erc721SafeTransferFrom(OWNER, EXTERNAL), value: '0' },
      ]);
      expect(external.classification).toBe('external_transfer');
      expect(external.interactions[0].selector).toBe('0x42842e0e');

      const toOwner = classify([
        { to: TOKEN, data: erc721SafeTransferFrom(OWNER, OWNER), value: '0' },
      ]);
      expect(toOwner.classification).toBe('unknown');
      expect(toOwner.interactions[0].rule).toBe(
        'erc721_safe_transfer_from_recipient_owner_unverifiable',
      );
    });

    it('classifies ERC721 safeTransferFrom (4-arg with data) by recipient', () => {
      const result = classify([
        {
          to: TOKEN,
          data: erc721SafeTransferFromData(OWNER, EXTERNAL, 7n, '0xdead'),
          value: '0',
        },
      ]);
      expect(result.classification).toBe('external_transfer');
      expect(result.interactions[0].selector).toBe('0xb88d4fde');
      expect(result.interactions[0].rule).toBe('erc721_safe_transfer_from_data_external');
    });

    it('classifies ERC1155 safeTransferFrom by recipient', () => {
      const result = classify([
        { to: TOKEN, data: erc1155SafeTransferFrom(OWNER, EXTERNAL), value: '0' },
      ]);
      expect(result.classification).toBe('external_transfer');
      expect(result.interactions[0].selector).toBe('0xf242432a');
    });

    it('classifies ERC1155 safeBatchTransferFrom external vs owner-unverifiable', () => {
      const external = classify([
        { to: TOKEN, data: erc1155SafeBatchTransferFrom(OWNER, EXTERNAL), value: '0' },
      ]);
      expect(external.classification).toBe('external_transfer');
      expect(external.interactions[0].selector).toBe('0x2eb2c2d6');

      const toOwner = classify([
        { to: TOKEN, data: erc1155SafeBatchTransferFrom(OTHER, OWNER), value: '0' },
      ]);
      expect(toOwner.classification).toBe('unknown');
      expect(toOwner.interactions[0].rule).toBe(
        'erc1155_safe_batch_transfer_from_recipient_owner_unverifiable',
      );
    });
  });

  describe('native value', () => {
    it('classifies plain native transfer to external as external_transfer', () => {
      const result = classify([{ to: EXTERNAL, data: '0x', value: '1000' }]);
      expect(result.classification).toBe('external_transfer');
      expect(result.rule).toBe('native_value_external');
      expect(result.interactions[0].recipient).toBe(EXTERNAL.toLowerCase());
    });

    it('classifies plain native transfer to owner as retained_protocol', () => {
      const result = classify([{ to: OWNER, data: '0x', value: '1' }]);
      expect(result.classification).toBe('retained_protocol');
      expect(result.rule).toBe('native_value_to_owner');
    });

    it('defaults missing value to zero and treats empty call as unknown (unverifiable)', () => {
      const result = classify([{ to: EXTERNAL, data: '0x' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('empty_call_unverifiable');
    });

    it('classifies native value to non-owner with unknown calldata as external_transfer', () => {
      const result = classify([{ to: EXTERNAL, data: '0xdeadbeef' + '00'.repeat(32), value: '1' }]);
      expect(result.classification).toBe('external_transfer');
      expect(result.rule).toBe('native_value_with_calldata_external');
    });
  });

  describe('batch priority', () => {
    it('batch is external_transfer when any interaction is external', () => {
      const result = classify([
        { to: TOKEN, data: erc20Transfer(OWNER), value: '0' },
        { to: TOKEN, data: erc20Transfer(EXTERNAL), value: '0' },
        { to: TOKEN, data: erc20Approve(OTHER), value: '0' },
      ]);
      expect(result.classification).toBe('external_transfer');
      expect(result.decisiveIndex).toBe(1);
      expect(result.interactions.map((i) => i.classification)).toEqual([
        'unknown',
        'external_transfer',
        'unknown',
      ]);
    });

    it('batch is unknown when no external but any unknown', () => {
      const result = classify([
        { to: AAVE_POOL_84532, data: aaveSupply(OWNER), value: '0' },
        { to: TOKEN, data: erc20Approve(OTHER), value: '0' },
      ]);
      expect(result.classification).toBe('unknown');
      expect(result.decisiveIndex).toBe(1);
      expect(result.rule).toBe('erc20_approve');
    });

    it('batch is retained_protocol only when every interaction is retained', () => {
      const result = classify([
        { to: OWNER, data: '0x', value: '1' },
        { to: AAVE_POOL_84532, data: aaveSupply(OWNER), value: '0' },
      ]);
      expect(result.classification).toBe('retained_protocol');
      expect(result.interactions).toHaveLength(2);
      expect(result.interactions.map((i) => i.classification)).toEqual([
        'retained_protocol',
        'retained_protocol',
      ]);
    });

    it('does not drop later interactions — full batch is always classified', () => {
      const result = classify([
        { to: TOKEN, data: erc20Transfer(EXTERNAL), value: '0' },
        { to: TOKEN, data: '0xdeadbeef' + '00'.repeat(32), value: '0' },
      ]);
      expect(result.interactions).toHaveLength(2);
      expect(result.interactions[1].classification).toBe('unknown');
    });

    it('approve in a batch with retained protocol calls keeps batch unknown', () => {
      const result = classify([
        { to: AAVE_POOL_84532, data: aaveSupply(OWNER), value: '0' },
        { to: TOKEN, data: erc20Approve(AAVE_POOL_84532), value: '0' },
      ]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('erc20_approve');
    });
  });

  describe('adversarial / unverifiable targets', () => {
    it('empty zero-value call to an arbitrary address is unknown, not retained', () => {
      const result = classify([{ to: FAKE_ROUTER, data: '0x', value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('empty_call_unverifiable');
    });

    it('empty zero-value call even to owner is unknown (not proven no-op)', () => {
      const result = classify([{ to: OWNER, data: '0x', value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('empty_call_unverifiable');
    });

    it('spoofed transfer(owner) on a non-token contract is unknown, not retained', () => {
      const result = classify([{ to: FAKE_ROUTER, data: erc20Transfer(OWNER), value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('erc20_transfer_recipient_owner_unverifiable');
      expect(result.interactions[0].recipient).toBe(OWNER.toLowerCase());
    });

    it('spoofed transfer(external) on a non-token contract is still external_transfer', () => {
      const result = classify([{ to: FAKE_ROUTER, data: erc20Transfer(EXTERNAL), value: '0' }]);
      expect(result.classification).toBe('external_transfer');
      expect(result.rule).toBe('erc20_transfer_external');
    });

    it('still retains audited Aave supply with safe onBehalfOf', () => {
      const result = classify([{ to: AAVE_POOL_84532, data: aaveSupply(OWNER), value: '0' }]);
      expect(result.classification).toBe('retained_protocol');
      expect(result.rule).toBe('aave_v3_supply_to_owner');
    });

    it('still retains audited Uniswap V3 swap with recipient owner', () => {
      const result = classify([
        { to: UNI_V3_ROUTER_84532, data: uniV3ExactInputSingle(OWNER), value: '0' },
      ]);
      expect(result.classification).toBe('retained_protocol');
      expect(result.rule).toBe('uni_v3_exact_input_single_to_owner');
    });

    it('batch fold: empty call + external transfer → external_transfer', () => {
      const result = classify([
        { to: FAKE_ROUTER, data: '0x', value: '0' },
        { to: TOKEN, data: erc20Transfer(EXTERNAL), value: '0' },
      ]);
      expect(result.classification).toBe('external_transfer');
      expect(result.decisiveIndex).toBe(1);
    });

    it('batch fold: spoofed transfer-to-owner + approve → unknown (no retained)', () => {
      const result = classify([
        { to: FAKE_ROUTER, data: erc20Transfer(OWNER), value: '0' },
        { to: TOKEN, data: erc20Approve(OTHER), value: '0' },
      ]);
      expect(result.classification).toBe('unknown');
      expect(result.interactions.every((i) => i.classification === 'unknown')).toBe(true);
    });
  });

  describe('truncated / bad encoding fail closed as unknown', () => {
    it('marks truncated transfer calldata as unknown (not retained)', () => {
      const truncated = '0xa9059cbb' + padAddress(EXTERNAL).slice(0, 20);
      const result = classify([{ to: TOKEN, data: truncated, value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.interactions[0].rule).toBe('erc20_transfer_decode_failed');
    });

    it('marks selector-only short calldata as unknown', () => {
      const result = classify([{ to: TOKEN, data: '0xa9059c', value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('truncated_calldata');
    });

    it('marks broken dynamic ERC721 safeTransferFrom data as unknown', () => {
      const broken =
        '0xb88d4fde' +
        padAddress(OWNER) +
        padAddress(EXTERNAL) +
        padUint(1n) +
        padUint(0x80n) +
        padUint(0xffffffffn);
      const result = classify([{ to: TOKEN, data: broken, value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.interactions[0].rule).toBe('erc721_safe_transfer_from_data_decode_failed');
    });

    it('marks non hex-aligned garbage as unknown', () => {
      const result = classify([{ to: TOKEN, data: '0xzz', value: '0' } as never]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('invalid_calldata');
    });

    it('marks invalid decimal value as unknown', () => {
      const result = classify([{ to: EXTERNAL, data: '0x', value: '0x01' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('invalid_native_value');
    });
  });

  describe('approvals, permits, unknown and multi-call style targets', () => {
    it('never treats erc20 approve as retained_protocol', () => {
      const result = classify([{ to: TOKEN, data: erc20Approve(EXTERNAL, 100n), value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('erc20_approve');
    });

    it('never treats setApprovalForAll as retained_protocol', () => {
      const data = '0xa22cb465' + padAddress(EXTERNAL) + padUint(1n);
      const result = classify([{ to: TOKEN, data, value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('nft_set_approval_for_all');
    });

    it.each([
      ['0xd505accf', 'permit_erc2612'],
      ['0x8fcbaf0c', 'permit_dai'],
      ['0x2b67b570', 'permit2_single'],
      ['0xb7f13ed4', 'permit2_compact'],
      ['0x002a3e3a', 'permit2_batch'],
    ])('classifies permit selector %s as unknown (%s)', (selector, rule) => {
      const data = selector + '00'.repeat(32);
      const result = classify([{ to: TOKEN, data, value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe(rule);
    });

    it('classifies arbitrary unknown contract calls as unknown', () => {
      const multicallLike = '0xac9650d8' + padUint(0x20n);
      const result = classify([{ to: OTHER, data: multicallLike + '00'.repeat(64), value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('unrecognized_call');
    });

    it('does not treat arbitrary router multicall as retained', () => {
      const multicall = '0xac9650d8' + padUint(0x20n) + '00'.repeat(64);
      const result = classify([{ to: UNI_V3_ROUTER_84532, data: multicall, value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('unrecognized_call');
    });

    it('does not whitelist Universal Router execute', () => {
      const execute = '0x3593564c' + '00'.repeat(64);
      const result = classify([
        { to: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', data: execute, value: '0' },
      ]);
      expect(result.classification).toBe('unknown');
    });
  });

  describe('audited retained-protocol registry', () => {
    it('exposes explicit aave + uniswap + weth + erc4626 protocol rules (not empty)', () => {
      expect(RETAINED_PROTOCOL_RULES.map((r) => r.id)).toEqual([
        'aave_v3_pool',
        'uniswap_v3_swap_router02',
        'uniswap_v2_router02',
        'weth9',
        'erc4626_vault',
      ]);
    });

    describe('Aave V3', () => {
      it('retains supply when target is official pool and onBehalfOf is owner', () => {
        const result = classify([{ to: AAVE_POOL_84532, data: aaveSupply(OWNER), value: '0' }]);
        expect(result.classification).toBe('retained_protocol');
        expect(result.rule).toBe('aave_v3_supply_to_owner');
        expect(result.interactions[0].selector).toBe('0x617ba037');
      });

      it('marks supply with external onBehalfOf as external_transfer', () => {
        const result = classify([{ to: AAVE_POOL_84532, data: aaveSupply(EXTERNAL), value: '0' }]);
        expect(result.classification).toBe('external_transfer');
        expect(result.rule).toBe('aave_v3_supply_external_on_behalf_of');
        expect(result.interactions[0].recipient).toBe(EXTERNAL.toLowerCase());
      });

      it('does not retain supply on wrong pool target', () => {
        const result = classify([{ to: FAKE_ROUTER, data: aaveSupply(OWNER), value: '0' }]);
        expect(result.classification).toBe('unknown');
        expect(result.rule).toBe('unrecognized_call');
      });

      it('does not retain supply on wrong chain (pool address for another chain)', () => {
        // Ethereum pool address on Base Sepolia chain id
        const result = classify(
          [{ to: AAVE_POOL_1, data: aaveSupply(OWNER), value: '0' }],
          OWNER,
          84532,
        );
        expect(result.classification).toBe('unknown');
      });

      it('does not retain supply with nonzero native value', () => {
        const result = classify([{ to: AAVE_POOL_84532, data: aaveSupply(OWNER), value: '1' }]);
        expect(result.classification).toBe('unknown');
        expect(result.rule).toBe('aave_v3_supply_nonzero_value');
      });

      it('retains supplyWithPermit when onBehalfOf is owner', () => {
        const result = classify([
          { to: AAVE_POOL_84532, data: aaveSupplyWithPermit(OWNER), value: '0' },
        ]);
        expect(result.classification).toBe('retained_protocol');
        expect(result.rule).toBe('aave_v3_supply_with_permit_to_owner');
        expect(result.interactions[0].selector).toBe('0x02c205f0');
      });

      it('marks supplyWithPermit external onBehalfOf as external_transfer', () => {
        const result = classify([
          { to: AAVE_POOL_84532, data: aaveSupplyWithPermit(EXTERNAL), value: '0' },
        ]);
        expect(result.classification).toBe('external_transfer');
        expect(result.rule).toBe('aave_v3_supply_with_permit_external_on_behalf_of');
      });

      it('retains withdraw when recipient is owner', () => {
        const result = classify([{ to: AAVE_POOL_84532, data: aaveWithdraw(OWNER), value: '0' }]);
        expect(result.classification).toBe('retained_protocol');
        expect(result.rule).toBe('aave_v3_withdraw_to_owner');
        expect(result.interactions[0].selector).toBe('0x69328dec');
      });

      it('marks withdraw to external as external_transfer', () => {
        const result = classify([
          { to: AAVE_POOL_84532, data: aaveWithdraw(EXTERNAL), value: '0' },
        ]);
        expect(result.classification).toBe('external_transfer');
        expect(result.rule).toBe('aave_v3_withdraw_external');
      });

      it('marks truncated supply calldata as unknown', () => {
        const truncated = '0x617ba037' + padAddress(TOKEN).slice(0, 16);
        const result = classify([{ to: AAVE_POOL_84532, data: truncated, value: '0' }]);
        expect(result.classification).toBe('unknown');
        expect(result.rule).toBe('aave_v3_supply_decode_failed');
      });

      it('does not retain borrow-like selectors on the official pool', () => {
        // borrow(address,uint256,uint256,uint16,address) selector 0xa415bcad
        const borrow = '0xa415bcad' + '00'.repeat(5 * 32);
        const result = classify([{ to: AAVE_POOL_84532, data: borrow, value: '0' }]);
        expect(result.classification).toBe('unknown');
        expect(result.rule).toBe('unrecognized_call');
      });
    });

    describe('Uniswap V3 SwapRouter02', () => {
      it('retains exactInputSingle when recipient is owner', () => {
        const result = classify([
          { to: UNI_V3_ROUTER_84532, data: uniV3ExactInputSingle(OWNER), value: '0' },
        ]);
        expect(result.classification).toBe('retained_protocol');
        expect(result.rule).toBe('uni_v3_exact_input_single_to_owner');
        expect(result.interactions[0].selector).toBe('0x04e45aaf');
      });

      it('marks exactInputSingle external recipient as external_transfer', () => {
        const result = classify([
          {
            to: UNI_V3_ROUTER_84532,
            data: uniV3ExactInputSingle(EXTERNAL),
            value: '0',
          },
        ]);
        expect(result.classification).toBe('external_transfer');
        expect(result.rule).toBe('uni_v3_exact_input_single_external');
      });

      it('retains exactInput when recipient is owner', () => {
        const result = classify([
          { to: UNI_V3_ROUTER_84532, data: uniV3ExactInput(OWNER), value: '0' },
        ]);
        expect(result.classification).toBe('retained_protocol');
        expect(result.rule).toBe('uni_v3_exact_input_to_owner');
      });

      it('rejects V3 swap with nonzero value as unknown (not ETH-in whitelist)', () => {
        const result = classify([
          { to: UNI_V3_ROUTER_84532, data: uniV3ExactInputSingle(OWNER), value: '1' },
        ]);
        expect(result.classification).toBe('unknown');
        expect(result.rule).toBe('uni_v3_exact_input_single_nonzero_value');
      });

      it('does not retain V3 swaps on wrong router', () => {
        const result = classify([
          { to: FAKE_ROUTER, data: uniV3ExactInputSingle(OWNER), value: '0' },
        ]);
        expect(result.classification).toBe('unknown');
      });

      it('does not retain V3 swaps when chain does not match router registry', () => {
        const result = classify(
          [{ to: UNI_V3_ROUTER_1, data: uniV3ExactInputSingle(OWNER), value: '0' }],
          OWNER,
          84532,
        );
        expect(result.classification).toBe('unknown');
      });

      it('marks malformed exactInputSingle as unknown', () => {
        const truncated = '0x04e45aaf' + '00'.repeat(8);
        const result = classify([{ to: UNI_V3_ROUTER_84532, data: truncated, value: '0' }]);
        expect(result.classification).toBe('unknown');
        expect(result.rule).toBe('uni_v3_exact_input_single_decode_failed');
      });
    });

    describe('Uniswap V2 Router02', () => {
      it('retains token-in swapExactTokensForTokens when to is owner and value is 0', () => {
        const result = classify(
          [
            {
              to: UNI_V2_ROUTER_1,
              data: uniV2SwapExactTokensForTokens(OWNER),
              value: '0',
            },
          ],
          OWNER,
          1,
        );
        expect(result.classification).toBe('retained_protocol');
        expect(result.rule).toBe('uni_v2_swap_exact_tokens_for_tokens_to_owner');
        expect(result.interactions[0].selector).toBe('0x38ed1739');
      });

      it('marks token-in swap with external recipient as external_transfer', () => {
        const result = classify(
          [
            {
              to: UNI_V2_ROUTER_1,
              data: uniV2SwapExactTokensForTokens(EXTERNAL),
              value: '0',
            },
          ],
          OWNER,
          1,
        );
        expect(result.classification).toBe('external_transfer');
        expect(result.rule).toBe('uni_v2_swap_exact_tokens_for_tokens_external');
      });

      it('does not retain token-in swap with nonzero native value', () => {
        const result = classify(
          [
            {
              to: UNI_V2_ROUTER_1,
              data: uniV2SwapExactTokensForTokens(OWNER),
              value: '100',
            },
          ],
          OWNER,
          1,
        );
        expect(result.classification).toBe('unknown');
        expect(result.rule).toBe('uni_v2_swap_exact_tokens_for_tokens_nonzero_value');
      });

      it('retains ETH-in swapExactETHForTokens when recipient is owner even with value>0', () => {
        const result = classify(
          [
            {
              to: UNI_V2_ROUTER_1,
              data: uniV2SwapExactETHForTokens(OWNER),
              value: '1000000000000000000',
            },
          ],
          OWNER,
          1,
        );
        expect(result.classification).toBe('retained_protocol');
        expect(result.rule).toBe('uni_v2_swap_exact_eth_for_tokens_to_owner');
        expect(result.interactions[0].selector).toBe('0x7ff36ab5');
      });

      it('marks ETH-in swap with external recipient as external_transfer (not generic native)', () => {
        const result = classify(
          [
            {
              to: UNI_V2_ROUTER_1,
              data: uniV2SwapExactETHForTokens(EXTERNAL),
              value: '1000',
            },
          ],
          OWNER,
          1,
        );
        expect(result.classification).toBe('external_transfer');
        expect(result.rule).toBe('uni_v2_swap_exact_eth_for_tokens_external');
        expect(result.interactions[0].recipient).toBe(EXTERNAL.toLowerCase());
      });

      it('uses chain-scoped V2 router on Base Sepolia', () => {
        const result = classify(
          [
            {
              to: UNI_V2_ROUTER_84532,
              data: uniV2SwapExactTokensForTokens(OWNER),
              value: '0',
            },
          ],
          OWNER,
          84532,
        );
        expect(result.classification).toBe('retained_protocol');
      });

      it('does not retain V2 swap on wrong router address', () => {
        const result = classify(
          [
            {
              to: FAKE_ROUTER,
              data: uniV2SwapExactETHForTokens(OWNER),
              value: '1',
            },
          ],
          OWNER,
          1,
        );
        // Wrong router + value>0 → generic native external (not proven V2).
        expect(result.classification).toBe('external_transfer');
        expect(result.rule).toBe('native_value_with_calldata_external');
      });
    });

    describe('batch precedence with protocol rules', () => {
      it('external protocol recipient wins over retained protocol calls', () => {
        const result = classify([
          { to: AAVE_POOL_84532, data: aaveSupply(OWNER), value: '0' },
          {
            to: UNI_V3_ROUTER_84532,
            data: uniV3ExactInputSingle(EXTERNAL),
            value: '0',
          },
        ]);
        expect(result.classification).toBe('external_transfer');
        expect(result.decisiveIndex).toBe(1);
      });

      it('unknown multicall wins over retained when no external', () => {
        const multicall = '0xac9650d8' + padUint(0x20n) + '00'.repeat(64);
        const result = classify([
          { to: AAVE_POOL_84532, data: aaveSupply(OWNER), value: '0' },
          { to: UNI_V3_ROUTER_84532, data: multicall, value: '0' },
        ]);
        expect(result.classification).toBe('unknown');
        expect(result.decisiveIndex).toBe(1);
      });
    });
  });

  // ── Phase 4 static extensions: WETH / revoke / ERC-4626 / Aave collateral ─

  describe('WETH wrap/unwrap', () => {
    const WETH_84532 = '0x4200000000000000000000000000000000000006';
    const WETH_1 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

    function wethDeposit(): string {
      return encodeFunctionData({
        abi: [{ type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' }],
        functionName: 'deposit',
      });
    }

    function wethWithdraw(amount: bigint): string {
      return encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'withdraw',
            inputs: [{ name: 'wad', type: 'uint256' }],
            outputs: [],
            stateMutability: 'nonpayable',
          },
        ],
        functionName: 'withdraw',
        args: [amount],
      });
    }

    it('retains deposit() wrap to official WETH with native value', () => {
      const result = classify([{ to: WETH_84532, data: wethDeposit(), value: '1000' }]);
      expect(result.classification).toBe('retained_protocol');
      expect(result.rule).toBe('weth_deposit_wrap');
    });

    it('retains wrap case-insensitively on checksum WETH address (mainnet)', () => {
      const result = classify([{ to: WETH_1, data: wethDeposit(), value: '1' }], OWNER, 1);
      expect(result.classification).toBe('retained_protocol');
      expect(result.rule).toBe('weth_deposit_wrap');
    });

    it('rejects pseudo-wrap when target is not official WETH', () => {
      const result = classify([{ to: OTHER, data: wethDeposit(), value: '1000' }]);
      // value>0 to non-owner arbitrary target → external
      expect(result.classification).toBe('external_transfer');
    });

    it('marks wrap with extra calldata as unknown', () => {
      const result = classify([
        { to: WETH_84532, data: wethDeposit() + '00'.repeat(32), value: '1000' },
      ]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('weth_deposit_extra_calldata');
    });

    it('marks deposit() with zero value as unknown', () => {
      const result = classify([{ to: WETH_84532, data: wethDeposit(), value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('weth_deposit_zero_value');
    });

    it('retains withdraw(amount>0) unwrap on official WETH', () => {
      const result = classify([{ to: WETH_84532, data: wethWithdraw(5n), value: '0' }]);
      expect(result.classification).toBe('retained_protocol');
      expect(result.rule).toBe('weth_withdraw_unwrap');
    });

    it('marks unwrap with zero amount as unknown', () => {
      const result = classify([{ to: WETH_84532, data: wethWithdraw(0n), value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('weth_withdraw_invalid_amount');
    });

    it('batch: wrap + external_transfer folds to external_transfer', () => {
      const result = classify([
        { to: WETH_84532, data: wethDeposit(), value: '1000' },
        { to: TOKEN, data: erc20Transfer(EXTERNAL), value: '0' },
      ]);
      expect(result.classification).toBe('external_transfer');
      expect(result.decisiveIndex).toBe(1);
    });
  });

  describe('approve-to-zero / setApprovalForAll revoke', () => {
    it('retains approve(spender,0) when spender is trusted protocol router', () => {
      const result = classify([
        { to: TOKEN, data: erc20Approve(UNI_V3_ROUTER_84532, 0n), value: '0' },
      ]);
      expect(result.classification).toBe('retained_protocol');
      expect(result.rule).toBe('erc20_approve_zero_trusted_spender');
    });

    it('keeps non-zero approve as unknown (including trusted spender)', () => {
      const result = classify([
        { to: TOKEN, data: erc20Approve(UNI_V3_ROUTER_84532, 100n), value: '0' },
      ]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('erc20_approve');
    });

    it('marks approve(0) to untrusted spender as unknown', () => {
      const result = classify([{ to: TOKEN, data: erc20Approve(EXTERNAL, 0n), value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('erc20_approve_zero_untrusted_spender');
    });

    it('retains setApprovalForAll(operator,false) for trusted operator', () => {
      const data =
        '0xa22cb465' + padAddress(AAVE_POOL_84532) + padUint(0n);
      const result = classify([{ to: TOKEN, data, value: '0' }]);
      expect(result.classification).toBe('retained_protocol');
      expect(result.rule).toBe('nft_set_approval_for_all_false_trusted_operator');
    });

    it('keeps setApprovalForAll(operator,true) as unknown even for trusted operator', () => {
      const data =
        '0xa22cb465' + padAddress(AAVE_POOL_84532) + padUint(1n);
      const result = classify([{ to: TOKEN, data, value: '0' }]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('nft_set_approval_for_all');
    });
  });

  describe('ERC-4626 vault deposit/redeem', () => {
    const VAULT_84532 = '0x4626462646264626462646264626462646264626';
    const UNKNOWN_VAULT = '0x9999999999999999999999999999999999999999';

    function erc4626Deposit(receiver: string, assets: bigint = 10n): string {
      return encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'deposit',
            inputs: [
              { name: 'assets', type: 'uint256' },
              { name: 'receiver', type: 'address' },
            ],
            outputs: [{ name: 'shares', type: 'uint256' }],
            stateMutability: 'nonpayable',
          },
        ],
        functionName: 'deposit',
        args: [assets, receiver as Address],
      });
    }

    function erc4626Redeem(receiver: string, owner: string, shares: bigint = 10n): string {
      return encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'redeem',
            inputs: [
              { name: 'shares', type: 'uint256' },
              { name: 'receiver', type: 'address' },
              { name: 'owner', type: 'address' },
            ],
            outputs: [{ name: 'assets', type: 'uint256' }],
            stateMutability: 'nonpayable',
          },
        ],
        functionName: 'redeem',
        args: [shares, receiver as Address, owner as Address],
      });
    }

    it('retains deposit to owner on registered vault', () => {
      const result = classify([
        { to: VAULT_84532, data: erc4626Deposit(OWNER), value: '0' },
      ]);
      expect(result.classification).toBe('retained_protocol');
      expect(result.rule).toBe('erc4626_deposit_to_owner');
    });

    it('marks deposit with external receiver as external_transfer', () => {
      const result = classify([
        { to: VAULT_84532, data: erc4626Deposit(EXTERNAL), value: '0' },
      ]);
      expect(result.classification).toBe('external_transfer');
      expect(result.rule).toBe('erc4626_deposit_external_receiver');
    });

    it('marks deposit carrying native value as unknown', () => {
      const result = classify([
        { to: VAULT_84532, data: erc4626Deposit(OWNER), value: '1' },
      ]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('erc4626_nonzero_value');
    });

    it('marks deposit on unknown vault as unknown', () => {
      const result = classify([
        { to: UNKNOWN_VAULT, data: erc4626Deposit(OWNER), value: '0' },
      ]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('unrecognized_call');
    });

    it('retains redeem when receiver and owner are execution owner', () => {
      const result = classify([
        { to: VAULT_84532, data: erc4626Redeem(OWNER, OWNER), value: '0' },
      ]);
      expect(result.classification).toBe('retained_protocol');
      expect(result.rule).toBe('erc4626_redeem_to_owner');
    });

    it('marks redeem with external receiver as external_transfer', () => {
      const result = classify([
        { to: VAULT_84532, data: erc4626Redeem(EXTERNAL, OWNER), value: '0' },
      ]);
      expect(result.classification).toBe('external_transfer');
      expect(result.rule).toBe('erc4626_redeem_external_receiver');
    });
  });

  describe('Aave V3 setUserUseReserveAsCollateral', () => {
    function aaveSetCollateral(useAsCollateral: boolean): string {
      return encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'setUserUseReserveAsCollateral',
            inputs: [
              { name: 'asset', type: 'address' },
              { name: 'useAsCollateral', type: 'bool' },
            ],
            outputs: [],
            stateMutability: 'nonpayable',
          },
        ],
        functionName: 'setUserUseReserveAsCollateral',
        args: [TOKEN as Address, useAsCollateral],
      });
    }

    it('retains disable-collateral (useAsCollateral=false) on official pool', () => {
      const result = classify([
        { to: AAVE_POOL_84532, data: aaveSetCollateral(false), value: '0' },
      ]);
      expect(result.classification).toBe('retained_protocol');
      expect(result.rule).toBe('aave_v3_set_collateral_disable');
    });

    it('marks enable-collateral (useAsCollateral=true) as unknown', () => {
      const result = classify([
        { to: AAVE_POOL_84532, data: aaveSetCollateral(true), value: '0' },
      ]);
      expect(result.classification).toBe('unknown');
      expect(result.rule).toBe('aave_v3_set_collateral_enable');
    });
  });
});
