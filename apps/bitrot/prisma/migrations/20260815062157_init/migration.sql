-- CreateEnum
CREATE TYPE "Ecosystem" AS ENUM ('npm', 'pypi');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('running', 'complete', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scans" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ecosystem" "Ecosystem" NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'running',
    "error" TEXT,
    "totalPackages" INTEGER NOT NULL DEFAULT 0,
    "resolvedPackages" INTEGER NOT NULL DEFAULT 0,
    "portfolioScore" INTEGER,
    "grade" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findings" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "ecosystem" "Ecosystem" NOT NULL,
    "packageName" TEXT NOT NULL,
    "section" TEXT,
    "requestedRange" TEXT,
    "resolvedVersion" TEXT,
    "latestVersion" TEXT,
    "rotScore" INTEGER,
    "grade" TEXT,
    "signals" JSONB,
    "reasons" JSONB,
    "lastPublishAt" TIMESTAMP(3),
    "firstPublishAt" TIMESTAMP(3),
    "maintainerCount" INTEGER,
    "releaseCount" INTEGER,
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "deprecationNote" TEXT,
    "license" TEXT,
    "repositoryUrl" TEXT,
    "lookupError" TEXT,

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_records" (
    "id" TEXT NOT NULL,
    "ecosystem" "Ecosystem" NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acknowledgements" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ecosystem" "Ecosystem" NOT NULL,
    "packageName" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "scans_userId_createdAt_idx" ON "scans"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "findings_scanId_idx" ON "findings"("scanId");

-- CreateIndex
CREATE INDEX "findings_scanId_rotScore_idx" ON "findings"("scanId", "rotScore");

-- CreateIndex
CREATE INDEX "package_records_fetchedAt_idx" ON "package_records"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "package_records_ecosystem_name_key" ON "package_records"("ecosystem", "name");

-- CreateIndex
CREATE UNIQUE INDEX "acknowledgements_userId_ecosystem_packageName_key" ON "acknowledgements"("userId", "ecosystem", "packageName");

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acknowledgements" ADD CONSTRAINT "acknowledgements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
