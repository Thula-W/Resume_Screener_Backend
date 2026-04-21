/*
  Warnings:

  - You are about to drop the column `candidateEmail` on the `Resume` table. All the data in the column will be lost.
  - You are about to drop the column `candidateName` on the `Resume` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Resume" DROP COLUMN "candidateEmail",
DROP COLUMN "candidateName";
