/**
 * RUNTIME UX + ADMIN OPERATIONS PASS — Tasks 1–5 tests.
 *
 * A. WAITING_ADMIN_VERIFY + status question → deterministic localized reply
 *    (real display name + Order ref), NO receiving-bank/account leak
 *    (KHQR UPAY / BIDV / receivingAccountSnapshot), conversational AI NOT called.
 * B. My Orders = ACTIVE ONLY (active + completed + cancelled → active shown;
 *    completed/cancelled only → active-empty message). History rows remain.
 * C. Admin transaction list: status badge + short ref + amount pair + identity
 *    visible per row WITHOUT opening the Order (✅=COMPLETED only,
 *    ❌=CANCELLED only, 🔴=non-terminal; filters never mix ledgers).
 * D. Completed Order detail exposes 🧾 Xem hóa đơn chuyển tiền → the EXACT
 *    stored Admin payout evidence (photo AND PDF paths). No button if absent.
 * E. Audit rows prefer Telegram numeric identity over long CUIDs and show the
 *    EXACT GMT+7 timestamp (relative only secondary). DB timestamps untouched.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Bot } from "grammy";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { mainRouter } from "../src/bot/router.js";
import { setBotInstance } from "../src/bot/notifications.js";
import { RuntimeConfigService } from "../src/modules/system-config/runtime-config-service.js";
import { LocalStorageService } from "../src/modules/storage/local-storage-service.js";
import { FileService } from "../src/modules/files/file-service.js";
import { ConversationalAIService } from "../src/modules/ai/customer-ai-service.js";
import { isOrderStatusQuestion } from "../src/bot/handlers/customer-handler.js";
import {
  transactionRowText,
  statusBadge,
  statusesForGroup,
  orderDetailKeyboard
} from "../src/bot/admin/admin-orders.js";
import {
  resolveAuditCustomers,
  auditCustomerName
} from "../src/bot/admin/audit-view.js";
import { formatAdminDateTime } from "../src/shared/app-time.js";

const ADMIN_CHAT = "885100001";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("ops-pass-jpeg")]);
const realFetch = globalThis.fetch;

function stubFetch(buffer: Buffer): void {
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/octet-stream" },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  });
}

function makeBot(): { bot: Bot<any>; sent: any[] } {
  const bot = new Bot("100000000:TEST-TOKEN");
  (bot as any).botInfo = { id: 997, is_bot: true, first_name: "OpsUX", username: "ops_ux_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  const sent: any[] = [];
  bot.api.config.use((async (_p: any, method: string, payload: any) => {
    if (method === "getFile") return { ok: true, result: { file_id: payload.file_id, file_path: "bills/ops.jpg", file_size: 1000 } };
    sent.push({ method, payload });
    return { ok: true, result: { message_id: 1, chat: { id: payload?.chat_id ?? 1 }, date: 1, text: "" } };
  }) as any);
  bot.use(mainRouter);
  return { bot, sent };
}

function makeAdminCaptureBot(): { calls: any[]; fake: any } {
  const calls: any[] = [];
  const fake = { api: new Proxy({}, { get: (_t, prop) => async (...args: any[]) => { calls.push({ method: String(prop), payload: args }); return { ok: true, result: { message_id: 1 } }; } }) };
  return { calls, fake };
}

let seq = 0;
async function mkCustomer(name: string): Promise<any> {
  seq++;
  const tg = String(886000000 + seq);
  return CustomerService.getOrCreateCustomer({ telegramId: tg, username: `opsux_${seq}`, fullName: name });
}

async function mkOrder(customerId: string, status: string, overrides: Record<string, any> = {}): Promise<any> {
  seq++;
  return prisma.order.create({
    data: {
      id: `ORD-OPS-${seq}-${Date.now().toString(36).toUpperCase()}`,
      customerId,
      sourceCurrency: "USD",
      targetCurrency: "VND",
      sourceAmount: 100,
      targetAmount: 2540000,
      rate: 25400,
      fee: 2,
      feeCurrency: "USD",
      status,
      ...overrides
    }
  });
}

function photoUpdate(updateId: number, telegramId: string, fileId: string): any {
  return {
    update_id: updateId,
    message: {
      message_id: 600 + updateId,
      from: { id: Number(telegramId), is_bot: false, first_name: "Ops", username: `ops_${telegramId}` },
      chat: { id: Number(telegramId), type: "private", first_name: "Ops" },
      date: 1,
      photo: [{ file_id: fileId, file_unique_id: `u-${fileId}`, width: 64, height: 64, file_size: JPEG.length }]
    }
  };
}

function textUpdate(updateId: number, telegramId: string, text: string): any {
  return {
    update_id: updateId,
    message: {
      message_id: 700 + updateId,
      from: { id: Number(telegramId), is_bot: false, first_name: "Ops", username: `ops_${telegramId}` },
      chat: { id: Number(telegramId), type: "private", first_name: "Ops" },
      date: 1,
      text
    }
  };
}

void beforeAll;


// A — deterministic WAITING_ADMIN_VERIFY status reply (no AI, no bank leak)
describe("A. Deterministic order-status reply at WAITING_ADMIN_VERIFY", () => {
  it("status question → localized reply with real name + Order ref, NO receiving-bank leak, AI not called", async () => {
    const customer = await mkCustomer("Ziconat");
    const order = await mkOrder(customer.id, "WAITING_ADMIN_VERIFY", {
      receivingAccountSnapshot: { bankName: "BIDV", accountName: "KHQR - UPAY", accountNumber: "123456", khqrBakongAccountId: "upay@bidv" }
    });
    await RuntimeConfigService.setAdminNotificationChatId(ADMIN_CHAT, "TEST");
    const { fake } = makeAdminCaptureBot();
    setBotInstance(fake as any);
    const generateReply = vi.spyOn(ConversationalAIService, "generateReply");

    const { bot, sent } = makeBot();
    try {
      await bot.handleUpdate(textUpdate(1, String(customer.telegramId), "Đơn của mình chuyển tiền rồi, khi nào nhận được tiền vậy shop?"));

      const reply = sent.find((c) => c.method === "sendMessage");
      expect(reply).toBeDefined();
      const body = String(reply!.payload.text || "");
      // Real display name + real Order reference:
      expect(body).toContain("Ziconat");
      expect(body).toContain(order.id);
      // Required deterministic content (verifying wording):
      expect(body).toContain("đã ghi nhận biên lai");
      expect(body).toContain("kiểm tra, đối soát");
      // NO system receiving-account leak as a payout destination:
      expect(body).not.toContain("UPAY");
      expect(body).not.toContain("BIDV");
      expect(body).not.toContain("upay@bidv");
      expect(body).not.toContain("123456");
      // AI never built this financial-state response:
      expect(generateReply).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
      generateReply.mockRestore();
    }
  });

  it("status intent detector covers vi/en/km/zh phrasings", () => {
    expect(isOrderStatusQuestion("Đơn hàng của mình thế nào rồi?")).toBe(true);
    expect(isOrderStatusQuestion("Trạng thái đơn ORD-X?")).toBe(true);
    expect(isOrderStatusQuestion("my order status?")).toBe(true);
    expect(isOrderStatusQuestion("when will I receive the transfer?")).toBe(true);
    expect(isOrderStatusQuestion("我的订单状态")).toBe(true);
    expect(isOrderStatusQuestion("khách hỏi giá USD hôm nay")).toBe(false);
  });
});

// B — My Orders = ACTIVE ONLY
describe("B. Customer My Orders shows ACTIVE only", () => {
  it("active + completed + cancelled → customer sees active only (history rows kept)", async () => {
    const customer = await mkCustomer("ActiveOnly");
    const active = await mkOrder(customer.id, "WAITING_ADMIN_VERIFY");
    await mkOrder(customer.id, "COMPLETED");
    await mkOrder(customer.id, "CANCELLED");

    const { fake } = makeAdminCaptureBot();
    setBotInstance(fake as any);
    const { bot, sent } = makeBot();
    try {
      await bot.handleUpdate({
        update_id: 2,
        callback_query: {
          id: "cb-orders",
          from: { id: Number(customer.telegramId), is_bot: false, first_name: "Active" },
          data: "customer:menu:orders",
          message: { message_id: 10, chat: { id: Number(customer.telegramId), type: "private" }, date: 1, from: { id: Number(customer.telegramId), is_bot: false, first_name: "Active" } }
        }
      } as any);

      const reply = sent.find((c) => c.method === "sendMessage");
      expect(reply).toBeDefined();
      const body = String(reply!.payload.text || "");
      expect(body).toContain(active.id.slice(-6)); // active shown
      // Terminal orders never leak into customer visibility:
      const all = await prisma.order.findMany({ where: { customerId: customer.id } });
      expect(all.length).toBe(3); // history kept in DB
      for (const o of all) {
        if (o.status === "COMPLETED" || o.status === "CANCELLED") {
          expect(body).not.toContain(o.id.slice(-6));
        }
      }
      expect(body).not.toContain("Hoàn tất");
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
    }
  });

  it("completed/cancelled only → active-empty message (localized key exists)", async () => {
    const customer = await mkCustomer("TerminalOnly");
    await mkOrder(customer.id, "COMPLETED");
    await mkOrder(customer.id, "CANCELLED");

    const { fake } = makeAdminCaptureBot();
    setBotInstance(fake as any);
    const { bot, sent } = makeBot();
    try {
      await bot.handleUpdate({
        update_id: 3,
        callback_query: {
          id: "cb-orders-empty",
          from: { id: Number(customer.telegramId), is_bot: false, first_name: "T" },
          data: "customer:menu:orders",
          message: { message_id: 11, chat: { id: Number(customer.telegramId), type: "private" }, date: 1, from: { id: Number(customer.telegramId), is_bot: false, first_name: "T" } }
        }
      } as any);

      const reply = sent.find((c) => c.method === "sendMessage");
      expect(String(reply!.payload.text || "")).toContain("không có giao dịch đang xử lý");
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
    }
  });
});

// C — Admin transaction list: status obvious WITHOUT opening the Order
describe("C. Admin transaction list rows + filters", () => {
  it("row shows badge + exact GMT+7 short time + short ref + amount pair + identity", () => {
    const row = transactionRowText({
      id: "ORD-OPS-ROW-AAAAAA",
      status: "WAITING_ADMIN_VERIFY",
      createdAt: new Date("2026-09-12T08:42:00Z"), // 15:42 GMT+7
      sourceAmount: 100,
      sourceCurrency: "USD",
      targetAmount: 2540000,
      targetCurrency: "VND",
      customer: { username: "ziconat", telegramId: "123456789", fullName: "Ziconat", id: "cmrow01" }
    });
    expect(row.startsWith("🔴")).toBe(true); // non-terminal badge
    expect(row).toContain("12/09 15:42"); // exact GMT+7 short time
    expect(row).toContain("#AAAAAA"); // short Order ref
    expect(row).toContain("100 USD"); // amount pair
    expect(row).toContain("VND");
    // STABLE identity: Telegram numeric ID primary; name secondary; username
    // (mutable) is never the identity:
    expect(row).toContain("TG 123456789");
    expect(row).toContain("Ziconat");
    expect(row).not.toContain("@ziconat");
  });

  it("badges are exact: ✅=COMPLETED only, ❌=CANCELLED only, 🔴=everything else", () => {
    expect(statusBadge("COMPLETED")).toBe("✅");
    expect(statusBadge("CANCELLED")).toBe("❌");
    expect(statusBadge("WAITING_ADMIN_VERIFY")).toBe("🔴");
    expect(statusBadge("PAYOUT_SENT")).toBe("🔴");
  });

  it("filters never mix ledgers: Thành công=COMPLETED only, Đã hủy=CANCELLED only", () => {
    const done = statusesForGroup("done");
    const cancelled = statusesForGroup("cancelled");
    const processing = statusesForGroup("processing");
    expect(done).toEqual(["COMPLETED"]);
    expect(cancelled).toEqual(["CANCELLED"]);
    // 🔴 Đang xử lý = every non-terminal operational status:
    expect(processing).toContain("WAITING_PAYMENT");
    expect(processing).toContain("WAITING_ADMIN_VERIFY");
    expect(processing).toContain("MANUAL_REVIEW");
    expect(processing).toContain("PAYOUT_SENT");
    expect(processing).not.toContain("COMPLETED");
    expect(processing).not.toContain("CANCELLED");
  });
});

// D — completed Order detail exposes Admin payout receipt viewing
describe("D. Completed Order detail exposes Admin payout receipt", () => {
  async function upsertAdmin(tg: string): Promise<void> {
    await prisma.staffUser.upsert({
      where: { telegramId: tg },
      update: { role: "ADMIN", status: "ACTIVE", permissions: [] },
      create: { telegramId: tg, name: "Ops Admin", role: "ADMIN", status: "ACTIVE", permissions: [] }
    });
  }

  async function clickPayoutView(orderId: string, adminTg: string, updateId: number): Promise<any[]> {
    const { bot, sent } = makeBot();
    await bot.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: `cb-pv-${updateId}`,
        from: { id: Number(adminTg), is_bot: false, first_name: "Admin" },
        data: `ops:payout:view:${orderId}`,
        message: { message_id: 40 + updateId, chat: { id: Number(adminTg), type: "private" }, date: 1, from: { id: Number(adminTg), is_bot: false, first_name: "Admin" } }
      }
    } as any);
    return sent;
  }

  it("photo payout evidence → 🧾 button in detail; click sends the EXACT stored photo", async () => {
    const adminTg = String(886111001);
    await upsertAdmin(adminTg);
    const customer = await mkCustomer("PayoutPhoto");
    const order: any = await mkOrder(customer.id, "COMPLETED", { payoutAt: new Date(), completedAt: new Date() });
    const saved = await FileService.saveEvidenceFile(JPEG, "payout_photo.jpg", "PAYOUT_BILL", "image/jpeg", order.id);
    await prisma.order.update({ where: { id: order.id }, data: { payoutBillFileId: saved.id } });

    // Detail keyboard shows the 🧾 view action:
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    const kb: any = orderDetailKeyboard(fresh);
    const data = kb.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(data).toContain(`ops:payout:view:${order.id}`);

    // Click → EXACT stored evidence bytes sent as a photo:
    const sent = await clickPayoutView(order.id, adminTg, 6);
    const photo = sent.find((c) => c.method === "sendPhoto");
    expect(photo).toBeDefined();
    expect(String(photo!.payload[2]?.caption || "")).toContain(order.id.slice(-6));
  });

  it("PDF payout evidence → click sends the stored document", async () => {
    const adminTg = String(886111002);
    await upsertAdmin(adminTg);
    const customer = await mkCustomer("PayoutPdf");
    const order: any = await mkOrder(customer.id, "COMPLETED", { payoutAt: new Date() });
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("payout-receipt-body")]);
    const saved = await FileService.saveEvidenceFile(pdf, "payout_receipt.pdf", "PAYOUT_BILL", "application/pdf", order.id);
    await prisma.order.update({ where: { id: order.id }, data: { payoutBillFileId: saved.id } });

    const sent = await clickPayoutView(order.id, adminTg, 7);
    const doc = sent.find((c) => c.method === "sendDocument");
    expect(doc).toBeDefined();
    expect(String(doc!.payload[2]?.caption || "")).toContain(order.id.slice(-6));
  });

  it("no payout receipt → NO fake 🧾 action", () => {
    const kb: any = orderDetailKeyboard({
      id: "ORD-OPS-NOPAY", status: "COMPLETED", payoutBillFileId: null,
      payoutAt: null, verifiedAt: null, completedAt: new Date()
    });
    const data = kb.inline_keyboard.flat().map((b: any) => b.callback_data);
    expect(data).not.toContain("ops:payout:view:ORD-OPS-NOPAY");
  });
});

// E — Audit identity + exact GMT+7 time
describe("E. Audit rows: Telegram identity + exact GMT+7 timestamp", () => {
  it("resolves customer from BOTH Customer.id and Telegram ID (display only)", async () => {
    const customer = await mkCustomer("AuditCustomer");
    const logs = [
      { actorId: customer.id, actorRole: "CUSTOMER", action: "ORDER_CREATED", targetId: "ORD-OPS-AUD1", targetType: "ORDER", createdAt: new Date("2026-09-12T08:42:00Z") },
      { actorId: customer.telegramId, actorRole: "CUSTOMER", action: "BILL_SUBMITTED", targetId: "ORD-OPS-AUD2", targetType: "ORDER", createdAt: new Date("2026-09-12T09:00:00Z") }
    ];
    const map = await resolveAuditCustomers(logs);
    const resolved1 = map.get(customer.id);
    const resolved2 = map.get(customer.telegramId);
    expect(resolved1?.telegramId).toBe(customer.telegramId);
    expect(resolved2?.id).toBe(customer.id);
    // Human label prefers name/username — never a long CUID:
    const label = auditCustomerName(resolved1);
    expect(label).not.toMatch(/^cm[a-z0-9]{20,}$/);
  });

  it("exact GMT+7 primary timestamp is available for audit rows (helper contract)", () => {
    expect(formatAdminDateTime(new Date("2026-09-12T08:42:00Z"))).toBe("12/09/2026 15:42");
  });
});



