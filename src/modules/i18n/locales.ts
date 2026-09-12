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
add("menu.support_active", "💬 Đang hỗ trợ", "💬 In support", "💬 កំពុងទទួលជំនួយ", "💬 人工客服中");


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
add("welcome.footer", "🤖 Đội ngũ CSKH luôn sẵn sàng hỗ trợ.", "🤖 Support staff are ready to help.", "🤖 បុគ្គលិកជំនួយរួចរាល់ក្នុងការជួយអ្នក។", "🤖 客服随时为您服务。");
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
add("order.pay_memo", "🔖 Nội dung chuyển tiền (memo): <code>{memo}</code>", "🔖 Transfer reference (memo): <code>{memo}</code>", "🔖 អត្ថបទផ្ទេរ (memo): <code>{memo}</code>", "🔖 转账备注（memo）：<code>{memo}</code>");
add("order.pay_memo_hint", "Vui lòng ghi đúng nội dung này trong phần chuyển tiền để hệ thống đối soát chính xác.", "Write this reference in the transfer note so the system can match your order.", "សូមសរបញ្ជាក់នេះនៅក្នុងកំណត់សម្គាល់ការផ្ទេរ ដើម្បីឲ្យប្រព័ន្ធជាក់លាក់។", "请在转账备注中填写此参考号，以便系统准确匹配订单。");

// Order creation / lifecycle messages (customer-visible)
add("order.created_title", "🎉 <b>ĐƠN HÀNG ĐÃ ĐƯỢC TẠO THÀNH CÔNG!</b>", "🎉 <b>ORDER CREATED SUCCESSFULLY!</b>", "🎉 <b>ការបញ្ជាទិញត្រូវបានបង្កើតដោយជោគជ័យ!</b>", "🎉 <b>订单创建成功！</b>");
add("order.transfer_amount", "💵 Vui lòng chuyển đúng số tiền: <b>{amount} {currency}</b>", "💵 Please transfer exactly: <b>{amount} {currency}</b>", "💵 សូមផ្ទេរប្រាក់ត្រឹមត្រូវ: <b>{amount} {currency}</b>", "💵 请准确转账：<b>{amount} {currency}</b>");
add("order.pay_to", "🏦 Đến tài khoản chỉ định:", "🏦 To the designated account:", "🏦 ទៅគណនីដែលបានកំណត់:", "🏦 请转账至指定账户：");
add("order.pay_qr_caption", "🖼 Mã QR thanh toán cho đơn {id}", "🖼 Payment QR for order {id}", "🖼 QR បង់ប្រាក់សម្រាប់ {id}", "🖼 订单 {id} 的付款二维码");
add("order.pay_later_note", "ℹ️ Sau khi Admin xác nhận tiền vào, hệ thống sẽ yêu cầu anh/chị chọn tài khoản nhận <b>{currency}</b>.", "ℹ️ After Admin verifies the incoming payment, the system will ask you to choose your <b>{currency}</b> payout account.", "ℹ️ បន្ទាប់ពី Admin បញ្ជាក់ប្រាក់ចូល ប្រព័ន្ធនឹងសួរអ្នកពីគណនីទទួល <b>{currency}</b>។", "ℹ️ 管理员确认收款后，系统将请您选择 <b>{currency}</b> 收款账户。");
add("order.create_error", "❌ Lỗi tạo đơn: {error}", "❌ Order creation failed: {error}", "❌ បង្កើតការបញ្ជាទិញមិនបានជោគជ័យ: {error}", "❌ 创建订单失败：{error}");
add("order.date", "• Ngày: {date}", "• Date: {date}", "• កាលបរិច្ឆេទ: {date}", "• 日期：{date}");
add("order.list_recent_title", "📦 <b>DANH SÁCH ĐƠN HÀNG GẦN ĐÂY:</b>", "📦 <b>RECENT ORDERS:</b>", "📦 <b>ការបញ្ជាទិញថ្មីៗ:</b>", "📦 <b>近期订单：</b>");
add("order.cancel_none", "Bạn không có đơn hàng nào đang chờ để hủy.", "You have no pending order to cancel.", "អ្នកមិនមានការបញ្ជាទិញកំពុងរង់ចាំដើម្បីបោះបង់ទេ។", "您没有可取消的待处理订单。");
add("order.cancel_success", "✅ Đã hủy đơn hàng <code>{id}</code> thành công.", "✅ Order <code>{id}</code> has been cancelled.", "✅ ការបញ្ជាទិញ <code>{id}</code> ត្រូវបានបោះបង់ដោយជោគជ័យ។", "✅ 订单 <code>{id}</code> 已成功取消。");
add("order.cancel_error", "❌ Không thể hủy đơn: {error}", "❌ Could not cancel the order: {error}", "❌ មិនអាចបោះបង់ការបញ្ជាទិញ: {error}", "❌ 无法取消订单：{error}");

// --- Order actions on the active-order view (customer, all locales) ---
add("order.cancel_btn", "❌ Huỷ đơn", "❌ Cancel order", "❌ បោះបង់ការបញ្ជាទិញ", "❌ 取消订单");
add("order.payinfo_btn", "💳 Xem thông tin chuyển khoản", "💳 View transfer details", "💳 មើលព័ត៌មានផ្ទេរប្រាក់", "💳 查看汇款信息");
add("order.bill_btn", "📷 Gửi bill", "📷 Send receipt", "📷 ផ្ញើបង្កាន់ដៃ", "📷 发送回执");
add("order.bill_instruction", "📷 Vui lòng gửi <b>ảnh biên lai chuyển tiền</b> (JPG/PNG/WebP hoặc PDF) vào khung chat này.\nBot sẽ tự động đính kèm vào đơn <code>{id}</code>.\n\nNếu bạn đã chuyển tiền nhưng chưa gửi bill, hãy gửi bill ngay bây giờ.", "📷 Please send a <b>photo of your transfer receipt</b> (JPG/PNG/WebP or PDF) in this chat.\nThe bot will attach it to order <code>{id}</code> automatically.\n\nIf you already transferred the money but have not sent the receipt, send it now.", "📷 សូមផ្ញើ <b>រូបភាពបង្កាន់ដៃផ្ទេរប្រាក់</b> (JPG/PNG/WebP ឬ PDF) នៅក្នុងការជជែកនេះ។\nបូតនឹងភ្ជាប់វាជាមួយការបញ្ជាទិញ <code>{id}</code> ដោយស្វ័យប្រវត្តិ។\n\nប្រសិនបើអ្នកបានផ្ទេរប្រាក់រួចហើយប៉ុន្តែមិនទាន់ផ្ញើបង្កាន់ដៃ សូមផ្ញើវាឥឡូវនេះ។", "📷 请在此聊天中发送<b>转账回执照片</b>（JPG/PNG/WebP 或 PDF）。\n机器人会自动将其附加到订单 <code>{id}</code>。\n\n如果您已转账但尚未发送回执，请立即发送。");
add("order.payinfo_hint", "💳 <b>THÔNG TIN CHUYỂN KHOẢN</b> cho đơn <code>{id}</code>", "💳 <b>TRANSFER DETAILS</b> for order <code>{id}</code>", "💳 <b>ព័ត៌មានផ្ទេរប្រាក់</b> សម្រាប់ការបញ្ជាទិញ <code>{id}</code>", "💳 订单 <code>{id}</code> 的<b>汇款信息</b>");

