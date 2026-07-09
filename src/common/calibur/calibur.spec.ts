const mockGetCode = jest.fn();

jest.mock('viem/actions', () => ({
  getCode: (...args: unknown[]) => mockGetCode(...args),
  readContract: jest.fn(),
}));

import {
  CALIBUR_ADDRESSES,
  CALIBUR_ADDRESS,
  encodeCaliburExecuteUserOpCalls,
  EIP7702_DELEGATION_PREFIX,
  getCaliburDelegationCodes,
  getCaliburDelegationCode,
  hasCaliburDelegation,
  LEGACY_CALIBUR_ADDRESS,
} from './calibur';

describe('Calibur delegation helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds the expected EIP-7702 delegation code for Calibur', () => {
    expect(getCaliburDelegationCode()).toBe(
      `${EIP7702_DELEGATION_PREFIX}${CALIBUR_ADDRESS.slice(2)}`,
    );
    expect(getCaliburDelegationCode(LEGACY_CALIBUR_ADDRESS)).toBe(
      `${EIP7702_DELEGATION_PREFIX}${LEGACY_CALIBUR_ADDRESS.slice(2)}`,
    );
    expect(getCaliburDelegationCodes()).toEqual(
      CALIBUR_ADDRESSES.map(
        (address) => `${EIP7702_DELEGATION_PREFIX}${address.slice(2)}`,
      ),
    );
  });

  it('detects whether an EOA is delegated to Calibur', async () => {
    const account = '0x1111111111111111111111111111111111111111';
    mockGetCode.mockResolvedValueOnce(getCaliburDelegationCode());
    mockGetCode.mockResolvedValueOnce(getCaliburDelegationCode(LEGACY_CALIBUR_ADDRESS));
    mockGetCode.mockResolvedValueOnce('0x');

    await expect(hasCaliburDelegation({} as any, account)).resolves.toBe(true);
    await expect(hasCaliburDelegation({} as any, account)).resolves.toBe(true);
    await expect(hasCaliburDelegation({} as any, account)).resolves.toBe(false);
  });

  it('encodes Calibur session calls with the EntryPoint executeUserOp selector', async () => {
    const callData = encodeCaliburExecuteUserOpCalls([
      {
        to: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
        value: 0n,
        data: '0x095ea7b3000000000000000000000000e111180000d2663c0091e4f400237545b87b996bffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      },
    ]);

    expect(callData).toMatch(/^0x8dd7712f/);
    expect(callData).not.toMatch(/^0xc0972062/);
  });
});
