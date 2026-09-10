import { describe, it, expect } from "vitest";
import {
  CSKH_PAGE_SIZE,
  activeRowText,
  escapeHtml,
  getCskhHomeKeyboard,
  getCustomerDetailKeyboard,
  getCustomerPreviewKeyboard,
  getHistoryKeyboard,
  messageLine,
  orderContextText,
  paginate,
  quoteNeedText,
  renderCskhHomeText,
  renderCustomerDetailText,
  renderCustomerPreviewText,
  renderHistoryText,
  senderLabel,
  shortCustomerLabel,
  shortTime,
  staffDisplayName,
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
    expect(paginate(items, 99).totalPages).toBe(3);
    expect(paginate(items, 99).pageItems).toHaveLength(2);
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

describe("CSKH panel C2 helpers", () => {
  it("senderLabel maps customer/bot/staff/system", () => {
    expect(senderLabel("CUSTOMER")).toBe("👤 Khách");
    expect(senderLabel("AI")).toBe("🤖 Bot");
    expect(senderLabel("BOT")).toBe("🤖 Bot");
    expect(senderLabel("CSKH")).toBe("👨‍💼 CSKH");
    expect(senderLabel("ADMIN")).toBe("👨‍💼 CSKH");
    expect(senderLabel("SYSTEM")).toBe("🛎 Hệ thống");
  });

  it("escapeHtml neutralizes tags/ampersands", () => {
    expect(escapeHtml("<b>&</b>")).toBe("&lt;b&gt;&amp;&lt;/b&gt;");
  });

  it("shortTime formats and tolerates invalid", () => {
    expect(shortTime("2026-01-01T09:05:00Z")).toMatch(/\d{2}:\d{2}/);
    expect(shortTime("not-a-date")).toBe("");
  });

  it("staffDisplayName: name(role) > short id fallback > unassigned", () => {
    expect(staffDisplayName({ name: "Long", role: "CSKH" })).toBe("Long (CSKH)");
    expect(staffDisplayName({ name: "Long" })).toBe("Long");
    expect(staffDisplayName(null, "tg_12345678")).toBe("#345678");
    expect(staffDisplayName(null, null)).toBe("Chưa phân công");
  });

  it("messageLine renders sender, content, time", () => {
    const line = messageLine({ senderType: "CUSTOMER", content: "100 do", createdAt: "2026-01-01T09:05:00Z" });
    expect(line).toContain("👤 Khách");
    expect(line).toContain("100 do");
  });

  it("detail text includes identity, owner, need, order, lastSeen", () => {
    const conv = {
      customerId: "cktest0000000000000001",
      mode: "HUMAN",
      claimedById: "tg_owner",
      customer: customer({ fullName: "Tomy", username: "tomy" })
    } as never;
    const text = renderCustomerDetailText(conv, {
      owner: "Long (CSKH)",
      need: "100 USD → VND",
      order: "Đơn …",
      lastSeen: "09:05"
    });
    expect(text).toContain("👤 <b>Khách</b>: Tomy");
    expect(text).toContain("🔗 @tomy");
    expect(text).toContain("👨‍💼 Người phụ trách: Long (CSKH)");
    expect(text).toContain("💱 Nhu cầu / báo giá: 100 USD → VND");
    expect(text).toContain("📦 Đơn hàng");
    expect(text).toContain("🕒");
  });

  it("detail keyboard: unclaimed shows claim, owned shows release, never both", () => {
    const unclaimed = getCustomerDetailKeyboard(conversation({ mode: "HUMAN", claimedById: null }) as never);
    const uButtons = unclaimed.inline_keyboard.flat().map((b) => b.text);
    expect(uButtons).toContain("✅ Nhận khách");
    expect(uButtons).not.toContain("↩️ Trả khách (kết thúc hỗ trợ)");
    expect(uButtons).toContain("📦 Xem đơn");
    expect(uButtons).toContain("🕘 Lịch sử");

    const owned = getCustomerDetailKeyboard(conversation({ mode: "HUMAN", claimedById: "me" }) as never, { isMine: true });
    const oButtons = owned.inline_keyboard.flat().map((b) => b.text);
    expect(oButtons).not.toContain("✅ Nhận khách");
    expect(oButtons).toContain("↩️ Trả khách (kết thúc hỗ trợ)");
  });

  it("history text: empty vs paginated", () => {
    expect(renderHistoryText("Tomy", [], 1, 1)).toContain("Không có tin nhắn nào.");
    const text = renderHistoryText(
      "Tomy",
      [{ senderType: "CUSTOMER", content: "xin chào", createdAt: "2026-01-01T09:00:00Z" }],
      2,
      3
    );
    expect(text).toContain("trang 2/3");
    expect(text).toContain("👤 Khách");
  });

  it("history keyboard: prev/next only when valid + back/home always", () => {
    const single = getHistoryKeyboard("c1", 1, 1).inline_keyboard.flat().map((b) => b.text);
    expect(single).not.toContain("⬅️");
    expect(single).not.toContain("➡️");
    expect(single).toContain("⬅️ Quay lại");
    expect(single).toContain("🏠 Menu CSKH");

    const mid = getHistoryKeyboard("c1", 2, 3).inline_keyboard.flat().map((b) => b.text);
    expect(mid).toContain("⬅️");
    expect(mid).toContain("➡️");
  });
});

    expect(text).toContain("🆔");
    expect(text).toContain("👨‍💼 Người phụ trách");
    expect(text).toContain("💱 Nhu cầu: 100 USD → VND");
    expect(text).toContain("📦 Đơn hàng");
  });
});
