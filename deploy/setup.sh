#!/bin/bash
# Run this script on a fresh Ubuntu 22.04 EC2 instance after copying the app files.
# Usage: bash deploy/setup.sh
set -e

echo "==> Installing system packages"
sudo apt update && sudo apt install -y python3-pip python3-venv nginx

echo "==> Setting up Python venv"
cd ~/werewolf
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

echo "==> Installing systemd service"
sudo cp ~/werewolf/deploy/werewolf.service /etc/systemd/system/werewolf.service
sudo systemctl daemon-reload
sudo systemctl enable werewolf
sudo systemctl start werewolf

echo "==> Configuring nginx"
sudo cp ~/werewolf/deploy/nginx.conf /etc/nginx/sites-available/werewolf
sudo ln -sf /etc/nginx/sites-available/werewolf /etc/nginx/sites-enabled/werewolf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

echo ""
echo "==> Done. Verify with:"
echo "    sudo systemctl status werewolf"
echo "    curl http://localhost/"
echo ""
EC2_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "<ec2-public-ip>")
echo "    Game URL: http://$EC2_IP/"
