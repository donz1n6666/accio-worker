# Accio Worker

基于 Cloudflare Workers 的 Accio 多账号 API 代理管理面板。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/GuJi08233/accio-worker)

## 功能特性

- **多账号管理** — 添加、启用/禁用、自动额度巡检
- **双层认证** — 管理员密码（全功能）+ API Key（仅模型调用）
- **三格式兼容** — 同时支持 Anthropic / OpenAI / Gemini API 格式
- **流式代理** — SSE 实时流式转换，支持 thinking、tool_use
- **账号调度** — 轮询（round_robin）和优先填充（fill）两种策略
- **统计面板** — 调用次数、Token 用量、按模型/账号维度统计
- **API Key 管理** — 创建/删除 Key，可限制可用模型
- **定时巡检** — Cron Trigger 每 5 分钟检查额度，自动禁用/恢复
- **全球边缘** — Workers 部署，无需额外代理

## 兼容的 API 端点

| 端点 | 格式 | 说明 |
|------|------|------|
| `POST /v1/messages` | Anthropic Messages | Claude 官方格式 |
| `POST /v1/chat/completions` | OpenAI Chat | GPT 兼容格式 |
| `POST /v1/responses` | OpenAI Responses | 新版 Responses API |
| `GET /v1/models` | OpenAI Models | 模型列表 |
| `POST /v1beta/models/{model}:generateContent` | Gemini | Google AI 格式 |
| `POST /v1beta/models/{model}:streamGenerateContent` | Gemini Stream | 流式 |
| `GET /v1beta/models` | Gemini Models | Gemini 模型列表 |

## 快速部署

### 方式一：一键部署按钮

点击上方 **Deploy to Cloudflare Workers** 按钮，按提示操作即可。

### 方式二：脚本部署

```bash
git clone https://github.com/GuJi08233/accio-worker.git
cd accio-worker
bash deploy.sh
```

脚本会自动完成：创建 D1 数据库 → 创建 KV 命名空间 → 写入配置 → 初始化表结构 → 部署 Worker。

### 方式三：手动部署

```bash
# 1. 克隆并安装依赖
git clone https://github.com/GuJi08233/accio-worker.git
cd accio-worker
npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 创建 D1 数据库
npx wrangler d1 create accio-db
# 将输出的 database_id 填入 wrangler.toml

# 4. 创建 KV 命名空间
npx wrangler kv namespace create "KV"
# 将输出的 id 填入 wrangler.toml

# 5. 初始化数据库
npx wrangler d1 execute accio-db --remote --file=./migrations/0001_init.sql

# 6. (可选) 设置管理员密码
npx wrangler secret put ADMIN_PASSWORD

# 7. 部署
npx wrangler deploy
```

### 方式四：GitHub Actions 自动部署

1. Fork 本仓库
2. 在仓库 Settings → Secrets and variables → Actions 中添加：
   - `CLOUDFLARE_API_TOKEN` — [创建 API Token](https://dash.cloudflare.com/profile/api-tokens)（需要 Workers 编辑权限）
   - `CLOUDFLARE_ACCOUNT_ID` — 你的 Cloudflare Account ID
3. 推送到 `main` 或 `master` 分支即自动部署

> **注意：** 首次部署前需手动创建 D1 和 KV 资源（步骤 3-5），之后的代码更新会自动部署。

## 使用方式

### 管理面板

部署后访问 Worker URL 根路径（如 `https://accio-worker.your-name.workers.dev`），输入管理员密码登录。

默认密码：`admin`（请尽快修改）

### API 调用

使用管理员密码或创建的 API Key 作为认证凭据：

```bash
# Anthropic 格式
curl https://your-worker.workers.dev/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# OpenAI 格式
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Gemini 格式
curl https://your-worker.workers.dev/v1beta/models/claude-sonnet-4-6:generateContent \
  -H "x-goog-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "Hello"}]}]
  }'
```

## 配置说明

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ADMIN_PASSWORD` | 管理员密码（建议通过 `wrangler secret` 设置） | `admin` |
| `ACCIO_BASE_URL` | 上游 API 地址 | `https://phoenix-gw.alibaba.com` |
| `ACCIO_VERSION` | 客户端版本号 | `0.5.4` |

### 存储

| 资源 | 类型 | 用途 |
|------|------|------|
| `DB` | D1 (SQLite) | 账号、API Key、统计、日志 |
| `KV` | KV Store | 设置缓存、模型目录缓存 |

## 项目结构

```
accio-worker/
├── wrangler.toml              # Workers 配置
├── deploy.sh                  # 一键部署脚本
├── migrations/
│   └── 0001_init.sql          # D1 表结构
├── public/
│   └── index.html             # 管理面板 SPA
├── src/
│   ├── index.ts               # 入口 + 路由注册
│   ├── types.ts               # TypeScript 类型
│   ├── auth.ts                # 双层认证
│   ├── utils.ts               # 工具函数
│   ├── db/
│   │   ├── accounts.ts        # 账号 CRUD
│   │   ├── api-keys.ts        # API Key CRUD
│   │   ├── stats.ts           # 统计
│   │   └── logs.ts            # 日志
│   ├── proxy/
│   │   ├── upstream.ts        # 上游请求构建
│   │   ├── sse-transform.ts   # SSE 流式转换
│   │   └── scheduler.ts       # 账号调度
│   ├── routes/
│   │   ├── admin.ts           # 管理 API
│   │   ├── proxy-api.ts       # 代理路由
│   │   └── models.ts          # 模型列表
│   └── services/
│       ├── accio-client.ts    # 上游客户端
│       ├── model-catalog.ts   # 模型目录
│       └── quota-checker.ts   # 额度巡检
└── .github/workflows/
    └── deploy.yml             # GitHub Actions
```

## 技术栈

- **Runtime**: Cloudflare Workers
- **Framework**: [Hono](https://hono.dev/)
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **Language**: TypeScript

## License

MIT
