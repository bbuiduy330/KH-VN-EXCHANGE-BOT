/**
 * Partner / CTV core service (S–W).
 *
 * SAFETY PRINCIPLES:
 * - Attribution is INVISIBLE to customers; partners see only aggregate
 *   counts/sums, never customer identity, Telegram ID, bank data, bills or
 *   chats.
 * - Referral assignment: only NEW/unassigned customers without prior
 *   COMPLETED orders; a second referral NEVER overwrites; reassignment is
 *   Admin-only and audited.
 * - Commissions: exactly ONE per Order (unique orderId), created
 *   idempotently on COMPLETED, HELD for `holdHours` (default 72h), never
 *   paid at completion; Admin batches settlements; corrections use
 *   reversal records, never deletion.
 *
 * COMMISSION FORMULA (U — actually implemented):
 *   baseCommission = partner.baseCommissionUsd (default 1 USD)
 *   spreadBonus    = DEFERRED — always 0 for now
 *   totalUsd       = baseCommission + spreadBonus
 *
 * SPREAD BONUS DEFERRED: the Order schema does not persist the authoritative
 * reference/base rate needed to compute REALIZED spread safely (Order.rate is
 * the customer-effective rate; Quote.baseRate is not snapshotted onto the
 * Order). Inventing arithmetic would fabricate profit — so spreadBonus stays
 * 0 and the column/field is ready for a future authoritative snapshot.
 */
import { Decimal } from "decimal.js";
import { prisma } from "../../database/client.js";
import { AuditService } from "../audit/audit-service.js";
import { logger } from "../../shared/logger.js";

/**
 * Minimal projection row for the reconciliation fallback walk — only the
 * Order id is needed. Keeps `orders`/`o`/`last` fully typed under strict TS
 * (noUncheckedIndexedAccess + implicit-any) without broad casts.
 */
type ReconciliationOrderRow = {
  id: string;
};

export const COMMISSION_LARGE_ORDER_USD = 500;

export class PartnerService {
  // -----------------------------------------------------------------------
  // Partner management
  // -----------------------------------------------------------------------
  static generateReferralCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
    let code = "";
    for (let i = 0; i < 8; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
  }

