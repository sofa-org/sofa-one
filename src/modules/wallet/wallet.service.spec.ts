import {
  BadRequestException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { hashMessage } from 'viem';

// ── viem mock ──────────────────────────────────────────────────────────────────
// Must be declared before any imports that pull in viem transitively.
const mockReadContract = jest.fn();
const mockGetBalance = jest.fn();

jest.mock('viem', () => {
  const actual = jest.requireActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: jest.fn(() => ({
      readContract: mockReadContract,
      getBalance: mockGetBalance,
    })),
  };
});

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

// ── service imports (after mock) ───────────────────────────────────────────────
import { WalletService } from './wallet.service';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import type { WithdrawDto } from './dto/withdraw.dto';

// ── helpers ────────────────────────────────────────────────────────────────────

const WALLET = {
  userId: 'user-1',
  walletAddress: '0xABCDEF1234567890ABCDEf1234567890abcdef12',
  openfortAccountId: 'acc-1',
  agentOpenfortAccountId: 'agent-acc-1',
  agentWalletAddress: '0x2222222222222222222222222222222222222222',
  agentKeyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
  chainId: BigInt(84532),
  status: 'active',
};

const VALID_DTO: WithdrawDto = {
  chainId: 84532,
  to: '0x1111111111111111111111111111111111111111',
  amount: '1000000', // 1 USDC
  token: 'USDC',
  idempotencyKey: 'idem-key-123',
};

// Sufficient balance (2 USDC in micro-units)
const SUFFICIENT_BALANCE = BigInt('2000000');
const API_KEY_PREFIX = 'sk_1234567890abcdef12345678';
const API_KEY_CONTEXT = {
  id: 'api-key-1',
  keyPrefix: API_KEY_PREFIX,
  name: 'Production key',
  allowedChains: [84532],
};

// ── test suite ─────────────────────────────────────────────────────────────────

