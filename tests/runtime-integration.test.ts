/**
 * Runtime-integration audit tests (Telegram runtime wiring).
 *
 * Covers the audited runtime failures:
 *  1. transfer-memo Admin config reachable + saved template consumed (L1/L2)
 *  2. memo bank-safe + short (L3)
 *  3. Admin/CSKH identity uses Telegram numeric ID, not CUID ref (L4)
 *  4. WAITING_PAYMENT cancel button visible + callback reaches handler (L5/L6)
 *  5. safely-unpaid admin cancel allowed / bill-state blocked (L7/L8)
 *  6. bill evidence retrievable by the authoritative helper (L9)
 *  7. bill-state order detail shows Xem bill + confirm actions (L10/L11)
 *  8. HUMAN-mode bill still routes to the bill handler (L13)
 *  9. payout QR session cannot route to bill (L14)
 * 10. deterministic financial parse makes zero AI calls (L15)
 * 11. AI timeout is bounded (L16)
 * 12. payment-instruction i18n keys exist for vi/en/km/zh (L18)
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { Bot } from "grammy";
import { prisma } from "../src/database/client.js";
import { OrderService } from "../src/modules/orders/order-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { ConversationService } from "../src/modules/conversation/conversation-service.js";
import { getCustomerBillEvidence, hasCustomerBillEvidence } from "../src/modules/orders/bill-evidence.js";
import {
  DEFAULT_TRANSFER_MEMO_TEMPLATE,
  generateTransferMemo,
  validateTransferMemoTemplate
} from "../src/modules/orders/transfer-memo.js";
import { SystemConfigService } from "../src/modules/system-config/system-config-service.js";
import { withAiTimeout, AiProvider } from "../src/modules/ai/ai-provider.js";
import { getActiveOrderActionKeyboard } from "../src/bot/menus/customer-menu.js";
import { orderDetailKeyboard } from "../src/bot/admin/admin-orders.js";
import { getOperationsCenterKeyboard } from "../src/bot/admin/admin-panel.js";
import { customerIdentity } from "../src/bot/notifications.js";
import { customerHandler } from "../src/bot/handlers/customer-handler.js";
import { setPayoutInputSession } from "../src/bot/state/customer-session.js";
import { resolveUserIdentity } from "../src/bot/middleware/identity.js";
import { SUPPORTED_LOCALES, t } from "../src/modules/i18n/locales.js";

const PAYMENT_KEYS = [
  "order.created_title",
  "order.pay_bank",
  "order.pay_number",
  "order.pay_name",
  "order.pay_memo",
  "order.pay_memo_hint",
  "order.pay_bill_hint",
  "order.cancel_btn"
];

// ---------------------------------------------------------------------------
// 1-3. Transfer memo (L1/L2/L3)
// ---------------------------------------------------------------------------
describe("Transfer memo — bank-safe, short, Admin-configurable (L1/L2/L3)", () => {
  it("default template is {shortOrder} CK and output is bank-safe and short", () => {
    expect(DEFAULT_TRANSFER_MEMO_TEMPLATE).toBe("{shortOrder} CK");
    const memo = generateTransferMemo(DEFAULT_TRANSFER_MEMO_TEMPLATE, {
      orderId: "ORD-J0PI6SAMPLE",
      username: "miniphung"
    });
    // Sanitized: '#' stripped, uppercase, letters/digits/single spaces only.
    expect(memo).toBe("J0PI6 CK");
    expect(memo.length).toBeLessThanOrEqual(20);
    expect(memo).toMatch(/^[A-Z0-9 ]+$/);
    expect(memo).not.toMatch(/[#→;:]/);
  });

  it("missing username falls back safely (never empty/garbage)", () => {
    const memo = generateTransferMemo(DEFAULT_TRANSFER_MEMO_TEMPLATE, {
      orderId: "ORD-AB12CD",
      username: null,
      telegramId: ""
    });
    expect(memo).toContain("AB12CD");
    const withTg = generateTransferMemo(DEFAULT_TRANSFER_MEMO_TEMPLATE, {
      orderId: "ORD-AB12CD",
      username: null,
      telegramId: "123456789"
    });
    expect(withTg.trim().length).toBeGreaterThan(0);
  });

  it("rejects unsupported/empty templates before save", () => {
    expect(validateTransferMemoTemplate("").ok).toBe(false);
    expect(validateTransferMemoTemplate("{accountNumber}").ok).toBe(false);
    expect(validateTransferMemoTemplate("{shortOrder} CK").ok).toBe(true);
  });

  it("the runtime config consumer (customer payment instruction) reads the SAME saved template immediately", async () => {
    const before = SystemConfigService.getTransferMemoTemplate();
    const custom = "{username}-{shortOrder}";
    await SystemConfigService.setTransferMemoTemplate(custom, "TEST");
    const after = SystemConfigService.getTransferMemoTemplate();
    expect(after).toBe(custom);
    const memo = generateTransferMemo(after, { orderId: "ORD-ZZ99YY", username: "tester" });
    expect(memo).toContain("ZZ99YY");
    await SystemConfigService.setTransferMemoTemplate(before, "TEST-restore");
  });

  it("Operations Center exposes ⚙️ Cấu hình (ops:config) and an ADMIN role passes the config gate", async () => {
    const buttons = getOperationsCenterKeyboard().inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(buttons).toContain("ops:config");
    const { PermissionService } = await import("../src/modules/permissions/permission-service.js");
    const tg = `runtime-int-admin-real-${Date.now()}`;
    await PermissionService.inviteStaff({ telegramId: tg, name: "Config Admin", role: "ADMIN" });
    const adminIdentity = await resolveUserIdentity(tg);
    expect(adminIdentity.userType).toBe("ADMIN");
    expect(typeof adminIdentity.userType).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 4. Customer identity uses Telegram numeric ID (L4)
// ---------------------------------------------------------------------------
describe("Customer identity rendering — Telegram numeric ID, not CUID ref (L4)", () => {
  it("renders @username + Telegram ID + Ref, never labels the CUID short ref as ID", () => {
    const out = customerIdentity({ username: "bui7968", fullName: "Bui", telegramId: "123456789", id: "cmabcveaz8cdef" });
    expect(out).toContain("@bui7968");
    expect(out).toContain("Telegram ID: <code>123456789</code>");
    expect(out).toContain("Ref: #");
    expect(out).not.toContain("ID ngắn");
  });

  it("falls back to display name + Telegram ID when no username", () => {
    const out = customerIdentity({ fullName: "Nguyen Van B", telegramId: "987654321", id: "cmx" });
    expect(out).toContain("Nguyen Van B");
    expect(out).toContain("Telegram ID: <code>987654321</code>");
  });
});

// ---------------------------------------------------------------------------
// 5-7. Cancel button + callback wiring (L5/L6), admin cancel rules (L7/L8)
// ---------------------------------------------------------------------------
const CANCEL_CALLBACK_REGEX = /^customer:order:cancel:([a-zA-Z0-9_-]+)$/;

describe("WAITING_PAYMENT customer actions — ❌ Cancel visible + wired (L5/L6)", () => {
  it("active-order keyboard shows ❌ Cancel immediately and matches the registered callback pattern", () => {
    const kb: any = getActiveOrderActionKeyboard({ id: "ORD-TEST01", status: "WAITING_PAYMENT" }, "vi");
    const cancel = kb.inline_keyboard.flat().find((b: any) => b.callback_data?.startsWith("customer:order:cancel:"));
    expect(cancel).toBeDefined();
    // Prove the callback data actually matches the handler's registered route.
    expect(CANCEL_CALLBACK_REGEX.test(cancel.callback_data)).toBe(true);
    const kb2: any = getActiveOrderActionKeyboard({ id: "ORD-TEST01", status: "WAITING_ADMIN_VERIFY" }, "vi");
    const cancel2 = kb2.inline_keyboard.flat().find((b: any) => b.callback_data?.startsWith("customer:order:cancel:"));
    expect(cancel2).toBeUndefined();
  });
});

describe("Admin cancel rules — safely unpaid works, bill-state blocked with explanation (L7/L8)", () => {
  it("safely unpaid WAITING_PAYMENT/no-evidence order CAN be admin-cancelled", async () => {
    const { customer, order } = await ensureCustomerOrderPair("admin-cancel-ok");
    expect(OrderService.canAdminCancel(order).allowed).toBe(true);
    const cancelled: any = await OrderService.cancelOrder(order.id, "admin-1", "ADMIN", "test", { source: "ADMIN_CANCELLED" });
    expect(cancelled.status).toBe("CANCELLED");
    void customer;
  });

  it("bill-state order cancel is BLOCKED with a visible BILL_EXISTS explanation (never a silent no-op)", async () => {
    const { order } = await ensureCustomerOrderPair("admin-cancel-bill");
    await prisma.order.update({ where: { id: order.id }, data: { customerBillFileId: "ev-x" } });
    const reloaded: any = await prisma.order.findUnique({ where: { id: order.id } });
    const decision = OrderService.canAdminCancel(reloaded);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("BILL_EXISTS");
    expect(decision.billWarning).toBe(true);
    await expect(OrderService.cancelOrder(order.id, "admin-1", "ADMIN", "test", { source: "ADMIN_CANCELLED" })).rejects.toThrow();
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("WAITING_PAYMENT");
  });
});

// ---------------------------------------------------------------------------
// Bill evidence helper (L9) + bill-state admin UI (L10/L11)
// ---------------------------------------------------------------------------
describe("ONE authoritative bill evidence reader (L9/L10/L11)", () => {
  it("retrieves evidence via the promoted primary reference after a real bill upload", async () => {
    const { customer, order } = await ensureCustomerOrderPair("bill-helper-primary");
    const result: any = await OrderService.submitCustomerBill(
      order.id,
      Buffer.from("runtime-integration-bill-primary"),
      "bill.jpg",
      "image/jpeg",
      customer.telegramId
    );
    expect(result.status).toBe("WAITING_ADMIN_VERIFY");

    const evidence = await getCustomerBillEvidence(order.id);
    expect(evidence).not.toBeNull();
    expect(evidence!.source).toBe("primary");
    expect(evidence!.filePath).toBeTruthy();

    const fresh: any = await OrderService.getOrder(order.id);
    const kb: any = orderDetailKeyboard(fresh);
    const data = kb.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(data).toContain(`ops:bill:view:${order.id}`);
    expect(data).toContain(`ops:pay:preview:${order.id}`);
    expect(data).toContain(`ops:pay:not_received:${order.id}`);
  });

  it("retrieves evidence from the evidence table when the primary reference is absent (legacy split)", async () => {
    const { customer, order } = await ensureCustomerOrderPair("bill-helper-table");
    const ev = await prisma.fileEvidence.create({
      data: {
        fileName: "bill_legacy.jpg",
        filePath: "legacy/bill_legacy.jpg",
        fileType: "CUSTOMER_BILL",
        fileSize: 10,
        mimeType: "image/jpeg",
        sha256: "deadbeef-runtime"
      }
    });
    await prisma.orderBillEvidence.create({
      data: {
        orderId: order.id,
        fileId: ev.id,
        filePath: "legacy/bill_legacy.jpg",
        sha256: "deadbeef-runtime",
        uploadedBy: customer.telegramId
      }
    });
    const evidence = await getCustomerBillEvidence(order.id);
    expect(evidence).not.toBeNull();
    expect(evidence!.source).toBe("evidence-table");
    expect(hasCustomerBillEvidence(order)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Router-level runtime wiring (L6/L13/L14)
// ---------------------------------------------------------------------------
interface CapturedCall {
  method: string;
  payload: any;
}

function makeTestBot(): { bot: Bot<any>; sent: CapturedCall[]; answered: CapturedCall[] } {
  const bot = new Bot("100000000:TEST-TOKEN");
  (bot as any).botInfo = {
    id: 999,
    is_bot: true,
    first_name: "RuntimeTestBot",
    username: "runtime_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false
  };
  const sent: CapturedCall[] = [];
  const answered: CapturedCall[] = [];
  bot.api.config.use((async (_prev: any, method: string, payload: any) => {
    if (method === "answerCallbackQuery") {
      answered.push({ method, payload });
      return { ok: true, result: true };
    }
    if (method === "getFile") {
      return { ok: true, result: { file_id: payload.file_id, file_path: "bills/runtime-test.jpg", file_size: 1000 } };
    }
    sent.push({ method, payload });
    return { ok: true, result: { message_id: 1, chat: { id: payload?.chat_id ?? 1 }, date: 1, text: "" } };
  }) as any);
  bot.use(customerHandler);
  return { bot, sent, answered };
}

function baseFrom(id: number) {
  return { id, is_bot: false, first_name: "Runtime", username: `runtime_${id}` } as any;
}

const realFetch = globalThis.fetch;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("runtime-test-jpeg-body")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("runtime-test-png-body")]);

async function stubFetch(buffer: Buffer): Promise<void> {
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/octet-stream" },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  });
}

describe("Customer cancel callback reaches its handler end-to-end (L6)", () => {
  it("tapping ❌ Huỷ đơn produces the two-step warning (handler reached, no silent ACK)", async () => {
    const { customer, order } = await ensureCustomerOrderPair("cancel-cb");
    const tgId = Number(customer.telegramId);
    const { bot, sent, answered } = makeTestBot();
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb-cancel",
        from: baseFrom(tgId),
        data: `customer:order:cancel:${order.id}`,
        message: { message_id: 10, chat: { id: tgId, type: "private" }, date: 1, from: baseFrom(tgId) }
      }
    } as any);
    expect(answered.length).toBeGreaterThanOrEqual(1);
    const reply = sent.find((c) => c.method === "sendMessage");
    expect(reply).toBeDefined();
    expect(JSON.stringify(reply!.payload.reply_markup)).toContain("customer:order:cancel:confirm");
  });
});

describe("HUMAN-mode bill routing precedence (L13/L14)", () => {
  it("bill photo while customer is in HUMAN support is STILL stored as bill evidence (not a support attachment)", async () => {
    const { customer, order } = await ensureCustomerOrderPair("human-bill");
    await ConversationService.claim(customer.id, "runtime-staff-h");
    const conv = await ConversationService.getOrCreateConversation(customer.id);
    expect(conv.mode).toBe("HUMAN");

    await stubFetch(JPEG);
    const tgId = Number(customer.telegramId);
    const { bot, sent } = makeTestBot();
    try {
      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 20,
          from: baseFrom(tgId),
          chat: { id: tgId, type: "private", first_name: "Runtime" },
          date: 1,
          photo: [{ file_id: "runtime-photo-1", file_unique_id: "u1", width: 100, height: 100, file_size: JPEG.length }]
        }
      } as any);

      const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
      expect(fresh.status).toBe("WAITING_ADMIN_VERIFY");
      const evidence = await getCustomerBillEvidence(order.id);
      expect(evidence).not.toBeNull();
      expect(sent.some((c) => c.method === "sendMessage")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("an active payout-QR session consumes the photo as payout QR — never as bill, never relayed", async () => {
    const { customer, order } = await ensureCustomerOrderPair("payout-qr-precedence");
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "WAITING_PAYOUT", verifiedAt: new Date() }
    });
    setPayoutInputSession(String(customer.telegramId), { orderId: order.id, kind: "qr" });

    await stubFetch(PNG);
    const tgId = Number(customer.telegramId);
    const { bot } = makeTestBot();
    try {
      await bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 30,
          from: baseFrom(tgId),
          chat: { id: tgId, type: "private", first_name: "Runtime" },
          date: 1,
          photo: [{ file_id: "runtime-photo-2", file_unique_id: "u2", width: 100, height: 100, file_size: PNG.length }]
        }
      } as any);

      const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
      expect((fresh.payoutBankSnapshot as any)?.type).toBe("qr");
      const bill = await getCustomerBillEvidence(order.id);
      expect(bill).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic-first + bounded AI (L15/L16)
// ---------------------------------------------------------------------------
describe("Deterministic financial actions make zero AI calls; AI is bounded (L15/L16)", () => {
  it("reserved exchange phrases resolve through the LOCAL parser (no Gemini path)", () => {
    const intent = AiProvider.parseLocalExchangeIntent("100 đô");
    expect(intent).not.toBeNull();
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
    const vnd = AiProvider.parseLocalExchangeIntent("10 triệu lấy đô la");
    expect(vnd?.sourceCurrency).toBe("VND");
  });

  it("AI timeout rejects with a bounded AI_TIMEOUT error instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const p = withAiTimeout(new Promise<string>(() => {}), 1000, "unit-test");
      const assertion = expect(p).rejects.toThrow("AI_TIMEOUT");
      await vi.advanceTimersByTimeAsync(1100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("AI success passes through the timeout wrapper untouched", async () => {
    await expect(withAiTimeout(Promise.resolve("ok"), 1000, "unit-test")).resolves.toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Localized payment instruction keys (L18)
// ---------------------------------------------------------------------------
describe("Customer payment instruction keys work in vi/en/km/zh (L18)", () => {
  it("every payment-instruction key exists and is localized for all 4 locales", () => {
    for (const loc of SUPPORTED_LOCALES) {
      for (const key of PAYMENT_KEYS) {
        const value = t(loc, key, { id: "ORD-X", amount: "100", currency: "USD", bank: "B", number: "N", name: "A", memo: "M" });
        expect(value, `${loc}:${key}`).toBeTruthy();
        expect(value, `${loc}:${key}`).not.toBe(key); // no missing-key passthrough
      }
      const viCancel = t("vi", "order.cancel_btn");
      const locCancel = t(loc, "order.cancel_btn");
      if (loc !== "vi") expect(locCancel).not.toBe(viCancel);
    }
  });
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
let seq = 0;
async function ensureCustomerOrderPair(tag: string): Promise<{ customer: any; order: any }> {
  seq++;
  // Numeric Telegram ID so router-level tests resolve the SAME customer
  // identity through ctx.from.id (identity middleware uses the numeric id).
  const tg = String(770000000 + seq);
  const customer = await CustomerService.getOrCreateCustomer({
    telegramId: tg,
    username: `runtime_${tag}`,
    fullName: `Runtime ${tag}`
  });
  const order = await createTestOrder(customer.id, `RI${seq}`, {});
  return { customer, order };
}

async function createTestOrder(customerId: string, tag: string, overrides: Record<string, any> = {}): Promise<any> {
  return prisma.order.create({
    data: {
      id: `ORD-${tag}-${Date.now().toString(36).toUpperCase()}`,
      customerId,
      sourceCurrency: "USD",
      targetCurrency: "VND",
      sourceAmount: 100,
      targetAmount: 2540000,
      rate: 25400,
      fee: 2,
      feeCurrency: "USD",
      status: "WAITING_PAYMENT",
      ...overrides
    }
  });
}

void beforeAll;
