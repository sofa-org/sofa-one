-- AlterTable
ALTER TABLE "security_events" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "security_notifications" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "user_known_ips" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "withdrawal_addresses" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "withdrawal_policies" ALTER COLUMN "id" DROP DEFAULT;
