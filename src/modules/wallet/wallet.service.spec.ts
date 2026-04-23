import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

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

  // Openfort mock handle
  const mockCreateTransactionIntent = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default: wallet exists, sufficient balance, no duplicate tx
    mockFindUnique.mockResolvedValue({ ...WALLET });
    mockFindFirst.mockResolvedValue(null);
    mockReadContract.mockResolvedValue(SUFFICIENT_BALANCE);
    mockCreateTransactionIntent.mockResolvedValue({ id: 'intent-1' });
    mockCreate.mockResolvedValue({ id: 'tx-1', intentId: 'intent-1', status: 'pending' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        {
          provide: PrismaService,
          useValue: {
            userWallet: { findUnique: mockFindUnique },
            transaction: { findFirst: mockFindFirst, create: mockCreate },
          },
        },
        {
          provide: OpenfortService,
          useValue: { createTransactionIntent: mockCreateTransactionIntent },
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

  // ── 4. Idempotency conflict ──────────────────────────────────────────────────

  it('throws ConflictException when idempotencyKey matches an existing pending tx', async () => {
    mockFindFirst.mockResolvedValue({ id: 'tx-existing' });

    const dto: WithdrawDto = { ...VALID_DTO, idempotencyKey: 'idem-key-123' };

    await expect(service.withdraw('user-1', dto)).rejects.toThrow(ConflictException);
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

  it('stores idempotencyKey in transaction details and succeeds when no duplicate exists', async () => {
    const dto: WithdrawDto = { ...VALID_DTO, idempotencyKey: 'unique-key-abc' };

    // No duplicate pending tx
    mockFindFirst.mockResolvedValue(null);

    await service.withdraw('user-1', dto);

    // idempotency check was performed
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          status: 'pending',
        }),
      }),
    );

    // idempotencyKey stored in details
    const createCall = mockCreate.mock.calls[0][0] as {
      data: { details: Record<string, unknown> };
    };
    expect(createCall.data.details).toMatchObject({ idempotencyKey: 'unique-key-abc' });
  });
});
