import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import Openfort, { getAccountsV2 } from '@openfort/openfort-node';
import { padHex, getAddress } from 'viem';
import { hashKey, KeyType } from '../src/common/calibur/calibur';
import { bindProvisionedAccount, findRawProviderAccount } from '../src/modules/wallet-provisioning-recovery/bind-recovery';

function args(argv: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Expected --name value arguments');
    result[key.slice(2)] = argv[i + 1];
  }
  return result;
}

async function main() {
  const options = args(process.argv.slice(2));
  const required = ['wallet-id', 'dispatch-token', 'account-id', 'operator', 'evidence'];
  for (const key of required) if (!options[key]) throw new Error(`Missing --${key}`);
  if (!process.env.DATABASE_URL || !process.env.OPENFORT_API_KEY || !process.env.OPENFORT_WALLET_SECRET) throw new Error('Required runtime configuration is missing');
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL) });
  try {
    const client = new Openfort(process.env.OPENFORT_API_KEY, { walletSecret: process.env.OPENFORT_WALLET_SECRET } as any);
    await bindProvisionedAccount(prisma, {
      getAccount: async (id) => findRawProviderAccount(
        (params) => getAccountsV2(params),
        id,
      ),
    }, (address) => hashKey({ keyType: KeyType.Secp256k1, publicKey: padHex(getAddress(address), { size: 32 }) }), {
      walletId: options['wallet-id'], dispatchToken: options['dispatch-token'], accountId: options['account-id'],
      operator: options.operator, evidence: options.evidence, expectedAddress: options['expected-address'],
    });
    console.info('Wallet provisioning bind completed');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`Recovery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
