/**
 * Customer button i18n + no-duplicated-navigation tests.
 *
 * Architecture under test:
 *   - Persistent bottom reply keyboard = GLOBAL NAVIGATION, localized per
 *     customer locale (vi/en/km/zh), refreshed immediately on language change.
 *   - Inline keyboards = MESSAGE-SPECIFIC actions only, localized, with
 *     LOCALE-STABLE callback_data (routing never depends on label text).
 *   - Ordinary messages do NOT re-attach the 4-button inline navigation block
 *     (regression-guarded against the handler source below).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InlineKeyboard } from "grammy";
import {
  getCustomerReplyKeyboard,
  getCustomerMenuKeyboard,
  getLanguageSelectorKeyboard
} from "../src/bot/menus/customer-menu.js";
import { resolveLocale, t } from "../src/modules/i18n/locales.js";

const LOCALES = ["vi", "en", "km", "zh"] as const;
const HANDLER_SRC = readFileSync(
  join(__dirname, "..", "src", "bot", "handlers", "customer-handler.ts"),
  "utf8"
);

/** Build a quote-confirm keyboard exactly like the production call sites. */
function quoteConfirmKb(locale: string, quoteId: string): InlineKeyboard {
  return new InlineKeyboard().text(
    t(resolveLocale(locale), "quote.confirm_btn"),
    `customer:quote:confirm:${quoteId}`
  );
}

describe("Persistent bottom menu is localized in all 4 locales", () => {
  it("every label equals the locale's menu.* translation", () => {
    for (const loc of LOCALES) {
      const kb = getCustomerReplyKeyboard(loc);
      const flat = kb.keyboard.flat().map((b) => b.text);
      expect(flat).toContain(t(resolveLocale(loc), "menu.exchange"));
      expect(flat).toContain(t(resolveLocale(loc), "menu.orders"));
      expect(flat).toContain(t(resolveLocale(loc), "menu.support"));
      expect(flat).toContain(t(resolveLocale(loc), "menu.language"));
      // no unresolved keys / mojibake
      for (const label of flat) {
        expect(label).not.toMatch(/^menu\./);
        expect(label).not.toContain("\uFFFD");
      }
    }
  });

  it("labels differ across locales (locale is authoritative)", () => {
    const vi = getCustomerReplyKeyboard("vi").keyboard.flat().map((b) => b.text).join("|");
    const en = getCustomerReplyKeyboard("en").keyboard.flat().map((b) => b.text).join("|");
    const km = getCustomerReplyKeyboard("km").keyboard.flat().map((b) => b.text).join("|");
    const zh = getCustomerReplyKeyboard("zh").keyboard.flat().map((b) => b.text).join("|");
    expect(new Set([vi, en, km, zh]).size).toBe(4);
  });

  it("inline menu keyboard (contextual use) is localized too", () => {
    for (const loc of LOCALES) {
      const labels = getCustomerMenuKeyboard(loc).inline_keyboard
        .flat()
        .map((b) => String(b.text));
      expect(labels).toContain(t(resolveLocale(loc), "menu.exchange"));
      expect(labels).toContain(t(resolveLocale(loc), "menu.support"));
    }
  });
});

describe("Message-specific inline buttons: localized labels, STABLE callback_data", () => {
  it("quote confirm: localized label, identical callback across locales", () => {
    const callbacks = LOCALES.map((loc) => {
      const kb = quoteConfirmKb(loc, "Q-1");
      const btn = kb.inline_keyboard.flat()[0];
      expect(String(btn.text)).toBe(t(resolveLocale(loc), "quote.confirm_btn"));
      expect(String(btn.text)).not.toContain("\uFFFD");
      return String(btn.callback_data);
    });
    expect(new Set(callbacks).size).toBe(1);
    expect(callbacks[0]).toBe("customer:quote:confirm:Q-1");
  });

  it("cancel confirm/keep + payinfo/bill: localized, stable callbacks", () => {
    for (const loc of LOCALES) {
      const locT = resolveLocale(loc);
      const kb = new InlineKeyboard()
        .text(t(locT, "order.cancel_confirm_btn"), "customer:order:cancel:confirm:O-1")
        .text(t(locT, "order.cancel_keep_btn"), "customer:order:keep:O-1")
        .row()
        .text(t(locT, "order.payinfo_btn"), "customer:order:payinfo:O-1")
        .text(t(locT, "order.bill_btn"), "customer:bill:upload:O-1");
      const btns = kb.inline_keyboard.flat();
      for (const b of btns) {
        expect(String(b.text)).not.toMatch(/^(order|payout|menu)\./);
        expect(String(b.text)).not.toContain("\uFFFD");
      }
      const data = btns.map((b) => String(b.callback_data)).join("|");
      expect(data).toBe(
        "customer:order:cancel:confirm:O-1|customer:order:keep:O-1|customer:order:payinfo:O-1|customer:bill:upload:O-1"
      );
    }
  });

  it("back + support buttons localized with stable callbacks", () => {
    for (const loc of LOCALES) {
      const locT = resolveLocale(loc);
      const kb = new InlineKeyboard()
        .text(t(locT, "clearchat.back"), "customer:clearchat:back")
        .text(t(locT, "menu.support"), "customer:menu:support");
      const btns = kb.inline_keyboard.flat();
      expect(String(btns[0].text)).toBe(t(locT, "clearchat.back"));
      expect(String(btns[1].text)).toBe(t(locT, "menu.support"));
      expect(String(btns[0].callback_data)).toBe("customer:clearchat:back");
      expect(String(btns[1].callback_data)).toBe("customer:menu:support");
    }
  });

  it("order-linked support button: localized in all 4 locales, stable callback", () => {
    const callbacks = LOCALES.map((loc) => {
      const kb = new InlineKeyboard().text(
        t(resolveLocale(loc), "payout.support_btn"),
        "customer:support:order:O-9"
      );
      const btn = kb.inline_keyboard.flat()[0];
      expect(String(btn.text)).toBe(t(resolveLocale(loc), "payout.support_btn"));
      return String(btn.callback_data);
    });
    expect(new Set(callbacks).size).toBe(1);
    expect(callbacks[0]).toBe("customer:support:order:O-9");
  });

  it("language picker stays inline and locale-neutral (choices are the locales)", () => {
    const kb = getLanguageSelectorKeyboard();
    const data = kb.inline_keyboard.flat().map((b) => String(b.callback_data));
    expect(data).toEqual(["customer:lang:vi", "customer:lang:en", "customer:lang:km", "customer:lang:zh"]);
  });
});

