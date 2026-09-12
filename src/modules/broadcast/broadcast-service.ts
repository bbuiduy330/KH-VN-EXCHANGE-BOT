/**
 * Broadcast / customer outreach (Part C) — service layer.
 *
 * SAFETY RULES:
 *  - Audience is SNAPSHOTTED into BroadcastRecipient rows BEFORE sending
 *    (unique campaignId+customerId) so the target can never change midway.
 *  - NO mass-send without a separate explicit Admin confirm; preview and
 *    "send test to Admin" NEVER touch recipients.
 *  - Durable DB queue (BroadcastRecipient PENDING rows) processed in small
 *    batches by a background scheduler — restart-safe, no in-memory queue.
 *  - Telegram BLOCKED/unreachable ⇒ recipient BLOCKED + Customer.telegramReachable
 *    = false. Transient (429 retry_after) ⇒ conservative retry, capped.
 *  - Marketing opt-out suppresses ONLY broadcasts — never order/payment/payout/
 *    support/security notifications (those never go through this module).
 *  - Content is 100% Admin-authored; AI never writes financial rates here.
 *    (Rate prefill, if used, reads the authoritative rate service only.)
 */
import { getBotInstance } from "../../bot/notifications.js";
import { AuditService } from "../audit/audit-service.js";
import { logger } from "../../shared/logger.js";

export type BroadcastAudienceType = "ALL" | "FILTER" | "LIST" | "ONE_CUSTOMER";

export interface BroadcastAudienceFilter {
  locale?: "vi" | "en" | "km" | "zh" | null;
  hasCompletedOrder?: boolean;
  directionUsdToVnd?: boolean;
  directionVndToUsd?: boolean;
  activity?: "LAST_7D" | "LAST_30D" | "LAST_90D" | "INACTIVE_30D" | null;
  /** Exclude customers with any SUSPICIOUS order (transparent signal). */
  excludeRisk?: boolean;
}

export interface BroadcastContent {
  text?: string;
  photoFileId?: string;
  caption?: string;
  /** Whitelisted CTA buttons (Đổi tiền ngay / Hỗ trợ). */
  cta?: boolean;
}

export const MAX_CONTENT_TEXT_LEN = 3500;
export const MAX_CONTENT_CAPTION_LEN = 900;
const MAX_SCAN_CUSTOMERS = 2000;
const MAX_RECIPIENTS = 1000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_SEC = 30;

/** Whitelisted CTA callbacks — ONLY existing customer routes are reusable. */
export const BROADCAST_CTA_BUTTONS = [
  { text: "💱 Đổi tiền ngay", callback: "customer:menu:quote" },
  { text: "💬 Hỗ trợ", callback: "customer:menu:support" }
];

// ---------------------------------------------------------------------------
// Transport (Telegram delivery) — injectable for deterministic tests; default
// implementation resolves the live bot instance at call time.
// ---------------------------------------------------------------------------
export interface BroadcastTransport {
  sendMessage(chatId: string, html: string, buttons?: { text: string; callback: string }[]): Promise<void>;
  sendPhoto(chatId: string, fileId: string, caption: string, buttons?: { text: string; callback: string }[]): Promise<void>;
}

let transportOverride: BroadcastTransport | null = null;

export function setBroadcastTransport(t: BroadcastTransport | null): void {
  transportOverride = t;
}

async function buildInline(buttons: { text: string; callback: string }[]): Promise<any> {
  const { InlineKeyboard } = await import("grammy");
  const kb = new InlineKeyboard();
  for (const b of buttons) kb.text(b.text, b.callback).row();
  return kb;
}

function getTransport(): BroadcastTransport {
  if (transportOverride) return transportOverride;
  const bot = getBotInstance();
  if (!bot) throw new Error("bot_not_ready");
  return {
    async sendMessage(chatId, html, buttons) {
      await bot.api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        ...(buttons && buttons.length > 0 ? { reply_markup: await buildInline(buttons) } : {})
      });
    },
    async sendPhoto(chatId, fileId, caption, buttons) {
      await bot.api.sendPhoto(chatId, fileId, {
        caption,
        parse_mode: "HTML",
        ...(buttons && buttons.length > 0 ? { reply_markup: await buildInline(buttons) } : {})
      });
    }
  };
}

/** Build the exact rendered message (HTML) — shared by test-send and delivery. */
export function renderBroadcastText(content: BroadcastContent): string {
  return String(content?.text || content?.caption || "").slice(0, MAX_CONTENT_TEXT_LEN);
}