// --- Customer cancellation two-step flow ---
add("order.cancel_warn_title", "⚠️ <b>XÁC NHẬN HỦY ĐƠN</b>", "⚠️ <b>CONFIRM ORDER CANCELLATION</b>", "⚠️ <b>បញ្ជាក់ការបោះបង់</b>", "⚠️ <b>确认取消订单</b>");
add("order.cancel_warn_body", "Bạn sắp huỷ đơn <code>{id}</code> ({amount}).\n\n🚨 <b>Nếu bạn ĐÃ chuyển tiền rồi thì ĐỪNG huỷ đơn.</b> Hãy gửi bill chuyển tiền hoặc bấm 💬 Hỗ trợ để được nhân viên kiểm tra.\n\nĐơn chỉ huỷ được khi CHƯA chuyển tiền và CHƯA gửi bill.", "You are about to cancel order <code>{id}</code> ({amount}).\n\n🚨 <b>If you have ALREADY transferred the money, DO NOT cancel.</b> Send your transfer receipt or tap 💬 Support so staff can check for you.\n\nAn order can only be cancelled if you have NOT transferred and have NOT sent a receipt.", "អ្នកកំពុងតែបោះបង់ការបញ្ជាទិញ <code>{id}</code> ({amount})។\n\n🚨 <b>ប្រសិនបើអ្នកបានផ្ទេរប្រាក់រួចហើយ សូមកុំបោះបង់។</b> សូមផ្ញើបង្កាន់ដៃផ្ទេរប្រាក់ ឬចុច 💬 ជំនួយ ដើម្បីឱ្យបុគ្គលិកពិនិត្យ។\n\nការបញ្ជាទិញអាចបោះបង់បានតែពេលអ្នកមិនទាន់ផ្ទេរប្រាក់ និងមិនទាន់ផ្ញើបង្កាន់ដៃប៉ុណ្ណោះ។", "您即将取消订单 <code>{id}</code>（{amount}）。\n\n🚨 <b>如果您已经转账，请勿取消。</b>请发送转账回执或点击 💬 客服，由工作人员为您核对。\n\n只有尚未转账且未发送回执的订单才能取消。");
add("order.cancel_confirm_btn", "✅ Xác nhận huỷ đơn", "✅ Confirm cancel", "✅ បញ្ជាក់ការបោះបង់", "✅ 确认取消");
add("order.cancel_keep_btn", "↩️ Giữ đơn, không huỷ", "↩️ Keep the order", "↩️ រក្សាការបញ្ជាទិញ", "↩️ 保留订单");
add("order.keep_note", "↩️ Đã giữ đơn <code>{id}</code>. Nếu bạn cần hỗ trợ, bấm 💬 Hỗ trợ.", "↩️ Order <code>{id}</code> kept. Tap 💬 Support if you need help.", "↩️ បានរក្សាការបញ្ជាទិញ <code>{id}</code>។ ចុច 💬 ជំនួយ ប្រសិនបើអ្នកត្រូវការជំនួយ។", "↩️ 已保留订单 <code>{id}</code>。如需帮助请点击 💬 客服。");
add("order.cancel_blocked_bill", "ℹ️ Bạn đã gửi bill/bằng chứng chuyển tiền cho đơn này nên KHÔNG thể tự huỷ.\nVui lòng bấm 💬 Hỗ trợ hoặc chờ nhân viên kiểm tra bill của bạn.", "ℹ️ You have already sent a receipt/proof of transfer for this order, so you cannot cancel it yourself.\nPlease tap 💬 Support or wait for staff to review your receipt.", "ℹ️ អ្នកបានផ្ញើបង្កាន់ដៃ/ភស្តុតាងផ្ទេរប្រាក់សម្រាប់ការបញ្ជាទិញនេះរួចហើយ ដូច្នេះអ្នកមិនអាចបោះបង់ខ្លួនឯងបានទេ។\nសូមចុច 💬 ជំនួយ ឬរង់ចាំបុគ្គលិកពិនិត្យបង្កាន់ដៃរបស់អ្នក។", "ℹ️ 您已为本订单发送了回执/转账凭证，因此无法自行取消。\n请点击 💬 客服 或等待工作人员审核您的回执。");
add("order.cancel_blocked_status", "ℹ️ Đơn <code>{id}</code> đang ở trạng thái <b>{status}</b> nên không thể tự huỷ.\nVui lòng bấm 💬 Hỗ trợ nếu cần giúp đỡ.", "ℹ️ Order <code>{id}</code> is currently <b>{status}</b> and can no longer be self-cancelled.\nPlease tap 💬 Support if you need help.", "ℹ️ ការបញ្ជាទិញ <code>{id}</code> ឥឡូវនេះស្ថិតនៅក្នុងស្ថានភាព <b>{status}</b> ដូច្នេះមិនអាចបោះបង់ដោយខ្លួនឯងបានទេ។\nសូមចុច 💬 ជំនួយ ប្រសិនបើអ្នកត្រូវការជំនួយ។", "ℹ️ 订单 <code>{id}</code> 当前状态为 <b>{status}</b>，无法自行取消。\n如需帮助请点击 💬 客服。");
add("order.cancel_already", "ℹ️ Đơn <code>{id}</code> đã được huỷ trước đó.", "ℹ️ Order <code>{id}</code> was already cancelled.", "ℹ️ ការបញ្ជាទិញ <code>{id}</code> ត្រូវបានបោះបង់រួចហើយ។", "ℹ️ 订单 <code>{id}</code> 已被取消。");
add("order.cancelled_by_admin", "❌ Đơn <code>{id}</code> đã bị huỷ bởi nhân viên.\nLý do: {reason}\n\nNếu bạn đã chuyển tiền cho đơn này, vui lòng bấm 💬 Hỗ trợ ngay để được xử lý.", "❌ Order <code>{id}</code> was cancelled by our staff.\nReason: {reason}\n\nIf you already transferred money for this order, please tap 💬 Support immediately so we can resolve it.", "❌ ការបញ្ជាទិញ <code>{id}</code> ត្រូវបានបុគ្គលិកបោះបង់។\nមូលហេតុ: {reason}\n\nប្រសិនបើអ្នកបានផ្ទេរប្រាក់សម្រាប់ការបញ្ជាទិញនេះ សូមចុច 💬 ជំនួយ ភ្លាមៗ។", "❌ 订单 <code>{id}</code> 已被工作人员取消。\n原因：{reason}\n\n如果您已为该订单转账，请立即点击 💬 客服 处理。");