describe('WalletService.withdraw()', () => {
  let service: WalletService;

  // Prisma mock handles
  const mockFindUnique = jest.fn();
  const mockFindFirst = jest.fn();
  const mockCreate = jest.fn();
  const mockUpdate = jest.fn();

  // Openfort mock handle
  const mockSendUserOperation = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default: wallet exists, sufficient balance, no duplicate tx
    mockFindUnique.mockResolvedValue({ ...WALLET });
    mockFindFirst.mockResolvedValue(null);
    mockReadContract.mockResolvedValue(SUFFICIENT_BALANCE);
    mockSendUserOperation.mockResolvedValue({ userOpHash: '0xuserop', transactionHash: '0xhash' });
    mockCreate.mockResolvedValue({ id: 'tx-1', txHash: null, status: 'submitting' });
    mockUpdate.mockResolvedValue({ id: 'tx-1', txHash: '0xhash', status: 'pending' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            userWallet: { findUnique: mockFindUnique },
            transaction: { findFirst: mockFindFirst, create: mockCreate, update: mockUpdate },
          },
        },
        {
          provide: OpenfortService,
          useValue: { sendUserOperation: mockSendUserOperation, signData: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  // ── 1. Wallet not found ──────────────────────────────────────────────────────

  it('throws NotFoundException when wallet not found', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(NotFoundException);
  });

  // ── 2. Wallet not active ─────────────────────────────────────────────────────

  it('throws BadRequestException when wallet status is suspended', async () => {
    mockFindUnique.mockResolvedValue({ ...WALLET, status: 'suspended' });

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(/not active/i);
  });

  // ── 3. Self-withdrawal ───────────────────────────────────────────────────────

  it('throws BadRequestException when `to` equals wallet address (case-insensitive)', async () => {
    const selfDto: WithdrawDto = {
      ...VALID_DTO,
      // uppercase version of the wallet address
      to: WALLET.walletAddress.toUpperCase() as `0x${string}`,
    };

    await expect(service.withdraw('user-1', selfDto)).rejects.toThrow(BadRequestException);

    await expect(service.withdraw('user-1', selfDto)).rejects.toThrow(
      'Cannot withdraw to your own wallet address',
    );
  });

  // ── 4. Idempotency duplicate ─────────────────────────────────────────────────

  it('returns the existing withdrawal when idempotencyKey was already submitted', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'tx-existing',
      txHash: '0xhash-existing',
      status: 'pending',
    });

    const result = await service.withdraw('user-1', VALID_DTO);

    expect(result).toEqual({
      transactionId: 'tx-existing',
      transactionHash: '0xhash-existing',
      status: 'pending',
    });
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('returns the in-progress withdrawal when idempotencyKey is already submitting', async () => {
    mockFindFirst.mockResolvedValue({ id: 'tx-existing', txHash: null, status: 'submitting' });

    const result = await service.withdraw('user-1', VALID_DTO);

    expect(result).toEqual({ transactionId: 'tx-existing', transactionHash: null, status: 'submitting' });
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('returns the existing withdrawal after a concurrent idempotency insert race', async () => {
    mockFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'tx-existing', txHash: null, status: 'submitting' });
    mockCreate.mockRejectedValue({ code: 'P2002' });

    const result = await service.withdraw('user-1', VALID_DTO);

    expect(result).toEqual({ transactionId: 'tx-existing', transactionHash: null, status: 'submitting' });
    expect(mockReadContract).toHaveBeenCalledTimes(1);
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  it('rejects withdrawal idempotency reuse with a different request before balance checks', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'tx-existing',
      txHash: '0xhash-existing',
      status: 'pending',
      requestHash: 'different-request',
    });

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);

    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSendUserOperation).not.toHaveBeenCalled();
  });

  // ── 5. Insufficient USDC balance ─────────────────────────────────────────────

  it('throws BadRequestException when USDC balance is insufficient', async () => {
    // Balance: 0.5 USDC (500_000 units) < requested 1 USDC (1_000_000 units)
    mockReadContract.mockResolvedValue(BigInt('500000'));

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(
      /Insufficient USDC balance/i,
    );
  });

  // ── 6. Balance fetch fails ───────────────────────────────────────────────────

  it('throws BadRequestException when readContract throws during balance check', async () => {
    mockReadContract.mockRejectedValue(new Error('RPC error'));

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(BadRequestException);

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow(
      /Unable to verify USDC balance/i,
    );
  });

  // ── 7. Happy path ─────────────────────────────────────────────────────────────

  it('calls openfort and prisma, returns correct shape on success', async () => {
    const result = await service.withdraw('user-1', VALID_DTO);

    // Openfort intent was created
    expect(mockSendUserOperation).toHaveBeenCalledTimes(1);
    expect(mockSendUserOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: VALID_DTO.chainId,
        accountAddress: WALLET.walletAddress,
        agentAccountId: WALLET.agentOpenfortAccountId,
        keyHash: WALLET.agentKeyHash,
        interactions: [
          expect.objectContaining({
            to: expect.any(String),
            data: expect.stringMatching(/^0x/),
            value: '0',
          }),
        ],
      }),
    );

    // Prisma transaction was persisted
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Return shape
    expect(result).toEqual({
      transactionId: 'tx-1',
      transactionHash: '0xhash',
      status: 'pending',
    });
  });

  // ── 8. Happy path with idempotencyKey ────────────────────────────────────────

  it('stores idempotencyKey in dedicated columns and details', async () => {
    const dto: WithdrawDto = { ...VALID_DTO, idempotencyKey: 'unique-key-abc' };
    await service.withdraw('user-1', dto);

    const createCall = mockCreate.mock.calls[0][0] as {
      data: { idempotencyKey: string; operationType: string; details: Record<string, unknown> };
    };
    expect(createCall.data.operationType).toBe('withdraw');
    expect(createCall.data.idempotencyKey).toBe('unique-key-abc');
    expect(createCall.data.details).toMatchObject({ idempotencyKey: 'unique-key-abc' });
  });

  it('marks the pre-created withdrawal failed when Openfort submission fails', async () => {
    mockSendUserOperation.mockRejectedValue(new Error('Openfort down'));

    await expect(service.withdraw('user-1', VALID_DTO)).rejects.toThrow('Openfort down');
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: { status: 'unknown' },
    });
  });
});

