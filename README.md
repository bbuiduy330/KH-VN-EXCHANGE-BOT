# KH-VN Exchange Bot — VPS hardening review

Bản vá dựa trên commit `a118417aa4d13698d5bee7d0ea20613129896763` của repo bbuiduy330/KH-VN-EXCHANGE-BOT. Giữ Node.js/TypeScript, grammY, PostgreSQL/Prisma và Gemini. Đây là bản sửa để chạy thử có kiểm soát, chưa phải xác nhận đủ điều kiện vận hành tiền thật.

## Khởi động trên VPS Ubuntu mới

```bash
git clone https://github.com/bbuiduy330/KH-VN-EXCHANGE-BOT.git
cd KH-VN-EXCHANGE-BOT
# Cài Docker nếu chưa có: curl -fsSL https://get.docker.com -o get-docker.sh && sudo sh get-docker.sh && sudo usermod -aG docker $USER
# Cấu hình secrets:
cp .env.example .env
# Đặt POSTGRES_PASSWORD và CONFIG_ENCRYPTION_KEY (dùng: openssl rand -hex 32)
sudo mkdir -p data
sudo chown -R 1000:1000 data
sudo chmod 700 data
sudo docker compose up -d --build
sudo docker compose logs --tail=80 app
curl --fail http://127.0.0.1:3000/health
```

Chỉ cần tạo `.env` một lần; không tạo lại nếu database đã có dữ liệu. Bot sẽ không tạo tài khoản ngân hàng mẫu. Gửi `/start` từ Telegram admin, rồi `/setrate` và ảnh QR thật có caption `/addqr` để cấu hình.

## Backup

```bash
sudo docker compose build backup
sudo bash scripts/init-restic.sh
sudo bash scripts/backup-storage.sh
sudo bash scripts/setup-backup-cron.sh
sudo systemctl list-timers kh-vn-backup.timer
```

Backup riêng database và file, mã hóa bằng Restic. Container backup nhìn đúng `./data` mà app đang dùng. Không xóa lock hay snapshot tự động. Bản sao lưu cùng VPS không bảo vệ khi mất cả VPS: tải thư mục `backups/restic` sang máy khác; giữ `.restic-password` ở nơi riêng.

## Kiểm thử phát triển

```bash
npm install --ignore-scripts
npm run prisma:generate
npm run typecheck
npm test
npm run build
```

Chỉ `NODE_ENV=test` mới dùng mock. Ngoài test, lỗi database được trả ra và không chuyển sang RAM. Test mock không kiểm chứng transaction/rollback PostgreSQL; vẫn cần nghiệm thu Docker/PostgreSQL thật.

## Phạm vi

Có: một bot, admin/CSKH, báo giá theo tiền gửi, hồ sơ đơn, duyệt nhận/chi thủ công, chứng từ SHA-256, local storage, scripts backup.

Chưa đầy đủ: cảnh báo nhiều Telegram dùng chung STK, lịch sử định danh, tự chọn ngôn ngữ trả lời, báo giá theo số tiền muốn nhận, khóa người chi trước khi chuyển ngân hàng, inbox/outbox bền vững và retry archive nền. Xem báo cáo trước khi triển khai có khách thật.
