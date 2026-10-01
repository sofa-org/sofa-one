import { TransactionReceiptNotFoundError } from 'viem';
import { ViemUsdcReceiptProvider } from './usdc-receipt.provider';

const mockGetTransactionReceipt = jest.fn();
const mockGetBlock = jest.fn();
const mockGetBlockNumber = jest.fn();
const mockCreatePublicClient = jest.fn(() => ({
  getTransactionReceipt: mockGetTransactionReceipt,
  getBlock: mockGetBlock,
  getBlockNumber: mockGetBlockNumber,
}));

jest.mock('viem', () => ({
  ...jest.requireActual('viem'),
  createPublicClient: () => mockCreatePublicClient(),
  http: jest.fn(() => 'http-transport'),
}));

const TX_HASH = '0x' + 'a'.repeat(64);
const RPC_URL = 'https://base.example.com/rpc';

describe('ViemUsdcReceiptProvider', () => {
  let provider: ViemUsdcReceiptProvider;
  const configGet = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    configGet.mockImplementation((key: string) => {
      const values: Record<string, unknown> = {
        'billing.usdc.rpcUrls.8453': RPC_URL,
      };
      return values[key];
    });
    provider = new ViemUsdcReceiptProvider({ get: configGet } as any);
  });

  it('returns null only for a genuine TransactionReceiptNotFoundError', async () => {
    mockGetTransactionReceipt.mockRejectedValue(
      new TransactionReceiptNotFoundError({ hash: TX_HASH as `0x${string}` }),
    );

    await expect(provider.getTransactionReceipt(8453, TX_HASH)).resolves.toBeNull();
  });

  it('rethrows a rate-limit error whose message contains "not found"', async () => {
    // The old message-based classification would have swallowed this as a
    // missing receipt; the type-based classification must rethrow it.
    mockGetTransactionReceipt.mockRejectedValue(new Error('rate limited: resource not found'));

    await expect(provider.getTransactionReceipt(8453, TX_HASH)).rejects.toThrow(
      'rate limited: resource not found',
    );
  });

  it('rethrows other RPC errors as retryable', async () => {
    mockGetTransactionReceipt.mockRejectedValue(new Error('connection refused'));

    await expect(provider.getTransactionReceipt(8453, TX_HASH)).rejects.toThrow(
      'connection refused',
    );
  });

  it('returns null when the client resolves a falsy receipt', async () => {
    mockGetTransactionReceipt.mockResolvedValue(null);

    await expect(provider.getTransactionReceipt(8453, TX_HASH)).resolves.toBeNull();
  });

  it('returns a sanitized receipt for a successful transaction', async () => {
    mockGetTransactionReceipt.mockResolvedValue({
      status: 'success',
      transactionHash: TX_HASH,
      from: '0x' + '3'.repeat(40),
      to: '0x' + '1'.repeat(40),
      blockNumber: 100n,
      blockHash: '0x' + 'b'.repeat(64),
      logs: [
        {
          address: '0x' + 'c'.repeat(40),
          topics: ['0x' + 'd'.repeat(64)],
          data: '0x' + 'e'.repeat(64),
          logIndex: 0,
          removed: false,
        },
      ],
    });
    mockGetBlock.mockResolvedValue({ timestamp: 1_785_000_000n });

    const receipt = await provider.getTransactionReceipt(8453, TX_HASH);

    expect(receipt).toEqual({
      status: 'success',
      transactionHash: TX_HASH,
      from: '0x' + '3'.repeat(40),
      to: '0x' + '1'.repeat(40),
      blockNumber: 100n,
      blockHash: '0x' + 'b'.repeat(64),
      blockTimestamp: 1_785_000_000n,
      logs: [
        {
          address: '0x' + 'c'.repeat(40),
          topics: ['0x' + 'd'.repeat(64)],
          data: '0x' + 'e'.repeat(64),
          logIndex: 0,
          removed: false,
        },
      ],
    });
  });

  it('throws when the RPC URL is not configured for the chain', async () => {
    configGet.mockReturnValue(undefined);

    await expect(provider.getTransactionReceipt(8453, TX_HASH)).rejects.toThrow(
      'USDC RPC URL is not configured',
    );
  });

  it('returns the current block number', async () => {
    mockGetBlockNumber.mockResolvedValue(104n);

    await expect(provider.getBlockNumber(8453)).resolves.toBe(104n);
  });
});
