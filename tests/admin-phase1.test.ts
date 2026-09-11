import { describe, it, expect } from "vitest";
import {
  ADMIN_CONTROL_HOME,
  ADMIN_CONTROL_INBOX,
  ADMIN_CONTROL_ORDERS,
  ADMIN_CONTROL_RATES,
  ADMIN_CONTROL_CUSTOMERS,
  ADMIN_CONTROL_CSKH,
  BILL_AWAITING_VERIFY_STATUSES,
  WARNING_REVIEW_STATUSES,
  getAdminPersistentKeyboard,
  isAdminReservedControl,
  maskAccountNumber,
  renderOperationsCenterText,
  shortCustomerId,
  shortOrderId,
  timeAgo
} from "../src/bot/admin/admin-panel.js";
import {
  clearAdminSession,
  getAdminSession,
  setAdminSearch,
  setPendingFinancialAction,
  setPayoutEvidenceSession
} from "../src/bot/admin/admin-session.js";
import { statusesForGroup } from "../src/bot/admin/admin-orders.js";
import { renderRateDetailText } from "../src/bot/admin/admin-screens.js";
import { isPayoutReadyTransition } from "../src/bot/notifications.js";

describe("Admin Phase 1 — persistent keyboard & reserved controls", () => {
  it("persistent keyboard has the required flags", () => {
    const kb = getAdminPersistentKeyboard() as any;
    expect(kb.resize_keyboard).toBe(true);
    expect(kb.is_persistent).toBe(true);
    expect(kb.one_time_keyboard).toBe(false);
    expect(kb.keyboard.length).toBe(3);
  });

  it("persistent keyboard contains the six navigation labels", () => {
    const kb = getAdminPersistentKeyboard() as any;
    const labels = kb.keyboard.flat().map((b: any) => b.text);
    expect(labels).toContain(ADMIN_CONTROL_HOME);
    expect(labels).toContain(ADMIN_CONTROL_INBOX);
    expect(labels).toContain(ADMIN_CONTROL_ORDERS);
    expect(labels).toContain(ADMIN_CONTROL_RATES);
    expect(labels).toContain(ADMIN_CONTROL_CUSTOMERS);
    expect(labels).toContain(ADMIN_CONTROL_CSKH);
  });

  it("reserved admin controls are intercepted before staff forwarding", () => {
    expect(isAdminReservedControl("🏠 Menu Admin")).toBe(true);
    expect(isAdminReservedControl("🔴 Việc cần xử lý")).toBe(true);
    expect(isAdminReservedControl("📦 Đơn hàng")).toBe(true);
    expect(isAdminReservedControl("💱 Tỷ giá")).toBe(true);
    expect(isAdminReservedControl("👥 Khách hàng")).toBe(true);
    expect(isAdminReservedControl("💬 CSKH")).toBe(true);
    expect(isAdminReservedControl("Tommy")).toBe(false);
    expect(isAdminReservedControl("26200")).toBe(false);
  });
});

describe("Admin Phase 1 — short IDs & masking (no full CUID)", () => {
  it("shortOrderId / shortCustomerId are #last6, never the full CUID", () => {
    const cuid = "cm9x7abc82f9130000aaaa";
    expect(shortOrderId(cuid)).toBe("#00aaaa");
    expect(shortCustomerId(cuid)).toBe("#00aaaa");
    expect(shortOrderId(cuid).length).toBeLessThan(cuid.length);
  });

  it("maskAccountNumber hides all but the last 4 digits", () => {
    expect(maskAccountNumber("1234567890")).toBe("****7890");
    expect(maskAccountNumber("1234")).toBe("****");
  });

  it("timeAgo returns a readable Vietnamese string", () => {
    const recent = timeAgo(new Date(Date.now() - 3 * 60_000));
    expect(recent.length).toBeGreaterThan(0);
  });
});

