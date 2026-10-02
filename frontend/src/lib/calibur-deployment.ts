import type { Address, Hex } from 'viem';
import { CALIBUR_ADDRESS, LEGACY_CALIBUR_ADDRESS } from './calibur';

// Verified 2026-10-02 by bytecode identity: v1.1 is 22,020 bytes
// (SHA-256 91d278eed4489e727fa971fa851c88cb28a62504d48c0e15b3c9af9df7fbbc74),
// and v1.0 is 24,504 bytes
// (SHA-256 ec2f73e60cd9acf855d1b6b4dfa3f6b7209066ff4194b72af230834f69f5bbb9).
// Prefer latest v1.1 wherever deployed; retain legacy v1.0 only on its older
// supported networks. This explicit read-only map prevents publicnode runtime scans.
const TRUSTED_CALIBUR_DEPLOYMENTS: Readonly<Partial<Record<number, Address>>> = Object.freeze({
  1: CALIBUR_ADDRESS,
  8453: CALIBUR_ADDRESS,
  11155111: CALIBUR_ADDRESS,
  42161: CALIBUR_ADDRESS,
  10: CALIBUR_ADDRESS,
  56: CALIBUR_ADDRESS,
  143: CALIBUR_ADDRESS,
  137: CALIBUR_ADDRESS,
  10143: CALIBUR_ADDRESS,
  84532: LEGACY_CALIBUR_ADDRESS,
  80002: LEGACY_CALIBUR_ADDRESS,
  11155420: LEGACY_CALIBUR_ADDRESS,
});

type DeploymentClient = {
  chain?: { id: number } | null;
  getCode: (args: { address: Address }) => Promise<Hex | undefined>;
};

type CacheEntry = { address: Address; expiresAt: number };

export function createCaliburDeploymentResolver(
  addresses: readonly Address[],
  ttlMs = 5 * 60_000,
  now: () => number = Date.now,
) {
  const cache = new Map<number, CacheEntry>();
  const inFlight = new Map<number, Promise<Address | null>>();

  return async function resolveCaliburDeployment(
    chainId: number,
    client: DeploymentClient,
  ): Promise<Address | null> {
    if (client.chain?.id !== undefined && client.chain.id !== chainId) {
      throw new Error(`Calibur RPC client chain ${client.chain.id} does not match requested chain ${chainId}.`);
    }
    const trustedAddress = TRUSTED_CALIBUR_DEPLOYMENTS[chainId];
    if (trustedAddress) return trustedAddress;
    const cached = cache.get(chainId);
    if (cached && cached.expiresAt > now()) return cached.address;
    cache.delete(chainId);

    const pending = inFlight.get(chainId);
    if (pending) return pending;

    const promise = (async () => {
      for (const address of addresses) {
        const code = await client.getCode({ address });
        if (code && code !== '0x') {
          cache.set(chainId, { address, expiresAt: now() + ttlMs });
          return address;
        }
      }
      return null;
    })();
    inFlight.set(chainId, promise);
    try {
      return await promise;
    } finally {
      if (inFlight.get(chainId) === promise) inFlight.delete(chainId);
    }
  };
}