// --- Payment reminders (scheduler, localized for the customer) ---
add("reminder.title", "🔔 <b>NHẮC NHỞ THANH TOÁN (lần {number})</b>", "🔔 <b>PAYMENT REMINDER ({number})</b>", "🔔 <b>ការរំលឹកបង់ប្រាក់ (លើក {number})</b>", "🔔 <b>付款提醒（第 {number} 次）</b>");
add("reminder.pay_now", "Vui lòng chuyển tiền theo thông tin trong đơn và gửi bill để chúng tôi xác nhận.", "Please transfer the amount using the order details and send your receipt so we can verify it.", "សូមផ្ទេរប្រាក់តាមព័ត៌មាននៅក្នុងការបញ្ជាទិញ និងផ្ញើបង្កាន់ដៃដើម្បីឱ្យពួកយើងផ្ទៀងផ្ទាត់។", "请按订单信息转账并发送回执，以便我们核对。");
add("reminder.transferred_hint", "🚨 Nếu bạn ĐÃ chuyển tiền: hãy gửi bill NGAY để nhân viên đối soát — đừng huỷ đơn.", "🚨 If you have ALREADY transferred: send your receipt NOW so staff can verify — do not cancel the order.", "🚨 ប្រសិនបើអ្នកបានផ្ទេរប្រាក់រួចហើយ៖ សូមផ្ញើបង្កាន់ដៃភ្លាមៗដើម្បីឱ្យបុគ្គលិកផ្ទៀងផ្ទាត់ — កុំបោះបង់ការបញ្ជាទិញ។", "🚨 如果您已转账：请立即发送回执以便工作人员核对——请勿取消订单。");
add("reminder.deadline", "⏰ Lưu ý: nếu không nhận được thanh toán, đơn sẽ tự động huỷ sau 50 phút kể từ khi tạo.", "⏰ Note: if payment is not received, the order will be automatically cancelled 50 minutes after creation.", "⏰ ចំណាំ៖ ប្រសិនបើមិនទទួលបានការបង់ប្រាក់ ការបញ្ជាទិញនឹងត្រូវបោះបង់ស្វ័យប្រវត្តិបន្ទាប់ពី 50 នាទី។", "⏰ 注意：如未收到付款，订单将在创建 50 分钟后自动取消。");

// --- Auto-cancel notice (localized for the customer) ---
add("autocancel.customer_title", "⏰ <b>ĐƠN ĐÃ TỰ ĐỘNG HUỸ</b>", "⏰ <b>ORDER AUTOMATICALLY CANCELLED</b>", "⏰ <b>ការបញ្ជាទិញត្រូវបានបោះបង់ស្វ័យប្រវត្តិ</b>", "⏰ <b>订单已自动取消</b>");
add("autocancel.customer_body", "Đơn hàng đã bị huỷ tự động do không nhận được thanh toán sau 50 phút.\n\nNếu bạn ĐÃ chuyển tiền trước đó, đừng lo — hãy gửi bill chuyển tiền vào đây, nhân viên sẽ xem xét và xử lý thủ công cho bạn.", "The order was automatically cancelled because payment was not received within 50 minutes.\n\nIf you ALREADY transferred money, don't worry — send your transfer receipt here and our staff will review it and handle it manually for you.", "ការបញ្ជាទិញត្រូវបានបោះបង់ស្វ័យប្រវត្តិ ព្រោះមិនបានទទួលការបង់ប្រាក់ក្នុងរយៈពេល 50 នាទី។\n\nប្រសិនបើអ្នកបានផ្ទេរប្រាក់រួចហើយ កុំបារម្ភ — សូមផ្ញើបង្កាន់ដៃផ្ទេរប្រាក់នៅទីនេះ បុគ្គលិកនឹងពិនិត្យ និងដោះស្រាយដោយដៃសម្រាប់អ្នក។", "由于 50 分钟内未收到付款，订单已自动取消。\n\n如果您已经转账，请不要担心——请在此发送转账回执，工作人员将为您人工审核处理。");

