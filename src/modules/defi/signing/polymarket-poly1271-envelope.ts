import { hashTypedData, hashDomain, keccak256, encodeAbiParameters, isHex, toBytes, toHex, concat } from 'viem';
import { POLYMARKET_ORDER_TYPE, type ValidatedPolymarketOrder } from './polymarket-clob-order';

const ORDER_FIELDS = [{name:'salt',type:'uint256'},{name:'maker',type:'address'},{name:'signer',type:'address'},{name:'tokenId',type:'uint256'},{name:'makerAmount',type:'uint256'},{name:'takerAmount',type:'uint256'},{name:'side',type:'uint8'},{name:'signatureType',type:'uint8'},{name:'timestamp',type:'uint256'},{name:'metadata',type:'bytes32'},{name:'builder',type:'bytes32'}] as const;
const ORDER_TYPES = ['bytes32','uint256','address','address','uint256','uint256','uint256','uint8','uint8','uint256','bytes32','bytes32'] as const;
const DOMAIN_FIELDS = [{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}] as const;
const ORDER_TYPE_HASH = keccak256(toHex(POLYMARKET_ORDER_TYPE));

function assertSignature(signature: string): void {
  if (!isHex(signature) || signature.length !== 132) throw new Error('Expected a 65-byte signature');
  const v = Number.parseInt(signature.slice(-2), 16);
  if (v !== 0 && v !== 1 && v !== 27 && v !== 28) throw new Error('Invalid signature recovery value');
}

/** Build the Poly1271 signature envelope; the supplied signature is over TypedDataSign. */
export function buildPolymarketPoly1271Envelope(payload: ValidatedPolymarketOrder, signature: `0x${string}`): `0x${string}` {
  assertSignature(signature);
  const contentsHash = contentsHashFor(payload);
  const appDomain = hashDomain({ domain:payload.domain, types:{EIP712Domain:DOMAIN_FIELDS} } as any);
  const typeBytes = toBytes(POLYMARKET_ORDER_TYPE);
  if (typeBytes.length > 65535) throw new Error('Order type is too long');
  const length = new Uint8Array([typeBytes.length >> 8, typeBytes.length & 255]);
  return concat([signature, appDomain, contentsHash, toHex(typeBytes), toHex(length)]) as `0x${string}`;
}

export function polymarketOrderContentsHash(payload: ValidatedPolymarketOrder): `0x${string}` {
  return contentsHashFor(payload);
}

function contentsHashFor(payload: ValidatedPolymarketOrder): `0x${string}` {
  const o = payload.message.contents as Record<string, any>;
  return keccak256(encodeAbiParameters(ORDER_TYPES.map((type) => ({type})) as any, [ORDER_TYPE_HASH, BigInt(o.salt), o.maker, o.signer, BigInt(o.tokenId), BigInt(o.makerAmount), BigInt(o.takerAmount), o.side, o.signatureType, BigInt(o.timestamp), o.metadata, o.builder]));
}

export { POLYMARKET_ORDER_TYPE };
