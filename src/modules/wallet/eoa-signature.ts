import type { Hex } from 'viem';

/** Canonical 65-byte EOA signature for recovery, contract verification and API output. */
export function normalizeEoaSignature(signature: string): Hex {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error('Expected a 65-byte EOA signature');
  }
  const v = Number.parseInt(signature.slice(-2), 16);
  if (v !== 0 && v !== 1 && v !== 27 && v !== 28) {
    throw new Error('Invalid EOA signature recovery value');
  }
  return v < 27 ? `0x${signature.slice(2, -2)}${(v + 27).toString(16)}` : signature as Hex;
}
