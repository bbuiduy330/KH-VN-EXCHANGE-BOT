import { Bot } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { BotContext } from "./middleware/identity.js";
import { mainRouter } from "./router.js";
import { setBotInstance } from "./notifications.js";
import { PermissionService } from "../modules/permissions/permission-service.js";

let singleBot: Bot<BotContext> | null = null;

export function createSingleBot(): Bot<BotContext> | null {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.info("TELEGRAM_BOT_TOKEN not provided; Single Bot running in standby mode.");
    setBotInstance(null);
    return null;
  }

  const bot = new Bot<BotContext>(token);

  // Attach main router
  bot.use(mainRouter);

  // Error handling
  bot.catch((err) => {
    logger.error({ err: err.message, ctx: err.ctx?.update }, "Unhandled error in Single Telegram Bot");
  });

  singleBot = bot;
  setBotInstance(bot);
  return bot;
}

export async function startSingleBot(): Promise<void> {
  // Bootstrap Super Admin idempotently
  try {
    await PermissionService.bootstrapSuperAdmin();
  } catch (err: any) {
    logger.warn({ err: err.message }, "Error bootstrapping Super Admin");
  }

  const bot = createSingleBot();
  if (!bot) return;

  logger.info("Starting Unified Telegram Bot...");
  bot.start({
    onStart: (botInfo) => {
      logger.info({ username: botInfo.username, id: botInfo.id }, "Unified Telegram Bot started successfully");
    }
  });
}

export async function stopSingleBot(): Promise<void> {
  if (singleBot) {
    try {
      await singleBot.stop();
      logger.info("Unified Telegram Bot stopped");
    } catch (err: any) {
      logger.warn({ err: err.message }, "Error stopping Single Bot");
    }
  }
}
