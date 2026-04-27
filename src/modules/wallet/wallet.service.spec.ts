import { BadRequestException, NotFoundException } from '@nestjs/common';
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

// ── test suite ─────────────────────────────────────────────────────────────────

describe('WalletService.withdraw()', () => {
  let service: WalletService;

  // Prisma mock handles
  const mockFindUnique = jest.fn();
  const mockFindFirst = jest.fn();
  const mockCreate = jest.fn();
  const mockUpdate = jest.fn();

  // Openfort mock handle
  const mockCreateTransactionIntent = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default: wallet exists, sufficient balance, no duplicate tx
    mockFindUnique.mockResolvedValue({ ...WALLET });
    mockFindFirst.mockResolvedValue(null);
    mockReadContract.mockResolvedValue(SUFFICIENT_BALANCE);
    mockCreateTransactionIntent.mockResolvedValue({ id: 'intent-1' });
    mockCreate.mockResolvedValue({ id: 'tx-1', intentId: null, status: 'submitting' });
    mockUpdate.mockResolvedValue({ id: 'tx-1', intentId: 'intent-1', status: 'pending' });

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
          useValue: { createTransactionIntent: mockCreateTransactionIntent, signData: jest.fn() },
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
    mockCreate.mockRejectedValue({ code: 'P2002' });
    mockFindFirst.mockResolvedValue({ id: 'tx-existing', intentId: 'intent-existing', status: 'pending' });

    const result = await service.withdraw('user-1', VALID_DTO);

    expect(result).toEqual({ transactionId: 'tx-existing', intentId: 'intent-existing', status: 'pending' });
    expect(mockCreateTransactionIntent).not.toHaveBeenCalled();
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
    expect(mockCreateTransactionIntent).toHaveBeenCalledTimes(1);
    expect(mockCreateTransactionIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: VALID_DTO.chainId,
        accountId: WALLET.openfortAccountId,
      }),
    );

    // Prisma transaction was persisted
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Return shape
    expect(result).toEqual({
      transactionId: 'tx-1',
      intentId: 'intent-1',
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
    mockCreateTransactionIntent.mockRejectedValue(new Error('Openfort down'));

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

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFindUnique.mockResolvedValue({ ...WALLET });
    mockSignData.mockResolvedValue('0xsigned');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: { userWallet: { findUnique: mockFindUnique } },
        },
        {
          provide: OpenfortService,
          useValue: { signData: mockSignData },
        },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
  });

  it('uses EIP-191 hash for message signing', async () => {
    const result = await service.sign('user-1', { type: 'message', message: 'Hello, SOFA ONE!' } as any);

    expect(mockSignData).toHaveBeenCalledWith(WALLET.openfortAccountId, hashMessage('Hello, SOFA ONE!'));
    expect(result).toEqual({ signature: '0xsigned', walletAddress: WALLET.walletAddress, type: 'message' });
  });

  it('throws NotFoundException when wallet not found', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(service.sign('user-1', { type: 'message', message: 'Hello' } as any)).rejects.toThrow(
      NotFoundException,
    );
  });
});
