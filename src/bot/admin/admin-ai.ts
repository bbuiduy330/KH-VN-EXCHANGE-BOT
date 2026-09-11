/**
 * Admin AI management — key update (secure session), model management, text
 * test, voice diagnostic, and runtime key removal. Never exposes the key.
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { env } from "../../config/env.js";
import { AiProvider } from "../../modules/ai/ai-provider.js";
import { SystemSecretService } from "../../modules/system-config/system-secret-service.js";
import { SystemConfigService } from "../../modules/system-config/system-config-service.js";
import { GeminiModelStrategy } from "../../modules/ai/gemini-models.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { clearWizard, consumePendingAction, getAdminSession, isSessionExpired, setPendingAction, startWizard, updateWizard } from "./admin-session.js";

export const adminAiHandler = new Composer<BotContext>();

export async function showAiManagement(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const resolved = await SystemSecretService.resolveGeminiApiKey();
  const configured = Boolean(resolved.key && resolved.key.length > 0);
  const sourceLabel = resolved.source === "ENCRYPTED_DB" ? "ENCRYPTED_DB" : resolved.source === "ENV" ? "ENV" : "NONE";
  const textModel = SystemConfigService.getGeminiTextModel();
  const sttModel = SystemConfigService.getGeminiTranscribeModel() || textModel;

  const lines = [
    "🤖 <b>QUẢN LÝ AI</b>",
    "",
    `🔑 API Key: ${configured ? "✅ Đã cấu hình" : "❌ Chưa cấu hình"}`,
    `Nguồn: <b>${sourceLabel}</b>`,
    "",
    `🧠 Text model: <b>${escapeHtml(textModel)}</b>`,
    `🎙 Voice/STT model: <b>${escapeHtml(sttModel)}</b>`,
    "",
    `🟢 Trạng thái: ${configured ? "Hoạt động" : "Chưa cấu hình"}`
  ];

  const kb = new InlineKeyboard()
    .text("🧪 Test Text AI", "ops:ai:test:text")
    .row()
    .text("🎙 Test Voice/STT", "ops:ai:test:voice")
    .row()
    .text("🔑 Cập nhật API Key", "ops:ai:key:input")
    .row()
    .text("🧠 Đổi Text model", "ops:ai:model:text")
    .text("🎙 Đổi Voice model", "ops:ai:model:stt")
    .row()
    .text("🗑 Xóa runtime API Key", "ops:ai:key:delete:preview")
    .row()
    .text("🏠 Menu Admin", "ops:home");

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

// ---------------------------------------------------------------------------
// API key update (SUPER_ADMIN / private only; message deleted after capture)
// ---------------------------------------------------------------------------

export async function startAiKeyInput(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (ctx.identity?.userType !== "SUPER_ADMIN") {
    await ctx.reply("⛔ Chỉ Super Admin mới có quyền cập nhật API Key.").catch(() => {});
    return;
  }
  if (ctx.chat?.type !== "private") {
    await ctx.answerCallbackQuery({ text: "⛔ Cập nhật API Key chỉ trong chat riêng.", show_alert: true }).catch(() => {});
    return;
  }
  startWizard(String(ctx.from?.id || ""), "ai_key_input", {});
  await ctx.reply("🔑 <b>GỬI GEMINI API KEY MỚI</b>\n\nTin nhắn chứa key sẽ được xóa sau khi xử lý.\n\nGửi /cancel để hủy.", { parse_mode: "HTML" });
}

export async function handleAiKeyInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || wizard.kind !== "ai_key_input") return false;

  // Delete the key message immediately (even for expired sessions).
  try {
    await ctx.deleteMessage();
  } catch {
    /* ignore */
  }

  // Expired session → reject BEFORE reading/saving the key. The message has
  // already been deleted above, so the secret never persists in chat.
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên nhập API Key đã hết hạn. Vui lòng bắt đầu lại.").catch(() => {});
    return true;
  }

  if (ctx.identity?.userType !== "SUPER_ADMIN") {
    clearWizard(adminId);
    await ctx.reply("⛔ Chỉ Super Admin mới có quyền cập nhật API Key.").catch(() => {});
    return true;
  }

  const newKey = text.trim();
  if (newKey.length < 20) {
    clearWizard(adminId);
    await ctx.reply("❌ Key không hợp lệ. Vui lòng cung cấp key hợp lệ từ Google AI Studio.").catch(() => {});
    return true;
  }

  const wait = await ctx.reply("⏳ Đang xác thực key mới với Google Gemini...").catch(() => null);
  const testRes = await AiProvider.testGeminiConnection(newKey);
  if (!testRes.ok) {
    clearWizard(adminId);
    await ctx.reply("❌ Key mới không hợp lệ. Key hiện tại vẫn được giữ nguyên.").catch(() => {});
    return true;
  }

  await SystemSecretService.setSecret("GEMINI_API_KEY", newKey, adminId);
  AiProvider.invalidateClient();
  clearWizard(adminId);

  const msg = `✅ <b>ĐÃ CẬP NHẬT API KEY</b>\n\nNguồn: ENCRYPTED_DB\nModel: <b>${escapeHtml(testRes.actualModel || testRes.primaryModel || "")}</b>\nĐộ trễ: ${testRes.latencyMs} ms`;
  if (wait) {
    await ctx.api.editMessageText(ctx.chat!.id, wait.message_id, msg, { parse_mode: "HTML" }).catch(() => {});
  } else {
    await ctx.reply(msg, { parse_mode: "HTML" }).catch(() => {});
  }
  return true;
}