// --- Bill upload errors / acknowledgements (localized; previously Vietnamese-only) ---
add("bill.too_large", "❌ Kích thước tệp vượt quá giới hạn cho phép ({limit}MB). Vui lòng gửi ảnh nhẹ hơn.", "❌ The file is too large (limit {limit}MB). Please send a smaller image.", "❌ ឯកសារធំពេក (កំណត់ {limit}MB)។ សូមផ្ញើរូបភាពតូចជាង។", "❌ 文件过大（限制 {limit}MB）。请发送更小的图片。");
add("bill.unsupported", "❌ Định dạng tệp không được hỗ trợ. Vui lòng gửi ảnh chụp rõ nét (JPG, PNG, WebP) hoặc PDF.", "❌ Unsupported file format. Please send a clear photo (JPG, PNG, WebP) or a PDF.", "❌ ទម្រង់ឯកសារមិនត្រឹមត្រូវ។ សូមផ្ញើរូបភាពច្បាស់ (JPG, PNG, WebP) ឬ PDF។", "❌ 不支持的文件格式。请发送清晰的图片（JPG、PNG、WebP）或 PDF。");
add("bill.download_failed", "❌ Không tải được tệp từ Telegram. Vui lòng thử gửi lại.", "❌ Could not download the file from Telegram. Please try sending it again.", "❌ មិនអាចទាញយកឯកសារពី Telegram បានទេ។ សូមព្យាយាមផ្ញើម្តងទៀត។", "❌ 无法从 Telegram 下载文件。请重新发送。");
add("bill.not_eligible", "ℹ️ Đơn này hiện không thể nhận thêm biên lai. Vui lòng bấm 💬 Hỗ trợ nếu cần.", "ℹ️ This order cannot accept a new receipt right now. Tap 💬 Support if you need help.", "ℹ️ ការបញ្ជាទិញនេះមិនអាចទទួលបង្កាន់ដៃថ្មីនៅពេលនេះទេ។ ចុច 💬 ជំនួយ ប្រសិនបើត្រូវការ។", "ℹ️ 该订单当前无法接收新回执。如需帮助请点击 💬 客服。");
add("bill.late_cancelled_customer", "✅ Đã nhận được bằng chứng chuyển tiền của bạn cho đơn đã huỷ <code>{id}</code>.\nNhân viên sẽ xem xét thủ công và liên hệ với bạn. Đơn sẽ KHÔNG được mở lại tự động.", "✅ We received your transfer proof for the cancelled order <code>{id}</code>.\nOur staff will review it manually and contact you. The order will NOT be reopened automatically.", "✅ យើងបានទទួលភស្តុតាងផ្ទេរប្រាក់របស់អ្នកសម្រាប់ការបញ្ជាទិញដែលបានបោះបង់ <code>{id}</code>។\nបុគ្គលិកនឹងពិនិត្យដោយដៃ និងទាក់ទងអ្នក។ ការបញ្ជាទិញនឹងមិនត្រូវបើកឡើងវិញស្វ័យប្រវត្តិទេ។", "✅ 已收到您为已取消订单 <code>{id}</code> 提交的转账凭证。\n工作人员将人工审核并与您联系。订单不会自动重新开启。");
add("quote.expired_notice", "⚠️ Báo giá đã hết hạn (hiệu lực chỉ 10 phút).\nVui lòng gửi lại số tiền muốn đổi để nhận báo giá mới.", "⚠️ The quote has expired (validity is 10 minutes).\nPlease send the amount you want to exchange again to get a new quote.", "⚠️ សម្រង់តម្លៃផុតកំណត់ហើយ (មានសុពលភាព 10 នាទី)។\nសូមផ្ញើចំនួនទឹកប្រាក់ដែលអ្នកចង់ប្តូរម្តងទៀត ដើម្បីទទួលសម្រង់តម្លៃថ្មី។", "⚠️ 报价已过期（有效期 10 分钟）。\n请重新发送您要兑换的金额以获取新报价。");
add("payout.before_verified", "ℹ️ Đơn của anh/chị chưa được Admin xác nhận tiền vào. Tài khoản nhận tiền sẽ được yêu cầu ngay sau khi Admin xác nhận.", "ℹ️ Your order is not yet verified for the incoming payment. Your payout account will be requested right after verification.", "ℹ️ ការបញ្ជាទិញរបស់អ្នកមិនទាន់ត្រូវបានបញ្ជាក់ប្រាក់ចូលទេ។ គណនីទទួលប្រាក់នឹងត្រូវសួរភ្លាមៗបន្ទាប់ពីការផ្ទៀងផ្ទាត់។", "ℹ️ 您的订单尚未确认收款。收款账户将在管理员确认后立即向您索取。");
add("payout.awaiting_info", "💸 Đơn <code>{id}</code>: Admin đã xác nhận tiền vào. Vui lòng chọn tài khoản nhận <b>{currency}</b>:", "💸 Order <code>{id}</code>: payment verified. Please choose your payout account for <b>{currency}</b>:", "💸 ការបញ្ជាទិញ <code>{id}</code>: ប្រាក់ចូលត្រូវបានបញ្ជាក់។ សូមជ្រើសរើសគណនីទទួល <b>{currency}</b>:", "💸 订单 <code>{id}</code>：收款已确认。请选择您的 <b>{currency}</b> 收款账户：");
add("payout.choose_title", "✅ <b>ĐÃ NHẬN TIỀN</b>", "✅ <b>PAYMENT VERIFIED</b>", "✅ <b>បានទទួលប្រាក់</b>", "✅ <b>已确认收款</b>");
add("payout.recent_header", "🕘 Tài khoản đã dùng gần đây (từ các đơn đã hoàn tất của anh/chị):", "🕘 Accounts used recently (from your completed orders):", "🕘 គណនីដែលបានប្រើថ្មីៗ (ពីការបញ្ជាទិញដែលបានបញ្ចប់របស់អ្នក):", "🕘 最近使用的收款账户（来自您已完成的订单）：");
add("payout.no_recent", "Chưa có tài khoản đã lưu. Anh/chị có thể nhập tài khoản mới hoặc gửi ảnh QR.", "No saved accounts yet. Enter a new account or send a QR.", "មិនទាន់មានគណនីរក្សាទុកទេ។ សូមបញ្ចូលគណនីថ្មី ឬផ្ញើរូបភាព QR។", "暂无已保存账户。请输入新账户或发送 QR 图片。");
add("payout.new_text", "➕ Tài khoản mới", "➕ New account", "➕ គណនីថ្មី", "➕ 新账户");
add("payout.new_qr", "📷 QR mới", "📷 New QR", "📷 QR ថ្មី", "📷 新 QR");
add("payout.support_btn", "💬 Hỗ trợ", "💬 Support", "💬 ជំនួយ", "💬 客服");
add("payout.text_input_hint", "✍️ Vui lòng gửi thông tin tài khoản nhận tiền của anh/chị.\nVí dụ: <code>vcb 0123456789 nguyen van a</code>", "✍️ Please send your payout account details.\nExample: <code>vcb 0123456789 nguyen van a</code>", "✍️ សូមផ្ញើព័ត៌មានគណនីទទួលប្រាក់របស់អ្នក។\nឧទាហរណ៍: <code>vcb 0123456789 nguyen van a</code>", "✍️ 请发送您的收款账户信息。\n示例：<code>vcb 0123456789 nguyen van a</code>");
add("payout.qr_input_hint", "📷 Vui lòng gửi <b>ảnh QR</b> tài khoản nhận tiền của anh/chị.", "📷 Please send a <b>QR code image</b> of your payout account.", "📷 សូមផ្ញើ <b>រូបភាពកូដ QR</b> គណនីទទួលប្រាក់របស់អ្នក។", "📷 请发送您收款账户的 <b>QR 码图片</b>。");
add("payout.preview_title", "⚠️ <b>XÁC NHẬN TÀI KHOẢN NHẬN TIỀN</b>", "⚠️ <b>CONFIRM PAYOUT ACCOUNT</b>", "⚠️ <b>បញ្ជាក់គណនីទទួលប្រាក់</b>", "⚠️ <b>确认收款账户</b>");
add("payout.preview_bank", "• Ngân hàng: <b>{bank}</b>", "• Bank: <b>{bank}</b>", "• ធនាគារ: <b>{bank}</b>", "• 银行：<b>{bank}</b>");
add("payout.preview_account", "• Số tài khoản: <code>{number}</code>", "• Account number: <code>{number}</code>", "• លេខគណនី: <code>{number}</code>", "• 账号：<code>{number}</code>");
add("payout.preview_holder", "• Chủ tài khoản: <b>{name}</b>", "• Account holder: <b>{name}</b>", "• ឈ្មោះគណនី: <b>{name}</b>", "• 户名：<b>{name}</b>");
add("payout.preview_qr", "• Loại: <b>Ảnh QR</b>", "• Type: <b>QR image</b>", "• ប្រភេទ: <b>រូបភាព QR</b>", "• 类型：<b>QR 图片</b>");
add("payout.confirm_hint", "Anh/chị vui lòng kiểm tra kỹ trước khi xác nhận.", "Please double-check before confirming.", "សូមពិនិត្យម្តងទៀតមុនពេលបញ្ជាក់។", "确认前请仔细核对。");
add("payout.confirm_btn", "✅ Xác nhận", "✅ Confirm", "✅ បញ្ជាក់", "✅ 确认");
add("payout.edit_btn", "✏️ Sửa", "✏️ Edit", "✏️ កែសម្រួល", "✏️ 修改");
add("payout.saved", "✅ Đã lưu tài khoản nhận tiền cho đơn <code>{id}</code>.\nNhân viên sẽ chuyển tiền tới tài khoản này.", "✅ Payout account saved for order <code>{id}</code>.\nStaff will send the money to this account.", "✅ បានរក្សាទុកគណនីទទួលប្រាក់សម្រាប់ការបញ្ជាទិញ <code>{id}</code>។\nបុគ្គលិកនឹងផ្ញើប្រាក់ទៅគណនីនេះ។", "✅ 已为订单 <code>{id}</code> 保存收款账户。\n工作人员将向该账户付款。");
add("payout.qr_attached", "✅ Đã lưu ảnh QR nhận tiền cho đơn <code>{id}</code>.\nNhân viên sẽ dùng QR này khi chuyển tiền cho anh/chị.", "✅ Your QR payout image was saved for order <code>{id}</code>.\nStaff will use this QR when paying you.", "✅ បានរក្សាទុករូបភាព QR ទទួលប្រាក់សម្រាប់ <code>{id}</code>។\nបុគ្គលិកនឹងប្រើ QR នេះពេលផ្ញើប្រាក់។", "✅ 已为订单 <code>{id}</code> 保存收款 QR 图片。\n工作人员付款时将使用此 QR。");
add("payout.invalid", "❌ Không đọc được thông tin tài khoản. Vui lòng gửi theo mẫu ví dụ: <code>vcb 0123456789 nguyen van a</code> hoặc bấm 💬 Hỗ trợ.", "❌ Could not read the account details. Please use the example format: <code>vcb 0123456789 nguyen van a</code>, or tap 💬 Support.", "❌ មិនអាចអានព័ត៌មានគណនីបានទេ។ សូមផ្ញើតាមគំរូ: <code>vcb 0123456789 nguyen van a</code> ឬចុច 💬 ជំនួយ។", "❌ 无法识别账户信息。请按示例格式发送：<code>vcb 0123456789 nguyen van a</code>，或点击 💬 客服。");
add("payout.qr_invalid", "❌ Không đọc được ảnh QR. Vui lòng gửi lại ảnh rõ hơn, hoặc nhập tài khoản bằng chữ, hoặc bấm 💬 Hỗ trợ.", "❌ Could not read the QR image. Please send a clearer QR, enter the account as text, or tap 💬 Support.", "❌ មិនអាចអានរូបភាព QR បានទេ។ សូមផ្ញើ QR ច្បាស់ជាង ឬបញ្ចូលគណនីជាអក្សរ ឬចុច 💬 ជំនួយ។", "❌ 无法读取 QR 图片。请重新发送更清晰的 QR，改用文字输入，或点击 💬 客服。");
add("payout.quote_expired", "⚠️ Phiên này đã hết hạn. Vui lòng bấm lại nút chọn tài khoản nhận tiền.", "⚠️ This session expired. Please tap the payout-account button again.", "⚠️ សម័យនេះផុតកំណត់ហើយ។ សូមចុចប៊ូតុងជ្រើសរើសគណនីទទួលម្តងទៀត។", "⚠️ 会话已过期。请重新点击选择收款账户按钮。");
add("payout.not_ready", "ℹ️ Đơn này chưa đến bước nhập tài khoản nhận tiền. Admin sẽ yêu cầu sau khi xác nhận tiền vào.", "ℹ️ This order is not at the payout-account step yet. Staff will request it after payment verification.", "ℹ️ ការបញ្ជាទិញនេះមិនទាន់ដល់ជំហានបញ្ចូលគណនីទទួលទេ។ បុគ្គលិកនឹងសុំបន្ទាប់ពីផ្ទៀងផ្ទាត់ប្រាក់ចូល។", "ℹ️ 该订单尚未到填写收款账户的步骤。管理员确认收款后会向您索取。");
add("payout.session_expired", "⚠️ Phiên nhập tài khoản đã hết hạn. Vui lòng bấm lại nút chọn tài khoản nhận tiền.", "⚠️ The input session expired. Please tap the payout-account button again.", "⚠️ សម័យបញ្ចូលផុតកំណត់។ សូមចុចប៊ូតុងគណនីទទួលម្តងទៀត។", "⚠️ 输入会话已过期。请重新点击收款账户按钮。");
add("payout.no_eligible", "ℹ️ Hiện không có đơn hàng nào của anh/chị cần nhập tài khoản nhận tiền.", "ℹ️ You currently have no order that needs a payout account.", "ℹ️ បច្ចុប្បន្នមិនមានការបញ្ជាទិញណាមួយត្រូវការគណនីទទួលទេ។", "ℹ️ 您目前没有需要填写收款账户的订单。");

