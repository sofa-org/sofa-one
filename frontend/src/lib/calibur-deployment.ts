import type { Address, Hex } from 'viem';
import { CALIBUR_ADDRESS, CALIBUR_ADDRESSES, LEGACY_CALIBUR_ADDRESS } from './calibur';

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

export async function resolveCaliburDeployment(
  chainId: number,
  client: DeploymentClient,
): Promise<Address | null> {
  if (client.chain?.id !== undefined && client.chain.id !== chainId) {
    throw new Error(`Calibur RPC client chain ${client.chain.id} does not match requested chain ${chainId}.`);
  }
  const trustedAddress = TRUSTED_CALIBUR_DEPLOYMENTS[chainId];
  if (trustedAddress) return trustedAddress;
  for (const address of CALIBUR_ADDRESSES) {
    const code = await client.getCode({ address });
    if (code && code !== '0x') return address;
  }
  return null;
}
