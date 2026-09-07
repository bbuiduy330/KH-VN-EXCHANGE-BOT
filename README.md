# KH-VN Exchange Bot V1

Telegram-first MVP for a manual-approval currency exchange workflow (USD/VND/KHR).

## What is included

- 3 bots: Customer, CSKH, Admin
- PostgreSQL + Prisma
- Manual rate management and immutable quote snapshots
- Payment account / original QR storage with versions and SHA-256
- Customer payout bank storage
- Customer bill ingestion + optional Gemini image analysis
- Admin two-step real-money confirmation
- Conversation AUTO/HUMAN mode, CSKH claim/release, internal notes and direct messaging
- Audit log models and key audit events
- Local persistent evidence storage; Google Drive service adapter included for next-step sync wiring
- Docker Compose for Ubuntu VPS

## Financial safety

AI never verifies that money actually arrived. Only an authorized Admin can move an order through payment verification, and the Admin action requires a second confirmation.

Original QR/bill files are retained. AI extraction is secondary metadata only.

## Important MVP note

This repository is intentionally a strong V1 foundation for Cursor refinement, not a finished regulated financial platform. Before handling real customer funds, add jurisdiction-specific compliance/KYC/AML controls as required, test restore procedures, enable encrypted backups, review access controls, and convert the initial `prisma db push` bootstrap to versioned migrations.

## Requirements

- Node.js 22+
- Docker + Docker Compose (recommended)
- Three Telegram bots from BotFather
- PostgreSQL (Docker Compose includes it)
- Gemini API key (optional for fallback text parsing; required for multilingual AI/image/voice expansion)

## Setup on PC

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

For a local PostgreSQL, set `DATABASE_URL` then run:

```bash
npx prisma db push
npm run prisma:seed
npm run dev
```

## Telegram setup

Create 3 bots in BotFather and put tokens in `.env`:

```env
CUSTOMER_BOT_TOKEN=
CSKH_BOT_TOKEN=
ADMIN_BOT_TOKEN=
SUPER_ADMIN_TELEGRAM_ID=
```

The first Super Admin is bootstrapped from `SUPER_ADMIN_TELEGRAM_ID`.

## Configure a rate

In Admin Bot:

```text
/setrate USD/VND 26300 50 100 2 USD
```

Format:

```text
/setrate SOURCE/TARGET base buyMargin sellMargin fee feeCurrency
```

The quote engine uses Decimal arithmetic. When the customer sells the source currency, `buyMargin` is applied; when buying target currency, `sellMargin` is applied.

Use `/rates` to view current rates.

## Add payment QR

Send an image to Admin Bot with caption:

```text
/addqr USD|ABA|ACCOUNT NAME|123456789|default
```

The application stores the original image under the persistent data directory and keeps its SHA-256. Do not delete the `app_data` Docker volume.

Use:

```text
/accounts
```

to list accounts.

## Customer flow

1. `/start`
2. Save payout bank, for example:
   `/bank VND|MB Bank|NGUYEN VAN A|123456789`
3. Message: `đổi 1000 USD sang VND`
4. Confirm quote
5. Bot sends the configured USD account and original QR
6. Customer sends bill image
7. Admin receives verification notification
8. Admin presses `Đã nhận tiền`, then performs the second confirmation after checking the actual account
9. Order moves to `WAITING_PAYOUT`

Payout-upload completion is intentionally left as the first Cursor extension so the real operational button/UX can match your exact workflow.

## CSKH commands

```text
/tickets
/claim KH-...
/release KH-...
/msg KH-... nội dung gửi khách
/note KH-... ghi chú nội bộ
/history KH-...
```

When a conversation is HUMAN mode, the Customer AI stops automatic replies. CSKH messages are sent through Customer Bot, not the employee's personal Telegram account.

## Gemini

Set:

```env
GEMINI_API_KEY=
GEMINI_TEXT_MODEL=gemini-3.8-flash
GEMINI_TRANSCRIBE_MODEL=gemini-3.5-transcribe
```

The code centralizes Gemini behind `AiProvider`. If no API key is set, a limited regex parser lets you test basic text exchange flows.

## Google Drive

The `GoogleDriveService` is included. Configure:

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_DRIVE_ROOT_FOLDER_ID=
```

Share the destination Drive folder with the service-account email. The next Cursor task should wire `DriveSyncJob` to automatically upload every QR, customer bill, payout bill, voice file and conversation export without making Drive a realtime database.

## Ubuntu VPS deployment

Recommended: Ubuntu 24.04 LTS, Docker Engine + Docker Compose plugin.

```bash
git clone YOUR_REPO_URL
cd KH-VN-EXCHANGE-BOT
cp .env.example .env
nano .env
docker compose up -d --build
docker compose logs -f app
```

Health endpoint:

```text
http://YOUR_VPS_IP:3000/health
```

For V1 long polling, a domain/Nginx/webhook is not required.

## Data volumes

Docker Compose creates:

- `postgres_data`: database
- `app_data`: original QR and evidence files
- `backups`: database backups

Back these volumes up before upgrades.

## Cursor: recommended first tasks

After opening this repo in Cursor Agent, ask it in this order:

1. `Install dependencies, run prisma generate, typecheck, tests and build. Fix all compatibility issues without changing business rules.`
2. `Implement Admin/CSKH staff invite and granular permission management UI using the existing schema.`
3. `Implement payout bill upload and two-step payout completion flow. Never auto-payout.`
4. `Wire DriveSyncJob so all original evidence is archived to Google Drive with retries.`
5. `Add voice-message handling using AiProvider.transcribeAudio and preserve the original OGG file.`
6. `Add Vietnamese/Khmer/English/Chinese reply localization and CSKH translate-preview-before-send.`
7. `Create real Prisma migrations and replace db push in production startup.`

## Current source layout

```text
src/
  bots/
    customer/
    cskh/
    admin/
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
prisma/
tests/
scripts/
```