// Customer bank wizard (per-order receiving-account entry)
add("bank.currency_choice", "🏦 <b>THIẾT LẬP TÀI KHOẢN NHẬN TIỀN</b>\n\nVui lòng chọn loại tiền tệ bạn muốn nhận:", "🏦 <b>SET UP YOUR PAYOUT ACCOUNT</b>\n\nPlease choose the currency you want to receive:", "🏦 <b>រៀបចំគណនីទទួលប្រាក់</b>\n\nសូមជ្រើសរើសរូបិយប័ណ្ណដែលអ្នកចង់ទទួល:", "🏦 <b>设置收款账户</b>\n\n请选择您要接收的货币：");
add("bank.wiz_title", "🏦 <b>TÀI KHOẢN NHẬN {currency}</b>\n\nVui lòng nhắn tin theo mẫu (các phần cách nhau bằng dấu |):", "🏦 <b>{currency} PAYOUT ACCOUNT</b>\n\nPlease message us using the template (parts separated by |):", "🏦 <b>គណនីទទួល {currency}</b>\n\nសូមផ្ញើសារតាមគំរូ (ខ្លែងបំបែកដោយ |):", "🏦 <b>{currency} 收款账户</b>\n\n请按模板发送消息（各部分用 | 分隔）：");
add("bank.wiz_example", "<i>Ví dụ:</i>\n<code>{currency} | Vietcombank | NGUYEN VAN A | 0123456789</code>", "<i>Example:</i>\n<code>{currency} | Vietcombank | NGUYEN VAN A | 0123456789</code>", "<i>ឧទាហរណ៍:</i>\n<code>{currency} | Vietcombank | NGUYEN VAN A | 0123456789</code>", "<i>示例：</i>\n<code>{currency} | Vietcombank | NGUYEN VAN A | 0123456789</code>");
add("bank.saved_title", "✅ <b>Đã lưu tài khoản nhận tiền {currency}:</b>", "✅ <b>{currency} payout account saved:</b>", "✅ <b>បានរក្សាទុកគណនីទទួល {currency}:</b>", "✅ <b>已保存 {currency} 收款账户：</b>");
add("bank.missing_info", "Thiếu thông tin. Định dạng yêu cầu: <code>TIỀN_TỆ|Tên Ngân Hàng|Tên Chủ TK|Số TK</code>", "Missing details. Required format: <code>CURRENCY|Bank Name|Account Holder|Account Number</code>", "ខ្វះព័ត៌មាន។ ទម្រង់តម្រូវ: <code>រូបិយប័ណ្ណ|ឈ្មោះធនាគារ|ឈ្មោះគណនី|លេខគណនី</code>", "信息不完整。要求格式：<code>货币|银行名称|户名|账号</code>");

