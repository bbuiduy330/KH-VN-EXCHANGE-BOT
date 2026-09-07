#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# KH-VN-EXCHANGE-BOT: Restic Repository Initializer
# ==============================================================================
# Initializes local or SFTP encrypted restic repository.
# Never logs passwords or secrets.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load .env if present
if [ -f "${ROOT_DIR}/.env" ]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "${ROOT_DIR}/.env" | xargs -0 -d '\n' 2>/dev/null || true)
fi

RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/backup/restic-repo}"
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-${ROOT_DIR}/.restic-password}"

if [ -z "${RESTIC_PASSWORD:-}" ] && [ ! -f "${RESTIC_PASSWORD_FILE}" ]; then
  echo "[-] Error: Neither RESTIC_PASSWORD nor RESTIC_PASSWORD_FILE is configured."
  echo "[-] To generate a secure password file:"
  echo "    openssl rand -base64 32 > ${RESTIC_PASSWORD_FILE}"
  echo "    chmod 600 ${RESTIC_PASSWORD_FILE}"
  exit 1
fi

if [ -f "${RESTIC_PASSWORD_FILE}" ]; then
  # Ensure strict permissions
  chmod 600 "${RESTIC_PASSWORD_FILE}"
  export RESTIC_PASSWORD_FILE
fi

export RESTIC_REPOSITORY

echo "[*] Target Restic Repository: ${RESTIC_REPOSITORY}"

# If local path, ensure parent directory exists
if [[ "${RESTIC_REPOSITORY}" != sftp:* ]] && [[ "${RESTIC_REPOSITORY}" != rest:* ]]; then
  mkdir -p "$(dirname "${RESTIC_REPOSITORY}")"
fi

# Check if repository is already initialized
if restic snapshots >/dev/null 2>&1; then
  echo "[+] Restic repository is already initialized and accessible."
  restic snapshots
  exit 0
fi

echo "[*] Initializing new encrypted Restic repository..."
restic init

echo "[+] Restic repository initialized successfully!"
restic snapshots
