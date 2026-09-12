import { describe, it, expect } from "vitest";
import {
  computeCrmStats,
  computeCompletedVolume,
  computeRiskLevel,
  orderStatusIcon
} from "../src/modules/crm/customer-crm.js";

/**
 * Part B — Customer mini-CRM pure helpers (B1–B3).
 */

describe("Part B — status icon mapping (B4)", () => {
  it("maps every status per the spec", () => {
    expect(orderStatusIcon("COMPLETED")).toBe("✅");
    expect(orderStatusIcon("CANCELLED")).toBe("❌");
    expect(orderStatusIcon("WAITING_PAYMENT")).toBe("⏳");
    expect(orderStatusIcon("CUSTOMER_SENT_BILL")).toBe("🧾");
    expect(orderStatusIcon("WAITING_ADMIN_VERIFY")).toBe("🧾");
    expect(orderStatusIcon("PAYMENT_CONFIRMED")).toBe("💸");
    expect(orderStatusIcon("WAITING_PAYOUT")).toBe("💸");
    expect(orderStatusIcon("PAYOUT_SENT")).toBe("💸");
    expect(orderStatusIcon("PAYMENT_MISMATCH")).toBe("⚠️");
    expect(orderStatusIcon("MANUAL_REVIEW")).toBe("⚠️");
    expect(orderStatusIcon("SUSPICIOUS")).toBe("🚨");
    expect(orderStatusIcon("")).toBe("⏳");
  });
});

describe("Part B — cancellation rate math (B1)", () => {
  it("counts completed/cancelled/active and excludes active from the denominator", () => {
    const orders = [
      { status: "COMPLETED" },
      { status: "COMPLETED" },
      { status: "CANCELLED" },
      { status: "CANCELLED" },
      { status: "CANCELLED" },
      { status: "WAITING_PAYMENT" },
      { status: "PAYMENT_CONFIRMED" }
    ];
    const stats = computeCrmStats(orders);
    expect(stats.completed).toBe(2);
    expect(stats.cancelled).toBe(3);
    expect(stats.active).toBe(2);
    expect(stats.cancellationRatePct).toBe(60); // 3 / (2+3), active excluded
  });

  it("shows no fake 0% when there are no terminal orders", () => {
    expect(computeCrmStats([{ status: "WAITING_PAYMENT" }]).cancellationRatePct).toBeNull();
    expect(computeCrmStats([]).cancellationRatePct).toBeNull();
  });
});

describe("Part B — completed volume (B2)", () => {
  it("uses COMPLETED only and never mixes USD with VND", () => {
    const vol = computeCompletedVolume([
      { status: "COMPLETED", sourceCurrency: "USD", sourceAmount: 100 },
      { status: "COMPLETED", sourceCurrency: "USD", sourceAmount: 50.5 },
      { status: "COMPLETED", sourceCurrency: "VND", sourceAmount: 37500000 },
      { status: "CANCELLED", sourceCurrency: "USD", sourceAmount: 999 },
      { status: "WAITING_PAYMENT", sourceCurrency: "VND", sourceAmount: 1 }
    ]);
    expect(vol.usdToVnd).toBe("150.5");
    expect(vol.vndToUsd).toBe("37500000");
  });

  it("returns null totals per direction when none completed", () => {
    const vol = computeCompletedVolume([{ status: "CANCELLED", sourceCurrency: "USD", sourceAmount: 10 }]);
    expect(vol.usdToVnd).toBeNull();
    expect(vol.vndToUsd).toBeNull();
  });
});

describe("Part B — deterministic risk signals (B3)", () => {
  it("HIGH only for SUSPICIOUS, with reasons", () => {
    const r = computeRiskLevel([{ status: "SUSPICIOUS" }, { status: "COMPLETED" }]);
    expect(r.level).toBe("HIGH");
    expect(r.reasons.join(" ")).toContain("SUSPICIOUS");
  });

  it("WATCH for PAYMENT_MISMATCH / MANUAL_REVIEW history", () => {
    expect(computeRiskLevel([{ status: "PAYMENT_MISMATCH" }]).level).toBe("WATCH");
    expect(computeRiskLevel([{ status: "MANUAL_REVIEW" }]).level).toBe("WATCH");
  });

  it("WATCH for cancellation rate ≥ 40% with ≥ 3 terminal orders", () => {
    const orders = [
      { status: "CANCELLED" }, { status: "CANCELLED" }, { status: "COMPLETED" },
      { status: "WAITING_PAYMENT" } // active never enters the denominator
    ];
    const r = computeRiskLevel(orders);
    expect(r.level).toBe("WATCH");
    expect(r.reasons.some((x) => x.includes("Tỷ lệ hủy 67%"))).toBe(true);
  });

  it("NOT risk: volume, newness, few transactions, CTV attribution alone", () => {
    // High volume + few transactions + no signals → NORMAL.
    const r = computeRiskLevel([
      { status: "COMPLETED" }, { status: "COMPLETED" }, { status: "COMPLETED" }
    ]);
    expect(r.level).toBe("NORMAL");
    expect(r.reasons).toEqual([]);
  });
});