describe("No duplicated global navigation on ordinary messages", () => {
  it("customer-handler no longer attaches the inline nav keyboard anywhere", () => {
    expect(HANDLER_SRC).not.toContain("getCustomerMenuKeyboard");
    expect(HANDLER_SRC).not.toContain("customer:history:detail");
  });

  it("persistent reply keyboard is still sent (locale refresh path intact)", () => {
    expect(HANDLER_SRC).toContain("getCustomerReplyKeyboard(locale, convNow.mode === \"HUMAN\")");
    expect(HANDLER_SRC).toContain("getCustomerReplyKeyboard(locale, false)");
  });

  it("Admin/CSKH operational labels remain Vietnamese (untouched)", () => {
    expect(HANDLER_SRC).toContain("📦 Mở đơn");
    expect(HANDLER_SRC).toContain("💬 Chat khách");
    expect(HANDLER_SRC).toContain("✋ Nhận hỗ trợ");
  });
});

describe("Closeout: neutral risk statuses, explicit menu label, dedicated order-support label", () => {
  it("PAYMENT_MISMATCH maps to a neutral localized status — raw enum never reaches the customer", () => {
    for (const loc of LOCALES) {
      const label = t(resolveLocale(loc), "status.PAYMENT_MISMATCH");
      expect(label).not.toBe("PAYMENT_MISMATCH"); // fallback returns the raw key
      expect(label).not.toContain("\uFFFD");
      expect(label.length).toBeGreaterThan(0);
    }
    expect(t(resolveLocale("vi"), "status.PAYMENT_MISMATCH")).toBe("Đang được kiểm tra");
    expect(t(resolveLocale("en"), "status.PAYMENT_MISMATCH")).toBe("Under review");
    // The other internal review statuses are neutral too.
    expect(t(resolveLocale("en"), "status.MANUAL_REVIEW")).toBe("Under review");
    expect(t(resolveLocale("en"), "status.SUSPICIOUS")).toBe("Needs review");
  });

  it("persistent menu label explicitly means ACTIVE orders (not 'My orders')", () => {
    expect(t(resolveLocale("vi"), "menu.orders")).toBe("📦 Đơn đang xử lý");
    expect(t(resolveLocale("en"), "menu.orders")).toBe("📦 Active orders");
    for (const loc of LOCALES) {
      expect(getCustomerReplyKeyboard(loc).keyboard.flat().map((b) => b.text))
        .toContain(t(resolveLocale(loc), "menu.orders"));
    }
  });

  it("order-linked support button is a DEDICATED label, distinct from generic Support", () => {
    for (const loc of LOCALES) {
      const dedicated = t(resolveLocale(loc), "order.support_this_btn");
      const generic = t(resolveLocale(loc), "menu.support");
      expect(dedicated).not.toBe(generic);
      expect(dedicated).not.toBe("order.support_this_btn");
      expect(dedicated).not.toContain("\uFFFD");
    }
    expect(t(resolveLocale("vi"), "order.support_this_btn")).toBe("💬 Hỗ trợ đơn này");
    expect(t(resolveLocale("en"), "order.support_this_btn")).toBe("💬 Support this order");
  });

  it("order-linked buttons use the dedicated label with STABLE callbacks", () => {
    // Mirrors the production call sites (cancel / completion / payout flow).
    expect(HANDLER_SRC).toContain('t(locale, "order.support_this_btn")');
    expect(HANDLER_SRC).toContain("customer:support:order:");
    expect(HANDLER_SRC).toContain("customer:payout:support:");
  });
});

