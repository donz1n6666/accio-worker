#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Accio Worker — 一键部署脚本
# 自动创建 D1 / KV 资源、写入配置、初始化数据库、部署 Worker
# ============================================================

# ---- 颜色 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ---- 检查前置条件 ----
info "检查前置条件..."

if ! command -v node &>/dev/null; then
  fail "未检测到 Node.js，请先安装: https://nodejs.org/"
fi

if ! command -v npx &>/dev/null; then
  fail "未检测到 npx，请确认 Node.js 安装完整"
fi

# 检查 wrangler
if ! npx wrangler --version &>/dev/null; then
  info "安装 wrangler..."
  npm install -g wrangler
fi

WRANGLER_VERSION=$(npx wrangler --version 2>/dev/null | head -1)
ok "Wrangler: ${WRANGLER_VERSION}"

# 检查是否已登录
if ! npx wrangler whoami &>/dev/null; then
  warn "尚未登录 Cloudflare，正在打开浏览器登录..."
  npx wrangler login
fi

WHOAMI=$(npx wrangler whoami 2>/dev/null | grep -oP '(?<=email:\s).*' || echo "已登录")
ok "Cloudflare 账号: ${WHOAMI}"

echo ""
info "${BOLD}===== 开始部署 Accio Worker =====${NC}"
echo ""

# ---- 1. 安装依赖 ----
info "安装 npm 依赖..."
npm install --silent
ok "依赖安装完成"

# ---- 2. 创建 D1 数据库 ----
D1_DB_NAME="accio-db"
TOML_FILE="wrangler.toml"

# 检查是否已有 D1 数据库
EXISTING_D1_ID=$(npx wrangler d1 list 2>/dev/null | grep -w "${D1_DB_NAME}" | awk '{print $1}' || true)

if [ -n "${EXISTING_D1_ID}" ] && [ "${EXISTING_D1_ID}" != "" ]; then
  ok "D1 数据库已存在: ${D1_DB_NAME} (${EXISTING_D1_ID})"
  D1_ID="${EXISTING_D1_ID}"
else
  info "创建 D1 数据库: ${D1_DB_NAME}"
  D1_OUTPUT=$(npx wrangler d1 create "${D1_DB_NAME}" 2>&1) || fail "D1 创建失败:\n${D1_OUTPUT}"
  D1_ID=$(echo "${D1_OUTPUT}" | grep -oP 'database_id\s*=\s*"\K[^"]+' || echo "")

  if [ -z "${D1_ID}" ]; then
    # 尝试另一种解析方式
    D1_ID=$(echo "${D1_OUTPUT}" | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || echo "")
  fi

  if [ -z "${D1_ID}" ]; then
    echo "${D1_OUTPUT}"
    fail "无法从 wrangler 输出中提取 D1 database_id"
  fi

  ok "D1 数据库已创建: ${D1_ID}"
fi

# ---- 3. 创建 KV 命名空间 ----
KV_TITLE="accio-worker-KV"

EXISTING_KV_ID=$(npx wrangler kv namespace list 2>/dev/null | grep -A1 "\"title\": \"${KV_TITLE}\"" | grep -oP '"id":\s*"\K[^"]+' || true)

if [ -n "${EXISTING_KV_ID}" ] && [ "${EXISTING_KV_ID}" != "" ]; then
  ok "KV 命名空间已存在: ${KV_TITLE} (${EXISTING_KV_ID})"
  KV_ID="${EXISTING_KV_ID}"
else
  info "创建 KV 命名空间: ACCIO_KV"
  KV_OUTPUT=$(npx wrangler kv namespace create "KV" 2>&1) || fail "KV 创建失败:\n${KV_OUTPUT}"
  KV_ID=$(echo "${KV_OUTPUT}" | grep -oP 'id\s*=\s*"\K[^"]+' || echo "")

  if [ -z "${KV_ID}" ]; then
    KV_ID=$(echo "${KV_OUTPUT}" | grep -oP '[0-9a-f]{32}' | head -1 || echo "")
  fi

  if [ -z "${KV_ID}" ]; then
    echo "${KV_OUTPUT}"
    fail "无法从 wrangler 输出中提取 KV namespace id"
  fi

  ok "KV 命名空间已创建: ${KV_ID}"
fi

# ---- 4. 写入 wrangler.toml ----
info "更新 wrangler.toml 配置..."

if grep -q "REPLACE_WITH_YOUR_D1_ID" "${TOML_FILE}"; then
  sed -i "s/REPLACE_WITH_YOUR_D1_ID/${D1_ID}/g" "${TOML_FILE}"
  ok "D1 ID 已写入 wrangler.toml"
else
  warn "wrangler.toml 中 D1 ID 已配置，跳过"
fi

if grep -q "REPLACE_WITH_YOUR_KV_ID" "${TOML_FILE}"; then
  sed -i "s/REPLACE_WITH_YOUR_KV_ID/${KV_ID}/g" "${TOML_FILE}"
  ok "KV ID 已写入 wrangler.toml"
else
  warn "wrangler.toml 中 KV ID 已配置，跳过"
fi

# ---- 5. 初始化数据库 ----
info "初始化 D1 数据库表结构..."
npx wrangler d1 execute "${D1_DB_NAME}" --remote --file=./migrations/0001_init.sql 2>&1 || warn "数据库迁移执行出现警告（如果表已存在可忽略）"
ok "数据库初始化完成"

# ---- 6. 部署 Worker ----
info "部署 Worker 到 Cloudflare..."
DEPLOY_OUTPUT=$(npx wrangler deploy 2>&1) || fail "部署失败:\n${DEPLOY_OUTPUT}"

# 提取 Worker URL
WORKER_URL=$(echo "${DEPLOY_OUTPUT}" | grep -oP 'https://[^\s]+\.workers\.dev' | head -1 || echo "")

ok "Worker 部署完成!"
echo ""

# ---- 7. 完成 ----
echo -e "${BOLD}============================================${NC}"
echo -e "${GREEN}${BOLD}  Accio Worker 部署成功!${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""

if [ -n "${WORKER_URL}" ]; then
  echo -e "  Worker URL:    ${CYAN}${WORKER_URL}${NC}"
fi

echo -e "  管理面板:      ${CYAN}${WORKER_URL:-https://your-worker.workers.dev}/public/index.html${NC}"
echo -e "  默认密码:      ${YELLOW}admin${NC}"
echo ""
echo -e "  ${BOLD}建议立即修改管理员密码:${NC}"
echo -e "    npx wrangler secret put ADMIN_PASSWORD"
echo ""
echo -e "  ${BOLD}或在管理面板 → 设置 中修改${NC}"
echo ""
echo -e "${BOLD}============================================${NC}"
