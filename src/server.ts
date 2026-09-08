import express from "express";
import { env } from "./config/env.js";
import { logger } from "./shared/logger.js";
import { LocalStorageService } from "./modules/storage/local-storage-service.js";
import { startSingleBot, stopSingleBot } from "./bot/index.js";
import { prisma } from "./database/client.js";
import { AiProvider } from "./modules/ai/ai-provider.js";
import { SystemConfigService } from "./modules/system-config/system-config-service.js";
import { BackupService } from "./modules/backup/backup-service.js";

const app = express();
app.use(express.json());

// Sole public endpoint for V1: GET /health
// No public administrative, financial, rate-editing, or order routes are exposed over HTTP.
// Telegram Bot is the sole operational interface with RBAC.
app.get("/health", async (req, res) => {
  let dbStatus = "ok";
  try {
    if (typeof (prisma as any).$queryRaw === "function" && process.env.DATABASE_URL) {
      await (prisma as any).$queryRaw`SELECT 1`;
    }
  } catch {
    dbStatus = "degraded";
  }

  const storageHealth = await LocalStorageService.checkStorageHealth();
  const cfg = SystemConfigService.getConfig();

  res.json({
    status: "ok",
    database: dbStatus,
    storage: {
      configured: storageHealth.configured,
      writable: storageHealth.writable
    },
    integrations: {
      gemini: Boolean(SystemConfigService.getGeminiApiKey()),
      geminiModel: cfg.geminiTextModel,
      backupEnabled: cfg.backupEnabled,
      telegramBot: Boolean(env.TELEGRAM_BOT_TOKEN)
    }
  });
});

// Diagnostic endpoint: GET /health/gemini (performs real test call to Gemini API)
app.get("/health/gemini", async (req, res) => {
  const result = await AiProvider.testGeminiConnection();
  res.status(result.ok ? 200 : 503).json(result);
});

// Start HTTP server - Port 3000 is strictly required by the reverse proxy infrastructure
const PORT = 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
  logger.info(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`KH-VN Exchange Bot server listening on http://0.0.0.0:${PORT}`);

  // 1. Initialize persistent system config from storage
  SystemConfigService.init();

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
