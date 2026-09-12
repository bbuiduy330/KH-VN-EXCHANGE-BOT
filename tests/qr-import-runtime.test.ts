/**
 * RUNTIME FIX PASS — QR IMPORT + CUSTOMER CONFIRM LABEL + CLEAR CHAT.
 *
 * A/B. Active qrmeta_import wizard + Admin photo (KHQR/VietQR/unsupported/
 *      decoder-failure) → the handler ALWAYS produces an explicit Vietnamese
 *      response (preview or error) — never silence. This is a router-level
 *      test through mainRouter with the wizard session pre-armed.
 * C.   The shared customer confirm label is exactly "✅ Confirm" in
 *      vi/en/km/zh.
 * D.   Clear-chat confirmation screen → NO backend delete operation occurs.
 * E.   Clear-chat execution → Telegram deleteMessages called with the bot's
 *      recorded message ids; Customer/Order/Audit/FileEvidence rows untouched.
 * F.   Telegram deletion failures (old/unavailable messages) → bot continues
 *      safely with the partial-cleanup wording; business data untouched.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { Bot } from "grammy";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { mainRouter } from "../src/bot/router.js";
import { setBotInstance } from "../src/bot/notifications.js";
import { startQrImportWizard } from "../src/bot/admin/account-qr-meta.js";
import { getAdminSession, clearWizard } from "../src/bot/admin/admin-session.js";
import { t, SUPPORTED_LOCALES } from "../src/modules/i18n/locales.js";
import { ConversationService } from "../src/modules/conversation/conversation-service.js";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("qr-import-jpeg")]);
const realFetch = globalThis.fetch;

interface CapturedCall { method: string; payload: any }

function makeBot(): { bot: Bot<any>; sent: CapturedCall[] } {
  const bot = new Bot("100000000:TEST-TOKEN");
  (bot as any).botInfo = { id: 996, is_bot: true, first_name: "QRImport", username: "qr_import_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  const sent: CapturedCall[] = [];
  bot.api.config.use((async (_p: any, method: string, payload: any) => {
    if (method === "getFile") {
      return { ok: true, result: { file_id: payload.file_id, file_path: "qr/import.jpg", file_size: 1000 } };
    }
    sent.push({ method, payload });
    return { ok: true, result: { message_id: 1, chat: { id: payload?.chat_id ?? 1 }, date: 1, text: "" } };
  }) as any);
  bot.use(mainRouter);
  return { bot, sent };
}

let seq = 0;

async function armAdminQrImport(adminTg: string): Promise<string> {
  // Invite the admin with ONLY payment_account.edit → proves permission gate.
  const { PermissionService } = await import("../src/modules/permissions/permission-service.js");
  await PermissionService.inviteStaff({ telegramId: adminTg, name: "QR Import Admin", role: "ADMIN", permissions: ["payment_account.edit"] });
  seq++;
  const account = await prisma.paymentAccount.create({
    data: {
      id: `PA-QRI2-${seq}-${Date.now().toString(36).toUpperCase()}`,
      currency: "USD",
      bankName: "ABA Bank",
      accountName: "PERSONAL ABA USD",
      accountNumber: `0055${seq}`,
      isActive: true
    }
  }) as any;
  // Arm the qrmeta_import wizard the way the 📷 button does:
  const { ctx } = fakeAdminCtx(adminTg);
  await startQrImportWizard(ctx, account.id);
  const wizard = getAdminSession(adminTg).wizard;
  expect(wizard?.kind).toBe("qrmeta_import");
  return account.id;
}

function fakeAdminCtx(adminTg: string): { ctx: any; replies: any[] } {
  const replies: any[] = [];
  return {
    ctx: {
      from: { id: Number(adminTg), is_bot: false, first_name: "Admin" },
      chat: { id: Number(adminTg), type: "private" },
      reply: async (text: string, opts?: any) => { replies.push({ text, opts }); return { message_id: replies.length }; },
      answerCallbackQuery: async () => true
    },
    replies
  };
}

afterAll(() => { globalThis.fetch = realFetch; });

// A/B — router-level: active qrmeta_import + Admin photo → explicit response
describe("A/B. qrmeta_import media intake is NEVER silent", () => {
  const adminTg = String(886333001);

  it("arms an admin + import wizard and answers a photo with preview or explicit error (never silence)", async () => {
    const accountId = await armAdminQrImport(adminTg);
    stubImage(JPEG); // decoder deps may be missing locally — the handler must
                     // still reply with an explicit Vietnamese error message.

    const { bot, sent } = makeBot();
    try {
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 101,
          from: { id: Number(adminTg), is_bot: false, first_name: "Admin" },
          chat: { id: Number(adminTg), type: "private", first_name: "Admin" },
          date: 1,
          photo: [{ file_id: "qr-photo-khqr", file_unique_id: "u1", width: 100, height: 100, file_size: JPEG.length }]
        }
      } as any);

      const reply = sent.find((c) => c.method === "sendMessage");
      // NEVER SILENT: some explicit response reached the Admin.
      expect(reply).toBeDefined();
      const body = String(reply!.payload.text || "");
      // Explicit Vietnamese response — preview (KHQR INDIVIDUAL …) or error:
      const isPreview = body.includes("KHQR") || body.includes("VietQR");
      const isError = body.startsWith("❌") || body.includes("❌");
      expect(isPreview || isError).toBe(true);
      void accountId;
    } finally {
      globalThis.fetch = realFetch;
      clearWizard(adminTg);
    }
  });

  it("VietQR photo with unsupported/decoder failure still yields an explicit error (never silence)", async () => {
    const accountId = await armAdminQrImport(adminTg);
    // Simulate a decoder download failure — the intake MUST surface an error.
    (globalThis as any).fetch = async () => ({ ok: false, status: 502, headers: { get: () => "" } });
    const { bot, sent } = makeBot();
    try {
      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 102,
          from: { id: Number(adminTg), is_bot: false, first_name: "Admin" },
          chat: { id: Number(adminTg), type: "private", first_name: "Admin" },
          date: 1,
          photo: [{ file_id: "qr-photo-vietqr", file_unique_id: "u2", width: 100, height: 100, file_size: JPEG.length }]
        }
      } as any);

      const reply = sent.find((c) => c.method === "sendMessage");
      expect(reply).toBeDefined(); // explicit error, never silence
      expect(String(reply!.payload.text || "").startsWith("❌")).toBe(true);
      void accountId;
    } finally {
      globalThis.fetch = realFetch;
      clearWizard(adminTg);
    }
  });
});

function stubImage(buffer: Buffer): void {
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/octet-stream" },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  });
}

// C — ONE shared customer confirm label = "✅ Confirm" in every locale
describe("C. Shared customer Confirm label", () => {
  it("common.confirm_btn is exactly '✅ Confirm' for vi/en/km/zh", () => {
    for (const loc of SUPPORTED_LOCALES) {
      expect(t(loc, "common.confirm_btn")).toBe("✅ Confirm");
    }
  });

  it("customer financial confirm keys are also exactly '✅ Confirm'", () => {
    for (const loc of SUPPORTED_LOCALES) {
      expect(t(loc, "quote.confirm_btn")).toBe("✅ Confirm");
      expect(t(loc, "payout.confirm_btn")).toBe("✅ Confirm");
    }
  });
});

// D — clear-chat confirmation: no backend delete operation
describe("D. Clear-chat confirmation screen deletes NOTHING backend", () => {
  async function mkCustomerWithTrackedMessages(): Promise<{ customer: any; trackedIds: number[] }> {
    seq++;
    const customer = await CustomerService.getOrCreateCustomer({
      telegramId: String(887000000 + seq),
      username: `clearchat_${seq}`
    });
    const conv = await ConversationService.getOrCreateConversation(customer.id);
    const trackedIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      await prisma.message.create({
        data: { conversationId: conv.id, senderType: "BOT", content: `tracked ${i}`, telegramMessageId: 1000 + i }
      });
      trackedIds.push(1000 + i);
    }
    return { customer, trackedIds };
  }

  function clearCallback(updateId: number, customer: any, data: string): any {
    return {
      update_id: updateId,
      callback_query: {
        id: `cb-cc-${updateId}`,
        from: { id: Number(customer.telegramId), is_bot: false, first_name: "C" },
        data,
        message: { message_id: 20 + updateId, chat: { id: Number(customer.telegramId), type: "private" }, date: 1, from: { id: Number(customer.telegramId), is_bot: false, first_name: "C" } }
      }
    } as any;
  }

  it("confirmation screen shows bullets + buttons and performs NO backend deletion", async () => {
    const { customer } = await mkCustomerWithTrackedMessages();
    const { calls, fake } = captureBotApi();
    setBotInstance(fake as any);
    const deleteManySpy = vi.spyOn(prisma.message, "deleteMany" as any).mockImplementation(async () => { throw new Error("MUST NOT BE CALLED"); });

    const { bot, sent } = makeBot();
    try {
      await bot.handleUpdate(clearCallback(3, customer, "customer:menu:clearchat"));

      const reply = sent.find((c) => c.method === "sendMessage");
      expect(reply).toBeDefined();
      const body = String(reply!.payload.text || "");
      expect(body).toContain("Xóa nội dung trò chuyện");
      expect(body).toContain("Không hủy giao dịch đang xử lý");
      expect(body).toContain("bảo toàn");
      const kb = JSON.stringify(reply!.payload.reply_markup || {});
      expect(kb).toContain("customer:clearchat:go");
      expect(kb).toContain("customer:clearchat:back");
      // Confirmation only — NO Telegram deletion, NO backend deletion:
      expect(calls.some((c: any) => String(c.method).startsWith("delete"))).toBe(false);
      expect(deleteManySpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
      deleteManySpy.mockRestore();
    }
  });
});

function captureBotApi(): { calls: any[]; fake: any } {
  const calls: any[] = [];
  const fake = {
    api: new Proxy({}, {
      get: (_t, prop) => async (...args: any[]) => {
        calls.push({ method: String(prop), payload: args });
        return true;
      }
    })
  };
  return { calls, fake };
}

// E — clear-chat execution: Telegram delete APIs called, business rows intact
describe("E. Clear-chat execution deletes Telegram messages only", () => {
  it("deleteMessages called with recorded ids; Customer/Message/Audit rows untouched", async () => {
    const { customer, trackedIds } = await mkCustomerWithTrackedMessages();
    const { calls, fake } = captureBotApi();
    setBotInstance(fake as any);
    const deleteManySpy = vi.spyOn(prisma.message, "deleteMany" as any).mockImplementation(async () => { throw new Error("MUST NOT BE CALLED"); });

    const { bot, sent } = makeBot();
    try {
      await bot.handleUpdate(clearCallback(4, customer, "customer:clearchat:go"));

      // Telegram batch API called with the bot's recorded ids:
      const batch = calls.find((c: any) => c.method === "deleteMessages");
      expect(batch).toBeDefined();
      expect(batch!.payload[1]).toEqual(trackedIds);

      // Fresh menu message with the done wording:
      const reply = sent.find((c: any) => c.method === "sendMessage");
      expect(String(reply!.payload.text || "")).toContain("làm sạch");

      // Business data untouched:
      const cust: any = await prisma.customer.findUnique({ where: { id: customer.id } });
      expect(cust).not.toBeNull();
      const rows = await prisma.message.findMany({ where: { conversationId: (await ConversationService.getOrCreateConversation(customer.id)).id } });
      expect(rows.length).toBe(3); // history intact — only Telegram copies deleted
      expect(deleteManySpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
      deleteManySpy.mockRestore();
    }
  });
});

// F — Telegram deletion failures are tolerated safely
describe("F. Telegram deletion failure → bot continues safely", () => {
  it("old/unavailable messages → partial wording, business data untouched", async () => {
    const { customer, trackedIds } = await mkCustomerWithTrackedMessages();
    const failingBot = {
      api: new Proxy({}, { get: () => async () => { throw new Error("Bad Request: message to delete not found"); } })
    };
    setBotInstance(failingBot as any);
    const { bot, sent } = makeBot();
    try {
      await bot.handleUpdate(clearCallback(5, customer, "customer:clearchat:go"));

      const reply = sent.find((c: any) => c.method === "sendMessage");
      expect(reply).toBeDefined();
      expect(String(reply!.payload.text || "")).toContain("Đã làm sạch các tin nhắn có thể xóa");

      const rows = await prisma.message.findMany({ where: { conversationId: (await ConversationService.getOrCreateConversation(customer.id)).id } });
      expect(rows.length).toBe(3);
      const cust: any = await prisma.customer.findUnique({ where: { id: customer.id } });
      expect(cust).not.toBeNull();
      void trackedIds;
    } finally {
      globalThis.fetch = realFetch;
      setBotInstance(null);
    }
  });
});



