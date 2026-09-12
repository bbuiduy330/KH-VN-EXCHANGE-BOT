/**
 * TASK 1 REGRESSION - router-level payment-bill intake (dev-ai runtime fix).
 *
 * Real runtime scenario: 100 USD -> quote -> confirm -> payment QR sent ->
 * customer sends the payment bill IMAGE.
 *
 * Guarantees exercised here THROUGH THE REAL mainRouter (identity -> photo
 * router -> handleCustomerPhoto), not through a single handler:
 *   1. WAITING_PAYMENT Order + customer photo -> OrderService.submitCustomerBill
 *      is called (Order -> WAITING_ADMIN_VERIFY).
 *   2. Evidence durably stored (FileEvidence + OrderBillEvidence + file on
 *      disk, verified via the authoritative getCustomerBillEvidence reader).
 *   3. Admin notification chat receives the TEXT notification AND the ACTUAL
 *      photo (botInstance.api.sendPhoto).
 *   4. The bill media NEVER reaches the conversational AI
 *      (ConversationalAIService.generateReply is never called; the photo
 *      router has no AI path at all).
 *   5. A SECOND bill photo is STILL ingested (order now WAITING_ADMIN_VERIFY)
 *      -> MANUAL_REVIEW + Admin-only ADDITIONAL_BILL warning ("second bill
 *      image may be ignored" regression).
 *   6. A photo for a customer with exactly one eligible WAITING_PAYOUT Order
 *      (no payout destination) is a payout QR - never a bill.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { Bot } from "grammy";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { mainRouter } from "../src/bot/router.js";
import { setBotInstance } from "../src/bot/notifications.js";
import { getCustomerBillEvidence } from "../src/modules/orders/bill-evidence.js";
import { RuntimeConfigService } from "../src/modules/system-config/runtime-config-service.js";
import { LocalStorageService } from "../src/modules/storage/local-storage-service.js";
import { ConversationalAIService } from "../src/modules/ai/customer-ai-service.js";
import { getPendingBillSession, clearPendingBillSession } from "../src/bot/state/pending-bill-session.js";

const ADMIN_CHAT = "881100001";

interface CapturedCall {
  method: string;
  payload: any;
}

/** Fake bot instance for the notifications module (Admin chat deliveries). */
function makeAdminCaptureBot(): { calls: CapturedCall[]; fake: any } {
  const calls: CapturedCall[] = [];
  const fake = {
    api: new Proxy(
      {},
      {
        get: (_t, prop) => async (...args: any[]) => {
          calls.push({ method: String(prop), payload: args });
          return { ok: true, result: { message_id: 1, chat: { id: 1 }, date: 1 } };
        }
      }
    )
  };
  return { calls, fake };
}

/** Real grammY Bot wired to the REAL mainRouter; Telegram API captured. */
function makeBot(): { bot: Bot<any>; sent: CapturedCall[] } {
  const bot = new Bot("100000000:TEST-TOKEN");
  (bot as any).botInfo = {
    id: 998,
    is_bot: true,
    first_name: "BillRouteTestBot",
    username: "bill_route_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false
  };
  const sent: CapturedCall[] = [];
  bot.api.config.use((async (_prev: any, method: string, payload: any) => {
    if (method === "getFile") {
      return { ok: true, result: { file_id: payload.file_id, file_path: "bills/bill-route-test.jpg", file_size: 1000 } };
    }
    sent.push({ method, payload });
    return { ok: true, result: { message_id: 1, chat: { id: payload?.chat_id ?? 1 }, date: 1, text: "" } };
  }) as any);
  bot.use(mainRouter);
  return { bot, sent };
}

/**
 * Unique upload bytes per test: submitCustomerBill flags a SHA-256 that
 * already exists on ANOTHER order as SUSPICIOUS (fraud guard), so every
 * simulated photo must carry distinct bytes.
 */
let jpegSeq = 0;
function makeJpeg(tag: string): Buffer {
  jpegSeq++;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0 + (jpegSeq % 8)]),
    Buffer.from(`bill-routing-${tag}-${jpegSeq}-${Date.now()}`)
  ]);
}
const realFetch = globalThis.fetch;

function stubFetch(buffer: Buffer): void {
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/octet-stream" },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  });
}

