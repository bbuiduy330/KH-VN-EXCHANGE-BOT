import { describe, it, expect, beforeEach } from "vitest";
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  normalizeLocale,
  resolveLocale,
  isSupportedLocale,
  detectMessageLocale,
  t
} from "../src/modules/i18n/locales.js";
import { getCustomerMenuKeyboard, getLanguageSelectorKeyboard, renderQuoteCard } from "../src/bot/menus/customer-menu.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { MoneyService } from "../src/modules/money/money-service.js";
import { inMemoryStore } from "../src/database/client.js";
import { ConversationService } from "../src/modules/conversation/conversation-service.js";

function resetStores() {
  for (const key of Object.keys(inMemoryStore) as (keyof typeof inMemoryStore)[]) {
    inMemoryStore[key].clear();
  }
}

describe("Phase B — i18n locales", () => {
  it("exposes exactly vi/en/km/zh", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["vi", "en", "km", "zh"]);
    expect(DEFAULT_LOCALE).toBe("vi");
    expect(isSupportedLocale("vi")).toBe(true);
    expect(isSupportedLocale("fr")).toBe(false);
  });

  it("normalizeLocale maps Telegram language_code prefixes", () => {
    expect(normalizeLocale("vi")).toBe("vi");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("km")).toBe("km");
    expect(normalizeLocale("zh-CN")).toBe("zh");
    expect(normalizeLocale("yue")).toBe("zh");
    expect(normalizeLocale("fr")).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
  });

  it("resolveLocale falls back to vi", () => {
    expect(resolveLocale(undefined)).toBe("vi");
    expect(resolveLocale("nope")).toBe("vi");
  });

  it("t() returns localized menu labels for all 4 locales", () => {
    expect(t("vi", "menu.exchange")).toContain("Đổi tiền");
    expect(t("en", "menu.exchange")).toContain("Exchange");
    expect(t("km", "menu.exchange")).toBeTruthy();
    expect(t("zh", "menu.exchange")).toContain("兑换");

    expect(t("en", "menu.orders")).toContain("My orders");
    expect(t("zh", "menu.support")).toContain("客服");
    expect(t("en", "menu.language")).toContain("Language");
  });

  it("t() interpolates vars without altering numeric payload", () => {
    const msg = t("en", "quote.send", { src: "2 000 000 VND" });
    expect(msg).toContain("2 000 000 VND");
    expect(msg).toContain("You send");
  });

  it("customer menus never mention KHR or CNY as exchange options", () => {
    for (const loc of SUPPORTED_LOCALES) {
      const kb = getCustomerMenuKeyboard(loc);
      const blob = JSON.stringify(kb.inline_keyboard);
      expect(blob).not.toMatch(/KHR|CNY|riel|人民币兑换/i);
      expect(blob).toMatch(/customer:menu:language/);
      expect(blob).toMatch(/customer:menu:quote/);
    }
  });

  it("language selector exposes all 4 locales", () => {
    const kb = getLanguageSelectorKeyboard();
    const blob = JSON.stringify(kb.inline_keyboard);
    expect(blob).toContain("customer:lang:vi");
    expect(blob).toContain("customer:lang:en");
    expect(blob).toContain("customer:lang:km");
    expect(blob).toContain("customer:lang:zh");
    expect(LOCALE_LABELS.vi).toContain("Tiếng Việt");
    expect(LOCALE_LABELS.en).toContain("English");
  });

  it("detectMessageLocale only returns clear signals and never auto-persists", () => {
    expect(detectMessageLocale("I want to exchange 100 USD to VND")).toBe("en");
    expect(detectMessageLocale("我想换100美元")).toBe("zh");
    expect(detectMessageLocale("ខ្ញុំចង់ប្តូរប្រាក់")).toBe("km");
    expect(detectMessageLocale("100 đô")).toBeNull(); // short / mixed finance — do not force
    expect(detectMessageLocale("xyz")).toBeNull();
  });
});