// ---------------------------------------------------------------------------
// Audience eligibility (C2/C3) — deterministic and pure where possible.
// NOTE: filtering runs on a bounded customer scan + narrow order projection
// (deterministic with the DB layer used by tests; MVP-scale volumes).
// ---------------------------------------------------------------------------
export function isBroadcastEligible(customer: any): boolean {
  if (!customer) return false;
  const tg = String(customer.telegramId ?? "").trim();
  if (!tg || !/^\d{4,20}$/.test(tg)) return false; // valid numeric Telegram ID only
  if (customer.marketingEnabled === false) return false;
  if (customer.telegramReachable === false) return false;
  return true;
}

const ACTIVITY_WINDOW_DAYS: Record<string, number> = {
  LAST_7D: 7,
  LAST_30D: 30,
  LAST_90D: 90
};

export function matchesAudienceFilter(
  customer: any,
  orders: { status: string; sourceCurrency: string; createdAt: Date | string }[],
  filter: BroadcastAudienceFilter | null | undefined,
  now: Date = new Date()
): boolean {
  if (!customer) return false;
  const f = filter || {};
  if (f.locale && String(customer.language || "").toLowerCase() !== String(f.locale).toLowerCase()) return false;

  const hasCompleted = (orders || []).some((o) => o.status === "COMPLETED");
  if (f.hasCompletedOrder && !hasCompleted) return false;
  if (f.directionUsdToVnd && !(orders || []).some((o) => o.status === "COMPLETED" && o.sourceCurrency === "USD")) return false;
  if (f.directionVndToUsd && !(orders || []).some((o) => o.status === "COMPLETED" && o.sourceCurrency === "VND")) return false;
  if (f.excludeRisk && (orders || []).some((o) => o.status === "SUSPICIOUS")) return false;

  if (f.activity) {
    if (f.activity === "INACTIVE_30D") {
      const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      if ((orders || []).some((o) => new Date(o.createdAt) >= cutoff)) return false;
    } else {
      const days = ACTIVITY_WINDOW_DAYS[f.activity];
      const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      if (!(orders || []).some((o) => new Date(o.createdAt) >= cutoff)) return false;
    }
  }
  return true;
}

/**
 * Eligible customers (bounded). When `customerIds` is provided the result is
 * intersected with that list — the LIST/ONE_CUSTOMER audiences never invent
 * targets, and uploaded Telegram-ID lists are NOT accepted (C2).
 */
export async function getEligibleCustomers(
  filter: BroadcastAudienceFilter | null | undefined,
  customerIds?: string[],
  limit: number = MAX_RECIPIENTS
): Promise<any[]> {
  const { prisma } = await import("../../database/client.js");
  const candidates = await prisma.customer.findMany({
    orderBy: { createdAt: "asc" },
    take: MAX_SCAN_CUSTOMERS
  });
  const base = candidates.filter((c: any) => isBroadcastEligible(c));
  const restricted = Array.isArray(customerIds) && customerIds.length > 0;
  if (!restricted && base.length === 0) return [];

  const wanted = restricted ? new Set(customerIds!.map(String)) : null;
  const pool = wanted ? base.filter((c: any) => wanted.has(String(c.id))) : base;
  if (pool.length === 0) return [];

  const needsOrders =
    !!filter && Boolean(
      filter.hasCompletedOrder || filter.directionUsdToVnd || filter.directionVndToUsd ||
      filter.activity || filter.excludeRisk
    );
  const filtered: any[] = [];
  if (!needsOrders) {
    filtered.push(...pool);
  } else {
    const ids = pool.map((c: any) => c.id);
    const orders = await prisma.order.findMany({
      where: { customerId: { in: ids } },
      select: { customerId: true, status: true, sourceCurrency: true, createdAt: true }
    });
    const byCustomer = new Map<string, any[]>();
    for (const o of orders as any[]) {
      const list = byCustomer.get(o.customerId) || [];
      list.push(o);
      byCustomer.set(o.customerId, list);
    }
    for (const c of pool) {
      if (matchesAudienceFilter(c, byCustomer.get(c.id) || [], filter)) filtered.push(c);
    }
  }
  return filtered.slice(0, limit);
}

