# Accio Worker

基于 Cloudflare Workers 的 Accio 多账号管理与切换面板。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/GuJi08233/accio-worker)

## 功能特性

- **多账号管理** — 添加、启用/禁用、一键切换、自动额度巡检
- **账号切换** — 一键跳转回调地址，快速切换本地登录账号
- **双层认证** — 管理员密码（全功能）+ API Key（仅模型调用）
- **三格式兼容** — 同时支持 Anthropic / OpenAI / Gemini API 格式
- **流式代理** — SSE 实时流式转换，支持 thinking、tool_use
- **账号调度** — 轮询（round_robin）和优先填充（fill）两种策略
- **统计面板** — 调用次数、Token 用量、按模型/账号维度统计
- **API Key 管理** — 创建/删除 Key，可限制可用模型
- **定时巡检** — Cron Trigger 每 5 分钟检查额度，自动禁用/恢复
- **自动建表** — 首次访问自动初始化数据库，一键部署无需手动迁移
- **OAuth 登录** — 支持立即登录、复制登录链接、手动导入回调地址
- **自动化导入** — 提供 `/api/login-url` 和 `/api/oauth/import-callback` 公开接口，方便脚本批量导入
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

## 页面路由

| 路径 | 说明 |
|------|------|
| `/` | 管理面板（需管理员密码登录） |
| `/dashboard` | 管理面板（同上） |
| `/oauth` | OAuth 登录页（立即登录 / 复制链接 / 手动导入回调） |
| `/oauth/callback` | OAuth 回调处理（自动或手动导入） |
| `/health` | 健康检查 |

## 快速部署

### 方式一：一键部署按钮（推荐）

点击上方 **Deploy to Cloudflare Workers** 按钮，在部署页面中：

1. 填写项目名称（默认 `accio-worker`）
2. KV 命名空间 → 选择 **+ 新建**
3. D1 数据库 → 选择 **+ 新建**，命名为 `accio-db`
4. 填写环境变量：
   - `ACCIO_BASE_URL` → `https://phoenix-gw.alibaba.com`
   - `ACCIO_VERSION` → `0.5.6`
   - `ADMIN_PASSWORD` → 你的管理员密码
5. 点击部署

> **数据库表结构会在首次访问时自动创建**，无需手动执行迁移 SQL。

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

# 5. 部署（数据库表会在首次访问时自动创建）
npx wrangler deploy
```

> 也可以手动初始化数据库：`npx wrangler d1 execute accio-db --remote --file=./migrations/0001_init.sql`

### 方式四：GitHub Actions 手动部署

1. Fork 本仓库
2. 在仓库 Settings → Secrets and variables → Actions 中添加：
   - `CLOUDFLARE_API_TOKEN` — [创建 API Token](https://dash.cloudflare.com/profile/api-tokens)（需要 Workers 编辑权限）
   - `CLOUDFLARE_ACCOUNT_ID` — 你的 Cloudflare Account ID
3. 前往 Actions 页面，手动点击 **Run workflow** 触发部署

> **注意：** 首次部署前需手动创建 D1 和 KV 资源（步骤 3-4），之后的代码更新通过 Actions 手动触发部署。

## 使用方式

### 管理面板

部署后访问 Worker URL 根路径（如 `https://accio-worker.your-name.workers.dev`），输入管理员密码登录。

默认密码：`admin`（请尽快在设置中修改）

### 添加账号

- **方式一：** 管理面板点击「+ 添加账号」→ 跳转 OAuth 登录页
- **方式二：** 直接访问 `/oauth` → 立即登录 / 复制登录链接
- **方式三：** 通过自动化脚本批量导入（见下方接口）

### 切换账号

在管理面板的账号列表中点击「切换账号」按钮，将自动携带该账号的 Token 跳转到本地回调地址，完成本地客户端的账号切换。

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

### 自动化导入接口

以下接口无需认证，供自动化脚本批量导入账号：

```python
# 获取登录链接（回调地址固定为本机 http://127.0.0.1:4097/auth/callback）
resp = requests.get(f"{WORKER_URL}/api/login-link")
login_url = resp.json()["url"]
callback_url = resp.json()["callbackUrl"]

# 导入回调地址（将完整回调 URL 发送给后端解析）
resp = requests.post(
    f"{WORKER_URL}/api/oauth/import-callback",
    json={"callbackUrl": "http://127.0.0.1:4097/auth/callback?accessToken=...&refreshToken=..."}
)
print(resp.json())  # {"success": true, "message": "账号已添加、验证通过并开始激活"}
```

> **注意：** `/api/login-link` 和 `/api/login-url` 均可使用，返回格式相同。

## 配置说明

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ADMIN_PASSWORD` | 管理员密码 | `admin` |
| `ACCIO_BASE_URL` | 上游 API 地址 | `https://phoenix-gw.alibaba.com` |
| `ACCIO_VERSION` | 客户端版本号 | `0.5.6` |
| `ACCIO_CALLBACK_HOST` | 本机回调主机（账号切换/导入用） | `127.0.0.1` |
| `ACCIO_CALLBACK_PORT` | 本机回调端口（账号切换/导入用） | `4097` |

### 存储

| 资源 | 类型 | 用途 |
|------|------|------|
| `DB` | D1 (SQLite) | 账号、API Key、统计、日志 |
| `KV` | KV Store | 设置缓存、模型目录缓存、迁移状态 |

## 项目结构

```
accio-worker/
├── wrangler.toml              # Workers 配置
├── deploy.sh                  # 一键部署脚本
├── migrations/
│   └── 0001_init.sql          # D1 表结构（手动迁移用）
├── public/
│   └── index.html             # 管理面板 SPA
├── src/
│   ├── index.ts               # 入口 + 路由注册 + OAuth 页面
│   ├── types.ts               # TypeScript 类型
│   ├── auth.ts                # 双层认证
│   ├── utils.ts               # 工具函数
│   ├── db/
│   │   ├── migrate.ts         # 自动建表迁移
│   │   ├── accounts.ts        # 账号 CRUD
│   │   ├── api-keys.ts        # API Key CRUD
│   │   ├── stats.ts           # 统计
│   │   └── logs.ts            # 日志
│   ├── proxy/
│   │   ├── upstream.ts        # 上游请求构建
│   │   ├── sse-transform.ts   # SSE 流式转换
│   │   └── scheduler.ts       # 账号调度
│   ├── routes/
│   │   ├── admin.ts           # 管理 API（需认证）
│   │   ├── proxy-api.ts       # 代理路由
│   │   └── models.ts          # 模型列表
│   └── services/
│       ├── accio-client.ts    # 上游客户端
│       ├── model-catalog.ts   # 模型目录
│       └── quota-checker.ts   # 额度巡检
└── .github/workflows/
    └── deploy.yml             # GitHub Actions（手动触发）
```

## 技术栈

- **Runtime**: Cloudflare Workers
- **Framework**: [Hono](https://hono.dev/)
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **Language**: TypeScript

## 友情链接

- [LINUX DO](https://linux.do) — 真诚、友善、团结、专业，共建你我引以为荣的社区

## License

MIT
