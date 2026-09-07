# KH-VN Exchange Bot V1

Telegram-first MVP for a manual-approval currency exchange workflow (USD/VND/KHR) built on Node.js + TypeScript, PostgreSQL, Prisma, and Google Drive archival.

## Target Architecture

The application runs **ONE Unified Telegram Bot** with Role-Based and Permission-Based Access Control (RBAC):

```text
                  ONE TELEGRAM BOT
                         │
                  telegram_user_id
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
        CUSTOMER        CSKH        ADMIN / SUPER_ADMIN
            │            │            │
            └────────────┼────────────┘
                         ▼
                      BACKEND
                         │
                Permission Engine
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   Conversation         Order          Audit
        │
        ▼
   PostgreSQL
        │
        └──── Google Drive Archive
```

### Roles & Access Resolution

When an update arrives from Telegram, identity is resolved using `ctx.from.id`:
1. **SUPER_ADMIN**: Defined by `SUPER_ADMIN_TELEGRAM_ID`. Bootstrapped idempotently on startup with all permissions.
2. **ADMIN**: Registered staff member with `ADMIN` role. Full visibility over orders, rate management, accounts/QR, and two-step financial verification.
3. **CSKH**: Registered customer support staff with `CSKH` role. Manages ticket queues, takes over conversations (`HUMAN` mode), adds internal notes, and replies directly to customers without exposing personal Telegram usernames.
4. **CUSTOMER**: Default for any Telegram user not present in the `StaffUser` table. Interacts seamlessly with AI assistance (`AUTO` mode), instant quotes, payment instructions, QR codes, and bill submission.

Staff permissions are granularly checked on every sensitive backend action (e.g., `payment.verify`, `payout.approve`, `rate.edit`, `staff.manage`). Menu visibility is never treated as a security boundary.

## Financial Safety Guardrails

1. **AI Never Confirms Money**: AI assists with quotes, intent recognition, translation, and transcription, but cannot verify payment arrival or approve payouts.
2. **Two-Step Payment Confirmation**: Verifying incoming customer payments requires explicit two-step confirmation by an authorized Admin after checking the physical bank application.
3. **Manual Payout Only**: Payouts require an authorized Admin to transfer funds, upload the payout receipt, and confirm completion.
4. **Evidence Immutability**: All original QR codes, customer receipts, payout receipts, voice recordings, and conversation exports are hashed with SHA-256 and archived to Google Drive asynchronously.

## Requirements

- Node.js 22+
- Docker & Docker Compose (recommended for Ubuntu VPS)
- One Telegram Bot token from @BotFather
- PostgreSQL (included via Docker Compose)
- Gemini API key (optional for fallback regex; required for AI exchange parsing, multilingual translation & voice transcription)
- Google Service Account (optional for Google Drive evidence archiving)

## Environment Configuration

Create a `.env` file from `.env.example`:

```env
NODE_ENV=production
PORT=3000
DATA_DIR=./data

# Unified Telegram Bot Token
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Super Admin & Notifications
SUPER_ADMIN_TELEGRAM_ID=123456789
ADMIN_NOTIFICATION_CHAT_ID=-100123456789

# Database
DATABASE_URL=postgresql://exchange:exchange_change_me@postgres:5432/exchange?schema=public

# Exchange & Quote Config
BASE_FEE_USD=2
QUOTE_EXPIRY_MINUTES=15
TIMEZONE=Asia/Phnom_Penh

# AI Engine (Google Gemini)
GEMINI_API_KEY=
GEMINI_TEXT_MODEL=gemini-2.5-flash
GEMINI_TRANSCRIBE_MODEL=gemini-2.5-flash

# Google Drive Storage & Archival
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_DRIVE_ROOT_FOLDER_ID=
```

## Setup & Local Development

```bash
cp .env.example .env
# edit .env
npm install
npm run prisma:generate
npm run prisma:validate
npm run typecheck
npm test
npm run build
```

For local development with PostgreSQL:

```bash
npx prisma db push
npm run prisma:seed
npm run dev
```

## How It Works

### 1. Customer Experience
Customers interact with the bot in a single chat thread from start to finish:
1. Send `/start` to view the **Customer Menu** (`💱 Đổi tiền`, `📦 Đơn của tôi`, `💬 Hỗ trợ`, `🏦 Tài khoản nhận tiền`).
2. Configure recipient account: `/bank VND|Vietcombank|NGUYEN VAN A|123456789`.
3. Request exchange rate: e.g., *"đổi 1000 USD sang VND"* or via voice note.
4. Confirm instant quote to create an order.
5. Receive receiving account details + payment QR image.
6. Transfer money and upload photo of bank receipt into the chat.
7. Receive real-time status updates as Admin confirms payment arrival and payout completion.

### 2. CSKH Workspace
Staff members with `CSKH` role see the **CSKH Menu** upon `/start`:
- `/tickets`: View active tickets and pending customer conversations.
- `/claim <ID_Khách>`: Take over a conversation, switching mode from `AUTO` to `HUMAN` (AI auto-replies pause).
- `/release <ID_Khách>`: Return conversation to `AUTO` AI mode.
- `/msg <ID_Khách> <nội dung>`: Send a message to the customer's private chat via the single bot without revealing staff's personal Telegram username.
- `/note <ID_Khách> <nội dung>`: Internal-only operational notes (never displayed to customers).
- `/history <ID_Khách>`: View past message history and internal notes.
- `/translate <ngôn ngữ> <nội dung>`: Test AI translation before sending messages.

### 3. Admin & Super Admin Dashboard
Staff members with `ADMIN` or `SUPER_ADMIN` role see the **Admin Menu** upon `/start`:
- `/pending`: Orders pending payment verification or waiting payout.
- Two-step payment verification: `pay_step1` ➔ `pay_step2`.
- Two-step payout completion: Upload bill with caption `/payout <orderId>` ➔ `payout_complete`.
- `/rates` and `/setrate`: View and update exchange rates (Base rate, margins, and service fees).
- `/accounts`: View accounts and upload new payment QR codes via photo caption `/addqr CURRENCY|BANK|NAME|NUMBER|TAG`.
- `/staff`: Comprehensive staff directory, invite generation (24h single-use token), approval queue, and granular permission toggles.
- `/drive <orderId>`: Inspect Drive sync status and trigger manual sync retry.
- `/audit`: Review security and operational audit trail.

## Ubuntu VPS Deployment

```bash
git clone YOUR_REPO_URL
cd KH-VN-EXCHANGE-BOT
cp .env.example .env
nano .env
docker compose up -d --build
docker compose logs -f app
```

Health check endpoint:
```text
http://YOUR_VPS_IP:3000/health
```

Persistent Docker volumes:
- `postgres_data`: PostgreSQL database storage
- `app_data`: Local evidence files and QR codes
- `backups`: Database dumps and backups

## Project Layout

```text
src/
  bot/
    handlers/
      admin-handler.ts
      cskh-handler.ts
      customer-handler.ts
    menus/
      admin-menu.ts
      cskh-menu.ts
      customer-menu.ts
    middleware/
      identity.ts
      permissions.ts
    index.ts
    notifications.ts
    router.ts
  modules/
    ai/
    audit/
    conversation/
    customer/
    drive/
    files/
    orders/
    payment-accounts/
    permissions/
    quotes/
  database/
  config/
  shared/
  server.ts
prisma/
tests/
```
