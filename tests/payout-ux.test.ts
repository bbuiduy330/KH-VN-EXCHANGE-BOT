import { describe, it, expect } from "vitest";
import { OrderService } from "../src/modules/orders/order-service.js";
import { shouldNotifyPayoutReady, isPayoutReadyTransition } from "../src/bot/notifications.js";
import {
  generateTransferMemo,
  validateTransferMemoTemplate,
  DEFAULT_TRANSFER_MEMO_TEMPLATE
} from "../src/modules/orders/transfer-memo.js";
import {
  parsePayoutDestinationText,
  parsePayoutDestinationWithAi,
  decodePayoutQrImage
} from "../src/modules/orders/payout-destination.js";
import { SUPPORTED_LOCALES, t } from "../src/modules/i18n/locales.js";
import { STATUS_VI } from "../src/bot/menus/cskh-panel.js";

const LIFECYCLE_KEYS = [
  "welcome.hello",
  "welcome.example_1",
  "welcome.example_2",
  "welcome.examples_intro",
  "quote.title",
  "quote.confirm_btn",
  "order.created_title",
  "order.transfer_amount",
  "order.pay_to",
  "order.pay_memo",
  "order.pay_memo_hint",
  "order.pay_later_note",
  "order.pay_qr_caption",
  "order.list_empty",
  "order.cancel_none",
  "order.cancel_success",
  "order.cancel_error",
  "bill.none",
  "bill.wait_verify",
  "bill.suspicious",
  "bill.manual_review",
  "payout.before_verified",
  "payout.awaiting_info",
  "payout.choose_title",
  "payout.recent_header",
  "payout.no_recent",
  "payout.new_text",
  "payout.new_qr",
  "payout.support_btn",
  "payout.text_input_hint",
  "payout.qr_input_hint",
  "payout.preview_title",
  "payout.preview_bank",
  "payout.preview_account",
  "payout.preview_holder",
  "payout.preview_qr",
  "payout.confirm_hint",
  "payout.confirm_btn",
  "payout.edit_btn",
  "payout.saved",
  "payout.qr_attached",
  "payout.invalid",
  "payout.qr_invalid",
  "payout.not_ready",
  "payout.session_expired",
  "payout.no_eligible",
  "payout.quote_expired",
  "bank.currency_choice",
  "bank.wiz_title",
  "bank.wiz_example",
  "bank.saved_title",
  "bank.missing_info",
  "help.body",
  "customer.fallback",
  "support.requested",
  "support.exited",
  "error.generic",
  "status.WAITING_PAYMENT",
  "status.CUSTOMER_SENT_BILL",
  "status.WAITING_ADMIN_VERIFY",
  "status.WAITING_PAYOUT",
  "status.PAYOUT_SENT",
  "status.COMPLETED",
  "status.CANCELLED",
  "menu.exchange",
  "menu.orders",
  "menu.support",
  "menu.language",
  "menu.exit_support",
  "order.bank_btn"
];

// ---------------------------------------------------------------------------
// Lifecycle: payout readiness (requirements E, L1-L4)
// ---------------------------------------------------------------------------

describe("payout readiness — WAITING_PAYOUT without destination is NOT payout-ready", () => {
  it("rejects non-WAITING_PAYOUT orders", () => {
    expect(OrderService.isPayoutReady({ status: "WAITING_PAYMENT" } as any)).toBe(false);
    expect(OrderService.isPayoutReady({ status: "WAITING_ADMIN_VERIFY" } as any)).toBe(false);
    expect(OrderService.isPayoutReady({ status: "PAYOUT_SENT" } as any)).toBe(false);
    expect(OrderService.isPayoutReady(null as any)).toBe(false);
  });

  it("rejects WAITING_PAYOUT without a payout destination", () => {
    expect(OrderService.isPayoutReady({ status: "WAITING_PAYOUT", payoutBankSnapshot: null } as any)).toBe(false);
    expect(OrderService.isPayoutReady({ status: "WAITING_PAYOUT" } as any)).toBe(false);
  });

  it("rejects incomplete destinations (no invented fields)", () => {
    expect(
      OrderService.isPayoutReady({
        status: "WAITING_PAYOUT",
        payoutBankSnapshot: { type: "text", bankName: "Vietcombank", accountNumber: "123" }
      } as any)
    ).toBe(false);
  });

  it("accepts a complete text destination or a QR destination", () => {
    expect(
      OrderService.isPayoutReady({
        status: "WAITING_PAYOUT",
        payoutBankSnapshot: {
          type: "text",
          currency: "USD",
          bankName: "Vietcombank",
          accountNumber: "0123456789",
          accountName: "NGUYEN VAN A",
          confirmedByCustomer: true
        }
      } as any)
    ).toBe(true);
    expect(
      OrderService.isPayoutReady({
        status: "WAITING_PAYOUT",
        payoutBankSnapshot: { type: "qr", qrFileId: "f1", qrFilePath: "x/y.png" }
      } as any)
    ).toBe(true);
  });

  it("notifyPayoutReady gate fires only for transition + ready orders (L4)", () => {
    expect(shouldNotifyPayoutReady({ status: "WAITING_PAYOUT", payoutBankSnapshot: null })).toBe(false);
    expect(
      shouldNotifyPayoutReady({
        status: "WAITING_PAYOUT",
        payoutBankSnapshot: { type: "text", bankName: "B", accountNumber: "12345678", accountName: "A" }
      })
    ).toBe(true);
    expect(
      shouldNotifyPayoutReady({
        status: "WAITING_ADMIN_VERIFY",
        payoutBankSnapshot: { type: "text", bankName: "B", accountNumber: "12345678", accountName: "A" }
      })
    ).toBe(false);
    expect(shouldNotifyPayoutReady(null)).toBe(false);
    // Legacy idempotency behavior preserved.
    expect(isPayoutReadyTransition("WAITING_PAYOUT")).toBe(true);
    expect(isPayoutReadyTransition("WAITING_ADMIN_VERIFY")).toBe(false);
  });
});
// ---------------------------------------------------------------------------
// Deterministic payout text parser (requirements F, L8)
// ---------------------------------------------------------------------------

