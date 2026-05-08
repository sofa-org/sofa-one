const mockGetCode = jest.fn();

jest.mock('viem/actions', () => ({
  getCode: (...args: unknown[]) => mockGetCode(...args),
  readContract: jest.fn(),
}));

import {
  CALIBUR_ADDRESS,
  EIP7702_DELEGATION_PREFIX,
  getCaliburDelegationCode,
  hasCaliburDelegation,
} from './calibur';

describe('Calibur delegation helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds the expected EIP-7702 delegation code for Calibur', () => {
    expect(getCaliburDelegationCode()).toBe(
      `${EIP7702_DELEGATION_PREFIX}${CALIBUR_ADDRESS.slice(2)}`,
    );
  });

  it('detects whether an EOA is delegated to Calibur', async () => {
    const account = '0x1111111111111111111111111111111111111111';
    mockGetCode.mockResolvedValueOnce(getCaliburDelegationCode());
    mockGetCode.mockResolvedValueOnce('0x');

    await expect(hasCaliburDelegation({} as any, account)).resolves.toBe(true);
    await expect(hasCaliburDelegation({} as any, account)).resolves.toBe(false);
  });
});
