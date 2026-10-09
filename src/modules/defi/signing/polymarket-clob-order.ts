import { BadRequestException } from '@nestjs/common';
import { hashTypedData, hashDomain, isAddress } from 'viem';

export const POLYMARKET_CLOB_ORDER_CAPABILITY_ID = 'polymarket:137:clob-order:v2';
export const POLYMARKET_ORDER_TYPE = 'Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)';
const MAX = (1n << 256n) - 1n;
const CONTRACTS = new Set(['0xe111180000d2663c0091e4f400237545b87b996b', '0xe2222d279d744050d28e00520010520000310f59']);
const ORDER_FIELDS = [['salt','uint256'],['maker','address'],['signer','address'],['tokenId','uint256'],['makerAmount','uint256'],['takerAmount','uint256'],['side','uint8'],['signatureType','uint8'],['timestamp','uint256'],['metadata','bytes32'],['builder','bytes32']] as const;
const WRAPPER_FIELDS = [['contents','Order'],['name','string'],['version','string'],['chainId','uint256'],['verifyingContract','address'],['salt','bytes32']] as const;
type Field = { name: string; type: string };
export type PolymarketOrder = Readonly<{ salt: string; maker: string; signer: string; tokenId: string; makerAmount: string; takerAmount: string; side: number; signatureType: number; timestamp: string; metadata: `0x${string}`; builder: `0x${string}` }>;
export type ValidatedPolymarketOrder = Readonly<{ domain: Readonly<Record<string, unknown>>; types: Readonly<Record<string, readonly Field[]>>; primaryType: 'TypedDataSign'; message: Readonly<Record<string, unknown>> }>;

/** Strictly normalize the sole supported Polygon CLOB V2 EOA order envelope. */
export function validatePolymarketClobOrder(input: unknown, nowMs = Date.now()): ValidatedPolymarketOrder {
  const fail = (): never => { throw new BadRequestException('Invalid typed-data signing request'); };
  const obj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
  const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(x, k));
  const fields = (x: unknown, expected: readonly (readonly [string,string])[]) => Array.isArray(x) && x.length === expected.length && x.every((f, i) => obj(f) && exact(f, ['name','type']) && f.name === expected[i][0] && f.type === expected[i][1]);
  const uint = (v: unknown): string | null => {
    if (typeof v === 'number') { if (!Number.isSafeInteger(v) || v < 0) return null; v = String(v); }
    if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) return null;
    try { return BigInt(v) <= MAX ? v : null; } catch { return null; }
  };
  if (!obj(input) || !exact(input, ['domain','types','primaryType','message']) || !obj(input.domain) || !obj(input.types) || !obj(input.message) || input.primaryType !== 'TypedDataSign') return fail();
  const d = input.domain;
  if (!exact(d, ['name','version','chainId','verifyingContract']) || d.name !== 'Polymarket CTF Exchange' || d.version !== '2' || d.chainId !== 137 || typeof d.verifyingContract !== 'string' || !CONTRACTS.has(d.verifyingContract.toLowerCase()) || !isAddress(d.verifyingContract)) return fail();
  if (!fields(input.types.Order, ORDER_FIELDS) || !fields(input.types.TypedDataSign, WRAPPER_FIELDS) || Object.keys(input.types).some((k) => !['Order','TypedDataSign','EIP712Domain'].includes(k))) return fail();
  if (input.types.EIP712Domain !== undefined && !fields(input.types.EIP712Domain, [['name','string'],['version','string'],['chainId','uint256'],['verifyingContract','address']])) return fail();
  const m = input.message;
  if (!exact(m, ['contents','name','version','chainId','verifyingContract','salt']) || !obj(m.contents) || !exact(m.contents, ORDER_FIELDS.map(([n]) => n))) return fail();
  const o = m.contents;
  const maker = typeof o.maker === 'string' && isAddress(o.maker), signer = typeof o.signer === 'string' && isAddress(o.signer);
  if (!maker || !signer || o.maker.toLowerCase() !== o.signer.toLowerCase() || o.maker.toLowerCase() === '0x0000000000000000000000000000000000000000') return fail();
  const nums: Record<string,string> = {};
  for (const key of ['salt','tokenId','makerAmount','takerAmount','timestamp'] as const) { const n = uint(o[key]); if (n === null) return fail(); nums[key] = n; }
  for (const key of ['side','signatureType'] as const) { const n = uint(o[key]); if (n === null || BigInt(n) > 255n) return fail(); nums[key] = n; }
  if (BigInt(nums.makerAmount) === 0n || BigInt(nums.takerAmount) === 0n || Number(nums.side) > 1 || Number(nums.signatureType) !== 3 || BigInt(nums.timestamp) === 0n || Math.abs(Number(nums.timestamp) - nowMs) > 300_000) return fail();
  if (typeof o.metadata !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.metadata) || typeof o.builder !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(o.builder)) return fail();
  if (m.name !== 'DepositWallet' || m.version !== '1' || m.chainId !== 137 || m.verifyingContract.toLowerCase() !== o.maker.toLowerCase() || m.verifyingContract.toLowerCase() !== o.signer.toLowerCase() || m.salt !== `0x${'00'.repeat(32)}`) return fail();
  if (typeof m.verifyingContract !== 'string' || !isAddress(m.verifyingContract)) return fail();
  const order = { salt: nums.salt, maker:o.maker, signer:o.signer, tokenId:nums.tokenId, makerAmount:nums.makerAmount, takerAmount:nums.takerAmount, side:Number(nums.side), signatureType:Number(nums.signatureType), timestamp:nums.timestamp, metadata:o.metadata, builder:o.builder };
  const types = { ...(input.types.EIP712Domain ? { EIP712Domain: input.types.EIP712Domain.map((f: Field) => ({...f})) } : {}), Order: ORDER_FIELDS.map(([name,type]) => ({name,type})), TypedDataSign: WRAPPER_FIELDS.map(([name,type]) => ({name,type})) };
  return deepFreeze({ domain:{...d}, types, primaryType:'TypedDataSign' as const, message:{contents:order,name:'DepositWallet',version:'1',chainId:137,verifyingContract:m.verifyingContract,salt:m.salt} });
}

export function polymarketOrderDigest(payload: ValidatedPolymarketOrder): `0x${string}` { return hashTypedData({ domain: payload.domain, types: { Order: payload.types.Order }, primaryType: 'Order', message: payload.message.contents } as any); }
export function polymarketDepositWalletAddress(payload: ValidatedPolymarketOrder): string { return String(payload.message.verifyingContract); }
export function polymarketWrapperDigest(payload: ValidatedPolymarketOrder): `0x${string}` { return hashTypedData(payload as any); }
export function polymarketDomainSeparator(payload: ValidatedPolymarketOrder): `0x${string}` { return hashDomain({ domain: payload.domain, types: { EIP712Domain: [{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}] } } as any); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value as object).forEach(deepFreeze); } return value; }