describe("deterministic payout text parser never invents data (L8)", () => {
  it("parses 'vcb 0123456789 nguyen van a'", () => {
    const p = parsePayoutDestinationText("vcb 0123456789 nguyen van a");
    expect(p).not.toBeNull();
    expect(p!.bankName).toBe("Vietcombank");
    expect(p!.accountNumber).toBe("0123456789");
    expect(p!.accountName).toBe("NGUYEN VAN A");
    expect(p!.source).toBe("deterministic");
  });

  it("parses reversed token order", () => {
    const p = parsePayoutDestinationText("nguyen van a mb 0987654321");
    expect(p).not.toBeNull();
    expect(p!.bankName).toBe("MB Bank");
    expect(p!.accountNumber).toBe("0987654321");
  });

  it("returns null when the account number is missing (no invention)", () => {
    expect(parsePayoutDestinationText("vcb nguyen van a")).toBeNull();
    expect(parsePayoutDestinationText("nguyen van a")).toBeNull();
  });

  it("returns null when no known bank alias exists (no guessing)", () => {
    expect(parsePayoutDestinationText("0123456789 nguyen van a")).toBeNull();
    expect(parsePayoutDestinationText("xyz 0123456789 nguyen van a")).toBeNull();
  });

  it("returns null for too-short account numbers", () => {
    expect(parsePayoutDestinationText("vcb 123 nguyen van a")).toBeNull();
  });

  it("never marks data confirmed and never triggers payout", () => {
    const p = parsePayoutDestinationText("vcb 0123456789 nguyen van a") as any;
    expect(Object.keys(p)).not.toContain("confirmed");
    expect(Object.keys(p)).not.toContain("confirmedByCustomer");
  });
});