export async function countEligible(
  audienceType: BroadcastAudienceType,
  filter: BroadcastAudienceFilter | null | undefined,
  customerIds?: string[]
): Promise<number> {
  const ids = audienceType === "ONE_CUSTOMER" || audienceType === "LIST" ? customerIds : undefined;
  const list = await getEligibleCustomers(audienceType === "ALL" || audienceType === "FILTER" ? filter : null, ids);
  return list.length;
}


// ---------------------------------------------------------------------------
// Campaign lifecycle
// ---------------------------------------------------------------------------
function validateContent(content: BroadcastContent): void {
  const text = String(content?.text || "");
  const caption = String(content?.caption || "");
  if (!text && !content?.photoFileId) {
    throw new Error("Nội dung trống — cần text hoặc ảnh.");
  }
  if (text.length > MAX_CONTENT_TEXT_LEN) throw new Error(`Nội dung quá dài (tối đa ${MAX_CONTENT_TEXT_LEN} ký tự).`);
  if (caption.length > MAX_CONTENT_CAPTION_LEN) throw new Error(`Caption quá dài (tối đa ${MAX_CONTENT_CAPTION_LEN} ký tự).`);
}

export async function createCampaign(params: {
  createdByTelegramId: string;
  audienceType: BroadcastAudienceType;
  audienceFilter?: BroadcastAudienceFilter | null;
  customerIds?: string[];
  content: BroadcastContent;
  title?: string;
}): Promise<any> {
  const { prisma } = await import("../../database/client.js");
  validateContent(params.content);
  if (!["ALL", "FILTER", "LIST", "ONE_CUSTOMER"].includes(params.audienceType)) {
    throw new Error("Nhóm khách không hợp lệ.");
  }
  if (params.audienceType === "ONE_CUSTOMER" && (!params.customerIds || params.customerIds.length !== 1)) {
    throw new Error("Cần đúng 1 khách cho chế độ Gửi 1 khách.");
  }
  const campaign = await prisma.broadcastCampaign.create({
    data: {
      title: params.title?.trim() || null,
      createdByTelegramId: params.createdByTelegramId,
      status: "DRAFT",
      audienceType: params.audienceType,
      audienceFilter: {
        ...(params.audienceFilter || {}),
        // Snapshot the intended targets for LIST/ONE_CUSTOMER audiences:
        ...(params.customerIds && params.customerIds.length > 0 ? { customerIds: params.customerIds } : {})
      },
      content: params.content
    }
  });
  await AuditService.log({
    actorId: params.createdByTelegramId,
    actorRole: "ADMIN",
    action: "BROADCAST_CAMPAIGN_CREATED",
    targetType: "BROADCAST_CAMPAIGN",
    targetId: campaign.id,
    details: { audienceType: params.audienceType }
  });
  return campaign;
}


/**
 * Confirm: snapshot the audience into BroadcastRecipient rows BEFORE sending,
 * dedupe by customerId (unique campaignId+customerId) and mark READY. The
 * snapshot is immutable afterwards — audience changes never affect a
 * confirmed campaign.
 */
export async function confirmCampaign(createdByTelegramId: string, campaignId: string): Promise<{ campaign: any; totalRecipients: number }> {
  const { prisma } = await import("../../database/client.js");
  const campaign: any = await prisma.broadcastCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error("Không tìm thấy chiến dịch.");
  if (campaign.status !== "DRAFT") throw new Error("Chiến dịch không ở trạng thái DRAFT.");
  if (String(campaign.createdByTelegramId) !== String(createdByTelegramId)) {
    throw new Error("Chỉ Admin tạo chiến dịch mới có thể xác nhận.");
  }

  const targetIds =
    campaign.audienceType === "ONE_CUSTOMER" || campaign.audienceType === "LIST"
      ? (campaign.audienceFilter?.customerIds as string[] | undefined) ?? []
      : undefined;
  const eligible = await getEligibleCustomers(campaign.audienceFilter, targetIds);
  if (eligible.length === 0) {
    throw new Error("Không có khách nào đủ điều kiện nhận trong nhóm đã chọn.");
  }

  let total = 0;
  for (const c of eligible) {
    try {
      await prisma.broadcastRecipient.create({
        data: {
          campaignId: campaign.id,
          customerId: c.id,
          telegramId: String(c.telegramId),
          locale: c.language || null
        }
      });
      total++;
    } catch {
      // Duplicate (unique campaignId+customerId) — never send twice.
    }
  }
  if (total === 0) throw new Error("Không có người nhận nào sau khi loại trùng.");

  const confirmed = await prisma.broadcastCampaign.update({
    where: { id: campaign.id },
    data: {
      status: "READY",
      confirmedAt: new Date(),
      totalRecipients: total,
      // Snapshot the RESOLVED audience list for the campaign detail view:
      audienceFilter: {
        ...(campaign.audienceFilter || {}),
        customerIds: eligible.map((c: any) => c.id)
      }
    }
  });
  await AuditService.log({
    actorId: createdByTelegramId,
    actorRole: "ADMIN",
    action: "BROADCAST_CAMPAIGN_CONFIRMED",
    targetType: "BROADCAST_CAMPAIGN",
    targetId: campaign.id,
    details: { totalRecipients: total, audienceType: campaign.audienceType }
  });
  return { campaign: confirmed, totalRecipients: total };
}

