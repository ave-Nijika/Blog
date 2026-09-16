# 阿里云部署指南

本指南说明如何在阿里云 Linux 服务器上部署博客系统。

> ⚠️ **APP_URL 必须等于实际访问源（协议+域名+端口）**
> 例如：`APP_URL=https://blog.example.com`。若与实际访问源不一致
>（如换端口、走 CDN/反代后域名不匹配），后台登录会**静默 403**
>（登录 Origin 校验为 fail-closed 安全设计）。部署前务必核对。

## 准备工作

### 1. 服务器准备

- **服务器规格**：建议 2 核 4GB 及以上
- **操作系统**：Ubuntu 22.04 LTS 或 CentOS 7+
- **域名准备**：提前准备好域名并解析到服务器 IP

### 2. 安全组配置

在阿里云控制台配置安全组规则：

| 协议 | 端口 | 源地址 | 说明 |
|------|------|--------|------|
| TCP | 22 | 你的 IP | SSH 访问 |
| TCP | 80 | 0.0.0.0/0 | HTTP |
| TCP | 443 | 0.0.0.0/0 | HTTPS |

### 3. 安装 Docker 和 Docker Compose

Ubuntu 22.04 示例：

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装必要依赖
sudo apt install -y curl git

# 安装 Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# 启动 Docker
sudo systemctl start docker
sudo systemctl enable docker

# 安装 Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# 验证安装
docker --version
docker-compose --version
```

### 4. DNS 配置

将域名 A 记录指向服务器公网 IP：

```
blog.yourdomain.com  A  你的服务器IP
```

## 项目部署

### 1. 克隆代码

```bash
# 在服务器上创建项目目录
cd /opt
sudo mkdir -p blog
sudo chown $USER:$USER blog
cd blog

# 克隆代码（替换为你的实际仓库地址）
git clone https://github.com/yourusername/blog.git .
```

### 2. 配置生产环境变量

创建 `.env.production` 文件：

```bash
cp .env.example .env.production
nano .env.production
```

重要配置项：

```bash
# 基本配置
NODE_ENV=production
APP_URL=https://blog.yourdomain.com

# 数据库配置（重要：生成强密码）
POSTGRES_PASSWORD=生成强随机密码

# 安全密钥（必须生成强随机值）
SESSION_SECRET=生成强随机密钥
IP_HASH_SECRET=生成强随机密钥
VISITOR_TOKEN_SECRET=生成强随机密钥

# 管理员登录路径（建议自定义）
ADMIN_LOGIN_PATH=/your-secret-admin-path

# Git 内容仓库（如果使用远程仓库）
CONTENT_REPO_PATH=/app/content
CONTENT_GIT_BRANCH=main
CONTENT_GIT_REMOTE=git@github.com:yourusername/blog-content.git
CONTENT_WEBHOOK_SECRET=生成强随机密钥

# 验证码（可选，使用真实提供商）
CAPTCHA_ENABLED=true
CAPTCHA_PROVIDER=hcaptcha
NEXT_PUBLIC_CAPTCHA_SITE_KEY=你的站点密钥
CAPTCHA_SECRET_KEY=你的私钥
CAPTCHA_EXPECTED_HOSTNAME=blog.yourdomain.com
CAPTCHA_EXPECTED_ACTION=comment

# 日志级别
LOG_LEVEL=info
```

### 3. 初始化 PostgreSQL

```bash
# 启动数据库服务
docker-compose -f docker-compose.prod.yml up -d postgres

# 等待数据库就绪
sleep 10

# 检查数据库状态
docker-compose -f docker-compose.prod.yml exec postgres pg_isready -U bloguser -d blogdb
```

### 4. 构建镜像并执行数据库迁移

> 生产使用 PostgreSQL 版 Prisma schema（`prisma/pg/schema.prisma`）。
> 运行镜像内已包含 prisma CLI、迁移文件与运维脚本（见 Dockerfile），
> 因此以下命令均在容器内直接执行。

```bash
# 构建应用镜像（构建期自动基于 PG schema 生成 Prisma Client）
docker-compose -f docker-compose.prod.yml build app

# 执行迁移（对 postgres:// URL 使用 PG 版 schema）
docker-compose -f docker-compose.prod.yml run --rm app   npx prisma migrate deploy --schema prisma/pg/schema.prisma

