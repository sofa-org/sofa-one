/*
  Warnings:

  - You are about to drop the column `salt` on the `api_keys` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "api_keys" DROP COLUMN "salt";

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "details" JSONB,
ADD COLUMN     "wallet_address" VARCHAR(42);