/**
 * "Send test to Admin" — renders the EXACT content/buttons and sends ONLY to
 * the requesting Admin's Telegram chat. Never mutates the campaign/recipients.
 */
export async function sendTestToAdmin(adminTelegramId: string, content: BroadcastContent): Promise<void> {
  validateContent(content);
  const t = getTransport();
  const buttons = content.cta ? BROADCAST_CTA_BUTTONS : undefined;
  if (content.photoFileId) {
    await t.sendPhoto(adminTelegramId, content.photoFileId, `[GỬI THỬ] ${content.caption || ""}`.trim(), buttons);
  } else {
    await t.sendMessage(adminTelegramId, `[GỬI THỬ]\n\n${renderBroadcastText(content)}`, buttons);
  }
}

export async function listCampaigns(limit: number = 10): Promise<any[]> {
  const { prisma } = await import("../../database/client.js");
  return prisma.broadcastCampaign.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

export async function cancelCampaign(createdByTelegramId: string, campaignId: string): Promise<any> {
  const { prisma } = await import("../../database/client.js");
  const campaign: any = await prisma.broadcastCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error("Không tìm thấy chiến dịch.");
  if (!["DRAFT", "READY"].includes(campaign.status)) throw new Error("Chiến dịch đang gửi/đã xong — không thể hủy.");
  const updated = await prisma.broadcastCampaign.update({
    where: { id: campaignId },
    data: { status: "CANCELLED" }
  });
  await AuditService.log({
    actorId: createdByTelegramId,
    actorRole: "ADMIN",
    action: "BROADCAST_CAMPAIGN_CANCELLED",
    targetType: "BROADCAST_CAMPAIGN",
    targetId: campaignId,
    details: { totalRecipients: campaign.totalRecipients ?? 0 }
  });
  return updated;
}


// ---------------------------------------------------------------------------
// Durable delivery queue (C7/C8)
// ---------------------------------------------------------------------------
function parseRetryAfter(err: unknown): number | null {
  const e = err as { parameters?: { retry_after?: unknown }; message?: string };
  const p = e?.parameters?.retry_after;
  const n = typeof p === "number" ? p : typeof p === "string" ? parseFloat(p) : NaN;
  if (Number.isFinite(n) && n > 0) return Math.min(n, MAX_RETRY_WAIT_SEC);
  const m = /retry after (\d+)/i.exec(String(e?.message || ""));
  if (m) return Math.min(parseFloat(m[1]), MAX_RETRY_WAIT_SEC);
  return null;
}

function isBlockedError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || "");
  return /403|blocked|chat not found|deactivated/i.test(msg);
}

