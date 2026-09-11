/**
 * Payment reminder + auto-cancel scheduler (requirements C, D, K).
 *
 * ARCHITECTURE:
 * - Quote expiry (10 minutes) is a SEPARATE concept and is NOT touched here.
 * - This is a database-derived polling scheduler, NOT per-Order setTimeout.
 *   Every tick queries the authoritative DB for orders still WAITING_PAYMENT,
 *   so reminders survive container/process restarts automatically and no
 *   in-memory reminder counter can be lost.
 * - The reminder index is derived from the PERSISTED AuditLog
 *   (action = PAYMENT_REMINDER_SENT, targetType = ORDER, targetId = orderId).
 *   Writing the audit marker right after sending prevents duplicate reminder
 *   spam when the process restarts between ticks (requirement K).
 * - Every reminder/auto-cancel reloads the authoritative Order first and asks
 *   the centralized rules (OrderService.isOrderPaymentReminderEligible /
 *   isOrderSafelyAutoCancellable) whether the action is still valid.
 */

import { prisma } from "../../database/client.js";
import { logger } from "../../shared/logger.js";
import { InlineKeyboard } from "grammy";
import { OrderService } from "./order-service.js";
// Namespace import so tests can spy on send/notification functions.
import * as notifications from "../../bot/notifications.js";
import { resolveLocale, t } from "../i18n/locales.js";
import { MoneyService } from "../money/money-service.js";

/** Reminder schedule (minutes after order creation): +10/+20/+30/+40. */
export const REMINDER_OFFSETS_MIN = [10, 20, 30, 40];
/** Final timeout: auto-cancel at +50 minutes. */
export const AUTO_CANCEL_MIN = 50;
/** Polling interval for the DB-derived scheduler. */
export const POLL_INTERVAL_MS = 60 * 1000;

export interface ReminderDecision {
  /** 1-based reminder number due now, or null. */
  dueReminder: number | null;
  autoCancelDue: boolean;
  ageMinutes: number;
  remindersSent: number;
}

/**
 * Pure decision helper (authoritative state must be reloaded by the caller).
 * `remindersSent` comes from the persisted AuditLog, `now` is injectable for
 * deterministic tests.
 */
export function computeReminderState(
  order: { createdAt: Date | string },
  remindersSent: number,
  now: Date = new Date()
): ReminderDecision {
  const created = new Date(order.createdAt).getTime();
  const ageMinutes = Math.max(0, (now.getTime() - created) / 60000);

  // Auto-cancel takes precedence: at/after the final timeout the order must be
  // cancelled, not reminded again — even if earlier reminders were missed
  // (e.g. after a long downtime).
  if (ageMinutes >= AUTO_CANCEL_MIN) {
    return { dueReminder: null, autoCancelDue: true, ageMinutes, remindersSent };
  }

  const nextOffset = REMINDER_OFFSETS_MIN[remindersSent];
  if (remindersSent < REMINDER_OFFSETS_MIN.length && nextOffset !== undefined && ageMinutes >= nextOffset) {
    return { dueReminder: remindersSent + 1, autoCancelDue: false, ageMinutes, remindersSent };
  }
  return { dueReminder: null, autoCancelDue: false, ageMinutes, remindersSent };
}

/** Localized reminder text with pay/send-bill instruction + action buttons. */
export function renderPaymentReminderMessage(order: any, reminderNumber: number): {
  text: string;
  kb: InlineKeyboard;
} {
  const locale = resolveLocale(order.customer?.language);
  const amount = `${MoneyService.formatAmount(order.sourceAmount, order.sourceCurrency)} ${order.sourceCurrency}`;
  const text =
    `${t(locale, "reminder.title", { number: String(reminderNumber) })}\n\n` +
    `${t(locale, "order.id", { id: order.id })}\n` +
    `${t(locale, "order.transfer_amount", { amount, currency: order.sourceCurrency })}\n\n` +
    `${t(locale, "reminder.pay_now")}\n` +
    `${t(locale, "reminder.transferred_hint")}\n\n` +
    `${t(locale, "reminder.deadline")}`;

  const kb = new InlineKeyboard()
    .text(t(locale, "order.bill_btn"), `customer:bill:upload:${order.id}`)
    .text(t(locale, "menu.support"), "customer:menu:support")
    .row()
    .text(t(locale, "order.cancel_btn"), `customer:order:cancel:${order.id}`);
  return { text, kb };
}