# 同步内容到数据库（content/posts → DB 索引）
docker-compose -f docker-compose.prod.yml run --rm app node scripts/sync-content.ts

# 初始化站点资料（可选）
docker-compose -f docker-compose.prod.yml run --rm app node prisma/seed.ts
```

### 5. 创建管理员账户

```bash
# 脚本从环境变量读取用户名密码（无交互、无默认密码）
docker-compose -f docker-compose.prod.yml run --rm   -e ADMIN_USERNAME=admin   -e ADMIN_PASSWORD=your-strong-password   app node scripts/admin-create.ts
```

### 6. 内容 Git 仓库

> 容器启动时 entrypoint 会自动把 /app/content 初始化为 git 仓库
> （幂等：已有 .git 时跳过），后台"保存即 Git 提交"依赖该仓库。

如需从远程内容仓库拉取历史文章：

```bash
# 在 app 容器中关联远程并拉取
docker-compose -f docker-compose.prod.yml run --rm app   sh -c "cd /app/content && git remote add origin <REMOTE_URL> && git pull origin main"

# 同步到数据库
docker-compose -f docker-compose.prod.yml run --rm app node scripts/sync-content.ts
```

### 7. 配置 Git SSH 密钥（如需）

```bash
# 在 app 容器中配置 SSH
docker-compose -f docker-compose.prod.yml run --rm app sh -c "mkdir -p /app/.ssh && chmod 700 /app/.ssh"

# 将你的 SSH 私钥复制到容器
docker cp ~/.ssh/id_rsa $(docker-compose -f docker-compose.prod.yml ps -q app):/app/.ssh/id_rsa
docker-compose -f docker-compose.prod.yml run --rm app sh -c "chmod 600 /app/.ssh/id_rsa"

# 添加 GitHub/GitLab 到 known_hosts
docker-compose -f docker-compose.prod.yml run --rm app sh -c "ssh-keyscan github.com >> /app/.ssh/known_hosts"
```

### 8. Webhook 自动同步（未实现）

> ⚠️ Git Webhook 自动同步当前**未实现**（`/api/admin/webhook` 路由不存在）。
> 内容变更后请手动执行：
> `docker-compose -f docker-compose.prod.yml run --rm app node scripts/sync-content.ts`

### 9. 配置 Nginx SSL 证书

#### 方法一：使用 Certbot（推荐）

```bash
# 安装 Certbot
sudo apt install -y certbot

# 生成证书
sudo certbot certonly --standalone -d blog.yourdomain.com

# 证书位置
# /etc/letsencrypt/live/blog.yourdomain.com/fullchain.pem
# /etc/letsencrypt/live/blog.yourdomain.com/privkey.pem