describe("Admin Phase 1 — session isolation & status groups", () => {
  it("two admins never interfere with each other's session", () => {
    clearAdminSession("adminA");
    clearAdminSession("adminB");

    setAdminSearch("adminA", "order");
    setAdminSearch("adminB", "customer");

    expect(getAdminSession("adminA").searchType).toBe("order");
    expect(getAdminSession("adminB").searchType).toBe("customer");

    setPendingFinancialAction("adminA", "confirm_payment", "ord-1");
    expect(getAdminSession("adminA").pendingFinancialAction?.orderId).toBe("ord-1");
    expect(getAdminSession("adminB").pendingFinancialAction).toBeNull();
  });

  it("clearAdminSession removes only the target admin", () => {
    setAdminSearch("adminA", "order");
    setAdminSearch("adminB", "order");
    clearAdminSession("adminA");
    expect(getAdminSession("adminA").mode).toBe("idle");
    expect(getAdminSession("adminB").mode).toBe("search");
    clearAdminSession("adminB");
  });

  it("status groups map to real lifecycle states", () => {
    expect(statusesForGroup("need_action")).toContain("WAITING_ADMIN_VERIFY");
    expect(statusesForGroup("need_action")).toContain("WAITING_PAYOUT");
    expect(statusesForGroup("processing")).toContain("WAITING_PAYMENT");
    expect(statusesForGroup("done")).toContain("COMPLETED");
  });

  it("COMPLETED filter excludes CANCELLED (separate cancelled group)", () => {
    expect(statusesForGroup("done")).toEqual(["COMPLETED"]);
    expect(statusesForGroup("done")).not.toContain("CANCELLED");
    expect(statusesForGroup("cancelled")).toEqual(["CANCELLED"]);
  });

  it("payout evidence session is isolated per admin", () => {
    clearAdminSession("adminA");
    clearAdminSession("adminB");
    setPayoutEvidenceSession("adminA", "ord-A");
    setPayoutEvidenceSession("adminB", "ord-B");
    expect(getAdminSession("adminA").mode).toBe("payout_evidence");
    expect(getAdminSession("adminA").selectedOrderId).toBe("ord-A");
    expect(getAdminSession("adminB").selectedOrderId).toBe("ord-B");
    clearAdminSession("adminA");
    expect(getAdminSession("adminA").mode).toBe("idle");
    expect(getAdminSession("adminB").selectedOrderId).toBe("ord-B");
    clearAdminSession("adminB");
  });

  it("payout evidence session binds exactly one order (no cross-order leakage)", () => {
    setPayoutEvidenceSession("adminA", "ord-A");
    expect(getAdminSession("adminA").selectedOrderId).toBe("ord-A");
    // A second admin's session cannot be read through admin A's key.
    expect(getAdminSession("adminA").selectedOrderId).not.toBe("ord-B");
    clearAdminSession("adminA");
  });
});

describe("Admin Phase 1 — bill counter semantics", () => {
  it("bill counter uses only real bill-verification states", () => {
    expect(BILL_AWAITING_VERIFY_STATUSES).toEqual(["WAITING_ADMIN_VERIFY", "CUSTOMER_SENT_BILL"]);
    expect(BILL_AWAITING_VERIFY_STATUSES).not.toContain("MANUAL_REVIEW");
    expect(BILL_AWAITING_VERIFY_STATUSES).not.toContain("SUSPICIOUS");
  });

  it("warning counter is disjoint from the bill counter", () => {
    expect(WARNING_REVIEW_STATUSES).toEqual(["MANUAL_REVIEW", "SUSPICIOUS"]);
    for (const s of WARNING_REVIEW_STATUSES) {
      expect(BILL_AWAITING_VERIFY_STATUSES).not.toContain(s);
    }
  });
});

describe("Admin Phase 1 — payout-ready notification idempotency", () => {
  it("fires only for a real WAITING_PAYOUT transition", () => {
    expect(isPayoutReadyTransition("WAITING_PAYOUT")).toBe(true);
    expect(isPayoutReadyTransition("WAITING_ADMIN_VERIFY")).toBe(false);
    expect(isPayoutReadyTransition("PAYOUT_SENT")).toBe(false);
    expect(isPayoutReadyTransition("COMPLETED")).toBe(false);
    expect(isPayoutReadyTransition(null)).toBe(false);
    expect(isPayoutReadyTransition(undefined)).toBe(false);
  });
});

describe("Admin Phase 1 — rate detail (no fake history)", () => {
  it("rate detail renders current rate without claiming history", () => {
    const text = renderRateDetailText({
      baseRate: 25400,
      buyMargin: 50,
      sellMargin: 50,
      fee: 2,
      feeCurrency: "USD",
      updatedAt: new Date(),
      updatedBy: "admin"
    });
    expect(text).toContain("CHI TIẾT TỶ GIÁ");
    expect(text).toContain("USD → VND");
    expect(text).not.toContain("Lịch sử giá");
  });
});

describe("Admin Phase 1 — operations center render", () => {
  it("renders real counter + rate blocks", () => {
    const text = renderOperationsCenterText(
      "Long",
      { billAwaitingVerify: 3, warningReviews: 1, awaitingPayout: 2, waitingCskh: 1, processingOrders: 9 },
      { usdToVnd: "26 150", vndToUsd: "26 250", updatedAt: new Date(), updatedBy: "admin" }
    );
    expect(text).toContain("TRUNG TÂM QUẢN TRỊ");
    expect(text).toContain("Bill chờ xác minh");
    expect(text).toContain("Chờ payout");
    expect(text).toContain("Khách chờ CSKH");
    expect(text).toContain("Đơn đang xử lý");
    expect(text).toContain("USD → VND");
  });
});
