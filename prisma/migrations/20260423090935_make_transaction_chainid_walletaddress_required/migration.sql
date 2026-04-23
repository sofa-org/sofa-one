/*
  Warnings:

  - Made the column `chain_id` on table `transactions` required. This step will fail if there are existing NULL values in that column.
  - Made the column `wallet_address` on table `transactions` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "transactions" ALTER COLUMN "chain_id" SET NOT NULL,
ALTER COLUMN "wallet_address" SET NOT NULL;