describe('WalletService.sign()', () => {
  let service: WalletService;

  const mockFindUnique = jest.fn();
  const mockSignData = jest.fn();
  const mockSigningRequestCreate = jest.fn();
  const mockSigningRequestUpdate = jest.fn();
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockFindUnique.mockResolvedValue({ ...WALLET });
    mockSignData.mockResolvedValue('0xsigned');
    mockSigningRequestCreate.mockResolvedValue({ id: 'signing-request-1' });
    mockSigningRequestUpdate.mockResolvedValue({ id: 'signing-request-1', status: 'signed' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            userWallet: { findUnique: mockFindUnique },
            signingRequest: { create: mockSigningRequestCreate, update: mockSigningRequestUpdate },
          },
        },
        {
          provide: OpenfortService,
          useValue: { signData: mockSignData },
        },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  it('uses EIP-191 hash for message signing', async () => {
    const result = await service.sign(
      'user-1',
      { type: 'message', message: 'Hello, SOFA ONE!', chainId: 84532 } as any,
      API_KEY_CONTEXT,
    );

    expect(mockSignData).toHaveBeenCalledWith(
      WALLET.agentOpenfortAccountId,
      hashMessage('Hello, SOFA ONE!'),
    );
    expect(result).toEqual({
      signature: '0xsigned',
      walletAddress: WALLET.walletAddress,
      signerAddress: WALLET.agentWalletAddress,
      type: 'message',
    });
  });

  it('audits a successful signing request without storing the plaintext message', async () => {
    await service.sign(
      'user-1',
      { type: 'message', message: 'Hello, SOFA ONE!', chainId: 84532 } as any,
      API_KEY_CONTEXT,
    );

    expect(mockSigningRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        apiKeyId: 'api-key-1',
        authMethod: 'api_key',
        apiKeyPrefix: API_KEY_PREFIX,
        apiKeyName: 'Production key',
        type: 'message',
        chainId: BigInt(84532),
        walletAddress: WALLET.walletAddress,
        digest: hashMessage('Hello, SOFA ONE!'),
        status: 'submitting',
      }),
    });
    expect(mockSigningRequestCreate.mock.calls[0][0].data.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.stringify(mockSigningRequestCreate.mock.calls[0][0], (_, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('Hello, SOFA ONE!');
    expect(mockSigningRequestUpdate).toHaveBeenCalledWith({
      where: { id: 'signing-request-1' },
      data: { status: 'signed', completedAt: expect.any(Date) },
    });
  });

  it('rejects Clerk-authenticated signing before loading the wallet or creating an audit record', async () => {
    await expect(
      service.sign('user-1', { type: 'message', message: 'Hello, SOFA ONE!' } as any),
    ).rejects.toThrow(UnauthorizedException);

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('marks the signing request failed when Openfort signing fails', async () => {
    mockSignData.mockRejectedValue(new Error('Openfort down'));

    await expect(
      service.sign(
        'user-1',
        { type: 'message', message: 'Hello', chainId: 84532 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow('Openfort down');

    expect(mockSigningRequestUpdate).toHaveBeenCalledWith({
      where: { id: 'signing-request-1' },
      data: { status: 'failed', completedAt: expect.any(Date) },
    });
  });

  it('returns the signature when the post-sign audit update fails', async () => {
    mockSigningRequestUpdate.mockRejectedValue(new Error('DB update failed'));

    const result = await service.sign(
      'user-1',
      { type: 'message', message: 'Hello', chainId: 84532 } as any,
      API_KEY_CONTEXT,
    );

    expect(result).toEqual({
      signature: '0xsigned',
      walletAddress: WALLET.walletAddress,
      signerAddress: WALLET.agentWalletAddress,
      type: 'message',
    });
    expect(mockSigningRequestUpdate).toHaveBeenCalledWith({
      where: { id: 'signing-request-1' },
      data: { status: 'signed', completedAt: expect.any(Date) },
    });
  });

  it('preserves the Openfort error when the failed audit update also fails', async () => {
    mockSignData.mockRejectedValue(new Error('Openfort down'));
    mockSigningRequestUpdate.mockRejectedValue(new Error('DB update failed'));

    await expect(
      service.sign(
        'user-1',
        { type: 'message', message: 'Hello', chainId: 84532 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow('Openfort down');
  });

  it('uses EIP-191 hash for raw hex message data', async () => {
    const raw = '0x68656c6c6f20776f726c64';
    const result = await service.sign(
      'user-1',
      { type: 'message', message: { raw }, chainId: 84532 } as any,
      API_KEY_CONTEXT,
    );

    expect(mockSignData).toHaveBeenCalledWith(WALLET.agentOpenfortAccountId, hashMessage({ raw }));
    expect(result).toEqual({
      signature: '0xsigned',
      walletAddress: WALLET.walletAddress,
      signerAddress: WALLET.agentWalletAddress,
      type: 'message',
    });
  });

  it('rejects API-key hash signing before creating an audit record', async () => {
    const hash = '0x'.padEnd(66, '1');

    await expect(
      service.sign('user-1', { type: 'hash', hash, chainId: 84532 } as any, API_KEY_CONTEXT),
    ).rejects.toThrow('hash signing is not allowed');

    expect(mockSigningRequestCreate).not.toHaveBeenCalled();
    expect(mockSignData).not.toHaveBeenCalled();
  });

  it('requires explicit chainId for API-key typed data signing', async () => {
    const typedData = createTypedData(84532);

    await expect(
      service.sign('user-1', { type: 'typed_data', typedData } as any, API_KEY_CONTEXT),
    ).rejects.toThrow('chainId is required when signing typed data with an API key');
  });

  it('requires typedData.domain.chainId for API-key typed data signing', async () => {
    const typedData = createTypedData(undefined);

    await expect(
      service.sign('user-1', { type: 'typed_data', typedData, chainId: 84532 } as any, {
        id: API_KEY_CONTEXT.id,
        allowedChains: [84532],
      }),
    ).rejects.toThrow(
      'typedData.domain.chainId is required when signing typed data with an API key',
    );
  });

  it('requires typedData.domain.chainId to match chainId for API-key typed data signing', async () => {
    const typedData = createTypedData(84531);

    await expect(
      service.sign('user-1', { type: 'typed_data', typedData, chainId: 84532 } as any, {
        id: API_KEY_CONTEXT.id,
        allowedChains: [84532],
      }),
    ).rejects.toThrow('typedData.domain.chainId must match chainId');
  });

  it('allows API-key typed data signing when chainId matches and is allowed', async () => {
    const typedData = createTypedData(84532);

    const result = await service.sign(
      'user-1',
      { type: 'typed_data', typedData, chainId: 84532 } as any,
      {
        id: API_KEY_CONTEXT.id,
        allowedChains: [84532],
      },
    );

    expect(mockSignData).toHaveBeenCalledWith(
      WALLET.agentOpenfortAccountId,
      expect.stringMatching(/^0x[a-f0-9]{64}$/),
    );
    expect(result).toEqual({
      signature: '0xsigned',
      walletAddress: WALLET.walletAddress,
      signerAddress: WALLET.agentWalletAddress,
      type: 'typed_data',
    });
  });

  it('throws NotFoundException when wallet not found', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      service.sign(
        'user-1',
        { type: 'message', message: 'Hello', chainId: 84532 } as any,
        API_KEY_CONTEXT,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

function createTypedData(chainId: number | undefined) {
  return {
    domain: {
      name: 'SOFA ONE',
      version: '1',
      ...(chainId === undefined ? {} : { chainId }),
    },
    types: {
      Mail: [{ name: 'message', type: 'string' }],
    },
    primaryType: 'Mail',
    message: { message: 'Hello' },
  };
}
