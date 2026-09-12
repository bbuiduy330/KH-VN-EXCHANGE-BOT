#!/usr/bin/env bash
# =============================================================================
# KH-VN EXCHANGE BOT — one-shot VPS deploy (PART V).
#
# Safe for beginners:
#   - never deletes volumes / database data
#   - never resets git state
#   - never prints secrets
#
# Usage:  bash scripts/deploy.sh
# Requires: .env in the repo root (see scripts/first-install.sh).
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

say()  { printf '%s\n' "$*"; }
fail() { printf '\n❌ %s\n' "$*"; exit 1; }

# 1. Docker + Compose availability
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker không tìm thấy. Cài Docker trước: https://docs.docker.com/engine/install/ubuntu/ — sau đó chạy lại script này."
fi
if ! docker compose version >/dev/null 2>&1; then
  fail "Docker Compose (plugin) không tìm thấy. Cài: apt-get install docker-compose-plugin"
fi
docker compose version >/dev/null 2>&1 || fail "docker compose plugin không hoạt động. Kiểm tra cài đặt Docker Compose v2."

# 2. .env must exist
if [ ! -f .env ]; then
  fail ".env chưa tồn tại. Chạy: bash scripts/first-install.sh  (hoặc tạo .env từ .env.example)"
fi

# 3. Validate REQUIRED bootstrap values (never print the values)
check_required() {
  local key="$1"
  local val
  val="$(grep -E "^${key}=" .env | head -n1 | cut -d= -f2- | tr -d '\"' | tr -d '[:space:]')"
  if [ -z "$val" ]; then
    fail "Biến bắt buộc ${key} đang trống trong .env. Chạy lại: bash scripts/first-install.sh (không ghi đè .env đã có — điền giá trị thủ công)."
  fi
  if [ "$val" = "CHANGE_ME" ]; then
    fail "${key} vẫn là placeholder trong .env. Điền giá trị thật rồi chạy lại."
  fi
}
check_required TELEGRAM_BOT_TOKEN
check_required SUPER_ADMIN_TELEGRAM_ID
check_required POSTGRES_PASSWORD
check_required CONFIG_ENCRYPTION_KEY
# Invalid Super Admin identity (must be numeric — usernames are NOT identity):
SUPER_ADMIN_VAL="$(grep -E '^SUPER_ADMIN_TELEGRAM_ID=' .env | head -n1 | cut -d= -f2- | tr -d '[:space:]')"
if ! echo "$SUPER_ADMIN_VAL" | grep -Eq '^[0-9]{4,20}$'; then
  fail "SUPER_ADMIN_TELEGRAM_ID phải là dãy số Telegram (4–20 chữ số). @username KHÔNG phải identity."
fi

# 4. Git state is NOT destructively reset (nothing is forced/stashed/reset here).

# 5-7. Build image + start postgres
say "🏗  Building app image…"
docker compose build app
say "🐘 Starting PostgreSQL…"
docker compose up -d postgres
say "⏳ Waiting for PostgreSQL health…"
for i in $(seq 1 30); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)" 2>/dev/null)" = "healthy" ]; then
    break
  fi
  [ "$i" = "30" ] && fail "PostgreSQL không healthy sau 30 lần kiểm tra. Diagnostic: docker compose logs postgres"
  sleep 2
done
say "✅ PostgreSQL healthy"

# 8. Migrations: the app container's entrypoint runs `prisma migrate deploy`
#    BEFORE starting the server (authoritative path — no host Node/npm needed).
#    Start the app; if migrations fail the container exits with a clear log.
say "🚀 Starting app (prisma migrate deploy runs inside the container)…"
docker compose up -d app
say "⏳ Waiting for app health…"
APP_CONTAINER="$(docker compose ps -q app)"
for i in $(seq 1 30); do
  st="$(docker inspect -f '{{.State.Health.Status}}' "$APP_CONTAINER" 2>/dev/null || echo starting)"
  if [ "$st" = "healthy" ]; then break; fi
  if [ "$st" = "exited" ]; then
    fail "App container exited — migration/startup failure. Diagnostic: docker compose logs app"
  fi
  [ "$i" = "30" ] && fail "App chưa healthy sau 60s. Diagnostic: docker compose logs app"
  sleep 2
done

# 9-11. Result
say ""
say "✅ PostgreSQL healthy"
say "✅ Migrations applied"
say "✅ Bot app healthy"
say ""
say "🤖 Bot đang chạy. Super Admin (Telegram ID trong .env) mở bot để cấu hình."
say "Logs:    docker compose logs -f app"