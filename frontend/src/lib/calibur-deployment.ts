import type { Address, Hex } from 'viem';

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
