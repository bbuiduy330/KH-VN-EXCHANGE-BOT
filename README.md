# KH-VN Exchange Bot V1

Telegram-first MVP for a manual-approval currency exchange workflow (USD/VND/KHR) built on Node.js + TypeScript, PostgreSQL, Prisma, Local VPS Evidence Storage, and Encrypted Restic Backups.

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
        │                 │               │
        ▼                 ▼               ▼
   PostgreSQL ◄──── (Source of Truth)
                          │
                          ▼
             VPS Local File Storage
             /data/KH-VN-EXCHANGE/
             (YYYY/MM/ORDER-ID/)
                          │
                          ▼
             Encrypted Backup Engine
             (restic + pg_dump)
             ├── Local: /backup/restic-repo
             └── SFTP:  sftp:user@host:/srv/restic-repo
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
4. **Evidence Immutability**: All original QR codes, customer receipts, payout receipts, voice recordings, and conversation exports are hashed with SHA-256 and preserved permanently in local storage without overwriting historical originals.

## Requirements

- Node.js 22+
- Docker & Docker Compose (recommended for Ubuntu VPS)
- One Telegram Bot token from @BotFather
- PostgreSQL 17 (included via Docker Compose)
- Restic backup utility (`sudo apt install restic`)
- Gemini API key (optional for fallback regex; required for AI exchange parsing, multilingual translation & voice transcription)

## Environment Configuration

Create a `.env` file from `.env.example`:

```env
NODE_ENV=production
PORT=3000

# Unified Telegram Bot Token
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Super Admin & Notifications
SUPER_ADMIN_TELEGRAM_ID=123456789
ADMIN_NOTIFICATION_CHAT_ID=-100123456789

# Database
DATABASE_URL=postgresql://exchange:exchange_change_me@postgres:5432/exchange?schema=public

# Local VPS Storage Root
STORAGE_ROOT=/data/KH-VN-EXCHANGE
DATA_DIR=/data/KH-VN-EXCHANGE

# Encrypted Restic Backup
BACKUP_ENABLED=true
RESTIC_REPOSITORY=/backup/restic-repo
# Or remote SFTP target:
# RESTIC_REPOSITORY=sftp:backupuser@backup-vps.internal:/srv/restic-repo
RESTIC_PASSWORD_FILE=/opt/kh-vn-exchange-bot/.restic-password
BACKUP_SCHEDULE=0 */6 * * *

# Exchange & Quote Config
BASE_FEE_USD=2
QUOTE_EXPIRY_MINUTES=15
TIMEZONE=Asia/Phnom_Penh

# AI Engine (Google Gemini)
GEMINI_API_KEY=
GEMINI_TEXT_MODEL=gemini-2.5-flash
GEMINI_TRANSCRIBE_MODEL=gemini-2.5-flash
```

---

## Local VPS Evidence Storage Architecture

All evidence files, payment instructions, customer and payout receipts, voice messages, conversation logs, and audit trails are persisted locally on the VPS under a configurable `STORAGE_ROOT` (`/data/KH-VN-EXCHANGE`).

### Order Folder Hierarchy

For every order, an idempotent directory structure is maintained:

```text
/data/KH-VN-EXCHANGE/
└── 2026/
    └── 09/
        └── ORD-MTRH31MM-7GKV/
            ├── payment_instruction/
            │   └── payment_qr_v1_USD.jpg
            ├── customer_bill/
            │   └── 1788799580158_71e51db395.jpg
            ├── payout_bill/
            │   └── 1788799590450_98ab71cf23.jpg
            ├── voice/
            ├── images/
            ├── documents/
            ├── order.json
            ├── customer.json
            ├── conversation.json
            ├── conversation.txt
            └── audit.json
```

### Safe Path Validation & Security

