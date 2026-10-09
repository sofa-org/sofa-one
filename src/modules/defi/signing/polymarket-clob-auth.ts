import { BadRequestException } from '@nestjs/common';
import { hashTypedData, isAddress } from 'viem';

export const POLYMARKET_CLOB_AUTH_CAPABILITY_ID = 'polymarket:137:clob-auth:v1';
export const POLYMARKET_CLOB_AUTH_ATTESTATION = 'This message attests that I control the given wallet';
const UINT256_MAX = (1n << 256n) - 1n;

export type ClobAuthTypedData = Readonly<{ domain: Readonly<{ name: 'ClobAuthDomain'; version: '1'; chainId: 137 }>; types: Readonly<Record<string, readonly Readonly<{ name: string; type: string }> []>>; primaryType: 'ClobAuth'; message: Readonly<{ address: string; timestamp: string; nonce: number | string; message: string }> }>;

/** Validate the sole supported signing protocol before viem is allowed to hash it. */
export function validatePolymarketClobAuth(input: unknown, selectedAddress: string, nowMs = Date.now()): ClobAuthTypedData {
  const fail = (): never => { throw new BadRequestException('Invalid typed-data signing request'); };
  const obj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
  const exactKeys = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(x, k));
  if (!obj(input) || !exactKeys(input, ['domain','types','primaryType','message']) || !obj(input.domain) || !obj(input.types) || !obj(input.message)) return fail();
  const d = input.domain;
  if (!exactKeys(d, ['name','version','chainId']) || d.name !== 'ClobAuthDomain' || d.version !== '1' || d.chainId !== 137 || input.primaryType !== 'ClobAuth') return fail();
  const fields = input.types.ClobAuth;
  if (!Array.isArray(fields) || fields.length !== 4 || !fields.every((f, i) => obj(f) && exactKeys(f, ['name','type']) && f.name === ['address','timestamp','nonce','message'][i] && f.type === ['address','string','uint256','string'][i])) return fail();
  const typeNames = Object.keys(input.types);
  if (typeNames.some((k) => k !== 'ClobAuth' && k !== 'EIP712Domain') || !typeNames.includes('ClobAuth')) return fail();
  if (input.types.EIP712Domain !== undefined) {
    const expected = [['name','string'],['version','string'],['chainId','uint256']];
    const domainFields = input.types.EIP712Domain;
    if (!Array.isArray(domainFields) || domainFields.length !== 3 || !domainFields.every((f, i) => obj(f) && exactKeys(f, ['name','type']) && f.name === expected[i][0] && f.type === expected[i][1])) return fail();
  }
  const m = input.message;
  if (!exactKeys(m, ['address','timestamp','nonce','message']) || typeof m.address !== 'string' || !isAddress(m.address) || !isAddress(selectedAddress) || m.address.toLowerCase() !== selectedAddress.toLowerCase() || m.message !== POLYMARKET_CLOB_AUTH_ATTESTATION) return fail();
  if (typeof m.timestamp !== 'string' || !/^(0|[1-9][0-9]{0,11})$/.test(m.timestamp)) return fail();
  const timestamp = Number(m.timestamp);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300) return fail();
  let nonce: string;
  if (typeof m.nonce === 'number') {
    if (!Number.isSafeInteger(m.nonce) || m.nonce < 0) return fail();
    nonce = String(m.nonce);
  } else if (typeof m.nonce === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(m.nonce)) nonce = m.nonce;
  else return fail();
  if (BigInt(nonce) > UINT256_MAX) return fail();
  const payload = { domain: { name: 'ClobAuthDomain' as const, version: '1' as const, chainId: 137 as const }, types: { ...(input.types.EIP712Domain ? { EIP712Domain: input.types.EIP712Domain.map((f: any) => ({ name: f.name, type: f.type })) } : {}), ClobAuth: fields.map((f: any) => ({ name: f.name, type: f.type })) }, primaryType: 'ClobAuth' as const, message: { address: m.address, timestamp: m.timestamp, nonce, message: POLYMARKET_CLOB_AUTH_ATTESTATION } };
  return deepFreeze(payload) as ClobAuthTypedData;
}

export function signingPayloadDigest(payload: ClobAuthTypedData): `0x${string}` { return hashTypedData(payload as any); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value as object).forEach(deepFreeze); } return value; }
