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

# Google Drive Storage & Archival (Personal Google Drive OAuth 2.0)
GOOGLE_DRIVE_CLIENT_ID=
GOOGLE_DRIVE_CLIENT_SECRET=
GOOGLE_DRIVE_REFRESH_TOKEN=
GOOGLE_DRIVE_ROOT_FOLDER_ID=
# Optional for development mock:
# GOOGLE_DRIVE_MOCK=false
```

## Google Drive OAuth 2.0 Setup (Personal Account)

The archive engine uses **OAuth 2.0 User Authentication** for a personal Google Drive account (My Drive). This replaces legacy Service Accounts, eliminating personal Google Drive storage quota limitations (`403 storageQuotaExceeded`).

### 1. Create Google Cloud OAuth Credentials
1. Open the [Google Cloud Console](https://console.cloud.google.com).
2. Create or select a project, then navigate to **APIs & Services > Library**.
3. Search for and enable the **Google Drive API**.
4. Configure **OAuth consent screen**:
   - User Type: **External**.
   - Fill in app name (e.g., `KH-VN Bot Archive`) and your developer email.
   - Under **Test users**, add your personal Google account (e.g. `yourname@gmail.com`).
5. Go to **APIs & Services > Credentials > Create Credentials > OAuth client ID**:
   - Application type: **Web application** (or **Desktop app**).
   - Name: `KH-VN Drive Sync`.
   - **Authorized redirect URIs**: Add `http://localhost:3000/oauth2callback` and `http://localhost`.
6. Copy the **Client ID** and **Client Secret**.

### 2. Prepare Root Folder in Personal Drive
1. Open your personal Google Drive in your browser.
2. Create a new root folder (e.g., `KH_VN_EXCHANGE_EVIDENCE`).
3. Open the folder and copy its ID from the browser URL:
   `https://drive.google.com/drive/folders/<GOOGLE_DRIVE_ROOT_FOLDER_ID>`
4. Add `GOOGLE_DRIVE_ROOT_FOLDER_ID` to your `.env` file.

### 3. Generate the Initial Refresh Token
Run the built-in helper script on your machine:
```bash
npm run auth:drive
```
1. Paste your `Client ID`, `Client Secret`, and Redirect URI when prompted (or have them in `.env`).
2. Open the printed authorization URL in your browser and sign in with your personal Google account.
3. Approve access to Google Drive.
4. Copy the authorization code from the redirect URL address bar and paste it back into the terminal.
5. The script exchanges the code and prints your `GOOGLE_DRIVE_REFRESH_TOKEN`.
6. Add this token to your production/VPS `.env` file.

> **Scope Justification:** The bot requests `https://www.googleapis.com/auth/drive` because it must search for and organize subfolders (`YYYY/MM/ORDER-ID/`) inside the pre-existing root folder (`GOOGLE_DRIVE_ROOT_FOLDER_ID`) created by the user. The narrower `drive.file` scope only grants access to files created directly by the client and cannot write to pre-existing personal Drive folders.

### 4. Headless VPS Execution
- The VPS runs 100% headless using `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, and `GOOGLE_DRIVE_REFRESH_TOKEN`.
- The Google OAuth2 client automatically refreshes short-lived access tokens in the background without any browser interaction.
- In `NODE_ENV=production`: Missing credentials will mark the integration as `NOT CONFIGURED` and safely fail sync jobs for retry with admin alerts, never producing fake success or mock IDs, and never interrupting customer financial transactions.

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
