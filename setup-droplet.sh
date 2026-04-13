#!/bin/bash
set -e

cd /opt/hemnet-cohort-tracker
echo "=== Pulling latest code ==="
git pull

echo "=== Installing dependencies ==="
npm install glob

echo "=== Configuring env ==="
IP=$(curl -s ifconfig.me)
# Only add if not already present
grep -q VIEW_SERVER_HOST .env || echo "VIEW_SERVER_HOST=$IP" >> .env
grep -q VIEW_SERVER_PORT .env || echo "VIEW_SERVER_PORT=3800" >> .env
echo "Droplet IP: $IP"

echo "=== Setting up systemd service ==="
cat << 'EOF' | sudo tee /etc/systemd/system/view-data-server.service
[Unit]
Description=Cohort View Data Server
After=network.target
[Service]
WorkingDirectory=/opt/hemnet-cohort-tracker
ExecStart=/usr/bin/node view-data-server.js
Restart=always
EnvironmentFile=/opt/hemnet-cohort-tracker/.env
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable view-data-server
sudo systemctl start view-data-server

echo "=== Adding cron entry ==="
(crontab -l 2>/dev/null | grep -v weekly-view-report; echo '30 9 * * 1  cd /opt/hemnet-cohort-tracker && node weekly-view-report.js') | crontab -

echo "=== Running first report ==="
node weekly-view-report.js

echo ""
echo "=== DONE ==="
echo "Visit: http://$IP:3800/"
