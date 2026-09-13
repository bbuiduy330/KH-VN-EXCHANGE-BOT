/**
 * PART F — AUTOMATED INCOMING PAYMENT VERIFICATION (provider-neutral).
 *
 * CONFIRMS INCOMING PAYMENT ONLY. NEVER auto-payouts, auto-completes, or
 * auto-refunds; a customer bill is NEVER a payment confirmation. Payout
 * authority remains the existing manual Admin workflow.
 *
 * Pipeline (F3): verify provider authenticity → deduplicate (unique
 * provider+externalTransactionId) → match PaymentAccount → match Order by
 * FROZEN transferMemo → compare currency/amount/account with Decimal →
 * call the SAME authoritative service used for manual verification
 * (OrderService.confirmPaymentReceived). Mismatches route through the
 * existing authoritative transition (manualFinancialOverride →
 * PAYMENT_MISMATCH). No payment-state logic is duplicated in providers.
 *
 * PROVIDERS (F1/F7/F8):
 *  - BAKONG_OPEN_API: IMPLEMENTED (background reconciliation by KHQR MD5;
 *    requires Admin-configured base URL + encrypted API token; enabled only
 *    when both are configured).
 *  - SEPAY / APIPAY / ABA_PAYWAY: SCAFFOLDED + DISABLED — the actual
 *    webhook authentication contracts are not provable from this repo, and
 *    an unauthenticated webhook can NEVER confirm payment. Enabling requires
 *    the provider's real signature/auth contract to be implemented first.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../../database/client.js";
import { logger } from "../../shared/logger.js";
import { AuditService } from "../audit/audit-service.js";
import { SystemSecretService } from "../system-config/system-secret-service.js";
import { OrderService } from "../orders/order-service.js";
import { sendToAdminNotificationChat, sendToCustomer } from "../../bot/notifications.js";
import { shortOrderId } from "../../bot/admin/admin-panel.js";
import { escapeHtml } from "../../bot/menus/cskh-panel.js";
import { formatAdminDateTime } from "../../shared/app-time.js";

export type IncomingProvider = "BAKONG_OPEN_API" | "ABA_PAYWAY" | "SEPAY" | "APIPAY";

export interface IncomingProviderMeta {
  provider: IncomingProvider;
  /** True ONLY when the provider's authentication contract is implemented. */
  authImplemented: boolean;
  /** True when the adapter can actively confirm payments. */
  enabled: boolean;
  /** What is still missing before the adapter can be enabled. */
  missingContract: string;
}

export const INCOMING_PROVIDERS: Record<IncomingProvider, IncomingProviderMeta> = {
  BAKONG_OPEN_API: {
    provider: "BAKONG_OPEN_API",
    authImplemented: true, // per-MD5 lookup with Admin-configured Bearer token
    enabled: true, // activates ONLY per PaymentAccount + configured secret
    missingContract: ""
  },
  ABA_PAYWAY: {
    provider: "ABA_PAYWAY",
    authImplemented: false,
    enabled: false,
    missingContract:
      "Cần hợp đồng callback/hMAC + merchant credentials thực tế của ABA PayWay (không tự suy luận)."
  },
  SEPAY: {
    provider: "SEPAY",
    authImplemented: false,
    enabled: false,
    missingContract: "Chuỗi xác thực webhook chính thức của SePay (header/API key) chưa có trong nguồn."
  },
  APIPAY: {
    provider: "APIPAY",
    authImplemented: false,
    enabled: false,
    missingContract: "Chuỗi xác thực webhook chính thức của ApiPay (header/API key) chưa có trong nguồn."
  }
};

/** Secret key for the Bakong Open API token (encrypted system secret). */
export function bakongTokenSecretKey(): string {
  return "incoming_payment_bakong_token";
}

export interface NormalizedIncomingEvent {
  provider: IncomingProvider;
  externalTransactionId: string;
  accountNumber?: string | null;
  currency?: string | null;
  amount?: string | number | null;
  memo?: string | null;
  receivedAt?: Date;
  rawMetadata?: object;
}

// ---------------------------------------------------------------------------
// Deduplication + matching (F3/F4) — authoritative, idempotent, replay-safe
// ---------------------------------------------------------------------------

