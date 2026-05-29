#!/bin/bash
# ============================================
#  部署: easybook-mirror + 后台管理
#  用法: bash deploy.sh
#  Ubuntu 22.04 / 24.04, root 用户
# ============================================
set -e

echo "========================================"
echo "  Easybook Mirror + 后台管理 部署"
echo "========================================"

# 1. 基础环境
echo "[1/6] 安装系统依赖..."
apt-get update -qq
apt-get install -y -qq curl git nginx

# Node.js 22
command -v node >/dev/null 2>&1 || {
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
}
echo "Node.js: $(node -v)"

# pnpm + pm2
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm
command -v pm2 >/dev/null 2>&1 || npm install -g pm2

# 2. 拉取代码
echo "[2/6] 拉取代码..."
mkdir -p /app

# 后台管理 (已有的 soybean-admin)
cd /app
if [ -d soybean-admin/.git ]; then
  cd /app/soybean-admin && git pull
else
  git clone https://github.com/Rshijituan-baozi/cineplex.git /app/soybean-admin
fi

# 前端镜像
if [ -d /app/easybook-mirror/.git ]; then
  cd /app/easybook-mirror && git pull
else
  git clone https://github.com/Rshijituan-baozi/easybook-mirror.git /app/easybook-mirror
fi

# 3. 安装依赖
echo "[3/6] 构建后台前端..."
cd /app/soybean-admin
pnpm install --no-frozen-lockfile 2>/dev/null || pnpm install
pnpm approve-builds 2>/dev/null || true
pnpm build

echo "  安装后端依赖..."
cd /app/soybean-admin/packages/server
pnpm install --no-frozen-lockfile

echo "  安装前端镜像依赖..."
cd /app/easybook-mirror
npm install

# 4. Nginx 配置
echo "[4/6] 配置 Nginx..."
cat > /etc/nginx/sites-available/easybook << 'NGINX'
# === 后台管理 (IP 直连) ===
server {
    listen 80;
    server_name _;
    root /app/soybean-admin/dist;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
    location /api/ {
        rewrite ^/api/(.*) /$1 break;
        proxy_pass http://127.0.0.1:9528;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s;
    }
}

# === 前端镜像 (域名访问) ===
server {
    listen 80;
    server_name easybookmy.it.com www.easybookmy.it.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }

    location /api/ {
        rewrite ^/api/(.*) /$1 break;
        proxy_pass http://127.0.0.1:9528;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/easybook /etc/nginx/sites-enabled/easybook
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# 5. 启动服务
echo "[5/6] 启动服务..."
pm2 delete all 2>/dev/null || true

pm2 start /app/soybean-admin/packages/server/src/index.ts \
  --name backend \
  --interpreter node \
  --node-args "--import tsx" \
  --cwd /app/soybean-admin/packages/server

pm2 start /app/easybook-mirror/src/index.js \
  --name easybook

pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# 6. 验证
echo "[6/6] 验证服务..."
sleep 3
pm2 status

echo ""
echo "========================================"
echo "  部署完成!"
echo ""
echo "  后台管理: http://$(curl -s ifconfig.me)"
echo "  前端镜像: https://easybookmy.it.com"
echo "  账号: Super / 123456"
echo "========================================"