// ---------------------------------------------------------------------------
// Model management (text / STT) — validate → preview → confirm → persist
// ---------------------------------------------------------------------------

export async function startModelInput(ctx: BotContext, kind: "text" | "stt"): Promise<void> {
  await ctx.answerCallbackQuery();
  if (ctx.identity?.userType !== "SUPER_ADMIN") {
    await ctx.reply("⛔ Chỉ Super Admin mới có quyền đổi model.").catch(() => {});
    return;
  }
  startWizard(String(ctx.from?.id || ""), kind === "text" ? "ai_text_model" : "ai_stt_model", {});
  const current = kind === "text" ? SystemConfigService.getGeminiTextModel() : SystemConfigService.getGeminiTranscribeModel();
  const note = kind === "stt" ? `\n\nHiện tại: <b>${escapeHtml(current || "đang dùng model Text")}</b>\nĐể trống nếu muốn dùng lại model Text.` : `\n\nHiện tại: <b>${escapeHtml(current)}</b>`;
  await ctx.reply(`🧠 <b>NHẬP ${kind === "text" ? "TEXT" : "VOICE/STT"} MODEL</b>\n\nGửi mã model (ví dụ: gemini-3.8-flash).${note}\n\nGửi /cancel để hủy.`, { parse_mode: "HTML" });
}

export async function handleAiModelInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || (wizard.kind !== "ai_text_model" && wizard.kind !== "ai_stt_model")) return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên đổi model đã hết hạn.").catch(() => {});
    return true;
  }
  const model = text.trim();
  if (!model || model.length < 3) {
    await ctx.reply("❌ Mã model không hợp lệ. Nhập lại hoặc /cancel.").catch(() => {});
    return true;
  }

  const isStt = wizard.kind === "ai_stt_model";

  if (isStt) {
    // STT: enter voice validation mode (do NOT persist yet).
    updateWizard(adminId, { step: 2, data: { model } });
    await ctx.reply(`🎙 <b>XÁC THỰC STT MODEL</b>\n\nGửi một tin nhắn thoại ngắn để xác thực model <b>${escapeHtml(model)}</b>.\n\nGửi /cancel để hủy.`, { parse_mode: "HTML" });
    return true;
  }

  // Text model: test candidate BEFORE persisting.
  const wait = await ctx.reply(`⏳ Đang xác thực model <b>${escapeHtml(model)}</b>...`, { parse_mode: "HTML" }).catch(() => null);
  const res = await AiProvider.testGeminiConnection(undefined, model);
  if (!res.ok) {
    clearWizard(adminId);
    const msg = `❌ Model <b>${escapeHtml(model)}</b> không hoạt động.\nModel hiện tại vẫn được giữ nguyên.\nLỗi: <code>${escapeHtml(String(res.error || "").slice(0, 140))}</code>`;
    if (wait) {
      await ctx.api.editMessageText(ctx.chat!.id, wait.message_id, msg, { parse_mode: "HTML" }).catch(() => {});
    } else {
      await ctx.reply(msg, { parse_mode: "HTML" }).catch(() => {});
    }
    return true;
  }

  updateWizard(adminId, { step: 2, data: { model, actualModel: res.actualModel, latencyMs: res.latencyMs } });
  const text2 =
    `⚠️ <b>XÁC NHẬN ĐỔI TEXT MODEL</b>\n\n` +
    `Model yêu cầu: <b>${escapeHtml(model)}</b>\n` +
    `Model thực tế: <b>${escapeHtml(res.actualModel || "N/A")}</b>\n` +
    `Độ trễ: ${res.latencyMs} ms\nFallback: ${res.fallbackUsed ? "Có" : "Không"}`;
  const kb = new InlineKeyboard().text("✅ LƯU", "ops:ai:model:confirm").row().text("❌ HỦY", "ops:ai:model:cancel");
  if (wait) {
    await ctx.api.editMessageText(ctx.chat!.id, wait.message_id, text2, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  } else {
    await ctx.reply(text2, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  }
  return true;
}

export async function confirmModelSave(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (ctx.identity?.userType !== "SUPER_ADMIN") {
    await ctx.reply("⛔ Chỉ Super Admin mới có quyền đổi model.").catch(() => {});
    return;
  }
  const adminId = String(ctx.from?.id || "");
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên đổi model đã hết hạn.").catch(() => {});
    return;
  }
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || (wizard.kind !== "ai_text_model" && wizard.kind !== "ai_stt_model")) {
    await ctx.reply("⚠️ Không có phiên đổi model.").catch(() => {});
    return;
  }
  const model = wizard.data.model;
  const isStt = wizard.kind === "ai_stt_model";
  const testedStep = isStt ? 3 : 2;
  if (wizard.step < testedStep) {
    await ctx.reply("⚠️ Model chưa được xác thực. Vui lòng xác thực trước khi lưu.").catch(() => {});
    return;
  }
  if (isStt) {
    await SystemConfigService.updateConfig({ geminiTranscribeModel: model }, adminId);
  } else {
    await SystemConfigService.updateConfig({ geminiTextModel: model }, adminId);
  }
  clearWizard(adminId);
  await ctx.reply(`✅ <b>ĐÃ LƯU MODEL</b>\n\n${isStt ? "Voice/STT" : "Text"}: <b>${escapeHtml(model)}</b>`, { parse_mode: "HTML" });
}