/** Record a normalized event. Duplicate ⇒ { duplicate: true } (no resend). */
export async function recordIncomingEvent(event: NormalizedIncomingEvent): Promise<{ event: any; duplicate: boolean }> {
  if (!event.externalTransactionId?.trim()) throw new Error("Thiếu externalTransactionId.");
  if (!INCOMING_PROVIDERS[event.provider]) throw new Error("Provider không hợp lệ.");
  const existing = await prisma.incomingPaymentEvent.findUnique({
    where: {
      provider_externalTransactionId: {
        provider: event.provider,
        externalTransactionId: event.externalTransactionId.trim()
      }
    }
  });
  if (existing) return { event: existing, duplicate: true };
  const created = await prisma.incomingPaymentEvent.create({
    data: {
      provider: event.provider,
      externalTransactionId: event.externalTransactionId.trim(),
      accountNumber: event.accountNumber ?? null,
      currency: event.currency ?? null,
      amount: event.amount != null ? new Decimal(String(event.amount)) : null,
      memo: event.memo ?? null,
      status: "RECEIVED",
      rawMetadata: event.rawMetadata ?? undefined,
      receivedAt: event.receivedAt ?? new Date()
    }
  });
  return { event: created, duplicate: false };
}


/**
 * F3/F4 — match ONE recorded event against the authoritative Order data and
 * apply the existing authoritative transitions. Never throws to the caller.
 */
export async function matchAndApplyIncomingEvent(eventId: string): Promise<void> {
  try {
    const event: any = await prisma.incomingPaymentEvent.findUnique({ where: { id: eventId } });
    if (!event || ["CONFIRMED", "MISMATCH", "IGNORED"].includes(event.status)) return;

    // 1. Match the Order by FROZEN transferMemo (incoming payment reference).
    const memo = String(event.memo ?? "").trim();
    const order = memo
      ? await prisma.order.findFirst({
          where: {
            transferMemo: memo,
            status: { in: ["WAITING_PAYMENT", "CUSTOMER_SENT_BILL", "WAITING_ADMIN_VERIFY"] }
          },
          include: { customer: true }
        })
      : null;
    if (!order) {
      await prisma.incomingPaymentEvent.update({ where: { id: event.id }, data: { status: "RECEIVED" } });
      return; // unmatched: stored for visibility, no Admin spam
    }
    await prisma.incomingPaymentEvent.update({
      where: { id: event.id },
      data: { matchedOrderId: order.id, status: "MATCHED" }
    });

    // 2. Account match (when the provider supplies the receiver account).
    const eventAccount = String(event.accountNumber ?? "").trim();
    if (eventAccount && order.receivingAccountId) {
      const account = await prisma.paymentAccount.findUnique({ where: { id: order.receivingAccountId } });
      if (account && String(account.accountNumber) !== eventAccount) {
        return mismatch(event, order, "Số tài khoản nhận không khớp");
      }
    }

    // 3. Currency match (case-insensitive against the frozen Order currency).
    if (event.currency && String(order.sourceCurrency).toUpperCase() !== String(event.currency).toUpperCase()) {
      return mismatch(event, order, "Đồng tiền không khớp");
    }

    // 4. Amount match: exact Decimal equality — 99 USD ≠ 100 USD.
    if (event.amount != null) {
      const expected = new Decimal(String(order.sourceAmount ?? 0));
      const received = new Decimal(String(event.amount));
      if (!expected.equals(received)) {
        return mismatch(event, order, `Số tiền không khớp (nhận ${received.toString()})`);
      }
    }

    // 5. All correct → the SAME authoritative verification service family.
    //    F3 FIX: a verified bank-provider event is authoritative incoming
    //    payment evidence — confirmation works from WAITING_PAYMENT and
    //    CUSTOMER_SENT_BILL too (no customer bill required), via the
    //    authoritative OrderService.confirmPaymentFromBankProvider (never a
    //    direct status write here). MANUAL_ADMIN semantics unchanged.
    let confirmed: any;
    try {
      confirmed = await OrderService.confirmPaymentFromBankProvider(
        order.id,
        event.provider,
        event.externalTransactionId
      );
    } catch (confirmErr: any) {
      if (String(confirmErr?.message || "").includes("BANK_CONFIRMED_REFUSED")) {
        // The Order reached a terminal/confirmed state in the meantime —
        // never reopen it; close this event as IGNORED (replay-safe).
        await prisma.incomingPaymentEvent.updateMany({
          where: { id: event.id, status: { in: ["RECEIVED", "MATCHED"] } },
          data: { status: "IGNORED" }
        }).catch(() => {});
        logger.warn(
          { eventId: event.id, orderId: order.id },
          "Incoming payment confirm refused by state machine — event IGNORED"
        );
        return;
      }
      throw confirmErr;
    }
    await prisma.incomingPaymentEvent.update({
      where: { id: event.id },
      data: { status: "CONFIRMED", verifiedAt: new Date() }
    });
    await AuditService.log({
      actorId: `INCOMING:${event.provider}`,
      actorRole: "SYSTEM",
      action: "INCOMING_PAYMENT_CONFIRMED",
      targetType: "ORDER",
      targetId: order.id,
      details: { externalTransactionId: event.externalTransactionId, provider: event.provider }
    });
    await notifyProviderEvent(event, confirmed ?? order, "✅ ĐÃ XÁC NHẬN TIỀN VÀO");
    // Customer continues DIRECTLY into the normal post-payment flow — no
    // "upload a bill" instruction (the bank confirmation replaced it).
    const customer = confirmed?.customer || order.customer;
    if (customer?.telegramId) {
      const { resolveLocale, t } = await import("../i18n/locales.js");
      await sendToCustomer(
        String(customer.telegramId),
        t(resolveLocale(customer.language), "order.status_reply_payout_info", { id: order.id }),
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, eventId }, "Incoming payment matching failed (event kept for retry)");
    await prisma.incomingPaymentEvent.updateMany({
      where: { id: eventId, status: { in: ["RECEIVED", "MATCHED"] } },
      data: { status: "FAILED" }
    }).catch(() => {});
  }
}