// Help & fallback
add("help.body", "📖 <b>HƯỚNG DẪN ĐỔI TIỀN</b>\n\n• Nhắn tin tự nhiên, ví dụ: <i>\"100 đô\"</i>, <i>\"10 triệu lấy đô\"</i> để nhận báo giá tức thời.\n• Sau khi tạo đơn, chuyển khoản đúng tài khoản hiển thị rồi <b>gửi ảnh biên lai</b> vào chat.\n• Sau khi Admin xác nhận tiền vào, hệ thống sẽ yêu cầu anh/chị chọn tài khoản nhận tiền.\n• Xem đơn đã tạo: <code>/orders</code>\n• Hủy đơn đang chờ: <code>/cancel</code>\n• Cần nhân viên hỗ trợ? Nhấn nút <b>💬 Hỗ trợ</b>.", "📖 <b>EXCHANGE GUIDE</b>\n\n• Just message naturally, e.g. <i>\"100 dollars\"</i>, <i>\"exchange VND for 100 USD\"</i> for an instant quote.\n• After creating an order, transfer to the shown account and <b>send the receipt photo</b> in this chat.\n• After Admin verifies the payment, the system will ask you to choose your payout account.\n• See your orders: <code>/orders</code>\n• Cancel a pending order: <code>/cancel</code>\n• Need a human? Tap <b>💬 Support</b>.", "📖 <b>មគ្គុទ្ទេសក៍ប្តូរប្រាក់</b>\n\n• ផ្ញើសារធម្មតា ឧទាហរណ៍: <i>\"100 dollars\"</i> ដើម្បីទទួលសម្រង់តម្លៃភ្លាមៗ។\n• បន្ទាប់ពីបង្កើតការបញ្ជាទិញ សូមផ្ទេរប្រាក់តាមគណនីដែលបានបង្ហាញ រួច <b>ផ្ញើរូបភាពបង្កាន់ដៃ</b>។\n• បន្ទាប់ពី Admin ផ្ទៀងផ្ទាត់ប្រាក់ចូល ប្រព័ន្ធនឹងសួរអ្នកពីគណនីទទួលប្រាក់។\n• មើលការបញ្ជាទិញ: <code>/orders</code>\n• បោះបង់: <code>/cancel</code>\n• ត្រូវការជំនួយ? ចុច <b>💬 ជំនួយ</b>។", "📖 <b>兑换指南</b>\n\n• 直接发送自然语言，例如 <i>\"100美元\"</i>，即可获取即时报价。\n• 创建订单后，请转账至显示的账户，并在此聊天中 <b>发送回单照片</b>。\n• 管理员确认收款后，系统将请您选择收款账户。\n• 查看订单：<code>/orders</code>\n• 取消订单：<code>/cancel</code>\n• 需要人工服务？点击 <b>💬 客服</b>。");
add("customer.fallback", "👋 Xin chào! Anh/chị có thể nhắn tin yêu cầu đổi tiền, ví dụ: <i>\"đổi 500 USD sang VND\"</i>, hoặc nhấn <b>💬 Hỗ trợ</b> để gặp nhân viên tư vấn.", "👋 Hello! You can message an exchange request, e.g. <i>\"exchange 500 USD to VND\"</i>, or tap <b>💬 Support</b> to talk to an agent.", "👋 សូមស្វាគមន៍! អ្នកអាចផ្ញើសារសុំប្តូរប្រាក់ ឧទាហរណ៍: <i>\"ប្តូរ 500 USD ទៅ VND\"</i> ឬចុច <b>💬 ជំនួយ</b>។", "👋 您好！您可以发送兑换请求，例如 <i>\"把 500 USD 换成 VND\"</i>，或点击 <b>💬 客服</b> 咨询人工。");

