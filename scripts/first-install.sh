#!/usr/bin/env bash
# =============================================================================
# KH-VN EXCHANGE BOT — first-install helper for beginners (PART W).
#
# What it does:
#   1. copies .env.example → .env (ONLY if .env absent — never overwrites)
#   2. prompts for the REQUIRED bootstrap values (never echoed back)
#   3. generates strong random POSTGRES_PASSWORD / CONFIG_ENCRYPTION_KEY
#   4. sets secure permissions on .env
#   5. hands over to scripts/deploy.sh
#
# Docker itself is NOT installed by this script — if missing, a clear manual
# instruction is printed instead of silently altering the system.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

say()  { printf '%s\n' "$*"; }
fail() { printf '\n❌ %s\n' "$*"; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  say "⚠️  Docker chưa được cài trên máy này."
  say "   Cài Docker (Ubuntu):"
  say "     curl -fsSL https://get.docker.com | sh"
  say "   Sau đó chạy lại: bash scripts/first-install.sh"
  exit 1
fi

if [ -f .env ]; then
  say "ℹ️  .env đã tồn tại — KHÔNG ghi đè."
  say "   Muốn cấu hình lại, sửa .env trực tiếp (không bao giờ in secrets ra màn hình)."
else
  cp .env.example .env
  chmod 600 .env

  prompt_value() {
    # Prompt without echo; validate non-empty; write silently into .env.
    local key="$1" label="$2" val
    while :; do
      printf '%s' "$label: "
      read -rs val
      printf '\n'
      if [ -n "$val" ]; then break; fi
      say "  ⚠️ Không được để trống."
    done
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  }

  say "🔧 Nhập thông tin khởi tạo (giá trị KHÔNG hiển thị lại sau khi nhập):"
  prompt_value "TELEGRAM_BOT_TOKEN" "Telegram BOT_TOKEN (từ @BotFather): "
  prompt_value "SUPER_ADMIN_TELEGRAM_ID" "Telegram ID dạng số của Super Admin: "

  if ! echo "$(grep -E '^SUPER_ADMIN_TELEGRAM_ID=' .env | cut -d= -f2-)" | grep -Eq '^[0-9]{4,20}$'; then
    fail "SUPER_ADMIN_TELEGRAM_ID phải là dãy số (4–20 chữ số). Chạy lại first-install hoặc sửa .env trực tiếp."
  fi

  if ! command -v openssl >/dev/null 2>&1; then
    fail "openssl không tìm thấy (cần để sinh khóa bảo mật). Cài: apt-get install openssl"
  fi
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 32)|" .env
  sed -i "s|^CONFIG_ENCRYPTION_KEY=.*|CONFIG_ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env
fi

chmod 600 .env
say "✅ .env sẵn sàng (quyền 600)."
exec bash scripts/deploy.sh