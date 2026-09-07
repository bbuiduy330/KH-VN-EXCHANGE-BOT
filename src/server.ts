import express from "express";
import { env } from "./config/env.js";
import { logger } from "./shared/logger.js";
import { LocalStorageService } from "./modules/storage/local-storage-service.js";
import { startSingleBot, stopSingleBot } from "./bot/index.js";
import { prisma } from "./database/client.js";

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

  res.json({
    status: "ok",
    database: dbStatus,
    storage: {
      configured: storageHealth.configured,
      writable: storageHealth.writable
    },
    integrations: {
      gemini: Boolean(env.GEMINI_API_KEY),
      telegramBot: Boolean(env.TELEGRAM_BOT_TOKEN)
    }
  });
});

// Start HTTP server
const PORT = env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
  logger.info(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`KH-VN Exchange Bot server listening on http://0.0.0.0:${PORT}`);

  // Bootstrap Unified Telegram Bot gracefully
  startSingleBot().catch((err) => {
    logger.warn({ err }, "Unified Telegram Bot startup error or token missing");
  });
});

// Graceful shutdown handlers
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, gracefully shutting down server and Telegram bot...");
  await stopSingleBot();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, gracefully shutting down server and Telegram bot...");
  await stopSingleBot();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

export { app };