// Bill / payout / support / errors / voice / status
add("bill.none", "Không tìm thấy đơn hàng nào của bạn đang chờ thanh toán. Vui lòng tạo đơn trước khi gửi biên lai.", "No order is waiting for payment evidence. Please create an order before sending a receipt.", "មិនមានការបញ្ជាទិញកំពុងរង់ចាំភស្តុតាងបង់ប្រាក់ទេ។ សូមបង្កើតការបញ្ជាទិញជាមុន។", "没有等待付款凭证的订单。请先创建订单再发送回单。");
add("bill.multi_title", "📸 <b>BẠN CÓ {count} ĐƠN HÀNG ĐANG CHỜ THANH TOÁN</b>", "📸 <b>YOU HAVE {count} ORDERS AWAITING PAYMENT</b>", "📸 <b>អ្នកមាន {count} ការបញ្ជាទិញកំពុងរង់ចាំបង់ប្រាក់</b>", "📸 <b>您有 {count} 个待付款订单</b>");
add("bill.multi_hint", "Vui lòng chọn chính xác đơn hàng áp dụng biên lai này:", "Please choose the exact order for this receipt:", "សូមជ្រើសរើសការបញ្ជាទិញត្រឹមត្រូវសម្រាប់បង្កាន់ដៃនេះ:", "请选择此回单对应的订单：");
add("bill.order_btn", "📋 Đơn {id} ({amount})", "📋 Order {id} ({amount})", "📋 ការបញ្ជាទិញ {id} ({amount})", "📋 订单 {id} ({amount})");
add("bill.received", "✅ Đã nhận biên lai cho đơn <code>{id}</code>. Nhân viên sẽ đối soát và phản hồi sớm.", "✅ Receipt received for order <code>{id}</code>. Staff will verify shortly.", "✅ បានទទួលបង្កាន់ដៃសម្រាប់ <code>{id}</code>។ បុគ្គលិកនឹងពិនិត្យឆាប់ៗ។", "✅ 已收到订单 <code>{id}</code> 的回单，工作人员将尽快核对。");
add("bill.error", "❌ Có lỗi khi xử lý biên lai: {error}", "❌ Could not process the receipt: {error}", "❌ មិនអាចដំណើរការបង្កាន់ដៃ: {error}", "❌ 处理回单失败：{error}");
add("bill.suspicious", "⚠️ <b>Hệ thống phát hiện biên lai có dấu hiệu cần kiểm tra thêm.</b>\nĐơn <code>{id}</code> đã được chuyển sang chế độ bảo mật để Admin kiểm tra trực tiếp.", "⚠️ <b>The receipt shows signs that need extra checking.</b>\nOrder <code>{id}</code> has been moved to secure review for Admin verification.", "⚠️ <b>បង្កាន់ដៃមានសញ្ញាត្រូវពិនិត្យបន្ថែម។</b>\nការបញ្ជាទិញ <code>{id}</code> ត្រូវបានផ្ទេរទៅការពិនិត្យសុវត្ថិភាព។", "⚠️ <b>回单存在需要进一步核实的迹象。</b>\n订单 <code>{id}</code> 已转入安全审核，由管理员直接检查。");
add("bill.manual_review", "ℹ️ <b>Đã nhận biên lai bổ sung cho đơn {id}.</b>\nĐơn đã được ghi nhận đầy đủ và chuyển Admin kiểm duyệt thủ công.", "ℹ️ <b>Additional receipt received for order {id}.</b>\nThe order is fully recorded and sent to Admin for manual review.", "ℹ️ <b>បានទទួលបង្កាន់ដៃបន្ថែមសម្រាប់ {id}។</b>\nការបញ្ជាទិញត្រូវបានកត់ត្រាពេញលេញ និងផ្ទេរទៅ Admin ពិនិត្យ។", "ℹ️ <b>已收到订单 {id} 的补充回单。</b>\n订单已完整记录，并转交管理员人工审核。");
add("bill.wait_verify", "✅ Đã nhận bill.\nĐang chờ xác nhận thanh toán.", "✅ Receipt received.\nAwaiting payment verification.", "✅ បានទទួលបង្កាន់ដៃ។\nរង់ចាំការផ្ទៀងផ្ទាត់ការទូទាត់។", "✅ 已收到回单。\n正在等待付款确认。");
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
add("voice.heard", "🎙 Em nghe được:", "🎙 I heard:", "🎙 ខ្ញុំបានឮ:", "🎙 我听到:");
add("voice.retry_prompt", "🎙 Em chưa nghe rõ nội dung ghi âm.\nAnh/chị có thể thử ghi âm lại hoặc chuyển sang nhân viên hỗ trợ.", "🎙 I couldn't understand the recording.\nYou can try recording again or switch to support staff.", "🎙 ខ្ញុំមិនអាចស្តាប់សំឡេងបានច្បាស់ទេ។\nសូមសាកល្បងថតម្តងទៀត ឬទាក់ទងបុគ្គលិកជំនួយ។", "🎙 我没听清录音内容。\n您可以重新录制或转接人工客服。");
add("voice.forwarded", "🎙 Đã chuyển ghi âm cho nhân viên hỗ trợ.", "🎙 Voice forwarded to support staff.", "🎙 បានបញ្ជូនសំឡេងទៅបុគ្គលិកជំនួយ។", "🎙 语音已转发给客服。");

