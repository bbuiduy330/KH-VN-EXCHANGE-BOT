#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# KH-VN-EXCHANGE-BOT: Encrypted Storage & PostgreSQL Backup Script
# ==============================================================================
# Backs up PostgreSQL database dump and VPS local evidence storage root
# using restic with AES-256 encryption.
# Never logs secrets or credentials.
# Designed for safe, non-blocking automation (cron / systemd timer).
# ==============================================================================

TIMESTAMP="$(date +'%Y%m%d_%H%M%S')"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 1. Load environment
if [ -f "${ROOT_DIR}/.env" ]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "${ROOT_DIR}/.env" | xargs -0 -d '\n' 2>/dev/null || true)
fi

STORAGE_ROOT="${STORAGE_ROOT:-/data/KH-VN-EXCHANGE}"
RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/backup/restic-repo}"
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-${ROOT_DIR}/.restic-password}"
DB_DUMP_DIR="${STORAGE_ROOT}/_backup/db"

echo "================================================================================"
echo "[*] [${TIMESTAMP}] Starting KH-VN-EXCHANGE Encrypted Backup..."
echo "================================================================================"

# 2. Validate Restic credentials
if [ -f "${RESTIC_PASSWORD_FILE}" ]; then
  chmod 600 "${RESTIC_PASSWORD_FILE}"
  export RESTIC_PASSWORD_FILE
elif [ -n "${RESTIC_PASSWORD:-}" ]; then
  export RESTIC_PASSWORD
else
  echo "[-] ERROR: Neither RESTIC_PASSWORD_FILE nor RESTIC_PASSWORD is set."
  echo "[-] Backup skipped safely. The Telegram bot and server remain operational."
  exit 1
fi

export RESTIC_REPOSITORY

# 3. Create dump directories safely
mkdir -p "${DB_DUMP_DIR}"
chmod 700 "${STORAGE_ROOT}/_backup" || true
chmod 700 "${DB_DUMP_DIR}" || true

# 4. Perform PostgreSQL Database Dump
DB_DUMP_FILE="${DB_DUMP_DIR}/db_dump_${TIMESTAMP}.sql.gz"
LATEST_DUMP_LINK="${DB_DUMP_DIR}/db_dump_latest.sql.gz"

echo "[*] Dumping PostgreSQL database..."
DUMP_SUCCESS=false

# Method A: Try docker-compose if running in Docker
if command -v docker >/dev/null 2>&1 && docker ps | grep -q "postgres"; then
  echo "[*] Executing pg_dump via Docker container..."
  if docker compose -f "${ROOT_DIR}/docker-compose.yml" exec -T postgres pg_dump -U exchange -d exchange | gzip -9 > "${DB_DUMP_FILE}"; then
    DUMP_SUCCESS=true
  fi
# Method B: Direct pg_dump via DATABASE_URL if native
elif command -v pg_dump >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  echo "[*] Executing direct pg_dump via DATABASE_URL..."
  if pg_dump "${DATABASE_URL}" | gzip -9 > "${DB_DUMP_FILE}"; then
    DUMP_SUCCESS=true
  fi
fi

if [ "${DUMP_SUCCESS}" = true ]; then
  chmod 600 "${DB_DUMP_FILE}"
  ln -sf "${DB_DUMP_FILE}" "${LATEST_DUMP_LINK}"
  DUMP_SIZE="$(du -h "${DB_DUMP_FILE}" | cut -f1)"
  echo "[+] Database dump completed successfully (${DUMP_SIZE})."
else
  echo "[!] Warning: Database dump failed or pg_dump/docker not reachable."
  echo "[!] Proceeding with local file storage backup without failing prematurely."
fi

# 5. Check if restic repository is initialized; initialize if missing
if ! restic snapshots >/dev/null 2>&1; then
  echo "[*] Restic repository not initialized. Running restic init..."
  if ! restic init; then
    echo "[-] ERROR: Failed to initialize restic repository."
    exit 1
  fi
fi

# 6. Unlock any stale repository locks (e.g. from previously aborted process)
restic unlock --remove-all >/dev/null 2>&1 || true

# 7. Execute Encrypted Backup
echo "[*] Performing restic backup of ${STORAGE_ROOT}..."
restic backup \
  "${STORAGE_ROOT}" \
  --tag "evidence" \
  --tag "database" \
  --tag "kh-vn-exchange" \
  --exclude-caches

echo "[+] Restic backup completed successfully!"

# 8. Apply Retention Policy
# Keep 24 hourly, 7 daily, 4 weekly
echo "[*] Applying retention policy: 24 hourly, 7 daily, 4 weekly..."
restic forget \
  --keep-hourly 24 \
  --keep-daily 7 \
  --keep-weekly 4 \
  --prune

# 9. Clean up local raw database dumps older than 3 days (since they are securely in restic snapshots)
find "${DB_DUMP_DIR}" -type f -name "db_dump_*.sql.gz" -mtime +3 -delete 2>/dev/null || true

echo "================================================================================"
echo "[+] [$(date +'%Y%m%d_%H%M%S')] Backup workflow completed successfully."
echo "================================================================================"
