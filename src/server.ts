import express from "express";
import { env } from "./config/env.js";
import { logger } from "./shared/logger.js";
import { LocalStorageService } from "./modules/storage/local-storage-service.js";
import { startSingleBot, stopSingleBot } from "./bot/index.js";
import { prisma, isRealPrismaClient, sanitizeDatabaseError } from "./database/client.js";
import { RuntimeConfigService } from "./modules/system-config/runtime-config-service.js";
import { BackupService } from "./modules/backup/backup-service.js";
import { startPaymentReminderScheduler, stopPaymentReminderScheduler } from "./modules/orders/payment-reminder-service.js";

const app = express();
app.use(express.json());

// Sole public endpoint for V1: GET /health
// No public administrative, diagnostic outbound, financial, or order routes are exposed over HTTP.
// Telegram Bot is the sole operational interface with RBAC.
app.get("/health", async (_req, res) => {
  const hasDbUrl = Boolean(process.env.DATABASE_URL || env.DATABASE_URL);
  let dbStatus: string;

  if (!hasDbUrl) {
    dbStatus = "not_configured";
  } else if (!isRealPrismaClient()) {
    // The in-memory mock (non-production/test fallback) is NOT a database.
    // It must never make /health report the database as OK.
    dbStatus = "mock";
  } else {
    try {
      await (prisma as any).$queryRaw`SELECT 1`;
      dbStatus = "ok";
    } catch {
      dbStatus = "degraded";
    }
  }

  const storageHealth = await LocalStorageService.checkStorageHealth();
  const storageStatus = storageHealth.writable ? "ok" : "degraded";
  const botStatus = Boolean(env.TELEGRAM_BOT_TOKEN) ? "configured" : "not_configured";
  const backupStatus = RuntimeConfigService.isBackupEnabled() ? "enabled" : "disabled";

  // In production a real PostgreSQL round-trip is mandatory for a healthy
  // verdict; "not_configured" is only acceptable outside production.
  const dbHealthy =
    dbStatus === "ok" || (dbStatus === "not_configured" && process.env.NODE_ENV !== "production");
  const isHealthy = dbHealthy && storageStatus === "ok";
  const overallStatus = isHealthy ? "ok" : "degraded";

  // Minimal non-sensitive status payload
  res.status(isHealthy ? 200 : 503).json({
    status: overallStatus,
    database: dbStatus,
    storage: storageStatus,
    bot: botStatus,
    backup: backupStatus
  });
});

// Production safety gate: PostgreSQL must be reachable through the REAL
// PrismaClient before the HTTP server (and therefore the Telegram bot) starts.
// Non-production (local dev / automated tests) may use the in-memory mock.
async function assertProductionDatabaseReady(): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;

  if (!process.env.DATABASE_URL && !env.DATABASE_URL) {
    logger.error("[DB] FATAL: DATABASE_URL is not configured — refusing to start in production");
    process.exit(1);
  }
  if (!isRealPrismaClient()) {
    logger.error("[DB] FATAL: real PrismaClient unavailable (mock fallback active) — refusing to start in production");
    process.exit(1);
  }

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await (prisma as any).$queryRaw`SELECT 1`;
      logger.info(`[DB] PostgreSQL connectivity verified at startup (attempt ${attempt})`);
      return;
    } catch (err) {
      const reason = sanitizeDatabaseError(err);
      if (attempt === maxAttempts) {
        logger.error({ error: reason }, "[DB] FATAL: PostgreSQL connectivity check failed — refusing to start in production");
        process.exit(1);
      }
      logger.warn({ error: reason, attempt }, "[DB] PostgreSQL not reachable yet — retrying");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

await assertProductionDatabaseReady();

// Start HTTP server - Port 3000 is strictly required by reverse proxy
const PORT = 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
  logger.info(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`KH-VN Exchange Bot server listening on http://0.0.0.0:${PORT}`);

  // 1. Initialize persistent system config from database
  RuntimeConfigService.init().catch((err) => {
    logger.warn({ error: err?.message }, "RuntimeConfigService init warning");
  });

  // 2. Start automated backup scheduler if enabled
  BackupService.startScheduler();

  // 2b. Start the payment reminder / auto-cancel scheduler (DB-derived polling;
  // survives restarts because reminder state is re-derived from the database).
  startPaymentReminderScheduler();

  // 3. Bootstrap Unified Telegram Bot gracefully
  startSingleBot().catch((err) => {
    logger.warn({ err }, "Unified Telegram Bot startup error or token missing");
  });
});

// Graceful shutdown handlers
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, gracefully shutting down server and Telegram bot...");
  BackupService.stopScheduler();
  stopPaymentReminderScheduler();
  await stopSingleBot();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, gracefully shutting down server and Telegram bot...");
  BackupService.stopScheduler();
  stopPaymentReminderScheduler();
  await stopSingleBot();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

export { app };
