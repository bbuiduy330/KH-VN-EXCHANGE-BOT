import { describe, it, expect } from "vitest";
import {
  CSKH_PAGE_SIZE,
  activeRowText,
  getCskhHomeKeyboard,
  getCustomerPreviewKeyboard,
  orderContextText,
  paginate,
  quoteNeedText,
  renderCskhHomeText,
  renderCustomerPreviewText,
  shortCustomerLabel,
  waitingRowText
} from "../src/bot/menus/cskh-panel.js";

function customer(overrides: Partial<{ id: string; username: string | null; fullName: string | null }> = {}) {
  return {
    id: "cktest0000000000000001",
    username: null as string | null,
    fullName: null as string | null,
    ...overrides
  };
}

function conversation(overrides: Partial<{ mode: string; claimedById: string | null }> = {}) {
  return {
    customerId: "cktest0000000000000001",
    mode: "HUMAN" as string,
    claimedById: null as string | null,
    ...overrides
  };
}

describe("CSKH panel helpers (C1)", () => {
  it("labels customers: username > fullName > #last6 fallback", () => {
    expect(shortCustomerLabel(customer({ username: "tomy" }))).toBe("@tomy");
    expect(shortCustomerLabel(customer({ fullName: "Nguyễn A" }))).toBe("Nguyễn A");
    expect(shortCustomerLabel(customer())).toBe("Khách #000001");
  });

  it("formats quote need as direction text", () => {
    const need = quoteNeedText({
      sourceAmount: 100 as never,
      sourceCurrency: "USD",
      targetAmount: 2535000 as never,
      targetCurrency: "VND"
    });
    expect(need).toContain("100 USD");
    expect(need).toContain("VND");
    expect(need).toContain("→");
  });

  it("formats order context with Vietnamese status", () => {
    const text = orderContextText({
      sourceAmount: 100 as never,
      sourceCurrency: "USD",
      targetAmount: 2535000 as never,
      targetCurrency: "VND",
      status: "WAITING_PAYMENT" as never
    });
    expect(text).toContain("Đơn");
    expect(text).toContain("Chờ thanh toán");
  });

  it("waiting rows show 🟡 + label + need", () => {
    const row = waitingRowText(
      { customer: customer({ username: "abc" }) } as never,
      "100 USD → VND",
      7
    );
    expect(row.startsWith("🟡 @abc")).toBe(true);
    expect(row).toContain("chờ 7p");
    expect(row).toContain("100 USD → VND");
  });

  it("active rows distinguish own vs other staff", () => {
    const conv = { customer: customer({ fullName: "Tomy" }), claimedById: "s1" } as never;
    expect(activeRowText(conv, { isMine: true })).toContain("của bạn");
    expect(activeRowText(conv, { isMine: false, ownerLabel: "staff_2" })).toContain("👨‍💼 staff_2");
  });

  it("paginate clamps out-of-range pages safely (stale buttons)", () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    expect(paginate(items, 1).pageItems).toHaveLength(CSKH_PAGE_SIZE);
    expect(paginate(items, 3).pageItems).toHaveLength(2);
    // Stale/overshoot pages clamp to last valid page
    expect(paginate(items, 99).totalPages).toBe(3);
    expect(paginate(items, 99).pageItems).toHaveLength(2);
    // Empty list still yields one page
    expect(paginate([], 5).totalPages).toBe(1);
    expect(paginate([], 5).pageItems).toHaveLength(0);
  });

  it("home keyboard shows counts and no slash-command list", () => {
    const kb = getCskhHomeKeyboard({ waiting: 3, active: 2 });
    const buttons = kb.inline_keyboard.flat().map((b) => b.text);
    expect(buttons).toContain("🔔 Khách đang chờ (3)");
    expect(buttons).toContain("💬 Đang hỗ trợ (2)");
    expect(buttons).toContain("❓ Hướng dẫn");
    expect(buttons.some((b) => b.startsWith("/"))).toBe(false);
  });

  it("home text greets staff without command manual", () => {
    const text = renderCskhHomeText("Long");
    expect(text).toContain("BÀN CSKH");
    expect(text).toContain("Long");
    expect(text).not.toContain("/tickets");
  });

  it("preview keyboard: claimable shows ✅ Nhận khách, exits always present", () => {
    const claimable = getCustomerPreviewKeyboard(conversation({ mode: "HUMAN", claimedById: null }) as never);
    const claimButtons = claimable.inline_keyboard.flat().map((b) => b.text);
    expect(claimButtons).toContain("✅ Nhận khách");
    expect(claimButtons).toContain("⬅️ Quay lại danh sách");
    expect(claimButtons).toContain("🏠 Menu CSKH");

    const owned = getCustomerPreviewKeyboard(conversation({ mode: "HUMAN", claimedById: "s1" }) as never);
    const ownedButtons = owned.inline_keyboard.flat().map((b) => b.text);
    expect(ownedButtons).not.toContain("✅ Nhận khách");
    expect(ownedButtons).toContain("🏠 Menu CSKH");
  });

  it("preview text shows identity, support state and context", () => {
    const conv = {
      customerId: "cktest0000000000000001",
      mode: "HUMAN",
      claimedById: "s1",
      customer: customer({ fullName: "Tomy" })
    } as never;
    const text = renderCustomerPreviewText(conv, { need: "100 USD → VND", order: "Đơn …" });
    expect(text).toContain("👤 <b>Khách</b>: Tomy");
    expect(text).toContain("🆔");
    expect(text).toContain("👨‍💼 Người phụ trách");
    expect(text).toContain("💱 Nhu cầu: 100 USD → VND");
    expect(text).toContain("📦 Đơn hàng");
  });
});
