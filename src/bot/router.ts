import { Composer } from "grammy";
import { BotContext, identityMiddleware } from "./middleware/identity.js";
import { customerHandler, showCustomerStart, handleCustomerTextMessage, handleCustomerPhoto, handleCustomerVoice } from "./handlers/customer-handler.js";
import { cskhHandler, showCskhStart } from "./handlers/cskh-handler.js";
import { adminHandler, showAdminStart, handleAdminPhoto } from "./handlers/admin-handler.js";
import { PermissionService } from "../modules/permissions/permission-service.js";
import { sendToAdminNotificationChat } from "./notifications.js";

export const mainRouter = new Composer<BotContext>();

// 1. Resolve Identity
mainRouter.use(identityMiddleware);

// 2. Disabled check
mainRouter.use(async (ctx, next) => {
  if (ctx.identity?.status === "DISABLED") {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: "⛔ Tài khoản của bạn đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên.",
        show_alert: true
      });
    } else {
      await ctx.reply("⛔ Tài khoản của bạn đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên.");
    }
    return;
  }
  await next();
});

// 3. Central /start Handler with Role & Invite Detection
mainRouter.command("start", async (ctx) => {
  const match = ctx.match?.trim();
  const telegramId = String(ctx.from?.id || "");
  const fullName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || ctx.from?.username || "Nhân viên mới";

  // Check if /start was called with an invite code (e.g. /start STAFF-XXXXX)
  if (match && match.startsWith("STAFF-")) {
    try {
      const { invite } = await PermissionService.claimInvite(match, telegramId, fullName);
      await ctx.reply(
        `🎉 <b>YÊU CẦU THAM GIA ĐÃ ĐƯỢC TIẾP NHẬN!</b>\n\n` +
          `• Mã mời: <code>${invite.code}</code>\n` +
          `• Vai trò đăng ký: <b>${invite.role}</b>\n` +
          `• Trạng thái hiện tại: <b>PENDING (Chờ duyệt)</b>\n\n` +
          `🔒 Vì lý do an toàn tài chính, quản trị viên sẽ phê duyệt tài khoản của bạn trong ít phút. Bạn sẽ nhận được thông báo khi tài khoản được kích hoạt.`,
        { parse_mode: "HTML" }
      );

      // Notify Admins
      await sendToAdminNotificationChat(
        `🔔 <b>CÓ NHÂN VIÊN MỚI ĐĂNG KÝ:</b>\n` +
          `• Tên: <b>${fullName}</b>\n` +
          `• Telegram ID: <code>${telegramId}</code>\n` +
          `• Vai trò: <b>${invite.role}</b>\n` +
          `Vui lòng vào <code>/staff</code> ➔ <b>⏳ Chờ phê duyệt</b> để kích hoạt.`,
        { parse_mode: "HTML" }
      );
      return;
    } catch (err: any) {
      await ctx.reply(`❌ Lỗi mã mời: ${err.message}`);
      return;
    }
  }

  // Pending staff check
  if (ctx.identity?.status === "PENDING") {
    await ctx.reply(
      `⏳ <b>TÀI KHOẢN ĐANG CHỜ PHÊ DUYỆT</b>\n\n` +
        `Tài khoản nhân sự của bạn đã được đăng ký và đang chờ Quản trị viên duyệt. Vui lòng liên hệ Admin nếu cần kích hoạt gấp.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Route based on UserType
  const userType = ctx.identity?.userType;
  if (userType === "SUPER_ADMIN" || userType === "ADMIN") {
    await showAdminStart(ctx);
  } else if (userType === "CSKH") {
    await showCskhStart(ctx);
  } else {
    // Default to CUSTOMER
    await showCustomerStart(ctx);
  }
});

// 4. Register Sub-handlers
mainRouter.use(adminHandler);
mainRouter.use(cskhHandler);
mainRouter.use(customerHandler);

// 5. Global Photo router
mainRouter.on("message:photo", async (ctx) => {
  const userType = ctx.identity?.userType;
  const caption = ctx.message?.caption?.trim() || "";

  if ((userType === "ADMIN" || userType === "SUPER_ADMIN") && (caption.startsWith("/addqr") || caption.startsWith("/payout"))) {
    await handleAdminPhoto(ctx);
  } else {
    await handleCustomerPhoto(ctx);
  }
});

// 6. Global Voice router
mainRouter.on("message:voice", async (ctx) => {
  await handleCustomerVoice(ctx);
});

// 7. Global Text message router (for conversational messages)
mainRouter.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) {
    // Unhandled command fallback
    return;
  }

  const userType = ctx.identity?.userType;
  if (userType === "CUSTOMER") {
    await handleCustomerTextMessage(ctx, text);
  } else if (userType === "CSKH") {
    await ctx.reply(
      `💡 <i>Gợi ý CSKH: Để gửi tin nhắn cho khách hàng, hãy dùng lệnh:</i>\n` +
        `<code>/msg &lt;ID_Khách&gt; &lt;Nội dung&gt;</code>`,
      { parse_mode: "HTML" }
    );
  }
});
