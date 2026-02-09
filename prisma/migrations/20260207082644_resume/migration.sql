/*
  Warnings:

  - You are about to drop the column `fileUrl` on the `Resume` table. All the data in the column will be lost.
  - Added the required column `storagePath` to the `Resume` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `Resume` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ResumeStatus" AS ENUM ('PENDING', 'UPLOADED', 'PARSED', 'EMBEDDED', 'READY');

-- AlterTable
ALTER TABLE "Resume" DROP COLUMN "fileUrl",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "status" "ResumeStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "storagePath" TEXT NOT NULL,
ADD COLUMN     "userId" TEXT NOT NULL,
ALTER COLUMN "uploadedAt" DROP NOT NULL,
ALTER COLUMN "uploadedAt" DROP DEFAULT;
