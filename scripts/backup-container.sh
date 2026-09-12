#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# KH-VN-EXCHANGE-BOT — CONTAINER-side backup entrypoint (Dockerfile.backup).
# ==============================================================================
# Runs INSIDE the optional `backup` Compose profile (postgres:17-bookworm +
# restic). Mirrors the HOST script's scope and retention policy exactly:
#   - PostgreSQL dump (via pg_isready/pg_dump in this image)
#   - FileEvidence/evidence storage (mounted read-only at /evidence)
#   - restic repository at RESTIC_REPOSITORY, password via RESTIC_PASSWORD_FILE
# Retention (restic forget 24h/7d/4w + prune) is the EXISTING policy from
# scripts/backup-storage.sh — nothing new is introduced.
# Restore remains explicit/manual: scripts/restore-storage.sh (host-side).
# Never logs secrets or credentials.
# ==============================================================================

TIMESTAMP="$(date +'%Y%m%d_%H%M%S')"

PGHOST="${PGHOST:-postgres}"
PGUSER="${PGUSER:-exchange}"
PGDATABASE="${PGDATABASE:-exchange}"

REPOSITORY="${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required (see docker-compose.yml backup service)}"
PASSWORD_FILE="${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required (compose secret)}"

echo "================================================================================"
echo "[*] [${TIMESTAMP}] Starting KH-VN-EXCHANGE container backup..."
echo "================================================================================"

# 1. Validate restic credentials (never printed)
if [ ! -s "${PASSWORD_FILE}" ]; then
  echo "[-] ERROR: RESTIC_PASSWORD_FILE is empty or missing."
  echo "[-] Backup skipped safely. The app remains operational."
  exit 1
fi
chmod 600 "${PASSWORD_FILE}" 2>/dev/null || true
export RESTIC_PASSWORD_FILE
export RESTIC_REPOSITORY="${REPOSITORY}"

# 2. Wait for PostgreSQL readiness (bounded)
echo "[*] Waiting for PostgreSQL (${PGHOST})..."
for i in $(seq 1 30); do
  if pg_isready -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" -q; then
    break
  fi
  if [ "$i" = "30" ]; then
    echo "[-] ERROR: PostgreSQL not ready — backup aborted (app unaffected)."
    exit 1
  fi
  sleep 2
done
echo "[+] PostgreSQL is ready."

# 3. Dump the database into tmpfs (container is read-only; /tmp is writable)
DUMP_FILE="/tmp/db_dump_${TIMESTAMP}.sql.gz"
echo "[*] Dumping PostgreSQL database..."
if ! pg_dump -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" | gzip -9 > "${DUMP_FILE}"; then
  echo "[-] ERROR: pg_dump failed — backup aborted (app unaffected)."
  exit 1
fi
chmod 600 "${DUMP_FILE}"
echo "[+] Database dump completed ($(du -h "${DUMP_FILE}" | cut -f1))."

# 4. Initialize the restic repository if missing (same policy as host script)
if ! restic snapshots >/dev/null 2>&1; then
  echo "[*] Restic repository not initialized. Running restic init..."
  if ! restic init; then
    echo "[-] ERROR: Failed to initialize restic repository."
    exit 1
  fi
fi

# 5. Unlock stale locks (best-effort, same as host script)
restic unlock --remove-all >/dev/null 2>&1 || true

# 6. Encrypted backup: DB dump + evidence storage (/evidence = ./data mount)
echo "[*] Performing restic backup (database dump + /evidence storage)..."
restic backup \
  "${DUMP_FILE}" \
  /evidence \
  --tag "evidence" \
  --tag "database" \
  --tag "kh-vn-exchange" \
  --exclude-caches

echo "[+] Restic backup completed successfully!"

# 7. Retention policy — IDENTICAL to the existing host script
echo "[*] Applying retention policy: 24 hourly, 7 daily, 4 weekly..."
restic forget \
  --keep-hourly 24 \
  --keep-daily 7 \
  --keep-weekly 4 \
  --prune

# 8. Cleanup (dump lives in tmpfs; nothing else is deleted)
rm -f "${DUMP_FILE}"

echo "================================================================================"
echo "[+] [$(date +'%Y%m%d_%H%M%S')] Container backup workflow completed."
echo "================================================================================"