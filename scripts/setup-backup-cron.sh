#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# KH-VN-EXCHANGE-BOT: Setup Backup Cron & Systemd Timer
# ==============================================================================
# Configures automated backup execution every 6 hours on Ubuntu VPS.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-storage.sh"
LOG_DIR="${ROOT_DIR}/logs"
LOG_FILE="${LOG_DIR}/backup.log"

mkdir -p "${LOG_DIR}"
chmod +x "${BACKUP_SCRIPT}"

echo "[*] Setting up automated backup (every 6 hours: 0 */6 * * *)..."

CRON_JOB="0 */6 * * * ${BACKUP_SCRIPT} >> ${LOG_FILE} 2>&1"

# Check if cron job already exists in crontab
if crontab -l 2>/dev/null | grep -q "${BACKUP_SCRIPT}"; then
  echo "[+] Backup cron job is already installed in crontab."
else
  (crontab -l 2>/dev/null || true; echo "${CRON_JOB}") | crontab -
  echo "[+] Cron job successfully added to crontab:"
  echo "    ${CRON_JOB}"
fi

echo ""
echo "================================================================================"
echo "ALTERNATIVE: Systemd Timer Configuration (For Ubuntu VPS systemd service)"
echo "================================================================================"
echo "If you prefer systemd timers over cron, create:"
echo ""
echo "1. /etc/systemd/system/kh-vn-backup.service:"
cat << 'EOF'
[Unit]
Description=KH-VN-EXCHANGE Encrypted Restic Backup Service
After=network.target

[Service]
Type=oneshot
User=root
WorkingDirectory=/opt/kh-vn-exchange-bot
ExecStart=/opt/kh-vn-exchange-bot/scripts/backup-storage.sh
StandardOutput=append:/var/log/kh-vn-backup.log
StandardError=append:/var/log/kh-vn-backup.log
EOF
echo ""
echo "2. /etc/systemd/system/kh-vn-backup.timer:"
cat << 'EOF'
[Unit]
Description=Run KH-VN-EXCHANGE Restic Backup every 6 hours

[Timer]
OnCalendar=*-*-* 00,06,12,18:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
echo ""
echo "Enable systemd timer via:"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now kh-vn-backup.timer"
echo "================================================================================"
