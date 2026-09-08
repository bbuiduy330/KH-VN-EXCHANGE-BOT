import express from "express";
import { env } from "./config/env.js";
import { logger } from "./shared/logger.js";
import { LocalStorageService } from "./modules/storage/local-storage-service.js";
import { startSingleBot, stopSingleBot } from "./bot/index.js";
import { prisma } from "./database/client.js";
import { RuntimeConfigService } from "./modules/system-config/runtime-config-service.js";
import { BackupService } from "./modules/backup/backup-service.js";

const app = express();
app.use(express.json());

// Sole public endpoint for V1: GET /health
// No public administrative, diagnostic outbound, financial, or order routes are exposed over HTTP.
// Telegram Bot is the sole operational interface with RBAC.
app.get("/health", async (_req, res) => {
  let dbStatus = "ok";
  const hasDbUrl = Boolean(process.env.DATABASE_URL || env.DATABASE_URL);

  if (!hasDbUrl) {
    dbStatus = "not_configured";
  } else {
    try {
      if (typeof (prisma as any).$queryRaw === "function") {
        await (prisma as any).$queryRaw`SELECT 1`;
      }
    } catch {
      dbStatus = "degraded";
    }
  }

  const storageHealth = await LocalStorageService.checkStorageHealth();
  const storageStatus = storageHealth.writable ? "ok" : "degraded";
  const botStatus = Boolean(env.TELEGRAM_BOT_TOKEN) ? "configured" : "not_configured";
  const backupStatus = RuntimeConfigService.isBackupEnabled() ? "enabled" : "disabled";

  const isHealthy = (dbStatus === "ok" || dbStatus === "not_configured") && storageStatus === "ok";
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

  // 3. Bootstrap Unified Telegram Bot gracefully
  startSingleBot().catch((err) => {
    logger.warn({ err }, "Unified Telegram Bot startup error or token missing");
  });
});

// Graceful shutdown handlers
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, gracefully shutting down server and Telegram bot...");
  BackupService.stopScheduler();
  await stopSingleBot();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, gracefully shutting down server and Telegram bot...");
  BackupService.stopScheduler();
  await stopSingleBot();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

export { app };