/** Send reminder N for one order. Returns true when the reminder was sent. */
async function sendReminder(order: any, reminderNumber: number): Promise<boolean> {
  const telegramId = order.customer?.telegramId ? String(order.customer.telegramId) : "";
  if (!telegramId) {
    logger.warn({ orderId: order.id }, "payment reminder skipped: customer has no telegramId");
    return false;
  }

  const { text, kb } = renderPaymentReminderMessage(order, reminderNumber);
  const sent = await notifications.sendToCustomer(telegramId, text, { parse_mode: "HTML", reply_markup: kb });
  if (!sent) return false;

  // Persist the marker AFTER a successful send, so a Telegram failure can be
  // retried on the next tick while a process restart between two ticks can
  // never duplicate an already-sent reminder.
  try {
    await prisma.auditLog.create({
      data: {
        actorId: "SYSTEM_SCHEDULER",
        actorRole: "SYSTEM",
        action: "PAYMENT_REMINDER_SENT",
        targetType: "ORDER",
        targetId: order.id,
        details: { reminderNumber, sentAt: new Date().toISOString() }
      }
    });
  } catch (err: any) {
    // Without the persisted marker the next tick could re-send; log loudly.
    logger.error({ err: err?.message, orderId: order.id }, "FAILED to persist PAYMENT_REMINDER_SENT marker");
  }

  // NOTE (financial-safety audit): NO Admin Telegram notification here. The
  // reminder marker is persisted in AuditLog for idempotency and the customer
  // receives the reminder; Admin is notified only for meaningful events
  // (cancellations, auto-cancel at timeout, late bill, abnormal situations) —
  // not four times per normal unpaid order.
  return true;
}

async function autoCancel(order: any, remindersSent: number): Promise<void> {
  const result = await OrderService.cancelOrderForPaymentTimeout(order.id);
  if (!result.cancelled) {
    logger.info({ orderId: order.id, reason: (result as any).reason }, "auto-cancel skipped (not eligible anymore)");
    return;
  }
  const locale = resolveLocale(order.customer?.language);
  await notifications.sendToCustomer(
    String(order.customer?.telegramId || ""),
    `${t(locale, "autocancel.customer_title")}\n\n` +
      `${t(locale, "order.id", { id: order.id })}\n` +
      t(locale, "autocancel.customer_body"),
    { parse_mode: "HTML" }
  ).catch(() => {});
  await notifications.notifyOrderAutoCancelled(order, remindersSent);
}

/**
 * One scheduler tick. Finds eligible orders from the DB, reloads the
 * authoritative row for each, then sends the due reminder or auto-cancels.
 */
export async function tickPaymentReminders(now: Date = new Date()): Promise<{ checked: number; reminders: number; autoCancelled: number }> {
  let reminders = 0;
  let autoCancelled = 0;

  // Cheap DB pre-filter: only orders that could be at least at reminder 1.
  const firstOffset = REMINDER_OFFSETS_MIN[0] ?? 10;
  const cutoff = new Date(now.getTime() - firstOffset * 60000);
  const candidates = await prisma.order.findMany({
    where: { status: "WAITING_PAYMENT", createdAt: { lte: cutoff } },
    include: { customer: true },
    orderBy: { createdAt: "asc" },
    take: 100
  });

  for (const stale of candidates) {
    try {
      // 1. Always reload the authoritative order before deciding/sending.
      const order = await OrderService.getOrder(stale.id);
      if (!order) continue;

      // 2. Centralized eligibility — stops immediately when a bill arrived,
      //    payment was confirmed, the order was cancelled/completed, or the
      //    order entered manual review.
      if (!OrderService.isOrderPaymentReminderEligible(order)) continue;

      // 3. Derive the reminder index from the persisted audit trail.
      const remindersSent = await OrderService.countPaymentReminders(order.id);
      const decision = computeReminderState(order, remindersSent, now);

      if (decision.autoCancelDue) {
        if (OrderService.isOrderSafelyAutoCancellable(order)) {
          await autoCancel(order, remindersSent);
          autoCancelled++;
        }
        continue;
      }

      if (decision.dueReminder) {
        const sent = await sendReminder(order, decision.dueReminder);
        if (sent) reminders++;
      }
    } catch (err: any) {
      logger.warn({ err: err?.message, orderId: stale.id }, "payment reminder tick error for order");
    }
  }

  return { checked: candidates.length, reminders, autoCancelled };
}

let schedulerTimer: NodeJS.Timeout | null = null;
let tickRunning = false;

/** Start the polling scheduler (idempotent). */
export function startPaymentReminderScheduler(): void {
  if (schedulerTimer) return;
  logger.info(
    { offsetsMin: REMINDER_OFFSETS_MIN, autoCancelMin: AUTO_CANCEL_MIN, intervalMs: POLL_INTERVAL_MS },
    "Payment reminder scheduler started"
  );
  schedulerTimer = setInterval(() => {
    if (tickRunning) return; // never overlap ticks
    tickRunning = true;
    tickPaymentReminders()
      .catch((err) => logger.warn({ err: err?.message }, "payment reminder tick failed"))
      .finally(() => {
        tickRunning = false;
      });
  }, POLL_INTERVAL_MS);
  // Never keep the process alive just for the scheduler.
  schedulerTimer.unref?.();
}

export function stopPaymentReminderScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    logger.info("Payment reminder scheduler stopped");
  }
}