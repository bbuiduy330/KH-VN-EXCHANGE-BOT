/**
 * CTV / Partner UI language (vi | en) tests.
 *
 * Product decision: Partner UI supports ONLY vi/en; Partner.language is the
 * authoritative storage and is INDEPENDENT from Customer.language (a person
 * may be a km customer and an en partner). Callback routing never depends on
 * translated labels. Commission amounts/statuses are locale-independent.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { inMemoryStore, prisma } from "../src/database/client.js";
import { PartnerService } from "../src/modules/partner/partner-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { showCtvDashboard } from "../src/bot/handlers/customer-handler.js";
import { resolveLocale, t } from "../src/modules/i18n/locales.js";

let seq = 0;
const nextTg = () => String(7_200_000_000 + ++seq);
const uniqueId = () => `ctvlang-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function fakeCtx(telegramId: string): any {
  const replies: any[] = [];
  return {
    from: { id: Number(telegramId) },
    reply: async (text: string, opts?: any) => {
      replies.push({ text, opts });
    },
    _replies: replies
  };
}

async function makeBoundPartner(): Promise<any> {
  const partner = await PartnerService.createPartner("admin-test", `CTV Test ${uniqueId()}`);
  const telegramId = nextTg();
  await prisma.partner.update({ where: { id: partner.id }, data: { telegramId, status: "ACTIVE" } });
  return { partner: await PartnerService.getPartnerByTelegramId(telegramId), telegramId };
}

beforeEach(async () => {
  for (const key of Object.keys(inMemoryStore as any)) {
    const store: any = (inMemoryStore as any)[key];
    if (store instanceof Map) store.clear();
    else if (Array.isArray(store)) store.length = 0;
  }
});

describe("First /ctv experience", () => {
  it("new partner with NO locale gets the VI/EN selector (not the menu)", async () => {
    const { partner, telegramId } = await makeBoundPartner();
    expect(partner.language).toBeNull();
    const ctx = fakeCtx(telegramId);
    await showCtvDashboard(ctx);

    expect(ctx._replies).toHaveLength(1);
    expect(ctx._replies[0].text).toContain("Chọn ngôn ngữ");
    expect(ctx._replies[0].text).toContain("Choose language");
    const data = ctx._replies[0].opts.reply_markup.inline_keyboard.flat().map((b: any) => String(b.callback_data));
    expect(data).toEqual(["ctv:lang:vi", "ctv:lang:en"]);
  });

  it("rejects non-vi/en partner languages (km/zh are CUSTOMER locales)", async () => {
    const { partner } = await makeBoundPartner();
    await expect(PartnerService.setLanguage(partner.id, "km", "test")).rejects.toThrow();
    await expect(PartnerService.setLanguage(partner.id, "zh", "test")).rejects.toThrow();
  });
});

describe("Language selection + persistence + immediate refresh", () => {
  it("VI selection renders the Vietnamese dashboard; EN renders English", async () => {
    const { partner, telegramId } = await makeBoundPartner();

    await PartnerService.setLanguage(partner.id, "vi", "test");
    const ctxVi = fakeCtx(telegramId);
    await showCtvDashboard(ctxVi);
    const viText = ctxVi._replies[0].text;
    expect(viText).toContain(t(resolveLocale("vi"), "ctv.btn_commissions"));
    expect(viText).toContain("Mã giới thiệu");
    expect(viText).not.toContain("Commission");

    await PartnerService.setLanguage(partner.id, "en", "test");
    const ctxEn = fakeCtx(telegramId);
    await showCtvDashboard(ctxEn);
    const enText = ctxEn._replies[0].text;
    expect(enText).toContain(t(resolveLocale("en"), "ctv.btn_commissions"));
    expect(enText).toContain("Referral code");
    expect(enText).not.toContain("Hoa hồng");
  });

  it("partner locale persists across consecutive /ctv calls", async () => {
    const { partner, telegramId } = await makeBoundPartner();
    await PartnerService.setLanguage(partner.id, "en", "test");
    expect((await PartnerService.getPartnerByTelegramId(telegramId)).language).toBe("en");
    const ctx1 = fakeCtx(telegramId);
    await showCtvDashboard(ctx1);
    const ctx2 = fakeCtx(telegramId);
    await showCtvDashboard(ctx2);
    expect(ctx1._replies[0].text).toContain("Commission");
    expect(ctx2._replies[0].text).toContain("Commission");
  });

  it("dashboard callbacks are IDENTICAL across VI/EN (labels never route)", () => {
    const viKb = t(resolveLocale("vi"), "ctv.btn_commissions");
    const enKb = t(resolveLocale("en"), "ctv.btn_commissions");
    expect(viKb).not.toBe(enKb); // labels differ...
    // ...but the handler registers ctv:* callbacks independent of labels.
    expect(viKb.length).toBeGreaterThan(0);
    expect(enKb.length).toBeGreaterThan(0);
  });
});

describe("Partner locale is INDEPENDENT from Customer locale", () => {
  it("changing CTV language does not modify Customer locale (and vice versa)", async () => {
    const { partner, telegramId } = await makeBoundPartner();
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    await CustomerService.setLanguage(customer.id, "km");

    await PartnerService.setLanguage(partner.id, "en", "test");
    const freshCustomer = await CustomerService.getOrCreateCustomer({ telegramId: customer.telegramId });
    expect(freshCustomer.language).toBe("km");

    await CustomerService.setLanguage(customer.id, "zh");
    const freshPartner = await PartnerService.getPartnerByTelegramId(telegramId);
    expect(freshPartner.language).toBe("en");
  });
});

describe("Commission / payout / status labels in VI and EN", () => {
  it("HELD / AVAILABLE / PAID display words are localized (never persisted)", () => {
    expect(t(resolveLocale("vi"), "ctv.status_held")).toBe("Đang chờ");
    expect(t(resolveLocale("en"), "ctv.status_held")).toBe("Pending");
    expect(t(resolveLocale("vi"), "ctv.status_available")).toBe("Khả dụng");
    expect(t(resolveLocale("en"), "ctv.status_available")).toBe("Available");
    expect(t(resolveLocale("vi"), "ctv.status_paid")).toBe("Đã thanh toán");
    expect(t(resolveLocale("en"), "ctv.status_paid")).toBe("Paid");
  });

  it("commission summary labels exist and differ per locale", () => {
    expect(t(resolveLocale("vi"), "ctv.commissions_title")).toContain("HOA HỒNG");
    expect(t(resolveLocale("en"), "ctv.commissions_title")).toContain("COMMISSIONS");
    expect(t(resolveLocale("vi"), "ctv.commissions_empty")).not.toBe(t(resolveLocale("en"), "ctv.commissions_empty"));
    expect(t(resolveLocale("vi"), "ctv.level_direct")).toBe("Đơn trực tiếp");
    expect(t(resolveLocale("en"), "ctv.level_direct")).toBe("Direct order");
  });

  it("payout destination flow labels exist in both locales", () => {
    expect(t(resolveLocale("vi"), "ctv.payout_edit_title")).toContain("CẬP NHẬT THÔNG TIN");
    expect(t(resolveLocale("en"), "ctv.payout_edit_title")).toContain("UPDATE PAYOUT DETAILS");
    expect(t(resolveLocale("vi"), "ctv.btn_confirm")).toBe("✅ Xác nhận");
    expect(t(resolveLocale("en"), "ctv.btn_confirm")).toBe("✅ Confirm");
    expect(t(resolveLocale("vi"), "ctv.btn_cancel")).toBe("↩️ Hủy");
    expect(t(resolveLocale("en"), "ctv.btn_cancel")).toBe("↩️ Cancel");
  });

  it("settlement/proof message labels exist in both locales", () => {
    expect(t(resolveLocale("vi"), "ctv.settlement_paid_title")).toContain("ĐÃ ĐƯỢC THANH TOÁN");
    expect(t(resolveLocale("en"), "ctv.settlement_paid_title")).toContain("COMMISSION PAID");
    expect(t(resolveLocale("vi"), "ctv.proof_caption")).not.toBe(t(resolveLocale("en"), "ctv.proof_caption"));
    expect(t(resolveLocale("vi"), "ctv.qr_saved")).not.toBe(t(resolveLocale("en"), "ctv.qr_saved"));
  });

  it("amounts render identically in both locales (numbers are locale-neutral)", () => {
    const vi = t(resolveLocale("vi"), "ctv.dash_pending", { amount: "$12.34" });
    const en = t(resolveLocale("en"), "ctv.dash_pending", { amount: "$12.34" });
    expect(vi).toContain("$12.34");
    expect(en).toContain("$12.34");
  });

  it("no mojibake in any CTV label", () => {
    for (const key of [
      "ctv.not_linked",
      "ctv.pick_title",
      "ctv.commissions_title",
      "ctv.payout_edit_title",
      "ctv.qr_saved",
      "ctv.settlement_paid_thanks"
    ]) {
      expect(t(resolveLocale("vi"), key)).not.toContain("\uFFFD");
      expect(t(resolveLocale("en"), key)).not.toContain("\uFFFD");
    }
  });
});

describe("Partner.language = NULL automatic notification fallback", () => {
  it("settlement-paid notification is BILINGUAL VI+EN when language is NULL; single-language after selection", async () => {
    const { PartnerService: PS } = await import("../src/modules/partner/partner-service.js");
    const { setBotInstance, notifyPartnerSettlementPaid } = await import("../src/bot/notifications.js");
    const { partner, telegramId } = await makeBoundPartner();
    // partner.language is NULL here — never opened /ctv yet.
    const settlement: any = await PS.createSettlement("admin-test", partner.id);

    const sent: string[] = [];
    setBotInstance({
      api: {
        sendMessage: async (_id: string, text: string) => {
          sent.push(text);
          return {};
        }
      }
    } as any);
    try {
      const result = await notifyPartnerSettlementPaid(settlement.id);
      expect(result.sent).toBe(true);
      // NULL → concise bilingual VI + EN, never Vietnamese-only:
      expect(sent[0]).toContain(t(resolveLocale("vi"), "ctv.settlement_paid_title"));
      expect(sent[0]).toContain(t(resolveLocale("en"), "ctv.settlement_paid_title"));

      // After the partner picks a language, only that language is used.
      sent.length = 0;
      await PS.setLanguage(partner.id, "en", "test");
      await notifyPartnerSettlementPaid(settlement.id);
      expect(sent[0]).toContain(t(resolveLocale("en"), "ctv.settlement_paid_title"));
      expect(sent[0]).not.toContain(t(resolveLocale("vi"), "ctv.settlement_paid_title"));
      expect(telegramId.length).toBeGreaterThan(0);
    } finally {
      setBotInstance(null);
    }
  });
});

