#!/bin/bash
# ============================================
#  部署: easybook-mirror
#  用法: bash deploy.sh
# ============================================
set -e

APP_DIR="/app/easybook-mirror"
GIT_REPO="https://github.com/Rshijituan-baozi/easybook-mirror.git"

echo "========================================"
echo "  开始部署 Easybook Mirror..."
echo "========================================"

# 1. 基础环境 (如果已装过 Node.js 可跳过)
echo "[1/4] 检查 Node.js..."
command -v node >/dev/null || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -qq nodejs)
echo "Node.js: $(node -v)"

# 2. 拉取代码
echo "[2/4] 拉取代码..."
mkdir -p "$APP_DIR"
cd "$APP_DIR"
if [ -d .git ]; then
  echo "  项目已存在，执行 git pull..."
  git pull
else
  echo "  克隆项目..."
  git clone "$GIT_REPO" .
fi

# 3. 安装依赖
echo "[3/4] 安装依赖..."
npm install

# 4. 启动服务
echo "[4/4] 启动服务..."

# 配置 nginx
cat > /etc/nginx/sites-available/easybook << 'NGINX'
# === Easybook 前端镜像 + 后台管理 ===
server {
    listen 80;
    server_name _;

    # 前端镜像 (easybook-mirror)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # 后台 API + WebSocket (soybean-admin)
    location /api/ {
        proxy_pass http://127.0.0.1:9528;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # 后台管理面板 (soybean-admin dist)
    location /admin/ {
        alias /app/soybean-admin/dist/;
        try_files $uri $uri/ /admin/index.html;
    }
}

# 有域名时使用以下配置
# server {
#     listen 80;
#     server_name easybook.com www.easybook.com;
#
#     location / {
#         proxy_pass http://127.0.0.1:3000;
#         proxy_http_version 1.1;
#         proxy_set_header Upgrade $http_upgrade;
#         proxy_set_header Connection "upgrade";
#         proxy_set_header Host $host;
#     }
#
#     location /api/ {
#         proxy_pass http://127.0.0.1:9528;
#         proxy_http_version 1.1;
#         proxy_set_header Upgrade $http_upgrade;
#         proxy_set_header Connection "upgrade";
#         proxy_set_header Host $host;
#     }
# }
NGINX

ln -sf /etc/nginx/sites-available/easybook /etc/nginx/sites-enabled/easybook
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# 用 pm2 启动
command -v pm2 >/dev/null || npm install -g pm2
pm2 delete easybook-mirror 2>/dev/null || true
pm2 start "$APP_DIR/src/index.js" --name easybook-mirror --node-args="--es-module-specifier-resolution=node"
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "========================================"
echo "  部署完成!"
echo ""
echo "  前端镜像: http://服务器IP/"
echo "  后台管理: http://服务器IP/admin/"
echo "  默认账号: Super / 123456"
echo "========================================"
