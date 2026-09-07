import express from "express";
import { env } from "./config/env.js";
import { logger } from "./shared/logger.js";
import { QuoteService } from "./modules/quotes/quote-service.js";
import { PaymentAccountService } from "./modules/payment-accounts/account-service.js";
import { OrderService } from "./modules/orders/order-service.js";
import { AuditService } from "./modules/audit/audit-service.js";
import { GoogleDriveService, DriveArchiveService } from "./modules/drive/drive-service.js";
import { startSingleBot, stopSingleBot } from "./bot/index.js";
import { prisma } from "./database/client.js";

const app = express();
app.use(express.json());

// Health endpoint specified in README
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: env.NODE_ENV,
    timezone: env.TIMEZONE,
    services: {
      gemini: Boolean(env.GEMINI_API_KEY),
      telegramBot: Boolean(env.TELEGRAM_BOT_TOKEN),
      googleDrive: Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY)
    }
  });
});

// API Routes
app.get("/api/rates", async (req, res) => {
  try {
    const rates = await QuoteService.getAllRates();
    res.json(rates);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/rates", async (req, res) => {
  try {
    const { pair, baseRate, buyMargin, sellMargin, fee, feeCurrency, updatedBy } = req.body;
    const rate = await QuoteService.setRate(
      pair,
      baseRate,
      buyMargin,
      sellMargin,
      fee,
      feeCurrency,
      updatedBy || "dashboard"
    );
    res.json(rate);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/quote", async (req, res) => {
  try {
    const { sourceCurrency, targetCurrency, amount } = req.body;
    if (!sourceCurrency || !targetCurrency || !amount) {
      return res.status(400).json({ error: "Missing required parameters" });
    }
    const quote = await QuoteService.calculateQuote(sourceCurrency, targetCurrency, amount);
    res.json({
      sourceCurrency: quote.sourceCurrency,
      targetCurrency: quote.targetCurrency,
      sourceAmount: quote.sourceAmount.toString(),
      targetAmount: quote.targetAmount.toString(),
      effectiveRate: quote.effectiveRate.toString(),
      baseRate: quote.baseRate.toString(),
      fee: quote.fee.toString(),
      feeCurrency: quote.feeCurrency,
      expiresAt: quote.expiresAt
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/accounts", async (req, res) => {
  try {
    const accounts = await PaymentAccountService.getAllAccounts();
    res.json(accounts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const orders = await OrderService.getAllOrders(50);
    res.json(orders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/orders/:id/verify-payment", async (req, res) => {
  try {
    const { adminId } = req.body;
    const updated = await OrderService.confirmPaymentReceived(req.params.id, adminId || "admin-ui");
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/orders/:id/complete-payout", async (req, res) => {
  try {
    const { adminId } = req.body;
    const updated = await OrderService.completePayout(req.params.id, adminId || "admin-ui");
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/audit", async (req, res) => {
  try {
    const logs = await AuditService.getLogs(undefined, 50);
    res.json(logs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Operations Web Dashboard
app.get("/", (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KH-VN Exchange Bot — Operational Center</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --surface-border: #30363d;
      --text: #c9d1d9;
      --text-bright: #f0f6fc;
      --accent: #58a6ff;
      --success: #238636;
      --success-text: #3fb950;
      --warning: #d29922;
      --danger: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 24px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--surface-border);
    }
    h1 { color: var(--text-bright); font-size: 24px; display: flex; align-items: center; gap: 10px; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      background: #1f6feb26;
      color: var(--accent);
      border: 1px solid #1f6feb;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 20px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 8px;
      padding: 20px;
    }
    .card-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-bright);
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .notice {
      background: #388bfd1a;
      border-left: 4px solid var(--accent);
      padding: 14px 16px;
      border-radius: 0 8px 8px 0;
      margin-bottom: 24px;
      font-size: 14px;
    }
    .notice strong { color: var(--text-bright); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--surface-border); }
    th { color: var(--text-bright); font-weight: 600; background: #21262d; }
    .status-pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-ok { background: #23863626; color: var(--success-text); }
    .status-wait { background: #d2992226; color: var(--warning); }
    .btn {
      background: var(--success);
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
    }
    .btn:hover { opacity: 0.9; }
    .input-group { display: flex; gap: 10px; margin-top: 12px; }
    input, select {
      background: #0d1117;
      border: 1px solid var(--surface-border);
      color: var(--text-bright);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 14px;
    }
    input:focus, select:focus { outline: none; border-color: var(--accent); }
    .code-box {
      background: #090d13;
      padding: 12px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 13px;
      overflow-x: auto;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>KH-VN Exchange Bot <span class="badge">V1 Operational</span></h1>
        <p style="font-size: 13px; color: #8b949e; margin-top: 4px;">Hệ thống chuyển đổi ngoại tệ USD / VND / KHR bảo mật đa lớp</p>
      </div>
      <div>
        <a href="/health" target="_blank" style="color: var(--accent); font-size: 13px; text-decoration: none;">🔍 Kiểm tra /health</a>
      </div>
    </header>

    <div class="notice">
      🛡 <strong>Quy tắc an toàn tài chính (Financial Safety Guardrails):</strong><br>
      1. AI không bao giờ tự động xác nhận tiền đã vào tài khoản.<br>
      2. Nhân viên CSKH không có quyền <code>payment.verify</code>.<br>
      3. Xác nhận tiền vào và hoàn tất thanh toán phải qua quy trình 2 bước của Admin.<br>
      4. Tất cả mã QR, biên lai khách, biên lai chi và tin nhắn thoại đều được lưu trữ file gốc + mã băm SHA-256.
    </div>

    <div class="grid">
      <!-- Rates Card -->
      <div class="card">
        <div class="card-title">
          <span>📈 Tỷ giá hối đoái hiện hành</span>
          <span class="badge">Live</span>
        </div>
        <div id="rates-table">Đang tải tỷ giá...</div>
      </div>

      <!-- Quick Calculator -->
      <div class="card">
        <div class="card-title">
          <span>🧮 Máy tính báo giá nhanh</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <div style="display: flex; gap: 10px;">
            <select id="calc-src" style="flex: 1;">
              <option value="USD">USD</option>
              <option value="VND">VND</option>
              <option value="KHR">KHR</option>
            </select>
            <span style="align-self: center;">➔</span>
            <select id="calc-tgt" style="flex: 1;">
              <option value="VND" selected>VND</option>
              <option value="USD">USD</option>
              <option value="KHR">KHR</option>
            </select>
          </div>
          <input type="number" id="calc-amount" placeholder="Nhập số tiền..." value="1000" />
          <button class="btn" onclick="calculateQuote()">Tính toán báo giá</button>
          <div id="quote-result" class="code-box" style="display: none;"></div>
        </div>
      </div>

      <!-- System & Bots Status -->
      <div class="card">
        <div class="card-title">
          <span>🤖 Trạng thái dịch vụ & Bots</span>
        </div>
        <div id="system-status">Đang tải trạng thái...</div>
      </div>
    </div>

    <!-- Active Orders -->
    <div class="card" style="margin-bottom: 24px;">
      <div class="card-title">
        <span>📦 Danh sách đơn hàng gần đây</span>
        <button class="btn" style="padding: 4px 10px; font-size: 12px;" onclick="loadOrders()">Làm mới</button>
      </div>
      <div id="orders-table" style="overflow-x: auto;">Đang tải danh sách đơn hàng...</div>
    </div>

    <!-- Audit Logs -->
    <div class="card">
      <div class="card-title">
        <span>🛡 Nhật ký kiểm toán an toàn (Audit Trail)</span>
      </div>
      <div id="audit-table" style="overflow-x: auto;">Đang tải nhật ký kiểm toán...</div>
    </div>
  </div>

  <script>
    async function loadRates() {
      try {
        const res = await fetch('/api/rates');
        const rates = await res.json();
        let html = '<table><thead><tr><th>Cặp</th><th>Tỷ giá gốc</th><th>Biên độ mua/bán</th><th>Phí dịch vụ</th></tr></thead><tbody>';
        for (const r of rates) {
          html += '<tr><td><strong>' + r.pair + '</strong></td><td>' + r.baseRate + '</td><td>-' + r.buyMargin + ' / +' + r.sellMargin + '</td><td>' + r.fee + ' ' + r.feeCurrency + '</td></tr>';
        }
        html += '</tbody></table>';
        document.getElementById('rates-table').innerHTML = html;
      } catch (e) {
        document.getElementById('rates-table').innerHTML = '<p style="color: var(--danger)">Lỗi tải tỷ giá</p>';
      }
    }

    async function loadStatus() {
      try {
        const res = await fetch('/health');
        const data = await res.json();
        const s = data.services;
        let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';
        html += '<div>Unified Telegram Bot: ' + (s.telegramBot ? '<span class="status-pill status-ok">Đang chạy</span>' : '<span class="status-pill status-wait">Standby (Chưa có Token)</span>') + '</div>';
        html += '<div>AI Engine: ' + (s.gemini ? '<span class="status-pill status-ok">Gemini Flash Ready</span>' : '<span class="status-pill status-wait">Regex Fallback Active</span>') + '</div>';
        html += '<div>Google Drive Sync: ' + (s.googleDrive ? '<span class="status-pill status-ok">Đã cấu hình</span>' : '<span class="status-pill status-wait">Chưa cấu hình</span>') + '</div>';
        html += '</div>';
        document.getElementById('system-status').innerHTML = html;
      } catch (e) {
        document.getElementById('system-status').innerText = 'Không thể lấy trạng thái';
      }
    }

    async function calculateQuote() {
      const src = document.getElementById('calc-src').value;
      const tgt = document.getElementById('calc-tgt').value;
      const amount = document.getElementById('calc-amount').value;
      if (!amount || amount <= 0) return alert('Vui lòng nhập số tiền hợp lệ');

      try {
        const res = await fetch('/api/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceCurrency: src, targetCurrency: tgt, amount: amount })
        });
        const q = await res.json();
        if (q.error) {
          alert(q.error);
          return;
        }
        const box = document.getElementById('quote-result');
        box.style.display = 'block';
        box.innerHTML = 'Khách gửi: <strong>' + q.sourceAmount + ' ' + q.sourceCurrency + '</strong><br>' +
          'Khách nhận: <strong style="color: var(--success-text)">' + Number(q.targetAmount).toLocaleString() + ' ' + q.targetCurrency + '</strong><br>' +
          'Tỷ giá hiệu dụng: ' + Number(q.effectiveRate).toFixed(4) + '<br>' +
          'Phí: ' + q.fee + ' ' + q.feeCurrency;
      } catch (e) {
        alert('Lỗi tính toán: ' + e.message);
      }
    }

    async function loadOrders() {
      try {
        const res = await fetch('/api/orders');
        const orders = await res.json();
        if (!orders || orders.length === 0) {
          document.getElementById('orders-table').innerHTML = '<p style="padding: 12px; color: #8b949e">Chưa có đơn hàng nào.</p>';
          return;
        }
        let html = '<table><thead><tr><th>Mã Đơn</th><th>Khách gửi</th><th>Khách nhận</th><th>Tỷ giá</th><th>Trạng thái</th><th>Thao tác Admin</th></tr></thead><tbody>';
        for (const o of orders) {
          const pillClass = o.status === 'COMPLETED' ? 'status-ok' : 'status-wait';
          let action = '-';
          if (o.status === 'PENDING_PAYMENT') {
            action = '<button class="btn" style="padding: 2px 8px; font-size: 11px;" onclick="verifyPayment(\\'' + o.id + '\\')">Xác nhận nhận tiền (2 bước)</button>';
          } else if (o.status === 'PAYOUT_SENT') {
            action = '<button class="btn" style="padding: 2px 8px; font-size: 11px;" onclick="completePayout(\\'' + o.id + '\\')">Hoàn tất chi tiền</button>';
          }
          html += '<tr><td><code>' + o.id + '</code></td><td>' + o.sourceAmount + ' ' + o.sourceCurrency + '</td><td>' + o.targetAmount + ' ' + o.targetCurrency + '</td><td>' + o.rate + '</td><td><span class="status-pill ' + pillClass + '">' + o.status + '</span></td><td>' + action + '</td></tr>';
        }
        html += '</tbody></table>';
        document.getElementById('orders-table').innerHTML = html;
      } catch (e) {
        document.getElementById('orders-table').innerHTML = '<p style="color: var(--danger)">Lỗi tải danh sách đơn</p>';
      }
    }

    async function verifyPayment(orderId) {
      if (!confirm('⚠️ Xác nhận an toàn tài chính (Bước 1/2):\\nBạn đã kiểm tra tài khoản ngân hàng thực tế và xác nhận tiền ĐÃ VÀO?')) return;
      if (!confirm('⚠️ Xác nhận lần 2 (Bước 2/2):\\nChắc chắn cập nhật trạng thái đơn sang WAITING_PAYOUT?')) return;

      try {
        const res = await fetch('/api/orders/' + orderId + '/verify-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adminId: 'admin-dashboard' })
        });
        const data = await res.json();
        if (data.error) alert(data.error);
        else {
          alert('✅ Đã xác nhận tiền vào thành công cho đơn ' + orderId);
          loadOrders();
        }
      } catch (e) {
        alert('Lỗi: ' + e.message);
      }
    }

    async function completePayout(orderId) {
      if (!confirm('Xác nhận hoàn tất đơn hàng ' + orderId + '?')) return;
      try {
        const res = await fetch('/api/orders/' + orderId + '/complete-payout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adminId: 'admin-dashboard' })
        });
        const data = await res.json();
        if (data.error) alert(data.error);
        else {
          alert('🎉 Đơn hàng đã hoàn tất!');
          loadOrders();
        }
      } catch (e) {
        alert('Lỗi: ' + e.message);
      }
    }

    async function loadAudit() {
      try {
        const res = await fetch('/api/audit');
        const logs = await res.json();
        if (!logs || logs.length === 0) {
          document.getElementById('audit-table').innerHTML = '<p style="padding: 12px; color: #8b949e">Chưa có nhật ký kiểm toán.</p>';
          return;
        }
        let html = '<table><thead><tr><th>Thời gian</th><th>Hành động</th><th>Đối tượng</th><th>Người thực hiện</th></tr></thead><tbody>';
        for (const l of logs.slice(0, 10)) {
          const time = new Date(l.createdAt).toLocaleTimeString();
          html += '<tr><td>' + time + '</td><td><strong>' + l.action + '</strong></td><td>' + l.targetType + ' (' + l.targetId + ')</td><td>' + l.actorRole + ' (' + l.actorId + ')</td></tr>';
        }
        html += '</tbody></table>';
        document.getElementById('audit-table').innerHTML = html;
      } catch (e) {
        document.getElementById('audit-table').innerHTML = '<p style="color: var(--danger)">Lỗi tải audit logs</p>';
      }
    }

    loadRates();
    loadStatus();
    loadOrders();
    loadAudit();
  </script>
</body>
</html>`;
  res.send(html);
});

// Start HTTP server
const PORT = env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
  logger.info(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`KH-VN Exchange Bot server listening on http://0.0.0.0:${PORT}`);

  // Bootstrap Unified Telegram Bot gracefully
  startSingleBot().catch((err) => {
    logger.warn({ err }, "Unified Telegram Bot startup error or token missing");
  });

  // Periodic Google Drive Sync (every 60s)
  setInterval(() => {
    DriveArchiveService.runPendingJobs().catch(() => {});
  }, 60000);
});

// Graceful shutdown handlers
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, gracefully shutting down server and Telegram bot...");
  await stopSingleBot();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, gracefully shutting down server and Telegram bot...");
  await stopSingleBot();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

export default app;