add("status.WAITING_PAYMENT", "Chờ thanh toán", "Awaiting payment", "រង់ចាំបង់ប្រាក់", "待付款");
add("status.CUSTOMER_SENT_BILL", "Đã gửi biên lai", "Receipt sent", "បានផ្ញើបង្កាន់ដៃ", "已发送回单");
add("status.WAITING_ADMIN_VERIFY", "Chờ đối soát", "Awaiting verification", "រង់ចាំផ្ទៀងផ្ទាត់", "待核对");
add("status.PAYMENT_CONFIRMED", "Đã xác nhận tiền vào", "Payment confirmed", "បានបញ្ជាក់ការបង់ប្រាក់", "已确认收款");
add("status.WAITING_PAYOUT", "Cần thông tin nhận tiền", "Awaiting your bank details", "ត្រូវការព័ត៌មានគណនីទទួល", "待提供收款信息");
add("status.PAYOUT_SENT", "Đã chi tiền", "Payout sent", "បានចំណាយ", "已出款");
add("status.MANUAL_REVIEW", "Đang xem xét", "Under review", "កំពុងពិនិត្យ", "人工审核中");
add("status.SUSPICIOUS", "Cần kiểm tra thêm", "Needs review", "ត្រូវពិនិត្យបន្ថែម", "需进一步检查");
add("status.COMPLETED", "Hoàn tất", "Completed", "បានបញ្ចប់", "已完成");
add("status.CANCELLED", "Đã hủy", "Cancelled", "បានលុបចោល", "已取消");

// --- C/P/O simplification + payout fresh-info UX (customer, all locales) ---
add("payout.verified_prompt", "✅ Đã nhận tiền.\nVui lòng gửi tài khoản hoặc QR nhận tiền.", "✅ Payment verified.\nPlease send your bank account or QR for payout.", "✅ បានទទួលប្រាក់។\nសូមផ្ញើគណនី ឬ QR ទទួលប្រាក់។", "✅ 已确认收款。\n请发送您的收款账户或二维码。");
add("payout.ask_hint", "Vui lòng gửi tài khoản hoặc QR nhận tiền:", "Please send your bank account or QR:", "សូមផ្ញើគណនី ឬ QR ទទួលប្រាក់:", "请发送收款账户或二维码：");
add("payout.received_title", "✅ Đã thanh toán.", "✅ Payout sent.", "✅ បានបង់ប្រាក់រួចរាល់។", "✅ 已付款。");
add("payout.receipt_caption", "Hoá đơn chuyển tiền ở bên dưới.\n📦 #{id}", "Your payout receipt is below.\n📦 #{id}", "វិក្កយបត្របង់ប្រាក់ខាងក្រោម។\n📦 #{id}", "付款凭证如下。\n📦 #{id}");
add("order.completed_title", "✅ Giao dịch hoàn tất.\n📦 #{id}", "✅ Exchange completed.\n📦 #{id}", "✅ បញ្ចប់ការប្តូរប្រាក់។\n📦 #{id}", "✅ 交易完成。\n📦 #{id}");
add("order.history_title", "📦 <b>LỊCH SỬ ĐƠN</b>", "📦 <b>ORDER HISTORY</b>", "📦 <b>ប្រវត្តិការបញ្ជាទិញ</b>", "📦 <b>订单历史</b>");
add("rate.title", "Bạn đánh giá dịch vụ thế nào?", "How would you rate our service?", "តើអ្នកវាយតម្លៃសេវាកម្មយ៉ាងដូចម្តេច?", "您如何评价我们的服务？");
add("rate.skip", "⏭ Bỏ qua", "⏭ Skip", "⏭ រំលង", "⏭ 跳过");
add("rate.thanks", "🙏 Cảm ơn phản hồi của bạn!", "🙏 Thanks for your feedback!", "🙏 អរគុណសម្រាប់មតិយោបល់!", "🙏 感谢您的反馈！");
add("rate.thanks_skip", "👋 Cảm ơn bạn đã sử dụng dịch vụ!", "👋 Thanks for using our service!", "👋 អរគុណសម្រាប់ការប្រើប្រាស់សេវាកម្ម!", "👋 感谢您使用我们的服务！");
add("quote.summary", "💱 <b>{src} → {tgt}</b>", "💱 <b>{src} → {tgt}</b>", "💱 <b>{src} → {tgt}</b>", "💱 <b>{src} → {tgt}</b>");

// --- Dynamic payment QR V1 (customer card, all locales) ---
add("paymentqr.pay_line", "Chuyển: <b>{amount} {currency}</b>", "Transfer: <b>{amount} {currency}</b>", "ផ្ទេរ: <b>{amount} {currency}</b>", "转账：<b>{amount} {currency}</b>");
add("paymentqr.memo_line", "Nội dung: <code>{memo}</code>", "Reference: <code>{memo}</code>", "ខ្លឹមសារ: <code>{memo}</code>", "附言：<code>{memo}</code>");
add("paymentqr.send_bill_hint", "Sau khi chuyển, gửi bill vào đây.", "After paying, send the receipt here.", "បន្ទាប់ពីបង់ សូមផ្ញើបង្កាន់ដៃនៅទីនេះ។", "付款后，请在此发送回单。");
add("paymentqr.expired",
  "⏰ Đơn {ref} đã hết thời gian thanh toán.\nVui lòng tạo đơn mới để nhận tỷ giá và QR mới.",
  "⏰ Order {ref} has passed its payment deadline.\nPlease create a new order to receive a fresh rate and QR.",
  "⏰ ការបញ្ជាទិញ {ref} ផុតកំណត់ពេលបង់ប្រាក់។\nសូមបង្កើតការបញ្ជាទិញថ្មី ដើម្បីទទួលអត្រា និង QR ថ្មី។",
  "⏰ 订单 {ref} 已超过付款期限。\n请创建新订单以获取新汇率和新二维码。");

export { TRANSLATIONS };