/** F4 — mismatch routing via the EXISTING authoritative transition. */
async function mismatch(event: any, order: any, reason: string): Promise<void> {
  try {
    await OrderService.manualFinancialOverride({
      orderId: order.id,
      actorId: `INCOMING:${event.provider}`,
      actorRole: "SYSTEM",
      targetStatus: "PAYMENT_MISMATCH",
      reason: `Tự động xác minh tiền vào: ${reason} (ref ${event.externalTransactionId})`
    });
  } catch (err: any) {
    // The state machine may refuse — never force a transition here.
    logger.warn({ err: err?.message, orderId: order.id }, "Incoming payment mismatch routing refused");
  }
  await prisma.incomingPaymentEvent.update({
    where: { id: event.id },
    data: { status: "MISMATCH" }
  }).catch(() => {});
  await AuditService.log({
    actorId: `INCOMING:${event.provider}`,
    actorRole: "SYSTEM",
    action: "INCOMING_PAYMENT_MISMATCH",
    targetType: "ORDER",
    targetId: order.id,
    details: { reason, externalTransactionId: event.externalTransactionId }
  });
  await notifyProviderEvent(event, order, "⚠️ GIAO DỊCH CẦN KIỂM TRA", reason);
}

/** F10 — Admin notification (no secrets, no raw webhook payload). */
async function notifyProviderEvent(event: any, order: any, title: string, reason?: string): Promise<void> {
  const customer = order.customer;
  const lines = [
    title,
    `📦 Đơn: <b>${shortOrderId(order.id)}</b>`,
    customer ? `👤 Khách: ${escapeHtml(customer.fullName || customer.username || "—")}${customer.telegramId ? ` · TG <code>${escapeHtml(customer.telegramId)}</code>` : ""}` : "",
    `💱 Kỳ vọng: <b>${Number(order.sourceAmount)} ${order.sourceCurrency}</b>`,
    `💱 Nhận: <b>${event.amount != null ? Number(event.amount) : "—"} ${event.currency ?? order.sourceCurrency}</b>`,
    `🏦 Provider: <b>${escapeHtml(event.provider)}</b>`,
    `🔖 Ref: <code>${escapeHtml(String(event.externalTransactionId).slice(0, 40))}</code>`,
    reason ? `⚠️ Lý do: ${escapeHtml(reason)}` : "",
    "",
    "<i>Payout vẫn do Admin thực hiện thủ công như hiện tại.</i>"
  ];
  const { InlineKeyboard } = await import("grammy");
  const kb = new InlineKeyboard().text("📦 Mở giao dịch", `ops:order:detail:${order.id}`);
  await sendToAdminNotificationChat(lines.filter(Boolean).join("\n"), { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
}


// ---------------------------------------------------------------------------
// PART 7 — Provider base URL safety (SSRF guard)
// ---------------------------------------------------------------------------
/** Official Bakong Open API host (default allowlist entry). */
const BAKONG_DEFAULT_HOST = "api-bakong.nbc.gov.kh";

/**
 * Admin-controlled host allowlist (env override) + hard SSRF blocks.
 * localhost / private / link-local / metadata targets are ALWAYS refused.
 */
export function isAllowedVerificationBaseUrl(rawUrl: string): boolean {
  try {
    const url = new URL(String(rawUrl || ""));
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    // Hard blocks (never configurable):
    if (
      host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" ||
      host === "::1" || host === "[::1]" ||
      /^127\./.test(host) || /^10\./.test(host) ||
      /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    // Official provider host is always allowed:
    if (host === BAKONG_DEFAULT_HOST || host.endsWith(`.${BAKONG_DEFAULT_HOST}`)) return true;
    // Admin-controlled relay allowlist (exact hosts only):
    const extra = String(process.env.INCOMING_PAYMENT_ALLOWED_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    return extra.includes(host);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// F5/F6 — BAKONG_OPEN_API background reconciliation (USD/KHQR by MD5)
// ---------------------------------------------------------------------------
function sanitizeLookup(tx: any): { hash: string; amount: number | string; currency: string | null } | null {
  // Defensive parse of the Open API transaction payload — shapes vary; any
  // missing critical field means we NEVER confirm.
  const data = tx?.data ?? tx;
  if (!data || typeof data !== "object") return null;
  const t = Array.isArray(data) ? data[0] : data;
  const hash = String(t?.hash ?? t?.transactionHash ?? t?.externalRef ?? "").trim();
  const amount = t?.amount ?? t?.amountValue ?? null;
  const currency = t?.currency ?? null;
  if (!hash || amount == null) return null;
  return { hash, amount, currency: currency ? String(currency).toUpperCase() : null };
}

/**
 * Poll unresolved active KHQR Orders (khqrMd5 present) whose PaymentAccount
 * has BAKONG_OPEN_API configured. Reasonable frequency (scheduler), bounded
 * work per tick, stops naturally when Orders leave WAITING_PAYMENT.
 */
export async function reconcileBakongOrders(batchSize: number = 20): Promise<void> {
  const accounts: any[] = await prisma.paymentAccount.findMany({
    where: { verificationProvider: "BAKONG_OPEN_API", verificationBaseUrl: { not: null } }
  });
  if (accounts.length === 0) return;
  const baseUrlByBakong = new Map<string, string>();
  for (const a of accounts) {
    const bakongId = String(a.khqrBakongAccountId ?? "").trim();
    const base = String(a.verificationBaseUrl ?? "").trim().replace(/\/+$/, "");
    // PART 7 — SSRF guard enforced at fetch time too (defense in depth).
    if (!bakongId || !base || !isAllowedVerificationBaseUrl(base)) continue;
    baseUrlByBakong.set(bakongId, base);
  }
  if (baseUrlByBakong.size === 0) return;

  const token = await SystemSecretService.getSecret(bakongTokenSecretKey());
  if (!token) return; // no Admin-configured token → manual workflow stays

  // PART 3 — poll ALL pre-confirmation states where provider confirmation is
  // still useful. Stop states (CANCELLED / PAYMENT_CONFIRMED / WAITING_PAYOUT /
  // PAYOUT_SENT / COMPLETED / MISMATCH-review) are never polled.
  const orders: any[] = await prisma.order.findMany({
    where: {
      status: { in: ["WAITING_PAYMENT", "WAITING_ADMIN_VERIFY"] },
      khqrMd5: { not: null },
      createdAt: { gte: new Date(Date.now() - 24 * 3600_000) }
    },
    take: batchSize,
    orderBy: { createdAt: "asc" }
  });

  for (const order of orders) {
    const snap = (order.receivingAccountSnapshot || {}) as Record<string, unknown>;
    const bakongId = String(snap.khqrBakongAccountId ?? "").trim();
    const base = baseUrlByBakong.get(bakongId);
    const md5 = String(order.khqrMd5 ?? "").trim();
    if (!base || !md5) continue;
    try {
      const res = await fetch(`${base}/check_transaction_by_md5/${encodeURIComponent(md5)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        logger.warn({ status: res.status, orderRef: order.id.slice(-6) }, "Bakong reconciliation: lookup failed");
        continue;
      }
      const json: any = await res.json().catch(() => null);
      if (json?.status?.code !== 0) continue; // not found yet — keep polling
      const tx = sanitizeLookup(json);
      if (!tx) continue; // unknown shape — never confirm on unknown data
      const { event } = await recordIncomingEvent({
        provider: "BAKONG_OPEN_API",
        externalTransactionId: tx.hash,
        accountNumber: bakongId,
        currency: tx.currency,
        amount: String(tx.amount),
        memo: String(order.transferMemo ?? ""),
        rawMetadata: { source: "bakong_reconciliation", md5 }
      });
      if (!event) continue;
      await matchAndApplyIncomingEvent(event.id);
    } catch (err: any) {
      logger.warn({ err: err?.message, orderRef: order.id.slice(-6) }, "Bakong reconciliation tick error");
    }
  }

  // PART 4 — old MATCHED events (pre-fix dead data) are safely reprocessed;
  // idempotency guards make this a no-op for already-CONFIRMED events.
  await reprocessMatchedEvents();
}

/** PART 4 — re-drive MATCHED events through the authoritative matching. */
export async function reprocessMatchedEvents(limit: number = 50): Promise<void> {
  const stuck: any[] = await prisma.incomingPaymentEvent.findMany({
    where: { status: "MATCHED" },
    orderBy: { receivedAt: "asc" },
    take: limit
  });
  for (const e of stuck) {
    await matchAndApplyIncomingEvent(e.id);
  }
}


// ---------------------------------------------------------------------------
// F9 — Admin configuration / readiness
// ---------------------------------------------------------------------------
export type VerificationReadiness = "READY" | "MISSING" | "OFF" | "ERROR";

export function getVerificationReadiness(account: {
  verificationProvider?: string | null;
  verificationBaseUrl?: string | null;
}): { status: VerificationReadiness; label: string } {
  const provider = String(account.verificationProvider ?? "").trim();
  if (!provider) return { status: "OFF", label: "🔴 Tắt (duyệt thủ công)" };
  const meta = INCOMING_PROVIDERS[provider as IncomingProvider];
  if (!meta) return { status: "ERROR", label: "🔴 Lỗi cấu hình (provider không hợp lệ)" };
  if (!meta.enabled) return { status: "ERROR", label: `🔴 ${provider}: ${meta.missingContract}` };
  if (provider === "BAKONG_OPEN_API" && !String(account.verificationBaseUrl ?? "").trim()) {
    return { status: "MISSING", label: "🟡 Thiếu cấu hình (API base URL)" };
  }
  return { status: "READY", label: "🟢 Sẵn sàng" };
}

export async function setAccountVerificationProvider(
  adminId: string,
  accountId: string,
  provider: IncomingProvider | null,
  baseUrl?: string | null,
  token?: string | null
): Promise<any> {
  if (provider && !INCOMING_PROVIDERS[provider]) throw new Error("Provider không hợp lệ.");
  if (provider === "BAKONG_OPEN_API") {
    if (!baseUrl?.trim()) throw new Error("Thiếu Bakong Open API base URL.");
    // PART 7 — SSRF guard: only https + allowlisted official/relay hosts.
    if (!isAllowedVerificationBaseUrl(baseUrl)) {
      throw new Error(
        "Base URL không được phép (chỉ https, host chính thức/allowlist; chặn localhost/private/metadata)."
      );
    }
    if (!token?.trim()) throw new Error("Thiếu Bakong API token.");
    // Encrypted secret storage — never logged, never returned to the UI.
    await SystemSecretService.setSecret(bakongTokenSecretKey(), token.trim(), adminId);
  }
  const updated = await prisma.paymentAccount.update({
    where: { id: accountId },
    data: {
      verificationProvider: provider,
      verificationBaseUrl: provider === "BAKONG_OPEN_API" ? baseUrl!.trim() : null
    }
  });
  await AuditService.log({
    actorId: adminId,
    actorRole: "ADMIN",
    action: "PAYMENT_ACCOUNT_VERIFICATION_CONFIGURED",
    targetType: "PAYMENT_ACCOUNT",
    targetId: accountId,
    details: { provider: provider ?? "OFF" }
  });
  return updated;
}

let incomingTimer: ReturnType<typeof setInterval> | null = null;

export function startIncomingPaymentScheduler(intervalMs: number = 60_000): void {
  if (incomingTimer) return;
  incomingTimer = setInterval(() => {
    reconcileBakongOrders().catch((err) =>
      logger.warn({ err: err?.message }, "Bakong reconciliation scheduler failed")
    );
  }, intervalMs);
}

export function stopIncomingPaymentScheduler(): void {
  if (incomingTimer) {
    clearInterval(incomingTimer);
    incomingTimer = null;
  }
}

/**
 * Webhook entry point (scaffolding). Every current provider is DISABLED
 * because no webhook authentication contract has been proven — an
 * unauthenticated webhook can NEVER confirm payment. Adapters must implement
 * verified signature/auth BEFORE calling recordIncomingEvent.
 */
export async function handleProviderWebhook(provider: string, payload: unknown): Promise<{ status: number; body: object }> {
  const meta = INCOMING_PROVIDERS[provider as IncomingProvider];
  if (!meta) return { status: 404, body: { error: "unknown provider" } };
  if (!meta.enabled || !meta.authImplemented) {
    return {
      status: 503,
      body: { error: "provider disabled — authentication contract not implemented", provider }
    };
  }
  // REACHABLE ONLY FOR FUTURE ENABLED ADAPTERS with verified auth:
  void payload;
  return { status: 503, body: { error: "provider adapter not active" } };
}