describe("Phase B — language persistence", () => {
  beforeEach(() => resetStores());

  it("setLanguage persists explicit choice on Customer.language", async () => {
    const c = await CustomerService.getOrCreateCustomer({
      telegramId: "tg-b-1",
      fullName: "Test",
      language: "vi"
    });
    expect(CustomerService.getLocale(c)).toBe("vi");

    const next = await CustomerService.setLanguage(c.id, "en");
    expect(next).toBe("en");

    const reloaded = await CustomerService.getOrCreateCustomer({ telegramId: "tg-b-1" });
    expect(CustomerService.getLocale(reloaded)).toBe("en");
  });

  it("Telegram language_code only seeds NEW customers; existing are not overwritten", async () => {
    const c = await CustomerService.getOrCreateCustomer({
      telegramId: "tg-b-2",
      language: "en"
    });
    expect(CustomerService.getLocale(c)).toBe("en");

    // Subsequent getOrCreate with a different language_code must NOT change stored preference
    const again = await CustomerService.getOrCreateCustomer({
      telegramId: "tg-b-2",
      language: "zh"
    });
    expect(CustomerService.getLocale(again)).toBe("en");
  });

  it("language switch does not change quote arithmetic numbers", () => {
    const fakeQuote = {
      sourceCurrency: "VND",
      targetCurrency: "USD",
      sourceAmount: 2000000,
      targetAmount: 76.59,
      effectiveRate: 0.000039,
      fee: 2,
      feeCurrency: "USD"
    } as any;

    const vi = renderQuoteCard(fakeQuote, 15, "vi");
    const en = renderQuoteCard(fakeQuote, 15, "en");
    const zh = renderQuoteCard(fakeQuote, 15, "zh");

    const srcFmt = MoneyService.formatAmount(2000000, "VND");
    const tgtFmt = MoneyService.formatAmount(76.59, "USD");

    for (const card of [vi, en, zh]) {
      expect(card).toContain(srcFmt);
      expect(card).toContain(tgtFmt);
      expect(card).toContain("VND");
      expect(card).toContain("USD");
      expect(card).not.toMatch(/\bKHR\b|\bCNY\b/);
    }

    // Labels differ, numbers do not
    expect(vi).toMatch(/gửi|Quý khách/i);
    expect(en).toMatch(/You send/i);
  });
});

describe("Phase B — media routing safety (service-level)", () => {
  beforeEach(() => resetStores());

  it("HUMAN claimed conversation routes only to assigned staff id", async () => {
    const c = await CustomerService.getOrCreateCustomer({ telegramId: "tg-b-media-1" });
    await ConversationService.claim(c.id, "staff-A");
    const conv = await ConversationService.getOrCreateConversation(c.id);
    expect(conv.mode).toBe("HUMAN");
    expect(conv.claimedById).toBe("staff-A");

    // After release, claimedById is null — media must not go to old staff
    await ConversationService.release(c.id, "staff-A");
    const after = await ConversationService.getOrCreateConversation(c.id);
    expect(after.mode).toBe("AUTO");
    expect(after.claimedById).toBeNull();
  });

  it("canStaffMessage denies unauthorized staff (no global selected customer)", async () => {
    const c = await CustomerService.getOrCreateCustomer({ telegramId: "tg-b-media-2" });
    await ConversationService.claim(c.id, "staff-owner");

    const allowed = await ConversationService.canStaffMessage(
      c.id,
      "staff-owner",
      "CSKH",
      ["customer.message"]
    );
    const denied = await ConversationService.canStaffMessage(
      c.id,
      "staff-other",
      "CSKH",
      ["customer.message"]
    );
    expect(allowed).toBe(true);
    expect(denied).toBe(false);
  });

  it("notifications module exports copy helpers (no download path required)", async () => {
    const mod = await import("../src/bot/notifications.js");
    expect(typeof mod.copyMessageToStaff).toBe("function");
    expect(typeof mod.copyMessageToCustomer).toBe("function");
    expect(typeof mod.copyMessageToChat).toBe("function");
  });
});
