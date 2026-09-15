/**
 * Proactive Partner (CTV) notification tests — referral / commission-earned /
 * HELD→AVAILABLE / REVERSED. Presentation only: persistence always commits
 * first; Telegram failures never roll back business state; Partner.language
 * (vi|en, NULL ⇒ bilingual) drives rendering; Customer.language is irrelevant.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import { inMemoryStore, prisma } from "../src/database/client.js";
import { PartnerService } from "../src/modules/partner/partner-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { OrderService } from "../src/modules/orders/order-service.js";
import { QuoteService } from "../src/modules/quotes/quote-service.js";
import { setBotInstance, notifyPartnerCommissionEarned } from "../src/bot/notifications.js";
import { RuntimeConfigService } from "../src/modules/system-config/runtime-config-service.js";
import { formatPublicOrderRef } from "../src/modules/orders/order-ref.js";
import { resolveLocale, t } from "../src/modules/i18n/locales.js";

let seq = 0;
const nextTg = () => String(8_100_000_000 + ++seq);
const uniqueId = () => `ctvnoti-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

interface Captured {
  id: string;
  text: string;
}

let sent: Captured[] = [];

function installCaptureBot(failSends = false): void {
  setBotInstance({
    api: {
      sendMessage: async (id: any, text: string) => {
        if (failSends) throw new Error("blocked: bot unreachable");
        sent.push({ id: String(id), text });
        return {};
      }
    }
  } as any);
}

beforeEach(async () => {
  for (const key of Object.keys(inMemoryStore as any)) {
    const store: any = (inMemoryStore as any)[key];
    if (store instanceof Map) store.clear();
    else if (Array.isArray(store)) store.length = 0;
  }
  sent = [];
});

async function seedRate(): Promise<void> {
  await RuntimeConfigService.init();
  await RuntimeConfigService.setBuyMarginVnd(0, "TEST");
  await RuntimeConfigService.setSellMarginVnd(0, "TEST");
  await QuoteService.setRateAndInvalidate("USD/VND", 25600, 0, 0, 3, "USD", "admin-1", "SUPER_ADMIN");
}

async function makeBoundPartner(language: string | null = null): Promise<{ partner: any; telegramId: string }> {
  const partner = await PartnerService.createPartner("admin-test", `CTV ${uniqueId()}`);
  const telegramId = nextTg();
  await prisma.partner.update({
    where: { id: partner.id },
    data: { telegramId, status: "ACTIVE", ...(language ? { language } : {}) }
  });
  return { partner: await PartnerService.getPartnerByTelegramId(telegramId), telegramId };
}

async function makeOrderFor(partnerId: string): Promise<any> {
  await seedRate();
  const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
  const calc = await QuoteService.calculateQuote("USD", "VND", 100);
  const order = await OrderService.createOrderFromQuote(customer.id, calc);
  await prisma.order.update({ where: { id: order.id }, data: { partnerId } });
  return OrderService.getOrder(order.id);
}

describe("NEW_REFERRAL notification", () => {
  it("successful new referral → direct Partner notified (NULL language ⇒ bilingual)", async () => {
    installCaptureBot();
    const { partner, telegramId } = await makeBoundPartner(); // language NULL
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    const outcome = await PartnerService.claimReferral(`ref_${partner.referralCode}`, customer.telegramId);
    expect(outcome.assigned).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe(telegramId);
    // NULL ⇒ bilingual VI + EN:
    expect(sent[0].text).toContain(t(resolveLocale("vi"), "ctv.notify_new_referral_title"));
    expect(sent[0].text).toContain(t(resolveLocale("en"), "ctv.notify_new_referral_title"));
    expect(sent[0].text).toContain("1");
    // Privacy: no referred-customer identity (Telegram ID / name / ref) leaks:
    expect(sent[0].text).not.toContain(customer.telegramId);
    expect(sent[0].text).not.toContain(customer.id);
  });

  it("repeated /start (ALREADY_ASSIGNED) never re-notifies", async () => {
    installCaptureBot();
    const { partner } = await makeBoundPartner();
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    await PartnerService.claimReferral(`ref_${partner.referralCode}`, customer.telegramId);
    expect(sent).toHaveLength(1);

    const again = await PartnerService.claimReferral(`ref_${partner.referralCode}`, customer.telegramId);
    expect(again.assigned).toBe(false);
    expect(again.reason).toBe("ALREADY_ASSIGNED");
    expect(sent).toHaveLength(1); // idempotent — no second notification
  });

  it("invalid referral code → no notification", async () => {
    installCaptureBot();
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const outcome = await PartnerService.claimReferral("ref_NOPE123", customer.telegramId);
    expect(outcome.assigned).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("Partner.language=vi → VI only; =en → EN only", async () => {
    installCaptureBot();
    const vi = await makeBoundPartner("vi");
    const c1 = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    await PartnerService.claimReferral(`ref_${vi.partner.referralCode}`, c1.telegramId);
    expect(sent[0].text).toContain(t(resolveLocale("vi"), "ctv.notify_new_referral_title"));
    expect(sent[0].text).not.toContain(t(resolveLocale("en"), "ctv.notify_new_referral_title"));

    const en = await makeBoundPartner("en");
    const c2 = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    await PartnerService.claimReferral(`ref_${en.partner.referralCode}`, c2.telegramId);
    expect(sent[1].text).toContain(t(resolveLocale("en"), "ctv.notify_new_referral_title"));
    expect(sent[1].text).not.toContain(t(resolveLocale("vi"), "ctv.notify_new_referral_title"));
  });

  it("Telegram failure does NOT undo the referral attribution", async () => {
    installCaptureBot(true); // every send throws
    const { partner } = await makeBoundPartner();
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    const outcome = await PartnerService.claimReferral(`ref_${partner.referralCode}`, customer.telegramId);
    expect(outcome.assigned).toBe(true);
    const fresh: any = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect(fresh.partnerId).toBe(partner.id); // attribution persisted
  });
});

describe("COMMISSION_EARNED notification", () => {
  it("L1 sees persisted fixed+spread with canonical public Ref; HELD shown as Pending", async () => {
    installCaptureBot();
    const { partner } = await makeBoundPartner("vi");
    const order = await makeOrderFor(partner.id);

    await notifyPartnerCommissionEarned(order.id, [
      {
        partnerId: partner.id,
        level: 1,
        baseCommissionUsd: new Decimal(1),
        spreadBonusUsd: new Decimal(0.24),
        totalUsd: new Decimal(1.24),
        status: "HELD"
      }
    ]);

    expect(sent).toHaveLength(1);
    const text = sent[0].text;
    expect(text).toContain(t(resolveLocale("vi"), "ctv.notify_earned_title"));
    expect(text).toContain(formatPublicOrderRef(order)); // canonical public Ref
    expect(text).not.toContain(order.id); // raw internal id absent
    expect(text).toContain("L1");
    expect(text).toContain("$1.00"); // persisted fixed
    expect(text).toContain("$0.24"); // persisted spread
    expect(text).toContain("$1.24"); // persisted total
    expect(text).toContain("Đang chờ"); // HELD truthfully shown as Pending
    expect(text).not.toMatch(/Available|Khả dụng/); // creation ≠ available
  });

  it("L1 + L2 each see ONLY their own persisted level/amount", async () => {
    installCaptureBot();
    const l1 = await makeBoundPartner("en");
    const l2 = await makeBoundPartner("en");
    await prisma.partner.update({ where: { id: l1.partner.id }, data: { parentPartnerId: l2.partner.id } });
    const order = await makeOrderFor(l1.partner.id);

    await notifyPartnerCommissionEarned(order.id, [
      {
        partnerId: l1.partner.id,
        level: 1,
        baseCommissionUsd: new Decimal(1),
        spreadBonusUsd: new Decimal(0),
        totalUsd: new Decimal(1),
        status: "HELD"
      },
      {
        partnerId: l2.partner.id,
        level: 2,
        baseCommissionUsd: new Decimal(0.4),
        spreadBonusUsd: new Decimal(0),
        totalUsd: new Decimal(0.4),
        status: "HELD"
      }
    ]);

    expect(sent).toHaveLength(2);
    const toL1 = sent.find((s) => s.id === l1.telegramId)!!;
    const toL2 = sent.find((s) => s.id === l2.telegramId)!!;
    expect(toL1.text).toContain("L1");
    expect(toL1.text).toContain("$1.00");
    expect(toL1.text).not.toContain("$0.40"); // L2 amount never leaks to L1
    expect(toL2.text).toContain("Your level: L2");
    expect(toL2.text).toContain("$0.40");
    expect(toL2.text).toContain(formatPublicOrderRef(order));
    expect(toL2.text).not.toContain(order.id);
    expect(toL2.text).not.toContain("$1.00"); // L1 amount never leaks to L2
  });

  it("Telegram failure never throws (Commission/Order unaffected)", async () => {
    installCaptureBot(true);
    const { partner } = await makeBoundPartner("vi");
    const order = await makeOrderFor(partner.id);
    await expect(
      notifyPartnerCommissionEarned(order.id, [
        {
          partnerId: partner.id,
          level: 1,
          baseCommissionUsd: new Decimal(1),
          spreadBonusUsd: new Decimal(0),
          totalUsd: new Decimal(1),
          status: "HELD"
        }
      ])
    ).resolves.toBeUndefined();
  });
});

describe("Partner.language = NULL bilingual fallback for EVERY notification type", () => {
  it("COMMISSION_EARNED NULL ⇒ bilingual VI + EN", async () => {
    installCaptureBot();
    const { partner } = await makeBoundPartner(); // NULL
    const order = await makeOrderFor(partner.id);
    await notifyPartnerCommissionEarned(order.id, [
      {
        partnerId: partner.id,
        level: 2,
        baseCommissionUsd: new Decimal(0),
        spreadBonusUsd: new Decimal(0),
        totalUsd: new Decimal(0.3),
        status: "HELD"
      }
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(t(resolveLocale("vi"), "ctv.notify_network_title"));
    expect(sent[0].text).toContain(t(resolveLocale("en"), "ctv.notify_network_title"));
  });

  it("COMMISSION_AVAILABLE NULL ⇒ bilingual VI + EN", async () => {
    installCaptureBot();
    const { partner } = await makeBoundPartner(); // NULL
    await prisma.commission.create({
      data: {
        orderId: `ord-${uniqueId()}`,
        level: 1,
        partnerId: partner.partner.id,
        baseCommissionUsd: new Decimal(1),
        spreadBonusUsd: new Decimal(0),
        totalUsd: new Decimal(3),
        status: "HELD",
        availableAt: new Date(Date.now() - 1000)
      }
    });
    await PartnerService.reconcileAvailableCommissions();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(t(resolveLocale("vi"), "ctv.notify_available_title"));
    expect(sent[0].text).toContain(t(resolveLocale("en"), "ctv.notify_available_title"));
  });

  it("REVERSED NULL ⇒ bilingual VI + EN", async () => {
    installCaptureBot();
    const { partner } = await makeBoundPartner(); // NULL
    const commission: any = await prisma.commission.create({
      data: {
        orderId: `ord-${uniqueId()}`,
        level: 1,
        partnerId: partner.partner.id,
        baseCommissionUsd: new Decimal(1),
        spreadBonusUsd: new Decimal(0),
        totalUsd: new Decimal(1),
        status: "AVAILABLE",
        availableAt: new Date()
      }
    });
    await PartnerService.reverseCommission("admin-test", commission.id, "duplicate bill review");
    expect(sent[0].text).toContain(t(resolveLocale("vi"), "ctv.notify_reversed_title"));
    expect(sent[0].text).toContain(t(resolveLocale("en"), "ctv.notify_reversed_title"));
  });

  it("in-transaction attempt that ROLLS BACK sends NO commission notification", async () => {
    installCaptureBot();
    const { partner } = await makeBoundPartner("vi");
    const order = await makeOrderFor(partner.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: "COMPLETED" } });

    try {
      await prisma.$transaction(async (tx: any) => {
        await PartnerService.onOrderCompleted(order.id, tx);
        throw new Error("force rollback");
      });
    } catch {
      // expected: the transaction did not commit
    }
    // The rows were never committed — the stashed notice must NOT be sent.
    expect(sent).toHaveLength(0);
  });
});

describe("HELD→AVAILABLE + REVERSED notifications", () => {
  it("aggregates per Partner per release run; second run notifies nothing", async () => {
    installCaptureBot();
    const a = await makeBoundPartner("vi");
    const b = await makeBoundPartner("en");
    const mk = async (p: any, i: number) =>
      prisma.commission.create({
        data: {
          orderId: `ord-${uniqueId()}`,
          level: 1,
          partnerId: p.partner.id,
          baseCommissionUsd: new Decimal(1),
          spreadBonusUsd: new Decimal(0),
          totalUsd: new Decimal(2 + i),
          status: "HELD",
          availableAt: new Date(Date.now() - 1000)
        }
      });
    await mk(a, 0);
    await mk(a, 1);
    await mk(b, 2);

    const released = await PartnerService.reconcileAvailableCommissions();
    expect(released).toBe(3);
    // ONE aggregated message per Partner:
    expect(sent).toHaveLength(2);
    const toA = sent.find((s) => s.id === a.telegramId)!!;
    expect(toA.text).toContain("2"); // aggregated count
    expect(toA.text).toContain("$5.00"); // 2 + 3 newly available
    const toB = sent.find((s) => s.id === b.telegramId)!!;
    expect(toB.text).toContain("$3.00");

    // Second run: nothing HELD left → no new notifications (no duplicates).
    sent.length = 0;
    const again = await PartnerService.reconcileAvailableCommissions();
    expect(again).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("REVERSED: notified with persisted amount + audited reason", async () => {
    installCaptureBot();
    const { partner } = await makeBoundPartner("vi");
    const commission: any = await prisma.commission.create({
      data: {
        orderId: `ord-${uniqueId()}`,
        level: 1,
        partnerId: partner.partner.id,
        baseCommissionUsd: new Decimal(1),
        spreadBonusUsd: new Decimal(0),
        totalUsd: new Decimal(1),
        status: "AVAILABLE",
        availableAt: new Date()
      }
    });

    await PartnerService.reverseCommission("admin-test", commission.id, "duplicate bill review");

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(t(resolveLocale("vi"), "ctv.notify_reversed_title"));
    expect(sent[0].text).toContain("-$1.00");
    expect(sent[0].text).toContain("duplicate bill review");
    const fresh: any = await prisma.commission.findUnique({ where: { id: commission.id } });
    expect(fresh.status).toBe("REVERSED"); // persisted truth unchanged
  });
});