  static async createPartner(adminId: string, displayName: string): Promise<any> {
    const name = String(displayName || "").trim();
    if (name.length < 2) throw new Error("Tên CTV phải từ 2 ký tự trở lên.");
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = this.generateReferralCode();
      try {
        const partner = await prisma.partner.create({
          data: { referralCode: code, displayName: name }
        });
        await AuditService.log({
          actorId: adminId,
          actorRole: "ADMIN",
          action: "PARTNER_CREATED",
          targetType: "PARTNER",
          targetId: partner.id,
          details: { referralCode: partner.referralCode, displayName: name }
        });
        return partner;
      } catch (err: any) {
        // referralCode collision → retry with a new code
        if (!String(err?.message || "").includes("referralCode")) throw err;
      }
    }
    throw new Error("Không tạo được mã giới thiệu (trùng lặp nhiều lần).");
  }

  static async setPartnerStatus(adminId: string, partnerId: string, status: "ACTIVE" | "DISABLED"): Promise<any> {
    const updated = await prisma.partner.update({ where: { id: partnerId }, data: { status } });
    await AuditService.log({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "PARTNER_STATUS_CHANGED",
      targetType: "PARTNER",
      targetId: partnerId,
      details: { status }
    });
    return updated;
  }

  static async listPartners(): Promise<any[]> {
    return prisma.partner.findMany({ orderBy: { createdAt: "desc" }, take: 30 });
  }

  static async getPartnerById(id: string): Promise<any | null> {
    return prisma.partner.findUnique({ where: { id } });
  }

  static async getPartnerByTelegramId(telegramId: string): Promise<any | null> {
    return prisma.partner.findUnique({ where: { telegramId: String(telegramId) } });
  }

  /** t.me/<botUsername>?start=ref_<code> deep link target token. */
  static referralPayload(partner: { referralCode: string }): string {
    return `ref_${partner.referralCode}`;
  }

  // -----------------------------------------------------------------------
  // Referral attribution (T)
  // -----------------------------------------------------------------------
  /**
   * Claim on /start ref_<code>. Returns the effective assignment outcome.
   * Rules: partner ACTIVE; customer already assigned → never overwrite;
   * customer with prior COMPLETED orders is NOT silently claimed.
   */
  static async claimReferral(payload: string, telegramId: string): Promise<
    { assigned: boolean; reason: "OK" | "BAD_CODE" | "DISABLED" | "ALREADY_ASSIGNED" | "PRIOR_COMPLETED" }
  > {
    const code = String(payload || "").replace(/^ref_/i, "").trim().toUpperCase();
    if (!code) return { assigned: false, reason: "BAD_CODE" };

    const partner = await prisma.partner.findUnique({ where: { referralCode: code } });
    if (!partner) return { assigned: false, reason: "BAD_CODE" };
    if (partner.status !== "ACTIVE") return { assigned: false, reason: "DISABLED" };

    const customer = await prisma.customer.findUnique({ where: { telegramId: String(telegramId) } });
    if (!customer) return { assigned: false, reason: "BAD_CODE" };
    if (customer.partnerId) return { assigned: false, reason: "ALREADY_ASSIGNED" };

    const priorCompleted = await prisma.order.count({
      where: { customerId: customer.id, status: "COMPLETED" }
    });
    if (priorCompleted > 0) return { assigned: false, reason: "PRIOR_COMPLETED" };

    await prisma.customer.update({
      where: { id: customer.id },
      data: { partnerId: partner.id, partnerAssignedAt: new Date() }
    });
    await AuditService.log({
      actorId: String(telegramId),
      actorRole: "CUSTOMER",
      action: "PARTNER_REFERRAL_ASSIGNED",
      targetType: "CUSTOMER",
      targetId: customer.id,
      details: { partnerId: partner.id, referralCode: code }
    });
    return { assigned: true, reason: "OK" };
  }

  /** Admin-only reassignment, fully audited (T). */
  static async adminAssignPartner(adminId: string, customerId: string, partnerId: string): Promise<void> {
    const [customer, partner] = await Promise.all([
      prisma.customer.findUnique({ where: { id: customerId } }),
      prisma.partner.findUnique({ where: { id: partnerId } })
    ]);
    if (!customer || !partner) throw new Error("Không tìm thấy khách hàng hoặc CTV.");
    const previousPartnerId = customer.partnerId;
    await prisma.customer.update({
      where: { id: customerId },
      data: { partnerId: partner.id, partnerAssignedAt: new Date() }
    });
    await AuditService.log({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "PARTNER_ASSIGNMENT_ADMIN_OVERRIDE",
      targetType: "CUSTOMER",
      targetId: customerId,
      details: { previousPartnerId, newPartnerId: partner.id }
    });
  }

  // -----------------------------------------------------------------------
  // Commission engine (U/V) — idempotent, one row per Order
  // -----------------------------------------------------------------------
  /** USD-equivalent of the order (business scope: USD<->VND only). */
  static orderUsdEquivalent(order: { sourceCurrency: string; targetCurrency: string; sourceAmount: any; targetAmount: any }): Decimal {
    if (order.sourceCurrency === "USD") return new Decimal(order.sourceAmount ?? 0);
    if (order.targetCurrency === "USD") return new Decimal(order.targetAmount ?? 0);
    return new Decimal(0);
  }

  /**
   * Commission creation attempt for a COMPLETED order.
   *
   * TRUTHFUL CONTRACT (1): this function NEVER throws for commission
   * problems — the outer catch swallows everything and logs. Therefore:
   *   - if called inside the Order completion transaction, a commission
   *     failure does NOT roll back the COMPLETED transition (the Order still
   *     commits successfully);
   *   - commission creation is NOT atomic with Order completion — it is a
   *     best-effort in-transaction attempt;
   *   - the AUTHORITATIVE eventual-consistency guarantee is
   *     reconcileMissingCommissions(): COMPLETED + partnerId + no Commission
   *     is repaired exactly once (unique orderId), by the scheduler, the
   *     Admin panel open, or the post-completion backstop.
   * Idempotent (unique orderId + pre-check). Risk flags HOLD the commission
   * (no availableAt) pending Admin release.
   */
  static async onOrderCompleted(orderId: string, tx?: any): Promise<void> {
    try {
      const db = tx ?? prisma;
      const order = await db.order.findUnique({ where: { id: orderId }, include: { customer: true } });
      if (!order || order.status !== "COMPLETED") return;
      if (!order.partnerId) return;

      const existing = await db.commission.findUnique({ where: { orderId } });
      if (existing) return;

      const partner = await db.partner.findUnique({ where: { id: order.partnerId } });
      if (!partner || partner.status === "DISABLED") return;

      const base = new Decimal(partner.baseCommissionUsd ?? 1);
      const spreadBonus = new Decimal(0); // U — spread bonus DEFERRED
      const total = base.plus(spreadBonus);

      const riskFlag = await this.evaluateRiskFlags(partner, order);
      const availableAt = riskFlag ? null : new Date(Date.now() + (partner.holdHours ?? 72) * 3600_000);

      try {
        await db.commission.create({
          data: {
            orderId,
            partnerId: partner.id,
            baseCommissionUsd: base,
            spreadBonusUsd: spreadBonus,
            totalUsd: total,
            status: "HELD",
            availableAt,
            riskFlag
          }
        });
        await AuditService.log({
          actorId: "SYSTEM",
          actorRole: "SYSTEM",
          action: "PARTNER_COMMISSION_CREATED",
          targetType: "ORDER",
          targetId: orderId,
          details: { partnerId: partner.id, totalUsd: total.toString(), riskFlag, availableAt: availableAt?.toISOString() ?? null }
        });
      } catch (createErr: any) {
        // Idempotency under concurrency: the unique orderId constraint means a
        // concurrent reconciliation/admin pass may have created it first.
        // That is an IDEMPOTENT SUCCESS/SKIP, not corruption — re-verify and
        // move on. Any other error is rethrown (still swallowed by the outer
        // fail-safe catch; reconciliation will repair).
        if (String(createErr?.message || "").includes("orderId")) {
          const again = await db.commission.findUnique({ where: { orderId } });
          if (again) {
            logger.info({ orderId }, "Commission already exists (concurrent creation) — idempotent skip");
            return;
          }
        }
        throw createErr;
      }
    } catch (err: any) {
      // Commission failure must NEVER break the authoritative financial flow.
      logger.warn({ err: err?.message, orderId }, "Partner commission creation failed (non-fatal)");
    }
  }

  // -----------------------------------------------------------------------
  // Reconciliation backstop (approach B) + HELD→AVAILABLE mechanism (2)
  //
  // DB-derived, restart-safe, idempotent, auditable — deliberately NOT based
  // on in-memory timers alone. Runs:
  //   - in a periodic scheduler (startReconciliationScheduler, wired in
  //     server.ts next to the existing schedulers),
  //   - whenever the Admin opens the 🤝 CTV panel,
  //   - after each completion as a belt-and-braces re-check.
  //
  // The schema intentionally has NO Prisma reverse relation
  // Order → Commission (Commission.orderId is a plain unique String, no
  // DB-level FK), so a "commission IS NULL" Prisma filter is not available
  // without changing the migration. Therefore:
  //   PRIMARY (production PostgreSQL): parameterized $queryRaw NOT EXISTS —
  //   the query returns ONLY genuinely missing rows, so already-reconciled
  //   rows disappear from the result automatically and can never starve
  //   later rows. No cursor persistence needed; restart-safe.
  //   FALLBACK (in-memory mock / dev without raw SQL): a work-limited,
  //   paged oldest-first walk that stops at the per-run work limit; every
  //   walk starts from the oldest row and skips already-created rows, so it
  //   still makes forward progress each run (no starvation) at O(prefix)
  //   scan cost — only used where raw SQL is unavailable.
  // -----------------------------------------------------------------------

  private static rawSqlCapability: "unknown" | "available" | "unavailable" = "unknown";

  /** P2002 detection: structured Prisma error code first, string fallback. */
  private static isUniqueViolation(err: any): boolean {
    if (!err) return false;
    if (err.code === "P2002") return true; // PrismaClientKnownRequestError
    if (err.name === "PrismaClientKnownRequestError" && String(err.message || "").includes("orderId")) return true;
    return String(err?.message || "").includes("orderId"); // mock/normalized errors
  }

  /**
   * MISSING-ONLY selection. Returns at most `workLimit` Order ids that are
   * COMPLETED, partner-attributed, and have NO Commission.
   *
   * Primary: safe tagged-template $queryRaw (no user input is interpolated;
   * the only bound value is the internal numeric LIMIT, passed as a bind
   * parameter). Fallback: paged oldest-first walk that stops as soon as
   * `workLimit` missing rows were collected (restart-safe: created rows stop
   * appearing in later walks, so progress is guaranteed without a cursor).
   */
  private static async findMissingCommissionOrderIds(workLimit: number): Promise<string[]> {
    if (this.rawSqlCapability !== "unavailable") {
      try {
        const rows = (await (prisma as any).$queryRaw`
          SELECT o."id" AS id
          FROM "Order" o
          WHERE o."status" = 'COMPLETED'
            AND o."partnerId" IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM "Commission" c
              WHERE c."orderId" = o."id"
            )
          ORDER BY o."completedAt" ASC, o."id" ASC
          LIMIT ${workLimit}`) as Array<{ id: string }>;
        this.rawSqlCapability = "available";
        return rows.map((r) => String(r.id));
      } catch (err: any) {
        if (this.rawSqlCapability === "available") {
          // Production regression — surface the real DB error.
          throw err;
        }
        this.rawSqlCapability = "unavailable";
        logger.warn(
          { err: err?.message },
          "Partner reconciliation: $queryRaw unavailable (mock/dev) — using paged fallback walk"
        );
      }
    }

    // Fallback: paged oldest-first walk, stops at the per-run work limit.
    // Only the id is needed — select a minimal, explicitly typed projection so
    // `orders`/`o`/`last` are fully inferred under strict TS (no implicit any).
    const missing: string[] = [];
    let cursorId: string | undefined = undefined;
    const pageSize = 100;
    for (;;) {
      const orders: ReconciliationOrderRow[] = await prisma.order.findMany({
        where: { status: "COMPLETED", partnerId: { not: null } },
        orderBy: [{ completedAt: "asc" }, { id: "asc" }],
        take: pageSize,
        select: { id: true },
        ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {})
      });
      if (orders.length === 0) break;
      // Non-advancing cursor guard: if the page still contains the cursor row
      // (mock/dev without cursor support), stop instead of looping forever.
      // Correctness is preserved — the next run rescans, and this run's work
      // limit still bounds creation work.
      if (cursorId && orders.some((o) => o.id === cursorId)) break;
      for (const o of orders) {
        const existing = await prisma.commission.findUnique({ where: { orderId: o.id } });
        if (!existing) {
          missing.push(o.id);
          if (missing.length >= workLimit) break;
        }
      }
      if (missing.length >= workLimit) break;
      const last: ReconciliationOrderRow | undefined = orders[orders.length - 1];
      if (!last || orders.length < pageSize) break;
      cursorId = last.id;
    }
    return missing;
  }

  /**
   * Reconciles missing Commissions with a per-run WORK LIMIT (creations, not
   * scanned rows). Restart-safe WITHOUT a persisted cursor: the next run's
   * missing-only selection no longer sees the rows fixed by this run, so
   * progress is automatic. Concurrency-safe: Commission.orderId UNIQUE +
   * per-order pre-check; a concurrent creation resolves as an idempotent
   * success/skip (P2002-aware, see isUniqueViolation).
   */
  static async reconcileMissingCommissions(workLimit: number = 100): Promise<number> {
    const missingIds = await this.findMissingCommissionOrderIds(workLimit);
    let created = 0;
    for (const orderId of missingIds) {
      await this.onOrderCompleted(orderId); // never throws; idempotent
      const after = await prisma.commission.findUnique({ where: { orderId } });
      if (after) created++;
    }
    if (created > 0) {
      await AuditService.log({
        actorId: "SYSTEM",
        actorRole: "SYSTEM",
        action: "PARTNER_COMMISSIONS_RECONCILED",
        targetType: "PARTNER",
        targetId: "BULK",
        details: { created, requested: missingIds.length }
      }).catch(() => {});
    }
    return created;
  }

  /**
   * HELD → AVAILABLE for ordinary (non-risk) commissions whose hold has
   * elapsed. Risk-flagged commissions stay HELD until Admin release.
   * Nothing is auto-paid — AVAILABLE is only settlement eligibility.
   */
  static async reconcileAvailableCommissions(): Promise<number> {
    const result = await prisma.commission.updateMany({
      where: { status: "HELD", riskFlag: null, availableAt: { lte: new Date() } },
      data: { status: "AVAILABLE" }
    });
    if (result.count > 0) {
      await AuditService.log({
        actorId: "SYSTEM",
        actorRole: "SYSTEM",
        action: "PARTNER_COMMISSIONS_AUTO_AVAILABLE",
        targetType: "PARTNER",
        targetId: "BULK",
        details: { count: result.count }
      }).catch(() => {});
    }
    return result.count;
  }

  private static reconciliationTimer: ReturnType<typeof setInterval> | null = null;

  /** Restart-safe DB-derived reconciliation loop (no auto-pay, ever). */
  static startReconciliationScheduler(intervalMs: number = 15 * 60_000): void {
    if (this.reconciliationTimer) return;
    this.reconciliationTimer = setInterval(() => {
      this.reconcileAvailableCommissions().catch((err) =>
        logger.warn({ err: err?.message }, "Partner HELD→AVAILABLE reconciliation failed")
      );
      this.reconcileMissingCommissions().catch((err) =>
        logger.warn({ err: err?.message }, "Partner missing-commission reconciliation failed")
      );
    }, intervalMs);
    // Initial pass shortly after boot (crash-recovery from previous run).
    setTimeout(() => {
      this.reconcileAvailableCommissions().catch(() => {});
      this.reconcileMissingCommissions().catch(() => {});
    }, 10_000);
  }

  static stopReconciliationScheduler(): void {
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
  }

  /** W — Admin-only risk heuristics; HOLD commission, never auto-accuse. */
  static async evaluateRiskFlags(partner: any, order: any): Promise<string | null> {
    const flags: string[] = [];

    // 1. Partner payout account matching a referred customer's payout account.
    const partnerAccount = String(partner.payoutAccountNumber || "").trim();
    if (partnerAccount.length >= 6) {
      const referred = await prisma.order.findMany({
        where: { partnerId: partner.id, status: "COMPLETED" },
        take: 100
      });
      for (const o of referred) {
        const snap = (o.payoutBankSnapshot || null) as any;
        if (snap?.type !== "qr" && String(snap?.accountNumber || "").trim() === partnerAccount) {
          flags.push("PAYOUT_ACCOUNT_OVERLAP");
          break;
        }
      }
    }

    // 2. Many orders intentionally just above the $500 large-order threshold.
    const usdValue = this.orderUsdEquivalent(order).toNumber();
    if (usdValue >= COMMISSION_LARGE_ORDER_USD && usdValue <= COMMISSION_LARGE_ORDER_USD + 60) {
      const near = await prisma.order.count({
        where: {
          partnerId: partner.id,
          status: "COMPLETED",
          OR: [
            { sourceCurrency: "USD", sourceAmount: { gte: COMMISSION_LARGE_ORDER_USD, lte: COMMISSION_LARGE_ORDER_USD + 60 } },
            { targetCurrency: "USD", targetAmount: { gte: COMMISSION_LARGE_ORDER_USD, lte: COMMISSION_LARGE_ORDER_USD + 60 } }
          ]
        }
      });
      if (near >= 3) flags.push("THRESHOLD_CLUSTERING");
    }

    // 3. Rapid repeated referrals (>= 5 assignments within 24h).
    const recentReferrals = await prisma.customer.count({
      where: { partnerId: partner.id, partnerAssignedAt: { gte: new Date(Date.now() - 24 * 3600_000) } }
    });
    if (recentReferrals >= 5) flags.push("RAPID_REFERRALS");

    return flags.length ? flags.join(",") : null;
  }

  /** Commission effective state for UI: PAID / REVERSED / AVAILABLE / HELD. */
  static effectiveStatus(c: { status: string; availableAt: Date | null }): string {
    if (c.status === "PAID" || c.status === "REVERSED") return c.status;
    if (c.status === "HELD" && c.availableAt && c.availableAt.getTime() <= Date.now()) return "AVAILABLE";
    return "HELD";
  }

  static async releaseCommission(adminId: string, commissionId: string): Promise<void> {
    const c = await prisma.commission.findUnique({ where: { id: commissionId } });
    if (!c) throw new Error("Không tìm thấy hoa hồng.");
    if (c.status !== "HELD") throw new Error("Chỉ hoa hồng đang HELD mới được chuyển AVAILABLE.");
    await prisma.commission.update({ where: { id: commissionId }, data: { status: "AVAILABLE", riskFlag: null } });
    await AuditService.log({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "PARTNER_COMMISSION_RELEASED",
      targetType: "COMMISSION",
      targetId: commissionId,
      details: { orderId: c.orderId, partnerId: c.partnerId }
    });
  }

  static async reverseCommission(adminId: string, commissionId: string, reason: string): Promise<void> {
    const c = await prisma.commission.findUnique({ where: { id: commissionId } });
    if (!c) throw new Error("Không tìm thấy hoa hồng.");
    if (c.status === "PAID") throw new Error("Hoa hồng đã PAID — dùng điều chỉnh kế toán, không đảo trạng thái tự động.");
    if (!reason || reason.trim().length < 5) throw new Error("Lý do đảo hoa hồng phải từ 5 ký tự.");
    await prisma.commission.update({
      where: { id: commissionId },
      data: { status: "REVERSED", reversedReason: reason.trim() }
    });
    await AuditService.log({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "PARTNER_COMMISSION_REVERSED",
      targetType: "COMMISSION",
      targetId: commissionId,
      details: { orderId: c.orderId, reason: reason.trim() }
    });
  }

  static async listPartnerCommissions(partnerId: string, take: number = 20): Promise<any[]> {
    return prisma.commission.findMany({ where: { partnerId }, orderBy: { createdAt: "desc" }, take });
  }

  static async partnerSummary(partnerId: string): Promise<{ held: Decimal; available: Decimal; paid: Decimal; eligibleCompleted: number }> {
    const commissions = await prisma.commission.findMany({ where: { partnerId } });
    let held = new Decimal(0);
    let available = new Decimal(0);
    let paid = new Decimal(0);
    for (const c of commissions) {
      const st = this.effectiveStatus(c);
      const total = new Decimal(c.totalUsd ?? 0);
      if (st === "AVAILABLE") available = available.plus(total);
      else if (st === "PAID") paid = paid.plus(total);
      else if (st === "HELD") held = held.plus(total);
    }
    const eligibleCompleted = await prisma.order.count({ where: { partnerId, status: "COMPLETED" } });
    return { held, available, paid, eligibleCompleted };
  }

  // -----------------------------------------------------------------------
  // Settlement batching (V)
  // -----------------------------------------------------------------------
  static async createSettlement(adminId: string, partnerId: string, note?: string): Promise<any> {
    // 2 — lifecycle: HELD → AVAILABLE → PAID. Materialise the HELD→AVAILABLE
    // transition first (idempotent, risk-flagged rows stay HELD), then settle
    // ONLY materialised AVAILABLE commissions. HELD (incl. risky, unreleased)
    // can never enter a settlement.
    await this.reconcileAvailableCommissions().catch(() => {});
    const settlement = await prisma.$transaction(async (tx: any) => {
      // Re-select INSIDE the transaction with the exact eligibility predicate:
      // status = AVAILABLE AND not yet claimed by any other settlement.
      const available = await tx.commission.findMany({
        where: { partnerId, status: "AVAILABLE", settlementId: null }
      });
      if (available.length === 0) throw new Error("Không có hoa hồng AVAILABLE nào để tất toán.");
      const total = available.reduce((acc: Decimal, c: any) => acc.plus(new Decimal(c.totalUsd ?? 0)), new Decimal(0));

      const created = await tx.partnerSettlement.create({
        data: {
          partnerId,
          totalUsd: total,
          itemCount: available.length,
          status: "PENDING",
          createdBy: adminId,
          note: note?.trim() || null
        }
      });
      for (const c of available) {
        // Claim is conditional: if another concurrent settlement won, this
        // fails and the WHOLE settlement rolls back (no partial claims).
        const claimed = await tx.commission.updateMany({
          where: { id: c.id, status: "AVAILABLE", settlementId: null },
          data: { settlementId: created.id }
        });
        if (claimed.count !== 1) {
          throw new Error("Hoa hồng đã thuộc đợt tất toán khác — tạo lại đợt mới.");
        }
      }
      await tx.auditLog.create({
        data: {
          actorId: adminId,
          actorRole: "ADMIN",
          action: "PARTNER_SETTLEMENT_CREATED",
          targetType: "PARTNER_SETTLEMENT",
          targetId: created.id,
          details: { partnerId, itemCount: available.length, totalUsd: total.toString() }
        }
      });
      return created;
    });
    return settlement;
  }

  /**
   * Admin confirms the actual bank transfer for the batch → commissions PAID.
   * Lifecycle-exact transition: ONLY status = AVAILABLE AND
   * settlementId = this settlement → PAID. Never HELD → PAID, never
   * REVERSED → PAID, never an unrelated commission → PAID. Each commission is
   * verified per-row inside the transaction (any mismatch rolls the whole
   * confirmation back). Idempotent: an already-PAID settlement returns as-is
   * without a second audit record.
   */
  static async markSettlementPaid(adminId: string, settlementId: string): Promise<any> {
    const settlement = await prisma.partnerSettlement.findUnique({
      where: { id: settlementId },
      include: { commissions: true }
    });
    if (!settlement) throw new Error("Không tìm thấy đợt tất toán.");
    if (settlement.status === "PAID") return settlement;
    const updated = await prisma.$transaction(async (tx: any) => {
      for (const c of settlement.commissions) {
        const marked = await tx.commission.updateMany({
          where: { id: c.id, settlementId: settlement.id, status: "AVAILABLE" },
          data: { status: "PAID", paidAt: new Date() }
        });
        if (marked.count !== 1) {
          throw new Error(`Hoa hồng ${c.id.slice(-6)} không ở trạng thái AVAILABLE trong đợt này — huỷ toàn bộ.`);
        }
      }
      const s = await tx.partnerSettlement.update({
        where: { id: settlementId },
        data: { status: "PAID", paidAt: new Date() }
      });
      await tx.auditLog.create({
        data: {
          actorId: adminId,
          actorRole: "ADMIN",
          action: "PARTNER_SETTLEMENT_PAID",
          targetType: "PARTNER_SETTLEMENT",
          targetId: settlementId,
          details: { itemCount: settlement.itemCount, totalUsd: settlement.totalUsd.toString(), paidAt: new Date().toISOString() }
        }
      });
      return s;
    });
    return updated;
  }
}