describe("AI extraction fallback cannot invent values (L8)", () => {
  it("rejects AI output whose account digits do not appear in the message", async () => {
    const fakePrompt = async () =>
      JSON.stringify({ bankName: "Vietcombank", accountNumber: "9999999999", accountName: "INVENTED NAME" });
    const r = await parsePayoutDestinationWithAi("nguyen van a chuyen cho toi", fakePrompt);
    expect(r).toBeNull();
  });

  it("rejects AI output with missing fields instead of filling them", async () => {
    const fakePrompt = async () =>
      JSON.stringify({ bankName: "Vietcombank", accountNumber: null, accountName: null });
    const r = await parsePayoutDestinationWithAi("vcb 0123456789", fakePrompt);
    expect(r).toBeNull();
  });

  it("accepts only values literally present in the message", async () => {
    const fakePrompt = async () =>
      JSON.stringify({ bankName: "Vietcombank", accountNumber: "0123456789", accountName: "nguyen van a" });
    const r = await parsePayoutDestinationWithAi("nguyen van a vcb 0123456789", fakePrompt);
    expect(r).not.toBeNull();
    expect(r!.source).toBe("ai");
    expect(r!.accountNumber).toBe("0123456789");
  });

  it("AI output never carries a confirmation flag", async () => {
    const fakePrompt = async () =>
      JSON.stringify({ bankName: "MB Bank", accountNumber: "1234567890", accountName: "test" });
    const r = await parsePayoutDestinationWithAi("mb 1234567890 test", fakePrompt) as any;
    expect(r).not.toBeNull();
    expect(r.confirmedByCustomer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Payout QR (requirements G, L9)
// ---------------------------------------------------------------------------

describe("payout QR never fabricates details (L9)", () => {
  it("deterministic QR decode is unavailable and returns null", () => {
    expect(decodePayoutQrImage(Buffer.from("fake-image-bytes"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transfer reference template (requirements C, L13)
// ---------------------------------------------------------------------------

describe("transfer memo generation (L13)", () => {
  it("default template produces '{shortOrder} CK'", () => {
    const memo = generateTransferMemo(DEFAULT_TRANSFER_MEMO_TEMPLATE, {
      orderId: "ORD-ABC123-X9Y8Z7",
      username: "someone",
      telegramId: "111222333"
    });
    expect(memo).toBe("#X9Y8Z7 CK");
  });

  it("falls back safely when username is absent (L13)", () => {
    const memo = generateTransferMemo("{username} {shortOrder}", {
      orderId: "ORD-ABC123-X9Y8Z7",
      username: null,
      telegramId: "123456789"
    });
    expect(memo).not.toContain("{");
    expect(memo).toContain("#X9Y8Z7");
    expect(memo).toContain("6789"); // telegram-id fallback token
    expect(memo.length).toBeLessThanOrEqual(20);
  });

  it("falls back to order token when username AND telegramId are absent", () => {
    const memo = generateTransferMemo("{username} {shortOrder}", { orderId: "ORD-ABC123-X9Y8Z7" });
    expect(memo).toContain("#X9Y8Z7");
  });

  it("sanitizes whitespace and special characters, deterministic", () => {
    const a = generateTransferMemo("{username}  CK   {shortOrder}!!!", { orderId: "ORD-1", username: "ph@u.cng", telegramId: "42" });
    const b = generateTransferMemo("{username}  CK   {shortOrder}!!!", { orderId: "ORD-1", username: "ph@u.cng", telegramId: "42" });
    expect(a).toBe(b);
    expect(a).not.toMatch(/[!@]/);
    expect(a).not.toMatch(/\s{2,}/);
  });

  it("telegramShort renders digits only", () => {
    const memo = generateTransferMemo("{telegramShort}", { orderId: "ORD-1", telegramId: "abc-987654" });
    expect(memo).toBe("7654");
  });

  it("rejects templates with unsupported variables", () => {
    expect(validateTransferMemoTemplate("{accountNumber} {shortOrder}").ok).toBe(false);
    expect(validateTransferMemoTemplate("").ok).toBe(false);
    expect(validateTransferMemoTemplate("{shortOrder} CK").ok).toBe(true);
  });

  it("never contains sensitive bank/account data", () => {
    const memo = generateTransferMemo("{username} {shortOrder}", { orderId: "ORD-1", username: "u", telegramId: "1" });
    expect(memo.toLowerCase()).not.toContain("vietcombank");
    expect(memo).not.toContain("0123456789");
  });
});

// ---------------------------------------------------------------------------
// Localization audit (requirements D, L10, L11)
// ---------------------------------------------------------------------------

describe("all four locales have lifecycle & customer button keys (L10)", () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`locale ${locale} defines every lifecycle & button key with real text`, () => {
      for (const key of LIFECYCLE_KEYS) {
        const value = t(locale, key);
        expect(value, `${locale}:${key} missing`).not.toBe(key);
        expect(String(value).trim().length).toBeGreaterThan(0);
      }
    });
  }

  it("core labels stay per-locale (vi / en / km / zh)", () => {
    expect(t("vi", "menu.support")).toContain("Hỗ trợ");
    expect(t("zh", "menu.support")).toContain("客服");
    expect(t("en", "menu.support")).toContain("Support");
    expect(t("km", "menu.support")).toContain("ជំនួយ");
  });

  it("confirmation preview buttons are localized in all locales", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(t(locale, "payout.confirm_btn")).not.toBe("payout.confirm_btn");
      expect(t(locale, "payout.edit_btn")).not.toBe("payout.edit_btn");
    }
  });
});

describe("Admin/CSKH interface remains Vietnamese (L11)", () => {
  it("admin status labels are Vietnamese for lifecycle statuses", () => {
    expect(STATUS_VI.WAITING_PAYOUT).toContain("giải ngân");
    expect(STATUS_VI.WAITING_PAYMENT).toContain("Chờ thanh toán");
    expect(STATUS_VI.COMPLETED).toContain("Hoàn tất");
  });
});