function photoUpdate(updateId: number, telegramId: string, fileId: string, bytes: number): any {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      from: { id: Number(telegramId), is_bot: false, first_name: "Bill", username: `bill_${telegramId}` },
      chat: { id: Number(telegramId), type: "private", first_name: "Bill" },
      date: 1,
      photo: [{ file_id: fileId, file_unique_id: `u-${fileId}`, width: 64, height: 64, file_size: bytes }]
    }
  };
}

let seq = 0;
async function makeCustomerOrder(status: string): Promise<{ order: any; telegramId: string }> {
  seq++;
  const telegramId = String(882000000 + seq);
  const customer = await CustomerService.getOrCreateCustomer({
    telegramId,
    username: `billroute_${seq}`
  });
  const order = await prisma.order.create({
    data: {
      id: `ORD-BR-${seq}-${Date.now().toString(36).toUpperCase()}`,
      customerId: customer.id,
      sourceCurrency: "USD",
      targetCurrency: "VND",
      sourceAmount: 100,
      targetAmount: 2540000,
      rate: 25400,
      fee: 2,
      feeCurrency: "USD",
      status
    }
  });
  return { order, telegramId };
}

/** Customer with TWO billable (WAITING_PAYMENT) Orders + both order rows. */
async function makeTwoBillableOrders(): Promise<{ orderA: any; orderB: any; telegramId: string }> {
  const n = ++seq;
  const telegramId = String(883000000 + n);
  const customer = await CustomerService.getOrCreateCustomer({
    telegramId,
    username: `billroute_multi_${n}`
  });
  const mk = (tag: string, amount: number) =>
    prisma.order.create({
      data: {
        id: `ORD-BRM-${tag}-${n}-${Date.now().toString(36).toUpperCase()}`,
        customerId: customer.id,
        sourceCurrency: "USD",
        targetCurrency: "VND",
        sourceAmount: amount,
        targetAmount: amount * 25400,
        rate: 25400,
        fee: 2,
        feeCurrency: "USD",
        status: "WAITING_PAYMENT"
      }
    });
  const orderA: any = await mk("A", 100);
  const orderB: any = await mk("B", 200);
  return { orderA, orderB, telegramId };
}

function callbackUpdate(updateId: number, telegramId: string, data: string): any {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: Number(telegramId), is_bot: false, first_name: "Bill", username: `bill_${telegramId}` },
      data,
      message: { message_id: 500 + updateId, chat: { id: Number(telegramId), type: "private" }, date: 1, from: { id: Number(telegramId), is_bot: false, first_name: "Bill" } }
    }
  };
}

