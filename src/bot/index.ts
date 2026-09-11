import { Bot } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { BotContext } from "./middleware/identity.js";
import { mainRouter } from "./router.js";
import { setBotInstance } from "./notifications.js";
import { PermissionService } from "../modules/permissions/permission-service.js";

let singleBot: Bot<BotContext> | null = null;
let runnerHandle: RunnerHandle | null = null;

// ---------------------------------------------------------------------------
// Per-user sequentialization (safe concurrency contract)
//
// The runner processes DIFFERENT users concurrently, but updates that can
// touch the same user-keyed mutable state are chained through a per-user
// promise queue. ALL session state in this codebase is keyed by Telegram
// from.id (admin-session.ts, customer payout sessions, staff-chat-session),
// and the SAME user may act from several chats (private bot chat + the admin
// notification group), so the primary key is from.id — not chat.id:
//  - a user's multi-step wizard / session callbacks stay strictly ordered,
//  - two different users never block each other,
//  - updates WITHOUT a `from` (e.g. channel posts) fall back to chat.id.
// Queue entries self-clean when idle so the Map cannot grow unbounded.
// ---------------------------------------------------------------------------
const chatQueues = new Map<string, Promise<void>>();

async function chatSequentializeMiddleware(ctx: BotContext, next: () => Promise<void>): Promise<void> {
  const fromId = ctx.from?.id;
  const key =
    fromId != null
      ? `u:${fromId}`
      : `c:${ctx.chat?.id ?? "no-chat"}`;
  const previous = chatQueues.get(key) ?? Promise.resolve();
  const current = previous.then(next, next);
  chatQueues.set(key, current);
  const cleanup = (): void => {
    if (chatQueues.get(key) === current) chatQueues.delete(key);
  };
  try {
    await current;
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Update timing diagnostics (NO message/bank content is ever logged)
// ---------------------------------------------------------------------------
async function timingMiddleware(ctx: BotContext, next: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    await next();
  } finally {
    const totalMs = Date.now() - startedAt;
    const update = ctx.update as any;
    const kind = update?.callback_query
      ? "callback_query"
      : update?.message?.photo
        ? "photo"
        : update?.message?.document
          ? "document"
          : update?.message?.voice
            ? "voice"
            : update?.message?.text
              ? "text"
              : "other";
    logger.info(
      {
        updateType: kind,
        telegramId: ctx.from?.id ? String(ctx.from.id) : undefined,
        chatType: ctx.chat?.type,
        totalMs,
        slow: totalMs > 3000
      },
      "update:timing"
    );
  }
}

export function createSingleBot(): Bot<BotContext> | null {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.info("TELEGRAM_BOT_TOKEN not provided; Single Bot running in standby mode.");
    setBotInstance(null);
    return null;
  }

  const bot = new Bot<BotContext>(token);

  // 1. Update timing diagnostics (outermost, no content logged)
  bot.use(timingMiddleware);
  // 2. Same-chat sequentialization (runner concurrency safety, see above)
  bot.use(chatSequentializeMiddleware);
  // 3. Main router
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

  logger.info("Starting Unified Telegram Bot (@grammyjs/runner, per-user sequentialized)...");
  // @grammyjs/runner keeps long polling responsive and processes DIFFERENT
  // chats concurrently; same-chat ordering is enforced by the middleware above.
  // This prevents one slow AI/file operation from stalling unrelated updates
  // (the previous bot.start() processed ALL updates strictly sequentially).
  runnerHandle = run(bot);
  const botInfo = await bot.api.getMe();
  // grammY only sets botInfo inside bot.start()/init(); the runner path does
  // not. Set it explicitly so ctx.me and runtime deep links (t.me/<username>)
  // work without any new env requirements.
  bot.botInfo = botInfo;
  logger.info(
    { username: botInfo.username, id: botInfo.id, concurrency: "per-user-sequentialized" },
    "Unified Telegram Bot started successfully with @grammyjs/runner"
  );
}

export async function stopSingleBot(): Promise<void> {
  if (runnerHandle) {
    try {
      await runnerHandle.stop();
      logger.info("Telegram Bot runner stopped");
    } catch (err: any) {
      logger.warn({ err: err.message }, "Error stopping Telegram Bot runner");
    } finally {
      runnerHandle = null;
    }
    // The runner owned polling; bot.stop() would reject for a bot that was
    // never started via bot.start() — drop the reference instead.
    singleBot = null;
    return;
  }
  if (singleBot) {
    try {
      await singleBot.stop();
      logger.info("Unified Telegram Bot stopped");
    } catch (err: any) {
      logger.warn({ err: err.message }, "Error stopping Single Bot");
    }
  }
}
