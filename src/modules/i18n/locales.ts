/**
 * Deterministic, dependency-free localization for CUSTOMER-facing text.
 * Labels only. Amounts/rates come from MoneyService/QuoteService.
 * Transaction currencies remain USD/VND for every locale.
 */

export const SUPPORTED_LOCALES = ["vi", "en", "km", "zh"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = "vi";

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function normalizeLocale(input?: string | null): SupportedLocale | null {
  if (!input) return null;
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;
  const base = raw.split(/[-_]/)[0] || raw;
  if (base === "vi") return "vi";
  if (base === "en") return "en";
  if (base === "km") return "km";
  if (base === "zh" || base === "yue" || base === "cmn") return "zh";
  return null;
}

export function resolveLocale(input?: string | null): SupportedLocale {
  return normalizeLocale(input) ?? DEFAULT_LOCALE;
}

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  vi: "🇻🇳 Tiếng Việt",
  en: "🇬🇧 English",
  km: "🇰🇭 ខ្មែរ",
  zh: "🇨🇳 中文"
};

export type TranslationKey = string;
type Vars = Record<string, string | number>;

export function t(locale: SupportedLocale | string | null | undefined, key: string, vars?: Vars): string {
  const loc = resolveLocale(typeof locale === "string" ? locale : undefined);
  const table = TRANSLATIONS[loc] || TRANSLATIONS[DEFAULT_LOCALE];
  const fallback = TRANSLATIONS[DEFAULT_LOCALE];
  const template = table[key] ?? fallback[key] ?? String(key);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

export function detectMessageLocale(text: string): SupportedLocale | null {
  const sample = (text || "").trim();
  if (sample.length < 4) return null;
  const hasKhmer = /[\u1780-\u17FF]/.test(sample);
  const hasChinese = /[\u4E00-\u9FFF]/.test(sample);
  const hasLatin = /[A-Za-z]/.test(sample);
  const hasVietnamese =
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(sample) ||
    /\b(đổi|lấy|tiền|đô|triệu|xin|chào|cảm|ơn|anh|chị|muốn|nhận|gửi)\b/i.test(sample);
  if (hasKhmer && !hasChinese) return "km";
  if (hasChinese && !hasKhmer) return "zh";
  if (hasLatin && !hasVietnamese && !hasKhmer && !hasChinese &&
      /\b(i|want|exchange|usd|vnd|dollar|please|hello|how|much|receive|send|money)\b/i.test(sample)) {
    return "en";
  }
  if (hasVietnamese) return "vi";
  return null;
}

const TRANSLATIONS: Record<SupportedLocale, Record<string, string>> = {
  vi: {},
  en: {},
  km: {},
  zh: {}
};

function add(key: string, vi: string, en: string, km: string, zh: string) {
  TRANSLATIONS.vi[key] = vi;
  TRANSLATIONS.en[key] = en;
  TRANSLATIONS.km[key] = km;
  TRANSLATIONS.zh[key] = zh;
}

// Menu
add("menu.exchange", "💱 Đổi tiền", "💱 Exchange", "💱 ផ្លាស់ប្តូររូបិយប័ណ្ណ", "💱 兑换");
add("menu.orders", "📦 Đơn của tôi", "📦 My orders", "📦 ការបញ្ជាទិញរបស់ខ្ញុំ", "📦 我的订单");
add("menu.support", "💬 Hỗ trợ", "💬 Support", "💬 ជំនួយ", "💬 客服");
add("menu.language", "🌐 Ngôn ngữ", "🌐 Language", "🌐 ភាសា", "🌐 语言");
add("menu.exit_support", "↩️ Quay lại đổi tiền", "↩️ Back to exchange", "↩️ ត្រឡប់ទៅការផ្លាស់ប្តូរ", "↩️ 返回兑换");

// Language
add("lang.selector_title", "🌐 <b>Chọn ngôn ngữ / Choose language</b>", "🌐 <b>Choose language / Chọn ngôn ngữ</b>", "🌐 <b>ជ្រើសរើសភាសា / Choose language</b>", "🌐 <b>选择语言 / Choose language</b>");
add("lang.changed", "✅ Đã chuyển sang {label}.", "✅ Language switched to {label}.", "✅ បានប្តូរទៅ {label}។", "✅ 已切换为 {label}。");
add("lang.suggest", "Em thấy anh/chị đang nhắn bằng {label}. Muốn đổi giao diện không?", "It looks like you're messaging in {label}. Switch the interface?", "ទំនងជាអ្នកកំពុងប្រើ {label}។ តើចង់ប្តូរចំណុចប្រទាក់ទេ?", "看起来您在使用 {label}。是否切换界面语言？");
add("lang.switch_to", "Chuyển sang {label}", "Switch to {label}", "ប្តូរទៅ {label}", "切换到 {label}");
add("lang.keep", "Giữ nguyên", "Keep current", "រក្សាដដែល", "保持当前");

// Welcome
add("welcome.hello", "👋 <b>Xin chào {name}!</b>", "👋 <b>Hello {name}!</b>", "👋 <b>សួស្តី {name}!</b>", "👋 <b>您好 {name}！</b>");
add("welcome.rates_title", "💱 <b>TỶ GIÁ HÔM NAY</b>", "💱 <b>TODAY'S RATES</b>", "💱 <b>អត្រាប្តូរថ្ងៃនេះ</b>", "💱 <b>今日汇率</b>");
add("welcome.rates_missing", "Tỷ giá được cập nhật liên tục theo thị trường.", "Rates are updated continuously with the market.", "អត្រាត្រូវបានធ្វើបច្ចុប្បន្នភាពជាបន្តបន្ទាប់។", "汇率随市场持续更新。");
add("welcome.examples_intro", "Anh/chị chỉ cần nhắn tự nhiên:", "Just message naturally:", "គ្រាន់តែផ្ញើសារធម្មតា:", "直接用自然语言发送即可：");
add("welcome.example_1", "• <i>100 đô</i>", "• <i>100 dollars</i>", "• <i>100 dollars</i>", "• <i>100 dollars</i>");
add("welcome.example_2", "• <i>500$ lấy tiền Việt</i>", "• <i>500$ to VND</i>", "• <i>500$ to VND</i>", "• <i>500$ to VND</i>");
add("welcome.example_3", "• <i>10 triệu lấy đô</i>", "• <i>10 million to USD</i>", "• <i>10 million to USD</i>", "• <i>10 million to USD</i>");
add("welcome.example_4", "• <i>20tr đổi USD</i>", "• <i>exchange VND for 100 USD</i>", "• <i>get 100 USD</i>", "• <i>get 100 USD</i>");
add("welcome.footer", "🤖 Trợ lý AI và đội ngũ CSKH luôn sẵn sàng hỗ trợ trực tiếp tại khung chat này!", "🤖 AI assistant and support staff are ready to help in this chat!", "🤖 ជំនួយ AI និងបុគ្គលិករួចរាល់ជួយនៅក្នុងជជែកនេះ!", "🤖 AI 助手和客服随时在此为您服务！");
add("welcome.first_time", "🌐 Em có thể phục vụ bằng 4 ngôn ngữ. Anh/chị chọn ngôn ngữ bên dưới nhé:", "🌐 I can serve you in 4 languages. Please choose one below:", "🌐 ខ្ញុំអាចបម្រើបាន ៤ ភាសា។ សូមជ្រើសរើសខាងក្រោម:", "🌐 我支持 4 种语言，请选择：");

add("exchange.instructions",
  "💱 <b>ĐỔI TIỀN TỰ ĐỘNG</b>\n\nAnh/chị chỉ cần nhắn số tiền, ví dụ:\n• <i>100 đô</i>\n• <i>500$ lấy tiền Việt</i>\n• <i>10 triệu lấy đô</i>\n• <i>đổi VND lấy 100 đô</i>",
  "💱 <b>AUTOMATIC EXCHANGE</b>\n\nJust send an amount, for example:\n• <i>100 dollars</i>\n• <i>500$ to VND</i>\n• <i>10 million to USD</i>\n• <i>get 100 USD</i>",
  "💱 <b>ផ្លាស់ប្តូរស្វ័យប្រវត្តិ</b>\n\nគ្រាន់តែផ្ញើចំនួនទឹកប្រាក់ ឧទាហរណ៍:\n• <i>100 dollars</i>\n• <i>500$ to VND</i>\n• <i>10 million to USD</i>",
  "💱 <b>自动兑换</b>\n\n直接发送金额，例如：\n• <i>100 dollars</i>\n• <i>500$ to VND</i>\n• <i>10 million to USD</i>");

// Quote
add("quote.title", "📊 <b>BÁO GIÁ ĐỔI TIỀN TỆ</b>", "📊 <b>EXCHANGE QUOTE</b>", "📊 <b>សម្រង់តម្លៃប្តូរប្រាក់</b>", "📊 <b>兑换报价</b>");
add("quote.send", "• Quý khách gửi: <b>{src}</b>", "• You send: <b>{src}</b>", "• អ្នកផ្ញើ: <b>{src}</b>", "• 您支付：<b>{src}</b>");
add("quote.receive", "• Quý khách nhận: <b>{tgt}</b>", "• You receive: <b>{tgt}</b>", "• អ្នកទទួល: <b>{tgt}</b>", "• 您收到：<b>{tgt}</b>");
add("quote.rate", "• Tỷ giá áp dụng: <b>{rate}</b>", "• Applied rate: <b>{rate}</b>", "• អត្រា: <b>{rate}</b>", "• 适用汇率：<b>{rate}</b>");
add("quote.fee", "• Phí dịch vụ: <b>{fee}</b>", "• Service fee: <b>{fee}</b>", "• ថ្លៃសេវា: <b>{fee}</b>", "• 服务费：<b>{fee}</b>");
add("quote.expiry", "• Hiệu lực: <i>{minutes} phút</i>", "• Valid for: <i>{minutes} minutes</i>", "• មានសុពលភាព: <i>{minutes} នាទី</i>", "• 有效时间：<i>{minutes} 分钟</i>");
add("quote.confirm_hint", "Bấm nút dưới đây để tạo đơn và nhận tài khoản chuyển tiền:", "Tap below to create the order and get payment details:", "ចុចខាងក្រោមដើម្បីបង្កើតការបញ្ជាទិញ និងទទួលព័ត៌មានបង់ប្រាក់:", "点击下方创建订单并获取付款信息：");
add("quote.confirm_btn", "✅ Xác nhận đổi tiền", "✅ Confirm exchange", "✅ បញ្ជាក់ការផ្លាស់ប្តូរ", "✅ 确认兑换");

// Order
add("order.active_title", "📦 <b>ĐƠN HÀNG CỦA BẠN ĐANG XỬ LÝ</b>", "📦 <b>YOUR ORDER IS IN PROGRESS</b>", "📦 <b>ការបញ្ជាទិញរបស់អ្នកកំពុងដំណើរការ</b>", "📦 <b>您的订单处理中</b>");
add("order.id", "• Mã đơn: <code>{id}</code>", "• Order ID: <code>{id}</code>", "• លេខសម្គាល់: <code>{id}</code>", "• 订单号：<code>{id}</code>");
add("order.exchange", "• Đổi: <b>{src}</b> ➔ <b>{tgt}</b>", "• Exchange: <b>{src}</b> ➔ <b>{tgt}</b>", "• ប្តូរ: <b>{src}</b> ➔ <b>{tgt}</b>", "• 兑换：<b>{src}</b> ➔ <b>{tgt}</b>");
add("order.status", "• Trạng thái: <b>{status}</b>", "• Status: <b>{status}</b>", "• ស្ថានភាព: <b>{status}</b>", "• 状态：<b>{status}</b>");
add("order.pay_title", "💳 <b>THÔNG TIN CHUYỂN KHOẢN:</b>", "💳 <b>PAYMENT DETAILS:</b>", "💳 <b>ព័ត៌មានបង់ប្រាក់:</b>", "💳 <b>付款信息：</b>");
add("order.pay_bank", "• Ngân hàng: <b>{bank}</b>", "• Bank: <b>{bank}</b>", "• ធនាគារ: <b>{bank}</b>", "• 银行：<b>{bank}</b>");
add("order.pay_name", "• Chủ tài khoản: <b>{name}</b>", "• Account name: <b>{name}</b>", "• ឈ្មោះគណនី: <b>{name}</b>", "• 户名：<b>{name}</b>");
add("order.pay_number", "• Số tài khoản: <code>{number}</code>", "• Account number: <code>{number}</code>", "• លេខគណនី: <code>{number}</code>", "• 账号：<code>{number}</code>");
add("order.pay_amount", "• Số tiền: <b>{amount}</b>", "• Amount: <b>{amount}</b>", "• ចំនួន: <b>{amount}</b>", "• 金额：<b>{amount}</b>");
add("order.pay_bill_hint", "Sau khi chuyển khoản, anh/chị chỉ cần <b>gửi ảnh biên lai</b> vào khung chat này.", "After transferring, simply <b>send the receipt photo</b> in this chat.", "បន្ទាប់ពីផ្ទេរ សូម <b>ផ្ញើរូបភាពបង្កាន់ដៃ</b> នៅក្នុងជជែកនេះ។", "转账后，请直接在此聊天中 <b>发送回单照片</b>。");
add("order.pay_wait", "Vui lòng chờ nhân viên gửi thông tin chuyển khoản chính thức.", "Please wait for staff to send official payment details.", "សូមរង់ចាំបុគ្គលិកផ្ញើព័ត៌មានបង់ប្រាក់ផ្លូវការ។", "请等待工作人员发送正式付款信息。");
add("order.list_title", "📦 <b>DANH SÁCH ĐƠN HÀNG CỦA BẠN:</b>", "📦 <b>YOUR ORDERS:</b>", "📦 <b>ការបញ្ជាទិញរបស់អ្នក:</b>", "📦 <b>您的订单：</b>");
add("order.list_empty", "📦 Bạn chưa có đơn hàng nào trong hệ thống.", "📦 You have no orders yet.", "📦 អ្នកមិនទាន់មានការបញ្ជាទិញទេ។", "📦 您还没有订单。");
add("order.bank_btn", "🏦 Nhập tài khoản nhận {currency}", "🏦 Enter receiving account ({currency})", "🏦 បញ្ចូលគណនីទទួល {currency}", "🏦 填写收款账户（{currency}）");
add("order.missing_desk_account", "⚠️ Hiện hệ thống chưa cấu hình tài khoản nhận {currency}. Vui lòng bấm 💬 Hỗ trợ để nhân viên hỗ trợ anh/chị.", "⚠️ The system receiving account for {currency} is not configured yet. Please tap 💬 Support.", "⚠️ ប្រព័ន្ធមិនទាន់មានគណនីទទួល {currency} ទេ។ សូមចុច 💬 ជំនួយ។", "⚠️ 系统尚未配置 {currency} 收款账户。请点击 💬 客服。");

// Bill / payout / support / errors / voice / status
add("bill.none", "Không tìm thấy đơn hàng nào của bạn đang chờ thanh toán. Vui lòng tạo đơn trước khi gửi biên lai.", "No order is waiting for payment evidence. Please create an order before sending a receipt.", "មិនមានការបញ្ជាទិញកំពុងរង់ចាំភស្តុតាងបង់ប្រាក់ទេ។ សូមបង្កើតការបញ្ជាទិញជាមុន។", "没有等待付款凭证的订单。请先创建订单再发送回单。");
add("bill.multi_title", "📸 <b>BẠN CÓ {count} ĐƠN HÀNG ĐANG CHỜ THANH TOÁN</b>", "📸 <b>YOU HAVE {count} ORDERS AWAITING PAYMENT</b>", "📸 <b>អ្នកមាន {count} ការបញ្ជាទិញកំពុងរង់ចាំបង់ប្រាក់</b>", "📸 <b>您有 {count} 个待付款订单</b>");
add("bill.multi_hint", "Vui lòng chọn chính xác đơn hàng áp dụng biên lai này:", "Please choose the exact order for this receipt:", "សូមជ្រើសរើសការបញ្ជាទិញត្រឹមត្រូវសម្រាប់បង្កាន់ដៃនេះ:", "请选择此回单对应的订单：");
add("bill.received", "✅ Đã nhận biên lai cho đơn <code>{id}</code>. Nhân viên sẽ đối soát và phản hồi sớm.", "✅ Receipt received for order <code>{id}</code>. Staff will verify shortly.", "✅ បានទទួលបង្កាន់ដៃសម្រាប់ <code>{id}</code>។ បុគ្គលិកនឹងពិនិត្យឆាប់ៗ។", "✅ 已收到订单 <code>{id}</code> 的回单，工作人员将尽快核对。");
add("bill.error", "❌ Có lỗi khi xử lý biên lai: {error}", "❌ Could not process the receipt: {error}", "❌ មិនអាចដំណើរការបង្កាន់ដៃ: {error}", "❌ 处理回单失败：{error}");
add("payout.prompt", "🏦 Để nhận <b>{amount} {currency}</b>, anh/chị vui lòng nhập tài khoản nhận tiền {currency}:", "🏦 To receive <b>{amount} {currency}</b>, please enter your {currency} receiving account:", "🏦 ដើម្បីទទួល <b>{amount} {currency}</b> សូមបញ្ចូលគណនីទទួល {currency}:", "🏦 为接收 <b>{amount} {currency}</b>，请填写您的 {currency} 收款账户：");
add("support.active_title", "💬 <b>BẠN ĐANG ĐƯỢC NHÂN VIÊN HỖ TRỢ TRỰC TIẾP</b>", "💬 <b>YOU ARE BEING HELPED BY SUPPORT STAFF</b>", "💬 <b>អ្នកកំពុងទទួលជំនួយពីបុគ្គលិក</b>", "💬 <b>客服正在为您服务</b>");
add("support.active_body", "Anh/chị vui lòng tiếp tục nhắn tin tại khung chat này.\nNhân viên CSKH sẽ phản hồi anh/chị ngay.\n\nMuốn tự đổi tiền theo tỷ giá tự động? Bấm <b>↩️ Quay lại đổi tiền</b>.", "Please continue messaging in this chat.\nA support agent will reply soon.\n\nWant automatic exchange instead? Tap <b>↩️ Back to exchange</b>.", "សូមបន្តផ្ញើសារនៅទីនេះ។\nបុគ្គលិកនឹងឆ្លើយតបឆាប់ៗ។\n\nចង់ផ្លាស់ប្តូរស្វ័យប្រវត្តិ? ចុច <b>↩️ ត្រឡប់ទៅការផ្លាស់ប្តូរ</b>។", "请继续在此聊天留言。\n客服将尽快回复。\n\n若要自动兑换，请点击 <b>↩️ 返回兑换</b>。");
add("support.requested", "✅ Đã gửi yêu cầu hỗ trợ. Nhân viên sẽ liên hệ anh/chị sớm nhất.\nTrong lúc chờ, anh/chị vẫn có thể nhắn tin tại đây.", "✅ Support request sent. Staff will contact you soon.\nYou can keep messaging here while waiting.", "✅ បានផ្ញើសំណើជំនួយ។ បុគ្គលិកនឹងទាក់ទងឆាប់ៗ។\nអ្នកនៅតែអាចផ្ញើសារនៅទីនេះ។", "✅ 已发送客服请求，工作人员将尽快联系您。\n等待期间仍可在此留言。");
add("support.exited", "✅ Đã kết thúc hỗ trợ trực tiếp. Anh/chị có thể đổi tiền tự động ngay.", "✅ Live support ended. You can use automatic exchange now.", "✅ បានបញ្ចប់ជំនួយផ្ទាល់។ ឥឡូវអ្នកអាចផ្លាស់ប្តូរស្វ័យប្រវត្តិបាន។", "✅ 已结束人工客服，您可以继续使用自动兑换。");
add("support.media_waiting", "💬 Yêu cầu hỗ trợ của anh/chị đã được ghi nhận. Media đã lưu; nhân viên sẽ xem khi tiếp nhận.", "💬 Your support request is noted. Media is saved; staff will see it when they take the ticket.", "💬 សំណើជំនួយត្រូវបានកត់ត្រា។ មេឌៀត្រូវបានរក្សាទុក។", "💬 已记录您的客服请求。媒体已保存，客服接入后可查看。");
add("support.media_relayed", "✅ Đã chuyển tới nhân viên hỗ trợ.", "✅ Forwarded to support staff.", "✅ បានបញ្ជូនទៅបុគ្គលិកជំនួយ។", "✅ 已转发给客服。");
add("error.generic", "❌ Có lỗi xảy ra. Vui lòng thử lại hoặc bấm 💬 Hỗ trợ.", "❌ Something went wrong. Please try again or tap 💬 Support.", "❌ មានបញ្ហា។ សូមព្យាយាមម្តងទៀត ឬចុច 💬 ជំនួយ។", "❌ 出现错误。请重试或点击 💬 客服。");
add("error.quote_failed", "❌ Không tạo được báo giá: {error}", "❌ Could not create a quote: {error}", "❌ មិនអាចបង្កើតសម្រង់តម្លៃ: {error}", "❌ 无法创建报价：{error}");
add("voice.transcript", "🎙 [{lang}] <i>\"{text}\"</i>", "🎙 [{lang}] <i>\"{text}\"</i>", "🎙 [{lang}] <i>\"{text}\"</i>", "🎙 [{lang}] <i>\"{text}\"</i>");
add("voice.failed", "🎙 Đã lưu file ghi âm nhưng hiện tại chưa thể chuyển thành văn bản. Xin vui lòng nhắn tin trực tiếp.", "🎙 Voice saved, but transcription is unavailable. Please type your message.", "🎙 បានរក្សាទុកសំឡេង ប៉ុន្តែមិនអាចបម្លែងជាអក្សរបានទេ។ សូមវាយសារ។", "🎙 语音已保存，但无法转写。请直接发送文字。");
add("status.WAITING_PAYMENT", "Chờ thanh toán", "Awaiting payment", "រង់ចាំបង់ប្រាក់", "待付款");
add("status.CUSTOMER_SENT_BILL", "Đã gửi biên lai", "Receipt sent", "បានផ្ញើបង្កាន់ដៃ", "已发送回单");
add("status.WAITING_ADMIN_VERIFY", "Chờ đối soát", "Awaiting verification", "រង់ចាំផ្ទៀងផ្ទាត់", "待核对");
add("status.PAYMENT_CONFIRMED", "Đã xác nhận tiền vào", "Payment confirmed", "បានបញ្ជាក់ការបង់ប្រាក់", "已确认收款");
add("status.WAITING_PAYOUT", "Chờ chi tiền", "Awaiting payout", "រង់ចាំចំណាយ", "待出款");
add("status.PAYOUT_SENT", "Đã chi tiền", "Payout sent", "បានចំណាយ", "已出款");
add("status.MANUAL_REVIEW", "Đang xem xét", "Under review", "កំពុងពិនិត្យ", "人工审核中");
add("status.SUSPICIOUS", "Cần kiểm tra thêm", "Needs review", "ត្រូវពិនិត្យបន្ថែម", "需进一步检查");
add("status.COMPLETED", "Hoàn tất", "Completed", "បានបញ្ចប់", "已完成");
add("status.CANCELLED", "Đã hủy", "Cancelled", "បានលុបចោល", "已取消");

export { TRANSLATIONS };