function sanitizeError(err: unknown): string {
  return String((err as { message?: string })?.message || "unknown error").slice(0, 200);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Process one campaign's PENDING recipients (small batches, never crashes). */
async function processCampaignRecipients(campaignId: string, batchSize: number): Promise<void> {
  const { prisma } = await import("../../database/client.js");
  const campaign: any = await prisma.broadcastCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.status !== "SENDING") return;
  const content: BroadcastContent = campaign.content || {};

  for (let batchGuard = 0; batchGuard < 200; batchGuard++) {
    const pending: any[] = await prisma.broadcastRecipient.findMany({
      where: { campaignId, status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: batchSize
    });
    if (pending.length === 0) break;

    for (const r of pending) {
      try {
        const t = getTransport();
        const buttons = content.cta ? BROADCAST_CTA_BUTTONS : undefined;
        if (content.photoFileId) {
          await t.sendPhoto(r.telegramId, content.photoFileId, content.caption || "", buttons);
        } else {
          await t.sendMessage(r.telegramId, renderBroadcastText(content), buttons);
        }
        await prisma.broadcastRecipient.update({
          where: { id: r.id },
          data: { status: "SENT", sentAt: new Date(), lastError: null }
        });
      } catch (err) {
        const retryAfter = parseRetryAfter(err);
        if (retryAfter !== null) {
          // Transient rate limit — conservative retry, recipient stays PENDING.
          logger.warn({ campaignId, attempts: (r.attempts || 0) + 1, retryAfter }, "Broadcast: rate-limited, will retry");
          await prisma.broadcastRecipient.update({
            where: { id: r.id },
            data: { attempts: (r.attempts || 0) + 1 }
          });
          await sleep(retryAfter * 1000);
          continue;
        }
        if (isBlockedError(err)) {
          await prisma.broadcastRecipient.update({
            where: { id: r.id },
            data: { status: "BLOCKED", attempts: (r.attempts || 0) + 1, lastError: sanitizeError(err) }
          });
          // Mark unreachable so future campaigns exclude this customer (C8).
          await prisma.customer.update({
            where: { id: r.customerId },
            data: { telegramReachable: false }
          }).catch(() => {});
          continue;
        }
        const attempts = (r.attempts || 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await prisma.broadcastRecipient.update({
            where: { id: r.id },
            data: { status: "FAILED", attempts, lastError: sanitizeError(err) }
          });
        } else {
          await prisma.broadcastRecipient.update({
            where: { id: r.id },
            data: { attempts }
          });
        }
      }
    }
  }


  // Recompute counts from the authoritative recipient rows and finalize.
  const recipients: any[] = await prisma.broadcastRecipient.findMany({ where: { campaignId } });
  const sent = recipients.filter((r) => r.status === "SENT").length;
  const failed = recipients.filter((r) => r.status === "FAILED").length;
  const blocked = recipients.filter((r) => r.status === "BLOCKED").length;
  const pendingLeft = recipients.filter((r) => r.status === "PENDING").length;

  await prisma.broadcastCampaign.update({
    where: { id: campaignId },
    data: {
      sentCount: sent,
      failedCount: failed,
      blockedCount: blocked,
      totalRecipients: recipients.length,
      ...(pendingLeft === 0 ? { status: "COMPLETED", completedAt: new Date() } : {})
    }
  });
  if (pendingLeft === 0) {
    await AuditService.log({
      actorId: campaign.createdByTelegramId,
      actorRole: "ADMIN",
      action: "BROADCAST_CAMPAIGN_COMPLETED",
      targetType: "BROADCAST_CAMPAIGN",
      targetId: campaignId,
      details: { sent, failed, blocked, total: recipients.length }
    });
  }
}


/**
 * Worker tick: claim the OLDEST READY campaign (snapshot already fixed) and
 * process its queue in small batches; resume a SENDING campaign that was
 * interrupted (restart-safe) once it is clearly stalled.
 */
export async function processPendingCampaigns(batchSize: number = 20): Promise<void> {
  const { prisma } = await import("../../database/client.js");
  const ready: any[] = await prisma.broadcastCampaign.findMany({
    where: { status: "READY" },
    orderBy: { createdAt: "asc" },
    take: 1
  });
  const stalled: any[] = await prisma.broadcastCampaign.findMany({
    where: { status: "SENDING", startedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } },
    orderBy: { startedAt: "asc" },
    take: 1
  });
  const next = ready[0] || stalled[0];
  if (!next) return;

  if (next.status === "READY") {
    const claimed = await prisma.broadcastCampaign.updateMany({
      where: { id: next.id, status: "READY" },
      data: { status: "SENDING", startedAt: new Date() }
    });
    if (claimed.count !== 1) return; // another run claimed it
    await AuditService.log({
      actorId: next.createdByTelegramId,
      actorRole: "ADMIN",
      action: "BROADCAST_SENDING_STARTED",
      targetType: "BROADCAST_CAMPAIGN",
      targetId: next.id,
      details: { totalRecipients: next.totalRecipients ?? 0 }
    });
  }
  try {
    await processCampaignRecipients(next.id, batchSize);
  } catch (err) {
    // One bad campaign/recipient must never crash the bot or the scheduler.
    logger.error({ err: (err as { message?: string })?.message, campaignId: next.id }, "Broadcast worker tick failed");
  }
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startBroadcastScheduler(intervalMs: number = 10_000): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    processPendingCampaigns().catch(() => {});
  }, intervalMs);
}

export function stopBroadcastScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

