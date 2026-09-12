/**
 * CANONICAL APPLICATION TIMEZONE TESTS (Asia/Ho_Chi_Minh, UTC+07:00).
 *
 * Guarantees:
 *  - Every human-facing formatter renders in Asia/Ho_Chi_Minh regardless of
 *    the machine's own local timezone (all Intl calls pin the zone).
 *  - Date rollover across the +07:00 boundary works.
 *  - Financial deadline math stays PURE EPOCH: unpaid-Order payment deadline
 *    (+50 min), quote expiry (+10 min), CTV commission hold (72h) are
 *    unchanged by any display-timezone behavior.
 *  - The logger exposes localTime with an explicit +07:00 offset.
 *
 * NO test depends on the machine's local timezone: every expectation is
 * derived from fixed UTC instants + the pinned APP_TIMEZONE.
 */
import { describe, it, expect, vi } from "vitest";
import {
  APP_TIMEZONE,
  APP_TIMEZONE_OFFSET,
  formatAdminDateTime,
  formatShortDateTime,
  formatAdminDate,
  formatAdminTime,
  formatDateTime,
  formatIsoWithOffset
} from "../src/shared/app-time.js";
import { computePaymentDeadlineMs } from "../src/modules/payment-qr/payment-qr-service.js";
import { AUTO_CANCEL_MIN } from "../src/modules/orders/payment-reminder-service.js";
import { RuntimeConfigService } from "../src/modules/system-config/runtime-config-service.js";
import { QuoteService } from "../src/modules/quotes/quote-service.js";
import { PartnerService } from "../src/modules/partner/partner-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";

// 1 — fixed UTC instant renders as Hanoi wall-clock
describe("Admin formatters render Asia/Ho_Chi_Minh (UTC+07:00)", () => {
  it("2026-09-12T07:00:00Z displays as 12/09/2026 14:00", () => {
    const t = new Date("2026-09-12T07:00:00Z");
    expect(formatAdminDateTime(t)).toBe("12/09/2026 14:00");
    expect(formatShortDateTime(t)).toBe("12/09 14:00");
    expect(formatAdminDate(t)).toBe("12/09/2026");
    expect(formatAdminTime(t)).toBe("14:00");
  });

  it("date rollover: 2026-09-12T20:30:00Z is 13/09/2026 03:30 GMT+7", () => {
    const t = new Date("2026-09-12T20:30:00Z");
    expect(formatAdminDateTime(t)).toBe("13/09/2026 03:30");
    expect(formatShortDateTime(t)).toBe("13/09 03:30");
    expect(formatAdminDate(t)).toBe("13/09/2026");
  });

  it("UTC evening rolls forward into the next GMT+7 day", () => {
    // 2026-09-12T18:00:00Z = 13/09 01:00 GMT+7
    expect(formatAdminDateTime(new Date("2026-09-12T18:00:00Z"))).toBe("13/09/2026 01:00");
  });

  it("localized formatDateTime keeps the zone while changing the locale", () => {
    const t = new Date("2026-09-12T07:00:00Z");
    const vi = formatDateTime(t, "vi-VN");
    const en = formatDateTime(t, "en-GB");
    // Locale may change separators/order; the Hanoi wall-clock is identical.
    expect(vi).toContain("14:00");
    expect(en).toContain("14:00");
  });

  it("null/invalid input degrades safely (never 'Invalid Date' garbage)", () => {
    expect(formatAdminDateTime(null)).toBe("N/A");
    expect(formatAdminDateTime("not-a-date")).toBe("N/A");
  });
});

// 2 — logger localTime
describe("Logger exposes explicit GMT+7 localTime (machine timestamp preserved)", () => {
  it("formatIsoWithOffset renders ISO-like local time with +07:00", () => {
    const out = formatIsoWithOffset(new Date("2026-09-12T07:00:00Z"));
    expect(out).toBe("2026-09-12T14:00:00+07:00");
    expect(out.endsWith(APP_TIMEZONE_OFFSET)).toBe(true);
  });

  it("app timezone constant is the single source of truth", () => {
    expect(APP_TIMEZONE).toBe("Asia/Ho_Chi_Minh");
    expect(APP_TIMEZONE_OFFSET).toBe("+07:00");
  });
});

// 3 — financial deadlines remain pure epoch arithmetic
describe("Financial deadlines are UNCHANGED by display-timezone work (pure epoch)", () => {
  it("unpaid-Order payment deadline = createdAt + 50 minutes EXACTLY", () => {
    expect(AUTO_CANCEL_MIN).toBe(50);
    const createdAt = new Date("2026-09-12T07:00:00Z");
    const deadline = computePaymentDeadlineMs({ createdAt });
    expect(deadline).toBe(createdAt.getTime() + 50 * 60_000);
  });

  it("quote expiry = now + 10 minutes EXACTLY (epoch, timezone-independent)", async () => {
    expect(RuntimeConfigService.getQuoteExpiryMinutes()).toBe(10);
    const t0 = new Date("2026-09-12T07:00:00Z").getTime();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(t0));
      const customer = await CustomerService.getOrCreateCustomer({
        telegramId: `apptime-quote-${t0}`,
        username: "apptime_quote"
      });
      const quote: any = await QuoteService.createQuote(customer.id, "USD", "VND", 100);
      expect(new Date(quote.expiresAt).getTime()).toBe(t0 + 10 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("CTV commission 72h hold stays EXACTLY 72 hours in epoch time", () => {
    const t0 = new Date("2026-09-12T07:00:00Z").getTime();
    vi.useFakeTimers();
    try {
      // One millisecond BEFORE the 72h mark → still HELD (pure epoch compare).
      vi.setSystemTime(new Date(t0 + 72 * 3600_000 - 1));
      expect(
        PartnerService.effectiveStatus({ status: "HELD", availableAt: new Date(t0 + 72 * 3600_000) })
      ).toBe("HELD");
      expect(
        PartnerService.effectiveStatus({ status: "HELD", availableAt: new Date(t0 + 72 * 3600_000 - 1) })
      ).toBe("AVAILABLE");

      // AT exactly the 72h mark → AVAILABLE (hold elapsed precisely).
      vi.setSystemTime(new Date(t0 + 72 * 3600_000));
      expect(
        PartnerService.effectiveStatus({ status: "HELD", availableAt: new Date(t0 + 72 * 3600_000) })
      ).toBe("AVAILABLE");

      // A held commission with NO availableAt (risk flag) never auto-releases.
      expect(PartnerService.effectiveStatus({ status: "HELD", availableAt: null })).toBe("HELD");
    } finally {
      vi.useRealTimers();
    }
  });
});

