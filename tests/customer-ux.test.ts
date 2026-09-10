import { describe, it, expect } from "vitest";
import { getCustomerReplyKeyboard } from "../src/bot/menus/customer-menu.js";
import { matchReservedAction } from "../src/bot/handlers/customer-handler.js";
import { t } from "../src/modules/i18n/locales.js";

function texts(locale: string, inHuman: boolean): string[] {
  return getCustomerReplyKeyboard(locale, inHuman).keyboard.flat().map((b) => b.text);
}

describe("customer persistent keyboard", () => {
  it("AUTO vi keyboard has exchange/orders/support/language", () => {
    expect(texts("vi", false)).toEqual(["💱 Đổi tiền", "📦 Đơn của tôi", "💬 Hỗ trợ", "🌐 Ngôn ngữ"]);
  });

  it("HUMAN vi keyboard has exit_support/support_active instead of exchange/support", () => {
    const t = texts("vi", true);
    expect(t).toContain("↩️ Quay lại đổi tiền");
    expect(t).toContain("💬 Đang hỗ trợ");
    expect(t).not.toContain("💱 Đổi tiền");
    expect(t).not.toContain("💬 Hỗ trợ");
  });

  it("is persistent + resized, not one-time", () => {
    const kb = getCustomerReplyKeyboard("vi", false) as { resize_keyboard: boolean; is_persistent: boolean; one_time_keyboard: boolean };
    expect(kb.resize_keyboard).toBe(true);
    expect(kb.is_persistent).toBe(true);
    expect(kb.one_time_keyboard).toBe(false);
  });

  it("supports en/km/zh locales without Vietnamese leftovers", () => {
    expect(texts("en", false)).toEqual(["💱 Exchange", "📦 My orders", "💬 Support", "🌐 Language"]);
    expect(texts("zh", false).every((x) => !/à|á|đ|ổ|Đ|ề/.test(x))).toBe(true);
  });
});

describe("customer reserved controls (cross-locale fail-safe)", () => {
  it("recognizes reserved navigation labels across all locales", () => {
    expect(matchReservedAction("💱 Đổi tiền")).toBe("exchange");
    expect(matchReservedAction("💱 Exchange")).toBe("exchange");
    expect(matchReservedAction("📦 Đơn của tôi")).toBe("orders");
    expect(matchReservedAction("🌐 Ngôn ngữ")).toBe("language");
    expect(matchReservedAction("💬 Đang hỗ trợ")).toBe("support_active");
    expect(matchReservedAction("💬 Hỗ trợ")).toBe("support");
    expect(matchReservedAction("↩️ Quay lại đổi tiền")).toBe("exit_support");
  });

  it("old Vietnamese reserved button after switching locale is still intercepted", () => {
    // Customer switched vi -> km but an old "💱 Đổi tiền" button is visible.
    expect(matchReservedAction("💱 Đổi tiền")).toBe("exchange");
    expect(matchReservedAction("💬 Hỗ trợ")).toBe("support");
  });

  it("freeform exchange text is NOT a reserved control (goes to parser/AI)", () => {
    expect(matchReservedAction("100 đô")).toBeNull();
    expect(matchReservedAction("xin chào")).toBeNull();
    expect(matchReservedAction("đổi 2 triệu lấy đô")).toBeNull();
  });
});
describe("customer welcome footer copy", () => {
  it("vi footer no longer mentions AI assistant", () => {
    const vi = t("vi", "welcome.footer");
    expect(vi).not.toContain("Trợ lý AI");
    expect(vi).toContain("Đội ngũ CSKH luôn sẵn sàng hỗ trợ");
  });

  it("en footer no longer mentions AI assistant", () => {
    const en = t("en", "welcome.footer");
    expect(en).not.toContain("AI assistant");
    expect(en).toContain("Support staff");
  });
});