export async function cancelModelSave(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  clearWizard(String(ctx.from?.id || ""));
  await ctx.reply("Đã hủy đổi model.").catch(() => {});
}

// ---------------------------------------------------------------------------
// Tests (text + voice diagnostic) and runtime key removal
// ---------------------------------------------------------------------------

export async function testTextAi(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery("Đang kiểm tra AI...");
  const wait = await ctx.reply("⏳ Đang kiểm tra kết nối Google Gemini...").catch(() => null);
  const res = await AiProvider.testGeminiConnection();
  const lines = [
    res.ok ? "✅ <b>KẾT NỐI THÀNH CÔNG</b>" : "❌ <b>KHÔNG KẾT NỐI ĐƯỢC</b>",
    "",
    `Model yêu cầu: <b>${escapeHtml(res.primaryModel || "N/A")}</b>`,
    `Model thực tế: <b>${escapeHtml(res.actualModel || "N/A")}</b>`,
    `Độ trễ: ${res.latencyMs} ms`,
    `Fallback: ${res.fallbackUsed ? "Có" : "Không"}`
  ];
  if (!res.ok && res.error) {
    lines.push(`Lỗi: <code>${escapeHtml(String(res.error).slice(0, 200))}</code>`);
  }
  const text = lines.join("\n");
  if (wait) {
    await ctx.api.editMessageText(ctx.chat!.id, wait.message_id, text, { parse_mode: "HTML" }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function startVoiceTest(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  startWizard(String(ctx.from?.id || ""), "ai_voice_test", {});
  await ctx.reply("🎙 <b>TEST VOICE/STT</b>\n\nGửi một tin nhắn thoại ngắn.\n\nGửi /cancel để hủy.", { parse_mode: "HTML" });
}

async function downloadVoiceBuffer(ctx: BotContext): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const voice = ctx.message?.voice;
  if (!voice?.file_id) return null;
  try {
    const file = await ctx.api.getFile(voice.file_id);
    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tải tệp thất bại (HTTP ${res.status})`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: voice.mime_type || "audio/ogg" };
  } catch {
    return null;
  }
}

export async function handleAiVoiceTestMedia(ctx: BotContext): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard) return false;

  const downloaded = await downloadVoiceBuffer(ctx);
  if (!downloaded) {
    await ctx.reply("⚠️ Không tìm thấy tin nhắn thoại.").catch(() => {});
    return wizard.kind === "ai_voice_test" || wizard.kind === "ai_stt_model";
  }

  // STT model validation (candidate tested via override, not persisted yet).
  if (wizard.kind === "ai_stt_model" && wizard.step === 2) {
    const candidate = String(wizard.data.model || "");
    const result = await AiProvider.transcribeAudio(downloaded.buffer, downloaded.mimeType, candidate);
    if (!result || !result.transcript) {
      clearWizard(adminId);
      await ctx.reply(`❌ Model STT <b>${escapeHtml(candidate)}</b> không hoạt động.\nModel hiện tại vẫn được giữ nguyên.`).catch(() => {});
      return true;
    }
    updateWizard(adminId, { step: 3, data: { model: candidate } });
    const text =
      `⚠️ <b>XÁC NHẬN LƯU STT MODEL</b>\n\n` +
      `Model: <b>${escapeHtml(candidate)}</b>\n` +
      `Kết quả xác thực: <i>${escapeHtml(result.transcript)}</i>`;
    const kb = new InlineKeyboard().text("✅ LƯU", "ops:ai:model:confirm").row().text("❌ HỦY", "ops:ai:model:cancel");
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    return true;
  }

  // Plain voice diagnostic (ai_voice_test).
  if (wizard.kind !== "ai_voice_test") return false;
  clearWizard(adminId);

  const result = await AiProvider.transcribeAudio(downloaded.buffer, downloaded.mimeType);
  if (!result || !result.transcript) {
    await ctx.reply("⚠️ Không chuyển được giọng nói thành văn bản.").catch(() => {});
    return true;
  }
  await ctx.reply(`🎙 <b>KẾT QUẢ STT</b>\n\n${escapeHtml(result.transcript)}${result.detectedLanguage ? `\n\nNgôn ngữ: ${escapeHtml(result.detectedLanguage)}` : ""}`, { parse_mode: "HTML" });
  return true;
}

export async function previewDeleteKey(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (ctx.identity?.userType !== "SUPER_ADMIN") {
    await ctx.reply("⛔ Chỉ Super Admin mới có quyền xóa API Key.").catch(() => {});
    return;
  }
  setPendingAction(String(ctx.from?.id || ""), "ai_delete_key", "gemini");
  const resolved = await SystemSecretService.resolveGeminiApiKey();
  const envFallback = resolved.source === "ENV";
  const text =
    `⚠️ <b>XÓA GEMINI API KEY RUNTIME?</b>\n\n` +
    `Sẽ xóa key mã hóa đang lưu trong DB.` +
    (envFallback ? `\n\nLưu ý: key ENV vẫn có thể giữ AI hoạt động sau khi xóa.` : "");
  const kb = new InlineKeyboard().text("✅ XÁC NHẬN XÓA", "ops:ai:key:delete:confirm").row().text("❌ HỦY", "ops:home");
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function confirmDeleteKey(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (ctx.identity?.userType !== "SUPER_ADMIN") {
    await ctx.reply("⛔ Chỉ Super Admin mới có quyền xóa API Key.").catch(() => {});
    return;
  }
  const adminId = String(ctx.from?.id || "");
  const pending = consumePendingAction(adminId, "ai_delete_key", "gemini");
  if (pending.expired) {
    await ctx.reply("⏱ Thao tác đã hết hạn. Vui lòng thực hiện lại từ đầu.").catch(() => {});
    return;
  }
  if (!pending.valid) {
    await ctx.reply("⚠️ Không có thao tác đang chờ xác nhận.").catch(() => {});
    return;
  }
  const ok = await SystemSecretService.deleteSecret("GEMINI_API_KEY");
  AiProvider.invalidateClient();
  await ctx.reply(ok ? "✅ Đã xóa runtime API Key khỏi DB." : "⚠️ Không có key runtime để xóa (hoặc xóa thất bại).").catch(() => {});
}

adminAiHandler.callbackQuery("ops:ai", (ctx) => showAiManagement(ctx));
adminAiHandler.callbackQuery("ops:ai:test:text", (ctx) => testTextAi(ctx));
adminAiHandler.callbackQuery("ops:ai:test:voice", (ctx) => startVoiceTest(ctx));
adminAiHandler.callbackQuery("ops:ai:key:input", (ctx) => startAiKeyInput(ctx));
adminAiHandler.callbackQuery("ops:ai:model:text", (ctx) => startModelInput(ctx, "text"));
adminAiHandler.callbackQuery("ops:ai:model:stt", (ctx) => startModelInput(ctx, "stt"));
adminAiHandler.callbackQuery("ops:ai:model:confirm", (ctx) => confirmModelSave(ctx));
adminAiHandler.callbackQuery("ops:ai:model:cancel", (ctx) => cancelModelSave(ctx));
adminAiHandler.callbackQuery("ops:ai:key:delete:preview", (ctx) => previewDeleteKey(ctx));
adminAiHandler.callbackQuery("ops:ai:key:delete:confirm", (ctx) => confirmDeleteKey(ctx));


