import { describe, it, expect } from "vitest";
import { applyRateInput, parseRateInput } from "../src/bot/admin/admin-rates.js";
import {
  clearAdminSession,
  getAdminSession,
  startWizard,
  updateWizard
} from "../src/bot/admin/admin-session.js";

describe("Admin Phase 2 — rate input parser (deterministic only)", () => {
  it("parses absolute values", () => {
    expect(parseRateInput("26200")).toEqual({ kind: "absolute", value: 26200 });
    expect(parseRateInput("26 200")).toEqual({ kind: "absolute", value: 26200 });
  });

  it("parses signed deltas", () => {
    expect(parseRateInput("+50")).toEqual({ kind: "delta", value: 50 });
    expect(parseRateInput("-100")).toEqual({ kind: "delta", value: -100 });
  });

  it("parses natural Vietnamese deltas", () => {
    expect(parseRateInput("tăng 50")).toEqual({ kind: "delta", value: 50 });
    expect(parseRateInput("giảm 100")).toEqual({ kind: "delta", value: -100 });
    expect(parseRateInput("tăng usd vnd thêm 50")).toEqual({ kind: "delta", value: 50 });
  });

  it("rejects ambiguous decimal/thousands separators", () => {
    expect(parseRateInput("1.000").kind).toBe("error");
    expect(parseRateInput("1,000").kind).toBe("error");
  });

  it("rejects non-numeric input", () => {
    expect(parseRateInput("abc").kind).toBe("error");
    expect(parseRateInput("").kind).toBe("error");
  });

  it("applyRateInput never inverts (VND→USD edits the same base reference)", () => {
    const current = 25400;
    // Absolute input stays absolute (never 1/rate).
    expect(applyRateInput(current, { kind: "absolute", value: 26200 })).toBe(26200);
    // Deltas add/subtract against the base reference.
    expect(applyRateInput(current, { kind: "delta", value: 50 })).toBe(25450);
    expect(applyRateInput(current, { kind: "delta", value: -100 })).toBe(25300);
    // Sanity: result is always in "VND per 1 USD" magnitude, never a tiny reciprocal.
    expect(applyRateInput(current, { kind: "absolute", value: 26200 })).toBeGreaterThan(1);
  });
});

describe("Admin Phase 2 — wizard session isolation", () => {
  it("wizards are isolated per admin and merge data", () => {
    clearAdminSession("adminA");
    clearAdminSession("adminB");
    startWizard("adminA", "account_add", {});
    startWizard("adminB", "rate_edit", { direction: "usd_vnd" });

    expect(getAdminSession("adminA").wizard?.kind).toBe("account_add");
    expect(getAdminSession("adminB").wizard?.kind).toBe("rate_edit");

    updateWizard("adminA", { step: 2, data: { bankName: "Vietcombank" } });
    expect(getAdminSession("adminA").wizard?.step).toBe(2);
    expect(getAdminSession("adminA").wizard?.data.bankName).toBe("Vietcombank");
    // B is untouched.
    expect(getAdminSession("adminB").wizard?.step).toBe(1);

    clearAdminSession("adminA");
    clearAdminSession("adminB");
  });
});
