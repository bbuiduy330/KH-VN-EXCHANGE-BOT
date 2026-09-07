# Prompt đầu tiên cho Cursor Agent

Hãy đọc toàn bộ repository này trước khi sửa.

Mục tiêu: biến repo KH-VN Exchange Bot V1 thành bản build sạch trên máy hiện tại mà KHÔNG thay đổi các nguyên tắc tài chính sau:

1. AI không được tự xác nhận tiền đã vào.
2. CSKH không được `payment.verify` mặc định.
3. Payment confirmation phải có 2 bước và kiểm tra state ở backend.
4. QR/bill/voice phải giữ file gốc + SHA-256; dữ liệu AI chỉ là metadata phụ.
5. Order giữ snapshot tỷ giá, tài khoản nhận và QR version đã gửi cho khách.
6. PostgreSQL là source of truth; Google Drive chỉ archive.

Làm ngay các bước sau:

- chạy `npm install`
- kiểm tra version/package incompatibility và chỉ sửa khi cần
- chạy `npm run prisma:generate`
- chạy `npm run prisma:validate`
- chạy `npm run typecheck`
- chạy `npm test`
- chạy `npm run build`
- sửa tất cả lỗi compile/type/API compatibility cho tới khi sạch

Sau khi build sạch, tiếp tục theo thứ tự:

A. Implement payout bill upload + two-step `PAYOUT_SENT -> COMPLETED`; không auto payout.
B. Implement Admin staff invite/approve/disable + permission UI bằng Telegram.
C. Wire `DriveSyncJob` để archive QR gốc, customer bill, payout bill, voice, conversation export lên Google Drive có retry.
D. Implement voice message end-to-end: giữ OGG gốc -> Gemini transcription -> intent parser.
E. Implement CSKH translation preview: CSKH gõ tiếng Việt -> AI dịch theo ngôn ngữ khách -> CSKH xem preview -> bấm Send.
F. Add Admin customer search và full conversation/audit history pagination.
G. Tạo versioned Prisma migration và thay `prisma db push` khỏi production startup.

Không viết lại project từ đầu. Preserve architecture và business rules hiện tại. Mỗi phase phải chạy lại typecheck + test + build trước khi chuyển phase tiếp theo.
