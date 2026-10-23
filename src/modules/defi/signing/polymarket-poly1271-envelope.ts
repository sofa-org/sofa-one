import { hashDomain, keccak256, encodeAbiParameters, isHex, toBytes, toHex, concat } from 'viem';
import { POLYMARKET_ORDER_TYPE, type ValidatedPolymarketOrder } from './polymarket-clob-order';

const ORDER_TYPES = ['bytes32','uint256','address','address','uint256','uint256','uint256','uint8','uint8','uint256','bytes32','bytes32'] as const;
const DOMAIN_FIELDS = [{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}] as const;
const ORDER_TYPE_HASH = keccak256(toHex(POLYMARKET_ORDER_TYPE));

function normalizeSignature(signature: `0x${string}`): `0x${string}` {
  if (!isHex(signature) || signature.length !== 132) throw new Error('Expected a 65-byte signature');
  const v = Number.parseInt(signature.slice(-2), 16);
  if (v !== 0 && v !== 1 && v !== 27 && v !== 28) throw new Error('Invalid signature recovery value');
  // DepositWallet's 65-byte ECDSA verifier requires v=27/28, not yParity=0/1.
  return v < 27 ? `0x${signature.slice(2, -2)}${(v + 27).toString(16)}` : signature;
}

/** Build the Poly1271 signature envelope; the supplied signature is over TypedDataSign. */
export function buildPolymarketPoly1271Envelope(payload: ValidatedPolymarketOrder, signature: `0x${string}`): `0x${string}` {
  const normalizedSignature = normalizeSignature(signature);
  const contentsHash = contentsHashFor(payload);
  const appDomain = hashDomain({ domain:payload.domain, types:{EIP712Domain:DOMAIN_FIELDS} } as any);
  const typeBytes = toBytes(POLYMARKET_ORDER_TYPE);
  if (typeBytes.length > 65535) throw new Error('Order type is too long');
  const length = new Uint8Array([typeBytes.length >> 8, typeBytes.length & 255]);
  return concat([normalizedSignature, appDomain, contentsHash, toHex(typeBytes), toHex(length)]) as `0x${string}`;
}

export function polymarketOrderContentsHash(payload: ValidatedPolymarketOrder): `0x${string}` {
  return contentsHashFor(payload);
}

function contentsHashFor(payload: ValidatedPolymarketOrder): `0x${string}` {
  const o = payload.message.contents as Record<string, any>;
  return keccak256(encodeAbiParameters(ORDER_TYPES.map((type) => ({type})) as any, [ORDER_TYPE_HASH, BigInt(o.salt), o.maker, o.signer, BigInt(o.tokenId), BigInt(o.makerAmount), BigInt(o.takerAmount), o.side, o.signatureType, BigInt(o.timestamp), o.metadata, o.builder]));
}

export { POLYMARKET_ORDER_TYPE };