# 复制证书到项目目录
sudo mkdir -p /opt/blog/nginx/ssl
sudo cp /etc/letsencrypt/live/blog.yourdomain.com/fullchain.pem /opt/blog/nginx/ssl/cert.pem
sudo cp /etc/letsencrypt/live/blog.yourdomain.com/privkey.pem /opt/blog/nginx/ssl/key.pem
sudo chmod 644 /opt/blog/nginx/ssl/*.pem

# 设置自动续期
sudo crontab -e
# 添加：0 3 * * * certbot renew --quiet && cp /etc/letsencrypt/live/blog.yourdomain.com/fullchain.pem /opt/blog/nginx/ssl/cert.pem && cp /etc/letsencrypt/live/blog.yourdomain.com/privkey.pem /opt/blog/nginx/ssl/key.pem && docker-compose -f /opt/blog/docker-compose.prod.yml restart nginx
```

#### 方法二：使用阿里云 SSL 证书

1. 在阿里云控制台申请免费 SSL 证书
2. 下载证书文件（Nginx 格式）
3. 上传到服务器 `/opt/blog/nginx/ssl/` 目录
4. 重命名为 `cert.pem` 和 `key.pem`

### 10. 启动服务

```bash
# 启动所有服务
docker-compose -f docker-compose.prod.yml up -d

# 查看服务状态
docker-compose -f docker-compose.prod.yml ps

# 查看日志
docker-compose -f docker-compose.prod.yml logs -f
```

### 11. 检查健康接口

```bash
# 检查存活接口
curl http://localhost/api/health/live

# 检查就绪接口
curl http://localhost/api/health/ready
```

### 12. 验证部署

访问 `https://blog.yourdomain.com` 确认服务正常运行。

访问 `https://blog.yourdomain.com/your-secret-admin-path` 登录后台。

## 本地生产模式启动口径

> 项目配置了 `output: "standalone"`，`pnpm start`（next start）会警告不匹配。
> 裸机/非 Docker 场景下的生产启动统一使用：
>
> ```bash
> PORT=3000 APP_URL=https://your-domain.com > IP_HASH_SECRET=xxx VISITOR_TOKEN_SECRET=xxx > node .next/standalone/server.js
> ```
>
> 服务器部署仍推荐 Docker Compose（见下文）。

## 日常运维

### 查看日志

```bash
# 查看所有服务日志
docker-compose -f docker-compose.prod.yml logs -f

# 查看特定服务日志
docker-compose -f docker-compose.prod.yml logs -f app
docker-compose -f docker-compose.prod.yml logs -f nginx
docker-compose -f docker-compose.prod.yml logs -f postgres

# 查看最近 100 行日志
docker-compose -f docker-compose.prod.yml logs --tail=100
```

### 更新应用

```bash
# 拉取最新代码
cd /opt/blog
git pull

# 重新构建并启动
docker-compose -f docker-compose.prod.yml build
docker-compose -f docker-compose.prod.yml up -d

# 执行数据库迁移（如有，使用 PG schema）
docker-compose -f docker-compose.prod.yml run --rm app   npx prisma migrate deploy --schema prisma/pg/schema.prisma
```

### 回滚

```bash
# 查看提交历史
git log --oneline

# 回滚到指定版本
git checkout <commit-hash>

# 重新构建并启动
docker-compose -f docker-compose.prod.yml build
docker-compose -f docker-compose.prod.yml up -d
```

### 备份恢复

参考 `docs/backup-restore.md` 进行完整备份恢复流程。

### 重启服务

```bash
# 重启所有服务
docker-compose -f docker-compose.prod.yml restart

# 重启特定服务
docker-compose -f docker-compose.prod.yml restart app
docker-compose -f docker-compose.prod.yml restart nginx
```

## 监控与告警

### 系统监控

```bash
# 查看容器资源使用
docker stats

# 查看磁盘使用
df -h

# 查看内存使用
free -h
```

### 健康检查脚本

创建 `healthcheck.sh`：

```bash
#!/bin/bash
curl -f http://localhost/api/health/live || exit 1
curl -f http://localhost/api/health/ready || exit 1
echo "Health check passed"
```

添加到 crontab 定期检查：

```bash
*/5 * * * * /opt/blog/healthcheck.sh
```

## 安全注意事项

1. **定期更新系统**：`sudo apt update && sudo apt upgrade -y`
2. **更改默认端口**：考虑更改 SSH 端口
3. **使用防火墙**：配置 UFW 或 iptables
4. **定期备份数据**：按照备份文档执行
5. **监控日志**：定期检查异常访问和错误
6. **HTTPS 强制**：确保所有流量都通过 HTTPS
7. **密钥管理**：不要将敏感密钥提交到 Git

## 故障排查

### 应用无法启动

```bash
# 查看详细日志
docker-compose -f docker-compose.prod.yml logs app

# 检查环境变量
docker-compose -f docker-compose.prod.yml config
```

### 数据库连接失败

```bash
# 检查数据库状态
docker-compose -f docker-compose.prod.yml ps postgres

# 进入数据库容器
docker-compose -f docker-compose.prod.yml exec postgres psql -U bloguser -d blogdb
```

### Nginx 配置错误

```bash
# 测试 Nginx 配置
docker-compose -f docker-compose.prod.yml exec nginx nginx -t

# 重载 Nginx
docker-compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

### 证书过期

```bash
# 检查证书有效期
sudo certbot certificates

# 手动续期
sudo certbot renew
```

## 性能优化

1. **启用 Gzip 压缩**：已在 Nginx 配置中启用
2. **静态资源缓存**：Nginx 已配置长期缓存
3. **数据库连接池**：Prisma 默认连接池配置
4. **CDN 加速**：考虑将静态文件部署到 CDN
5. **图片优化**：使用 WebP 格式和适当尺寸