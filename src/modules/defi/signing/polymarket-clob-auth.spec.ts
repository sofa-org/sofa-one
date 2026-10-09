import { hashTypedData } from 'viem';
import { validatePolymarketClobAuth, POLYMARKET_CLOB_AUTH_ATTESTATION, signingPayloadDigest } from './polymarket-clob-auth';

const address = '0x1111111111111111111111111111111111111111';
const typedData = (nonce: number | string = 0, now = 1_700_000_000) => ({
  domain: { name: 'ClobAuthDomain', version: '1', chainId: 137 },
  types: { ClobAuth: [{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }] },
  primaryType: 'ClobAuth', message: { address, timestamp: String(now), nonce, message: POLYMARKET_CLOB_AUTH_ATTESTATION },
});

describe('Polymarket ClobAuth validator', () => {
  it('accepts SDK shape, normalizes nonce zero, freezes payload and hashes independently with viem', () => {
    const accepted = validatePolymarketClobAuth(typedData(0), address, 1_700_000_000_000);
    expect(accepted.message.nonce).toBe('0');
    expect(Object.isFrozen(accepted.message)).toBe(true);
    expect(signingPayloadDigest(accepted)).toBe(hashTypedData(accepted as any));
  });

  it('accepts maximum uint256 and optional exact EIP712Domain definition', () => {
    const input: any = typedData(((1n << 256n) - 1n).toString());
    input.types.EIP712Domain = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }];
    expect(validatePolymarketClobAuth(input, address, 1_700_000_000_000).message.nonce).toBe(((1n << 256n) - 1n).toString());
  });

  it('accepts inclusive timestamp bounds when now has fractional milliseconds', () => {
    const nowMs = 1_700_000_000_987;
    for (const offset of [-300, 300]) {
      const input: any = typedData();
      input.message.timestamp = String(Math.floor(nowMs / 1000) + offset);
      expect(() => validatePolymarketClobAuth(input, address, nowMs)).not.toThrow();
    }
    for (const offset of [-301, 301]) {
      const input: any = typedData();
      input.message.timestamp = String(Math.floor(nowMs / 1000) + offset);
      expect(() => validatePolymarketClobAuth(input, address, nowMs)).toThrow();
    }
  });
  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5, null, ((1n << 256n)).toString()])('rejects invalid nonce %p', (nonce) => {
    expect(() => validatePolymarketClobAuth(typedData(nonce as any), address, 1_700_000_000_000)).toThrow();
  });
  it('rejects extra payload fields and address mismatch', () => {
    const extra = typedData(); (extra.message as any).extra = true;
    expect(() => validatePolymarketClobAuth(extra, address, 1_700_000_000_000)).toThrow();
    expect(() => validatePolymarketClobAuth(typedData(), '0x2222222222222222222222222222222222222222', 1_700_000_000_000)).toThrow();
  });
  it.each([
    ['domain extra', (x: any) => { x.domain.verifyingContract = address; }],
    ['salt domain', (x: any) => { x.domain.salt = '0x' + '00'.repeat(32); }],
    ['field reordering', (x: any) => { x.types.ClobAuth.reverse(); }],
    ['extra type', (x: any) => { x.types.Other = []; }],
    ['wrong primary type', (x: any) => { x.primaryType = 'Order'; }],
    ['wrong attestation', (x: any) => { x.message.message = 'other'; }],
    ['noncanonical timestamp', (x: any) => { x.message.timestamp = '01'; }],
    ['timestamp overflow', (x: any) => { x.message.timestamp = '999999999999999999'; }],
  ])('rejects %s', (_label, change) => {
    const input: any = JSON.parse(JSON.stringify(typedData()));
    change(input);
    expect(() => validatePolymarketClobAuth(input, address, 1_700_000_000_000)).toThrow();
  });
});
