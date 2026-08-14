-- CreateEnum
CREATE TYPE "HealthMetric" AS ENUM ('heart_rate', 'spo2', 'blood_pressure', 'stress', 'hrv', 'steps', 'distance', 'calories', 'battery');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('device_realtime', 'device_history', 'calculated', 'estimated');

-- CreateEnum
CREATE TYPE "SleepStage" AS ENUM ('light', 'deep', 'rem', 'awake');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firmwareVersion" TEXT,
    "hardwareVersion" TEXT,
    "capabilities" JSONB,
    "hasVibrationMotor" BOOLEAN,
    "batteryLevel" INTEGER,
    "batteryCharging" BOOLEAN,
    "lastSeenAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_samples" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "metric" "HealthMetric" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "value2" DOUBLE PRECISION,
    "unit" TEXT NOT NULL,
    "source" "DataSource" NOT NULL,

    CONSTRAINT "health_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sleep_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "totalMinutes" INTEGER NOT NULL,
    "sleepScore" INTEGER,
    "source" "DataSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sleep_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sleep_stage_segments" (
    "id" TEXT NOT NULL,
    "sleepSessionId" TEXT NOT NULL,
    "stage" "SleepStage" NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "durationMin" INTEGER NOT NULL,

    CONSTRAINT "sleep_stage_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_scores" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "comparedToWeeklyAvgPct" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alarms" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "label" TEXT NOT NULL,
    "time" TEXT NOT NULL,
    "days" INTEGER[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "vibration" BOOLEAN NOT NULL DEFAULT true,
    "nativeDeviceAlarm" BOOLEAN NOT NULL DEFAULT false,
    "windowEndTime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alarms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_insights" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "basedOnRangeStart" TIMESTAMP(3) NOT NULL,
    "basedOnRangeEnd" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "devices_userId_bleId_key" ON "devices"("userId", "bleId");

-- CreateIndex
CREATE INDEX "health_samples_userId_metric_ts_idx" ON "health_samples"("userId", "metric", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "health_samples_deviceId_metric_ts_key" ON "health_samples"("deviceId", "metric", "ts");

-- CreateIndex
CREATE INDEX "sleep_sessions_userId_date_idx" ON "sleep_sessions"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "sleep_sessions_deviceId_date_key" ON "sleep_sessions"("deviceId", "date");

-- CreateIndex
CREATE INDEX "sleep_stage_segments_sleepSessionId_idx" ON "sleep_stage_segments"("sleepSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_scores_userId_date_key" ON "recovery_scores"("userId", "date");

-- CreateIndex
CREATE INDEX "alarms_userId_idx" ON "alarms"("userId");

-- CreateIndex
CREATE INDEX "ai_insights_userId_createdAt_idx" ON "ai_insights"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_samples" ADD CONSTRAINT "health_samples_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "health_samples" ADD CONSTRAINT "health_samples_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_sessions" ADD CONSTRAINT "sleep_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_sessions" ADD CONSTRAINT "sleep_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sleep_stage_segments" ADD CONSTRAINT "sleep_stage_segments_sleepSessionId_fkey" FOREIGN KEY ("sleepSessionId") REFERENCES "sleep_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_scores" ADD CONSTRAINT "recovery_scores_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alarms" ADD CONSTRAINT "alarms_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alarms" ADD CONSTRAINT "alarms_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