describe("Router-level payment-bill intake (WAITING_PAYMENT + customer photo)", () => {
  it("stores the bill, advances the Order, notifies Admin with the ACTUAL photo, and the AI is NEVER called", async () => {
    const { order, telegramId } = await makeCustomerOrder("WAITING_PAYMENT");
    await RuntimeConfigService.setAdminNotificationChatId(ADMIN_CHAT, "TEST");

    const { calls, fake } = makeAdminCaptureBot();
    setBotInstance(fake as any);

    // Financial media must never reach the conversational AI:
    const generateReply = vi.spyOn(ConversationalAIService, "generateReply");

    stubFetch(makeJpeg("first"));
    const { bot, sent } = makeBot();
    try {
      await bot.handleUpdate(photoUpdate(1, telegramId, "bill-photo-1", 1024));

      // 1. submitCustomerBill ran: state transition + promoted primary ref.
      const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
      expect(fresh.status).toBe("WAITING_ADMIN_VERIFY");
      expect(fresh.customerBillFileId).toBeTruthy();

      // 2. Evidence durably stored (authoritative reader + evidence table + file).
      const evidence = await getCustomerBillEvidence(order.id);
      expect(evidence).not.toBeNull();
      expect(evidence!.source).toBe("primary");
      const billRows = await prisma.orderBillEvidence.findMany({ where: { orderId: order.id } });
      expect(billRows.length).toBeGreaterThan(0);
      expect(await LocalStorageService.readFile(evidence!.filePath!)).not.toBeNull();

      // 3. Admin received the ACTUAL photo (sendPhoto to the Admin chat) plus
      //    the order-referenced text notification.
      const adminPhoto = calls.find((c) => c.method === "sendPhoto");
      expect(adminPhoto).toBeDefined();
      expect(String(adminPhoto!.payload[0])).toBe(ADMIN_CHAT);
      expect(String(adminPhoto!.payload[2]?.caption || "")).toContain(order.id.slice(-6));
      const adminText = calls.find((c) => c.method === "sendMessage" && String(c.payload[0]) === ADMIN_CHAT);
      expect(adminText).toBeDefined();
      expect(String(adminText!.payload[1] || "")).toContain(order.id.slice(-6));
      // No risk/duplicate warning on a clean first bill:
      const riskFreeBody = String(adminText!.payload[1] || "");
      expect(riskFreeBody).not.toContain("Bill trùng");
      expect(riskFreeBody).not.toContain("Bill bổ sung");

      // 4. Customer got the required acknowledgment.
      const ack = sent.find(
        (c) => c.method === "sendMessage" && String(c.payload.text || "").includes("Đã nhận bill")
      );
      expect(ack).toBeDefined();

      // 5. AI was NEVER called (with the bill media or anything else).
      expect(generateReply).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
      generateReply.mockRestore();
    }
  });

  it("a SECOND bill photo is still ingested (WAITING_ADMIN_VERIFY) -> MANUAL_REVIEW + Admin risk warning", async () => {
    const { order, telegramId } = await makeCustomerOrder("WAITING_PAYMENT");
    await RuntimeConfigService.setAdminNotificationChatId(ADMIN_CHAT, "TEST");
    const { calls, fake } = makeAdminCaptureBot();
    setBotInstance(fake as any);

    const generateReply = vi.spyOn(ConversationalAIService, "generateReply");
    const { bot } = makeBot();
    try {
      // First bill -> WAITING_ADMIN_VERIFY.
      stubFetch(makeJpeg("second-first"));
      await bot.handleUpdate(photoUpdate(2, telegramId, "bill-photo-1", 1024));
      let fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
      expect(fresh.status).toBe("WAITING_ADMIN_VERIFY");

      // SECOND bill -> must NOT be ignored: re-upload recorded + flagged.
      stubFetch(makeJpeg("second-extra"));
      await bot.handleUpdate(photoUpdate(3, telegramId, "bill-photo-2", 2048));
      fresh = await prisma.order.findUnique({ where: { id: order.id } });
      expect(fresh.status).toBe("MANUAL_REVIEW");
      const bills = await prisma.orderBillEvidence.findMany({ where: { orderId: order.id } });
      expect(bills.length).toBe(2); // both photos preserved, none dropped

      // Admin-only risk warning for the additional bill:
      const adminTexts = calls.filter((c) => c.method === "sendMessage" && String(c.payload[0]) === ADMIN_CHAT);
      const body = adminTexts.map((c) => String(c.payload[1] || "")).join("\n");
      expect(body).toContain("Bill bổ sung");

      // The conversational AI was never involved.
      expect(generateReply).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
      generateReply.mockRestore();
    }
  });

  it("exactly-one WAITING_PAYOUT Order (no destination) consumes the photo as payout QR - never a bill", async () => {
    const { order, telegramId } = await makeCustomerOrder("WAITING_PAYOUT");
    await prisma.order.update({
      where: { id: order.id },
      data: { verifiedAt: new Date(), payoutBankSnapshot: null }
    });

    const { calls, fake } = makeAdminCaptureBot();
    setBotInstance(fake as any);
    const generateReply = vi.spyOn(ConversationalAIService, "generateReply");

    const { bot } = makeBot();
    try {
      stubFetch(makeJpeg("payout"));
      await bot.handleUpdate(photoUpdate(3, telegramId, "payout-photo-1", 1024));

      const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
      expect((fresh.payoutBankSnapshot as any)?.type).toBe("qr");
      // No bill evidence may ever be created from this photo:
      const bill = await getCustomerBillEvidence(order.id);
      expect(bill).toBeNull();
      const billRows = await prisma.orderBillEvidence.findMany({ where: { orderId: order.id } });
      expect(billRows.length).toBe(0);

      // Admin is notified that the payout destination arrived (text event).
      const adminText = calls.find((c) => c.method === "sendMessage" && String(c.payload[0]) === ADMIN_CHAT);
      expect(adminText).toBeDefined();
      expect(String(adminText!.payload[1] || "")).toContain("CẦN THANH TOÁN KHÁCH");

      // The conversational AI was never involved.
      expect(generateReply).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
      generateReply.mockRestore();
    }
  });

  it("TWO billable Orders + one photo -> Order chooser, NO auto-attach, selection attaches ORIGINAL media", async () => {
    const { orderA, orderB, telegramId } = await makeTwoBillableOrders();
    const { fake } = makeAdminCaptureBot();
    setBotInstance(fake as any);
    const generateReply = vi.spyOn(ConversationalAIService, "generateReply");
    stubFetch(makeJpeg("multi-order"));
    const { bot, sent } = makeBot();
    try {
      // 1. Incoming photo with MULTIPLE billable Orders:
      await bot.handleUpdate(photoUpdate(4, telegramId, "bill-photo-multi", 4096));

      // NO Order may receive evidence before the explicit selection.
      expect(await getCustomerBillEvidence(orderA.id)).toBeNull();
      expect(await getCustomerBillEvidence(orderB.id)).toBeNull();
      const freshA: any = await prisma.order.findUnique({ where: { id: orderA.id } });
      const freshB: any = await prisma.order.findUnique({ where: { id: orderB.id } });
      expect(freshA.status).toBe("WAITING_PAYMENT");
      expect(freshB.status).toBe("WAITING_PAYMENT");

      // The pending-bill session holds the ORIGINAL media reference...
      const pending = getPendingBillSession(telegramId);
      expect(pending).not.toBeNull();
      expect(pending!.fileId).toBe("bill-photo-multi");
      expect(pending!.mediaType).toBe("photo");

      // ...and the customer got the Order chooser (both orders, no resend).
      const chooser = sent.find(
        (c) => c.method === "sendMessage" && JSON.stringify(c.payload.reply_markup || {}).includes("customer:bill:attach:")
      );
      expect(chooser).toBeDefined();
      const chooserKb = JSON.stringify(chooser!.payload.reply_markup);
      expect(chooserKb).toContain(`customer:bill:attach:${orderA.id}`);
      expect(chooserKb).toContain(`customer:bill:attach:${orderB.id}`);
      expect(String(chooser!.payload.text || "")).toContain("không cần gửi lại");

      // 2. Customer selects order B -> ORIGINAL media attaches to B ONLY.
      await bot.handleUpdate(callbackUpdate(5, telegramId, `customer:bill:attach:${orderB.id}`));

      const selected: any = await prisma.order.findUnique({ where: { id: orderB.id } });
      expect(selected.status).toBe("WAITING_ADMIN_VERIFY");
      expect(selected.customerBillFileId).toBeTruthy();
      expect(await getCustomerBillEvidence(orderB.id)).not.toBeNull();
      // A: evidence stored EXACTLY ONCE for the selected Order.
      const selectedRows = await prisma.orderBillEvidence.findMany({ where: { orderId: orderB.id } });
      expect(selectedRows.length).toBe(1);

      // Order A untouched: NO evidence, still WAITING_PAYMENT.
      const untouchedA: any = await prisma.order.findUnique({ where: { id: orderA.id } });
      expect(untouchedA.status).toBe("WAITING_PAYMENT");
      expect(await getCustomerBillEvidence(orderA.id)).toBeNull();

      // 3. Pending session CLEARED after selection (single-use).
      expect(getPendingBillSession(telegramId)).toBeNull();

      // 4. Customer ack — the bill was accepted without any re-send.
      const ack = sent.find(
        (c) => c.method === "sendMessage" && String(c.payload.text || "").includes("Đã nhận bill")
      );
      expect(ack).toBeDefined();

      // 5. Conversational AI never involved.
      expect(generateReply).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
      clearPendingBillSession(telegramId);
      generateReply.mockRestore();
    }
  });

  it("B. upload/storage failure KEEPS the pending session; retry succeeds with the ORIGINAL media (no resend)", async () => {
    const { orderA, orderB, telegramId } = await makeTwoBillableOrders();
    const { fake } = makeAdminCaptureBot();
    setBotInstance(fake as any);
    const generateReply = vi.spyOn(ConversationalAIService, "generateReply");
    const { bot, sent } = makeBot();
    try {
      // Photo -> chooser -> pending session holds the ORIGINAL media ref.
      stubFetch(makeJpeg("retry"));
      await bot.handleUpdate(photoUpdate(6, telegramId, "bill-photo-retry", 1024));
      expect(getPendingBillSession(telegramId)).not.toBeNull();

      // 1st attempt: the Telegram file download FAILS (storage/network fault).
      (globalThis as any).fetch = async () => ({
        ok: false,
        status: 500,
        headers: { get: () => "" },
        arrayBuffer: async () => new ArrayBuffer(0)
      });
      await bot.handleUpdate(callbackUpdate(7, telegramId, `customer:bill:attach:${orderB.id}`));

      // NO evidence may be stored on a failed attempt.
      expect(await getCustomerBillEvidence(orderB.id)).toBeNull();
      const freshB: any = await prisma.order.findUnique({ where: { id: orderB.id } });
      expect(freshB.status).toBe("WAITING_PAYMENT");

      // The ORIGINAL media reference is RESTORED — retry needs NO resend.
      const restored = getPendingBillSession(telegramId);
      expect(restored).not.toBeNull();
      expect(restored!.fileId).toBe("bill-photo-retry");
      expect(restored!.mediaType).toBe("photo");

      // Concise retry message (no resend required).
      const retryMsg = sent.find(
        (c) => c.method === "sendMessage" && String(c.payload.text || "").includes("vẫn được giữ")
      );
      expect(retryMsg).toBeDefined();

      // Retry (same pending media, same order button) now SUCCEEDS.
      stubFetch(makeJpeg("retry-success"));
      await bot.handleUpdate(callbackUpdate(8, telegramId, `customer:bill:attach:${orderB.id}`));

      const selected: any = await prisma.order.findUnique({ where: { id: orderB.id } });
      expect(selected.status).toBe("WAITING_ADMIN_VERIFY");
      const rows = await prisma.orderBillEvidence.findMany({ where: { orderId: orderB.id } });
      expect(rows.length).toBe(1); // exactly once across both attempts
      expect(await getCustomerBillEvidence(orderB.id)).not.toBeNull();

      // Success finally clears the pending session.
      expect(getPendingBillSession(telegramId)).toBeNull();

      // Conversational AI never involved (failure or retry).
      expect(generateReply).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
      clearPendingBillSession(telegramId);
      generateReply.mockRestore();
    }
  });

  it("C2. DOUBLE callback while processing -> at most ONE evidence attachment", async () => {
    const { orderA, orderB, telegramId } = await makeTwoBillableOrders();
    const { fake } = makeAdminCaptureBot();
    setBotInstance(fake as any);
    const generateReply = vi.spyOn(ConversationalAIService, "generateReply");
    const { bot, sent } = makeBot();
    try {
      // Photo -> chooser -> pending session.
      stubFetch(makeJpeg("double-click"));
      await bot.handleUpdate(photoUpdate(9, telegramId, "bill-photo-double", 1024));
      expect(getPendingBillSession(telegramId)).not.toBeNull();

      // SLOW download keeps the first attempt genuinely in flight while the
      // second (double-click) callback is dispatched concurrently.
      const buffer = Buffer.from("double-click-slow-body");
      (globalThis as any).fetch = async () => {
        await new Promise((r) => setTimeout(r, 80));
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/octet-stream" },
          arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        };
      };

      await Promise.all([
        bot.handleUpdate(callbackUpdate(10, telegramId, `customer:bill:attach:${orderB.id}`)),
        bot.handleUpdate(callbackUpdate(11, telegramId, `customer:bill:attach:${orderB.id}`))
      ]);

      // At most ONE evidence attachment:
      const rows = await prisma.orderBillEvidence.findMany({ where: { orderId: orderB.id } });
      expect(rows.length).toBe(1);
      const freshB: any = await prisma.order.findUnique({ where: { id: orderB.id } });
      expect(freshB.status).toBe("WAITING_ADMIN_VERIFY");
      const untouchedA: any = await prisma.order.findUnique({ where: { id: orderA.id } });
      expect(await getCustomerBillEvidence(orderA.id)).toBeNull();

      // Session cleared on success; the second click got the "processing" note.
      expect(getPendingBillSession(telegramId)).toBeNull();
      const processing = sent.find(
        (c) => c.method === "sendMessage" && String(c.payload.text || "").includes("Đang xử lý")
      );
      expect(processing).toBeDefined();

      // Conversational AI never involved.
      const generateReplyNotUsed = !generateReply.mock.calls.length;
      expect(generateReplyNotUsed).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
      clearPendingBillSession(telegramId);
      generateReply.mockRestore();
    }
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