- **Path Traversal Prevention**: Every incoming path is validated against `STORAGE_ROOT`. Relative path escapes (`../`, `..\`, null bytes `\0`) are strictly rejected with an exception.
- **Original File Preservation**: Evidence files are named with `${timestamp}_${sha256_prefix}.${ext}` and given restricted permissions (`0600`). Originals are never overwritten.
- **Full Metadata Synchronization**:
  - `order.json`: Complete snapshot of currency pair, exchange rate, amounts, status transitions, and admin verifiers.
  - `customer.json`: Customer Telegram ID, username, and registration details.
  - `conversation.txt`: Formatted chronological chat transcript with clear tags (`CUSTOMER`, `AI`, `BOT`, `CSKH`, `ADMIN`, `SYSTEM`, and `INTERNAL NOTE`).
  - `conversation.json`: Raw messages and notes payload.
  - `audit.json`: Complete timeline of security and state transition audit logs for the order.

---

## Encrypted Backups with Restic

Backups are executed independently from the Telegram bot via shell scripts using `restic` with authenticated AES-256 encryption.

### 1. Initialize Restic Repository

Create a secure password file (permission `600`):
```bash
openssl rand -base64 32 > .restic-password
chmod 600 .restic-password
```

Initialize local or SFTP repository:
```bash
./scripts/init-restic.sh
```

### 2. Manual Backup Execution

```bash
./scripts/backup-storage.sh
```

What `backup-storage.sh` does:
1. Performs a compressed database dump (`pg_dump ... | gzip -9`) to `/data/KH-VN-EXCHANGE/_backup/db/`.
2. Automatically clears any stale repository locks (`restic unlock --remove-all`).
3. Runs `restic backup /data/KH-VN-EXCHANGE` with tags `evidence`, `database`, and `kh-vn-exchange`.
4. Enforces the snapshot retention policy:
   - **Keep 24 hourly snapshots**
   - **Keep 7 daily snapshots**
   - **Keep 4 weekly snapshots**
   - Runs `restic prune` to reclaim space.
5. Fails safely without halting the bot or web server.

### 3. Automated Backup (Every 6 Hours)

Configure the automated cron job:
```bash
./scripts/setup-backup-cron.sh
```
Or create an Ubuntu `systemd` service and timer (`kh-vn-backup.timer`) as detailed in `scripts/setup-backup-cron.sh`.

### 4. Disaster Recovery & Restore

List available snapshots:
```bash
./scripts/restore-storage.sh list
```

Restore the latest snapshot to the storage directory:
```bash
./scripts/restore-storage.sh restore latest /data/KH-VN-EXCHANGE
```

Restore database from the restored dump:
```bash
gunzip -c /data/KH-VN-EXCHANGE/_backup/db/db_dump_latest.sql.gz | docker compose exec -T postgres psql -U exchange -d exchange
```

---

## Remote SFTP Backup Target (Optional)

To stream encrypted backups directly to an off-site VPS over SFTP:

1. Setup an SSH key for the backup user:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/id_restic_backup -N ""
   ssh-copy-id -i ~/.ssh/id_restic_backup.pub backupuser@remote-vps.com
   ```
2. In `.env`:
   ```env
   RESTIC_REPOSITORY=sftp:backupuser@remote-vps.com:/srv/restic-repo
   RESTIC_PASSWORD_FILE=/opt/kh-vn-exchange-bot/.restic-password
   ```
3. Run `./scripts/init-restic.sh` to initialize the remote repository.

---

## Setup & Local Development

```bash
cp .env.example .env
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

---

## Ubuntu VPS Deployment with Docker Compose

```bash
git clone YOUR_REPO_URL
cd KH-VN-EXCHANGE-BOT
cp .env.example .env
nano .env

# Create restic password file
openssl rand -base64 32 > .restic-password
chmod 600 .restic-password

# Start containers
docker compose up -d --build
docker compose logs -f app

# Initialize restic repo and cron
./scripts/init-restic.sh
./scripts/setup-backup-cron.sh
```

### Persistent Docker Volumes
- `postgres_data`: PostgreSQL database storage (`/var/lib/postgresql/data`)
- `storage_data`: Local evidence files and metadata (`/data/KH-VN-EXCHANGE`)
- `backup_data`: Local encrypted Restic repository (`/backup/restic-repo`)

### Health Check Endpoint
```bash
curl http://localhost:3000/health
```
Response:
```json
{
  "status": "ok",
  "database": "ok",
  "storage": {
    "configured": true,
    "writable": true
  },
  "integrations": {
    "gemini": true,
    "telegramBot": true
  }
}
```

---

## Telegram Bot Operational Commands

### Customer Commands
- `/start`: Open Customer Menu (`💱 Đổi tiền`, `📦 Đơn của tôi`, `💬 Hỗ trợ`, `🏦 Tài khoản`).
- `/bank <TIỀN_TỆ>|<NGÂN_HÀNG>|<TÊN_CHỦ_TK>|<SỐ_TK>`: Set receiving bank account.

### CSKH Commands
- `/tickets`: View active tickets & waiting queues.
- `/claim <ID_Khách>`: Take over ticket (switches to `HUMAN` mode).
- `/release <ID_Khách>`: Return ticket to `AUTO` AI mode.
- `/msg <ID_Khách> <Nội dung>`: Reply directly to customer through the bot.
- `/note <ID_Khách> <Nội dung>`: Add internal operator note.
- `/history <ID_Khách>`: View conversation history & internal notes.

### Admin & Super Admin Commands
- `/pending`: View waiting payment confirmations and payouts.
- `/rates`: View exchange rate table and margins.
- `/setrate <CẶP> <GIÁ_GỐC> [MARGIN]`: Update exchange rate.
- `/accounts`: View receiving accounts and bank QR codes.
- `/staff`: Manage staff members and permissions.
- `/storage <orderId>`: Inspect order folder on VPS (`order.json`, `customer.json`, `conversation.txt`, `audit.json`, bills, QR).
- `/audit`: View real-time security audit logs.
