#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# KH-VN-EXCHANGE-BOT: Encrypted Storage & Database Restore Script
# ==============================================================================
# Restores files and database dump from restic encrypted repository.
# Never logs secrets or credentials.
# ==============================================================================

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

if [ -f "${RESTIC_PASSWORD_FILE}" ]; then
  chmod 600 "${RESTIC_PASSWORD_FILE}"
  export RESTIC_PASSWORD_FILE
elif [ -n "${RESTIC_PASSWORD:-}" ]; then
  export RESTIC_PASSWORD
else
  echo "[-] ERROR: Neither RESTIC_PASSWORD_FILE nor RESTIC_PASSWORD is configured."
  exit 1
fi

export RESTIC_REPOSITORY

# Unlock repository if locked
restic unlock --remove-all >/dev/null 2>&1 || true

# Parse command line arguments
ACTION="${1:-list}"
SNAPSHOT_ID="${2:-latest}"
RESTORE_TARGET="${3:-${STORAGE_ROOT}}"

case "${ACTION}" in
  list)
    echo "================================================================================"
    echo "[*] Available Restic Snapshots in ${RESTIC_REPOSITORY}:"
    echo "================================================================================"
    restic snapshots
    echo ""
    echo "Usage to restore:"
    echo "  $0 restore [snapshot_id|latest] [/target/directory]"
    echo "  Example:"
    echo "  $0 restore latest /data/KH-VN-EXCHANGE"
    ;;

  restore)
    echo "================================================================================"
    echo "[*] Restoring Snapshot '${SNAPSHOT_ID}' to '${RESTORE_TARGET}'..."
    echo "================================================================================"

    mkdir -p "${RESTORE_TARGET}"
    restic restore "${SNAPSHOT_ID}" --target "${RESTORE_TARGET}"

    echo "[+] Snapshot files restored successfully to ${RESTORE_TARGET}."
    echo ""
    echo "================================================================================"
    echo "DATABASE RESTORE INSTRUCTIONS"
    echo "================================================================================"
    echo "A database dump was also restored under:"
    echo "  ${RESTORE_TARGET}/_backup/db/"
    echo ""
    echo "To inspect available dumps:"
    echo "  ls -la ${RESTORE_TARGET}/_backup/db/"
    echo ""
    echo "To restore into PostgreSQL (Docker container):"
    echo "  docker compose exec -T postgres dropdb -U exchange exchange --if-exists"
    echo "  docker compose exec -T postgres createdb -U exchange exchange"
    echo "  gunzip -c ${RESTORE_TARGET}/_backup/db/db_dump_latest.sql.gz | docker compose exec -T postgres psql -U exchange -d exchange"
    echo ""
    echo "To restore into native PostgreSQL via DATABASE_URL:"
    echo "  gunzip -c ${RESTORE_TARGET}/_backup/db/db_dump_latest.sql.gz | psql \"\${DATABASE_URL}\""
    echo "================================================================================"
    ;;

  *)
    echo "[-] Unknown command: ${ACTION}"
    echo "Usage: $0 {list|restore} [snapshot_id] [target_path]"
    exit 1
    ;;
esac
