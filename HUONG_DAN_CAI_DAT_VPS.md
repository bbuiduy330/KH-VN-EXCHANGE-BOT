# HƯỚNG DẪN TRIỂN KHAI VÀ QUẢN TRỊ BOT TỪ TELEGRAM

Tài liệu hướng dẫn triển khai hệ thống **AIWASH / KH-VN Exchange Bot** lên VPS theo kiến trúc tối giản nhất: **Cài 1 lần - Quản trị và cấu hình 100% qua Telegram**.

---

## 1. NGUYÊN TẮC THIẾT KẾ MỚI
- **Chỉ khai báo 2 biến tối thiểu trên VPS**:
  1. `TELEGRAM_BOT_TOKEN`: Token của bot lấy từ [@BotFather](https://t.me/BotFather).
  2. `SUPER_ADMIN_TELEGRAM_ID`: Telegram ID số của Admin (lấy từ [@userinfobot](https://t.me/userinfobot)).
- **Toàn bộ thông số còn lại cài đặt trực tiếp qua chat Telegram**:
  - Không cần đăng nhập SSH vào sửa file cấu hình `.env` phức tạp.
  - Cài và đổi Google Gemini API Key trực tiếp qua chat, kiểm tra độ trễ tự động trước khi lưu.
  - Tự chọn và chuyển đổi Model AI (`gemini-3.6-flash`, `gemini-3.5-flash-lite`...).
  - Thiết lập phòng chat nhận thông báo đơn hàng chỉ bằng 1 lệnh `/sethere`.
  - Quản lý sao lưu dữ liệu (Backup), kích hoạt sao lưu tức thì, xem lịch sử và chu kỳ tự động.
  - Cấu hình phí dịch vụ, ngưỡng cảnh báo giao dịch lớn, thời hạn báo giá.
  - Mọi thay đổi lưu vĩnh viễn vào ổ đĩa VPS (`system_config.json`) và áp dụng ngay lập tức mà **không cần khởi động lại bot hay VPS**.

---

## 2. CÁC BƯỚC CÀI ĐẶT TRÊN VPS (3 BƯỚC DUY NHẤT)

### Bước 1: Chuẩn bị thư mục trên VPS
Đăng nhập SSH vào VPS và tải mã nguồn hoặc tạo thư mục:
```bash
mkdir -p /app/exchange-bot && cd /app/exchange-bot
```

### Bước 2: Tạo file cấu hình `.env` tối giản
Chỉ cần đúng 2 dòng:
```bash
cat << 'EOF' > .env
TELEGRAM_BOT_TOKEN="8731758268:AAxxxxx_dien_token_bot_vao_day"
SUPER_ADMIN_TELEGRAM_ID="123456789"
EOF
```

### Bước 3: Khởi động hệ thống
Nếu dùng Docker:
```bash
docker compose up -d
```
Hoặc nếu chạy trực tiếp Node.js:
```bash
npm install
npm run build
npm start
```

Sau khi khởi động, bot sẽ báo online ngay lập tức trên Telegram!

---

## 3. HƯỚNG DẪN CÀI ĐẶT CÁC THÔNG SỐ QUA TELEGRAM

Mở Telegram, tìm và nhắn tin trực tiếp cho Bot của bạn:

### 3.1. Bảng điều khiển cài đặt tổng thể: `/settings` hoặc `/config`
Gõ `/settings` hoặc bấm nút **⚙️ Cài đặt hệ thống** trong menu `/admin`:
Bot sẽ hiển thị toàn bộ trạng thái hệ thống và bàn phím tương tác:
- Trạng thái Google Gemini API Key (Đã kích hoạt hay chưa)
- Model AI đang dùng
- Kênh nhận thông báo đơn hàng
- Trạng thái tự động sao lưu, chu kỳ và lần sao lưu gần nhất
- Bảng phí dịch vụ và ngưỡng cảnh báo

---

### 3.2. Cài đặt Google Gemini API Key: `/setkey <api_key>`
Admin chỉ cần gửi lệnh kèm API Key:
```text
/setkey AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxx
```
- **Cơ chế thông minh**: Bot sẽ gửi một tin nhắn thử nghiệm tới Google Gemini API:
  - Nếu key hợp lệ: Bot phản hồi `✅ ĐÃ CẬP NHẬT GOOGLE GEMINI API KEY THÀNH CÔNG!`, ghi nhận độ trễ (ms), model và kích hoạt tính năng AI tư vấn khách hàng ngay tức thì.
  - Nếu key sai hoặc hết quota: Bot báo lỗi chi tiết để Admin kiểm tra lại mà không làm gián đoạn hệ thống.

---

### 3.3. Đổi Model AI: `/setmodel` hoặc `/setmodel <tên_model>`
- Gõ `/setmodel` để mở danh sách chọn nhanh:
  - `⚡ gemini-3.6-flash`: Cân bằng hoàn hảo, tốc độ cao, trích xuất hóa đơn chuẩn xác (Khuyên dùng).
  - `🪶 gemini-3.5-flash-lite`: Siêu nhẹ, phản hồi cực nhanh, tiết kiệm quota.
  - `🧠 gemini-3.8-flash`: Model thế hệ mới.
- Hoặc gõ trực tiếp: `/setmodel gemini-3.6-flash`

---

### 3.4. Cài đặt kênh/nhóm nhận thông báo đơn hàng: `/sethere`
- Khi muốn bot gửi thông báo đơn hàng mới, hóa đơn khách chuyển tiền, cảnh báo cần duyệt vào một nhóm hay kênh chat của bạn:
  1. Thêm Bot vào nhóm đó và cấp quyền đọc/gửi tin nhắn.
  2. Tại nhóm đó, chỉ cần gõ lệnh:
     ```text
     /sethere
     ```
  3. Bot sẽ tự động nhận diện `Chat ID` của nhóm và lưu làm kênh thông báo chính thức!
- Nếu muốn nhập ID thủ công: `/setnotify <chat_id>`

---

### 3.5. Kiểm tra kết nối AI: `/testai`
- Gõ `/testai` bất kỳ lúc nào để ping kiểm tra Google Gemini API:
  - Xem độ trễ phản hồi (ms)
  - Xem model đang phản hồi
  - Kiểm tra xem token đã được ghi nhận trên Google AI Studio hay chưa.

---

### 3.6. Quản lý Sao lưu dữ liệu (Backup):
- `/backup`: Kích hoạt sao lưu toàn bộ cơ sở dữ liệu và kho chứng từ hóa đơn trên VPS ngay lập tức.
- `/backups`: Xem danh sách 10 bản sao lưu gần nhất kèm thời gian và dung lượng.
- `/setbackup <số_giờ>`: Thay đổi chu kỳ tự động sao lưu (ví dụ `/setbackup 6` là mỗi 6 tiếng tự sao lưu 1 lần).
- `/togglebackup`: Bật hoặc tắt chế độ tự động sao lưu định kỳ.

---

### 3.7. Cài đặt tài chính & tỷ giá:
- `/setfee <usd>`: Đổi phí giao dịch mặc định (ví dụ: `/setfee 2`).
- `/setthreshold <usd>`: Đổi ngưỡng cảnh báo giao dịch lớn (ví dụ: `/setthreshold 5000`).
- `/setrate`: Cập nhật tỷ giá hối đoái cho các cặp tiền USD/VND, USD/KHR, VND/KHR.

---

## 4. TÓM TẮT DANH SÁCH LỆNH DÀNH CHO ADMIN

| Lệnh | Mô tả |
| :--- | :--- |
| `/settings` hoặc `/config` | Mở bảng điều khiển cài đặt toàn diện |
| `/setkey <api_key>` | Cài hoặc đổi Google Gemini API Key |
| `/setmodel <model>` | Đổi Model Google Gemini AI |
| `/sethere` | Đặt phòng chat/nhóm này làm kênh nhận thông báo |
| `/testai` | Kiểm tra kết nối và độ trễ Gemini AI |
| `/backup` | Chạy sao lưu hệ thống ngay lập tức |
| `/backups` | Xem lịch sử các bản sao lưu đã lưu trên VPS |
| `/setbackup <giờ>` | Đặt chu kỳ tự động sao lưu (mỗi X giờ) |
| `/togglebackup` | Bật/Tắt tự động sao lưu định kỳ |
| `/setfee <usd>` | Đổi phí giao dịch mặc định |
| `/setthreshold <usd>` | Đổi ngưỡng giao dịch lớn cần chú ý |
| `/rates` & `/setrate` | Xem và cài đặt tỷ giá mua/bán |
| `/accounts` & `/addqr` | Quản lý tài khoản ngân hàng & QR nhận tiền |
| `/staff` & `/invite` | Quản trị và phân quyền nhân viên CSKH/Admin |
