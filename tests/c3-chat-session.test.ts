import { describe, it, expect } from "vitest";
import { clearSelectedCustomer, getSelectedCustomer, setSelectedCustomer } from "../src/bot/state/staff-chat-session.js";
import { getReplyModeKeyboard, renderReplyModeText } from "../src/bot/menus/cskh-panel.js";

describe("C3 per-staff selected chat", () => {
  it("isolates selections per staff and switches safely", () => {
    setSelectedCustomer("staffA", "custX");
    setSelectedCustomer("staffB", "custY");
    expect(getSelectedCustomer("staffA")).toBe("custX");
    expect(getSelectedCustomer("staffB")).toBe("custY");

    // A switches X -> Z; B is untouched.
    setSelectedCustomer("staffA", "custZ");
    expect(getSelectedCustomer("staffA")).toBe("custZ");
    expect(getSelectedCustomer("staffB")).toBe("custY");
  });

  it("clear removes only that staff's selection", () => {
    setSelectedCustomer("staffA", "custZ");
    setSelectedCustomer("staffB", "custY");
    clearSelectedCustomer("staffA");
    expect(getSelectedCustomer("staffA")).toBeUndefined();
    expect(getSelectedCustomer("staffB")).toBe("custY");
  });

  it("no selection returns undefined (fail closed)", () => {
    expect(getSelectedCustomer("never-seen")).toBeUndefined();
  });

  it("reply keyboard offers history / switch / exit / home", () => {
    const kb = getReplyModeKeyboard("custX");
    const buttons = kb.inline_keyboard.flat().map((b) => b.text);
    expect(buttons).toContain("🕘 Lịch sử");
    expect(buttons).toContain("🔄 Chọn khách khác");
    expect(buttons).toContain("↩️ Thoát trả lời");
    expect(buttons).toContain("🏠 Menu CSKH");
  });

  it("reply text names the selected customer and context", () => {
    const conv = {
      customerId: "custX",
      mode: "HUMAN",
      claimedById: "s1",
      customer: { id: "custX", username: null, fullName: "Tomy" }
    } as never;
    const text = renderReplyModeText(conv, { need: "100 USD → VND" });
    expect(text).toContain("ĐANG TRẢ LỜI KHÁCH");
    expect(text).toContain("Tomy");
    expect(text).toContain("100 USD → VND");
  });
});
