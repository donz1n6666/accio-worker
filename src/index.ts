/**
 * Accio Worker — 主入口
 * Cloudflare Workers + Hono 框架
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import adminRoutes from './routes/admin';
import proxyApiRoutes from './routes/proxy-api';
import modelRoutes from './routes/models';
import { handleScheduledEvent } from './services/quota-checker';
import { AccioClient } from './services/accio-client';
import { upsertFromCallback, deleteAccount } from './db/accounts';
import { jsonResponse } from './utils';
// @ts-ignore — Wrangler 将 .html 作为 Text 模块导入
import DASHBOARD_HTML from '../public/index.html';

const app = new Hono<{ Bindings: Env }>();

// ---- CORS ----
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-goog-api-key', 'anthropic-version'],
  exposeHeaders: ['x-accio-account-id', 'x-accio-account-strategy', 'x-accio-account-remaining'],
}));

// ---- 管理面板（根路径） ----
app.get('/', (c) => {
  return new Response(DASHBOARD_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

app.get('/dashboard', (c) => {
  return new Response(DASHBOARD_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

app.get('/health', (c) => jsonResponse({ status: 'ok' }));

// ---- 管理后台 API ----
app.route('/api', adminRoutes);

// ---- 代理 API 路由 ----
app.route('/', proxyApiRoutes);

// ---- 模型列表路由 ----
app.route('/', modelRoutes);

// ---- OAuth 回调页面（返回 HTML） ----
app.get('/oauth/callback', async (c) => {
  return new Response(OAUTH_CALLBACK_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

// ---- OAuth 回调接口 ----
app.post('/oauth/callback', async (c) => {
  const body = await c.req.json<{
    accessToken: string;
    refreshToken: string;
    expiresAt?: unknown;
    cookie?: string;
  }>();

  if (!body.accessToken || !body.refreshToken) {
    return jsonResponse({ success: false, message: '缺少 accessToken 或 refreshToken' }, 400);
  }

  const { account, created } = await upsertFromCallback(c.env.DB, {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresAt: body.expiresAt,
    cookie: body.cookie || null,
  });

  const client = new AccioClient({
    baseUrl: c.env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: c.env.ACCIO_VERSION || '2.3.2',
  });

  // 导入验证：检查能否获取额度
  const quotaResult = await client.queryQuota(account);
  if (!quotaResult.success) {
    // 额度获取失败 → 如果是新建的账号则删除
    if (created) {
      await deleteAccount(c.env.DB, account.id);
    }
    return jsonResponse({
      success: false,
      message: `账号验证失败，无法获取额度: ${String(quotaResult.message || '未知错误')}。${created ? '账号未保存。' : ''}`,
    });
  }

  // 自动激活新账号
  if (created) {
    c.executionCtx.waitUntil(
      client.activateAccount(account).catch(() => {}),
    );
  }

  return jsonResponse({
    success: true,
    created,
    message: created ? '账号已添加、验证通过并开始激活' : '账号 Token 已更新，验证通过',
  });
});

// ---- Login URL 生成 ----
app.get('/api/login-url', async (c) => {
  const callbackUrl = c.req.query('callback_url') || `${new URL(c.req.url).origin}/oauth/callback`;
  const client = new AccioClient({
    baseUrl: c.env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: c.env.ACCIO_VERSION || '2.3.2',
  });
  const url = client.buildLoginUrl(callbackUrl);
  return jsonResponse({ success: true, data: { url } });
});

// ---- 404 ----
app.notFound((c) => {
  return jsonResponse({ error: 'Not Found', path: new URL(c.req.url).pathname }, 404);
});

// ---- Error handler ----
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return jsonResponse(
    { error: 'Internal Server Error', message: err.message },
    500,
  );
});

// ---- Exports ----

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduledEvent(env));
  },
};

// ---- OAuth Callback HTML ----
const OAUTH_CALLBACK_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accio 授权回调</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f5f5; display: flex; justify-content: center; align-items: center;
    min-height: 100vh; padding: 20px; }
  .card { background: #fff; border-radius: 12px; padding: 40px; max-width: 480px;
    width: 100%; box-shadow: 0 2px 12px rgba(0,0,0,.08); text-align: center; }
  h2 { font-size: 20px; margin-bottom: 16px; color: #333; }
  .status { font-size: 14px; color: #666; margin-bottom: 16px; }
  .success { color: #22c55e; }
  .error { color: #ef4444; }
  .spinner { width: 32px; height: 32px; border: 3px solid #e5e7eb;
    border-top: 3px solid #3b82f6; border-radius: 50%;
    animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="card">
  <div class="spinner" id="spinner"></div>
  <h2 id="title">正在处理授权...</h2>
  <p class="status" id="status">请稍候</p>
</div>
<script>
(async function() {
  const title = document.getElementById('title');
  const status = document.getElementById('status');
  const spinner = document.getElementById('spinner');

  try {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace('#', '?'));
    const accessToken = params.get('access_token') || hashParams.get('access_token') || '';
    const refreshToken = params.get('refresh_token') || hashParams.get('refresh_token') || '';
    const expiresAt = params.get('expires_at') || hashParams.get('expires_at') || '';
    const cookie = document.cookie || '';

    if (!accessToken || !refreshToken) {
      throw new Error('未获取到 Token 信息，请重新授权。');
    }

    const response = await fetch('/oauth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken, refreshToken, expiresAt, cookie }),
    });

    const data = await response.json();
    spinner.style.display = 'none';

    if (data.success) {
      title.textContent = '授权成功!';
      status.className = 'status success';
      status.textContent = data.message || '账号已添加';
    } else {
      title.textContent = '授权失败';
      status.className = 'status error';
      status.textContent = data.message || '处理失败';
    }
  } catch (e) {
    spinner.style.display = 'none';
    title.textContent = '授权失败';
    status.className = 'status error';
    status.textContent = e.message || '未知错误';
  }
})();
</script>
</body>
</html>`;
