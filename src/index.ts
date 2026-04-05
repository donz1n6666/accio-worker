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
import { autoMigrate } from './db/migrate';
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

// ---- 自动数据库迁移（首次请求时同步等待完成） ----
app.use('*', async (c, next) => {
  await autoMigrate(c.env.DB, c.env.KV);
  await next();
});

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

// ---- 公开 API（无需认证，必须在 adminRoutes 之前注册） ----

// Login URL 生成（回调地址固定为本机地址，与原 FastAPI 项目保持一致）
const loginLinkHandler = async (c: any) => {
  const callbackHost = c.env.ACCIO_CALLBACK_HOST || '127.0.0.1';
  const callbackPort = c.env.ACCIO_CALLBACK_PORT || '4097';
  const callbackUrl = `http://${callbackHost}:${callbackPort}/auth/callback`;
  const client = new AccioClient({
    baseUrl: c.env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: c.env.ACCIO_VERSION || '0.5.6',
  });
  const url = client.buildLoginUrl(callbackUrl);
  return jsonResponse({ success: true, url, callbackUrl });
};
app.get('/api/login-link', loginLinkHandler);
app.get('/api/login-url', loginLinkHandler);

// OAuth 导入回调地址接口
app.post('/api/oauth/import-callback', async (c) => {
  const body = await c.req.json<{ callbackUrl: string }>();
  if (!body.callbackUrl) {
    return jsonResponse({ success: false, message: '缺少 callbackUrl 参数' }, 400);
  }

  let url: URL;
  try {
    url = new URL(body.callbackUrl);
  } catch {
    return jsonResponse({ success: false, message: 'callbackUrl 格式无效' }, 400);
  }

  const sp = url.searchParams;
  const hashStr = url.hash.startsWith('#') ? url.hash.slice(1) : '';
  const hp = new URLSearchParams(hashStr);

  const accessToken = sp.get('access_token') || sp.get('accessToken') || hp.get('access_token') || hp.get('accessToken') || '';
  const refreshToken = sp.get('refresh_token') || sp.get('refreshToken') || hp.get('refresh_token') || hp.get('refreshToken') || '';
  const expiresAt = sp.get('expires_at') || sp.get('expiresAt') || hp.get('expires_at') || hp.get('expiresAt') || '';

  if (!accessToken || !refreshToken) {
    return jsonResponse({ success: false, message: 'URL 中未找到 accessToken 和 refreshToken 参数' }, 400);
  }

  const { account, created } = await upsertFromCallback(c.env.DB, {
    accessToken,
    refreshToken,
    expiresAt: expiresAt || undefined,
    cookie: null,
  });

  const client = new AccioClient({
    baseUrl: c.env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  const quotaResult = await client.queryQuota(account);
  if (!quotaResult.success) {
    if (created) {
      await deleteAccount(c.env.DB, account.id);
    }
    return jsonResponse({
      success: false,
      message: `账号验证失败，无法获取额度: ${String(quotaResult.message || '未知错误')}。${created ? '账号未保存。' : ''}`,
    });
  }

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

// ---- 管理后台 API（需要认证） ----
app.route('/api', adminRoutes);

// ---- 代理 API 路由 ----
app.route('/', proxyApiRoutes);

// ---- 模型列表路由 ----
app.route('/', modelRoutes);

// ---- OAuth 页面（登录入口 + 回调处理） ----
app.get('/oauth', async (c) => {
  return new Response(OAUTH_CALLBACK_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

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
    version: c.env.ACCIO_VERSION || '0.5.6',
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
<title>Accio OAuth 登录</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:#f0f2f5; color:#333; line-height:1.6; }

  /* 顶部横幅 */
  .hero { background:linear-gradient(135deg,#1e3a5f 0%,#2d6ea3 50%,#4a9bd9 100%);
    color:#fff; padding:48px 24px; text-align:center; }
  .hero h1 { font-size:32px; font-weight:700; margin-bottom:12px; }
  .hero p { font-size:15px; max-width:680px; margin:0 auto 20px; opacity:.9; line-height:1.7; }
  .hero .github-btn { display:inline-flex; align-items:center; gap:8px; background:rgba(255,255,255,.15);
    color:#fff; border:1px solid rgba(255,255,255,.3); padding:8px 20px; border-radius:8px;
    text-decoration:none; font-size:14px; font-weight:500; transition:background .2s; }
  .hero .github-btn:hover { background:rgba(255,255,255,.25); }
  .hero .github-btn svg { width:20px; height:20px; fill:currentColor; }

  /* 主体内容 */
  .main { max-width:1100px; margin:0 auto; padding:32px 20px; }

  /* 回调处理模式 */
  .callback-card { background:#fff; border-radius:12px; padding:40px; max-width:480px;
    margin:0 auto; box-shadow:0 2px 12px rgba(0,0,0,.06); text-align:center; }
  .callback-card h2 { font-size:20px; margin-bottom:16px; }
  .callback-status { font-size:14px; color:#666; margin-bottom:16px; }
  .callback-status.success { color:#22c55e; }
  .callback-status.error { color:#ef4444; }
  .spinner { width:32px; height:32px; border:3px solid #e5e7eb;
    border-top:3px solid #3b82f6; border-radius:50%;
    animation:spin .8s linear infinite; margin:0 auto 16px; }
  @keyframes spin { to { transform:rotate(360deg); } }

  /* 登录操作界面 - 两栏布局 */
  .panels { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
  @media(max-width:768px) { .panels { grid-template-columns:1fr; } }

  .panel { background:#fff; border-radius:12px; padding:28px; box-shadow:0 2px 12px rgba(0,0,0,.06); }
  .panel h2 { font-size:20px; font-weight:700; margin-bottom:8px; color:#1a1a1a; }
  .panel .desc { font-size:13px; color:#666; margin-bottom:20px; line-height:1.6; }

  /* 信息展示区 */
  .info-block { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;
    padding:16px; margin-bottom:16px; font-size:13px; word-break:break-all; }
  .info-label { color:#3b82f6; font-weight:600; margin-bottom:4px; }
  .info-value { color:#1e293b; font-family:monospace; font-size:12px; line-height:1.5; }

  /* 按钮 */
  .btn { display:inline-block; padding:8px 20px; border:none; border-radius:8px;
    cursor:pointer; font-size:14px; font-weight:500; transition:all .2s; text-decoration:none; }
  .btn:hover { opacity:.85; }
  .btn-primary { background:#22c55e; color:#fff; }
  .btn-outline { background:#fff; color:#1e3a5f; border:1px solid #d1d5db; }
  .btn-blue { background:#3b82f6; color:#fff; }
  .btn-group { display:flex; gap:10px; flex-wrap:wrap; margin-top:20px; }

  /* 手动导入区 */
  .import-label { font-size:13px; font-weight:600; color:#333; margin-bottom:8px; }
  .import-textarea { width:100%; min-height:120px; border:1px solid #d1d5db; border-radius:8px;
    padding:12px; font-size:13px; font-family:monospace; resize:vertical; outline:none;
    transition:border-color .2s; }
  .import-textarea:focus { border-color:#3b82f6; }
  .import-textarea::placeholder { color:#9ca3af; }

  /* Toast 提示 */
  .toast { position:fixed; top:20px; left:50%; transform:translateX(-50%);
    background:#333; color:#fff; padding:10px 24px; border-radius:8px; font-size:14px;
    z-index:1000; opacity:0; transition:opacity .3s; pointer-events:none; }
  .toast.show { opacity:1; }

  /* 结果提示 */
  .result-msg { margin-top:12px; padding:10px 14px; border-radius:8px; font-size:13px; display:none; }
  .result-msg.ok { display:block; background:#dcfce7; color:#166534; }
  .result-msg.fail { display:block; background:#fee2e2; color:#991b1b; }
</style>
</head>
<body>

<!-- 顶部横幅 -->
<div class="hero">
  <h1>OAuth 登录</h1>
  <p>这个页面只负责 OAuth 登录和回调导入。若服务部署在服务器上，无法直接收到本机浏览器的 localhost 回调时，可以把浏览器地址栏里的完整回调 URL 粘贴到下面手动导入。</p>
  <a class="github-btn" href="https://github.com/GuJi08233/accio-worker" target="_blank" rel="noopener">
    <svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    GitHub
  </a>
</div>

<!-- 回调处理模式（有 token 参数时显示） -->
<div class="main" id="callback-mode" style="display:none">
  <div class="callback-card">
    <div class="spinner" id="spinner"></div>
    <h2 id="cb-title">正在处理授权...</h2>
    <p class="callback-status" id="cb-status">请稍候</p>
    <div class="btn-group" style="justify-content:center;margin-top:20px" id="cb-actions" hidden>
      <a class="btn btn-outline" href="/oauth/callback">返回登录页</a>
      <a class="btn btn-outline" href="/">返回面板</a>
    </div>
  </div>
</div>

<!-- 登录操作界面（无 token 参数时显示） -->
<div class="main" id="login-mode" style="display:none">
  <div class="panels">

    <!-- 左侧：登录入口 -->
    <div class="panel">
      <h2>登录入口</h2>
      <p class="desc">支持直接跳转到 Accio 登录页，也支持复制登录链接到其他浏览器打开。默认回调仍然使用本地地址，且每次都会生成新的随机 state。</p>

      <div class="info-block">
        <div class="info-label">本地回调地址：</div>
        <div class="info-value" id="callback-url"></div>
      </div>
      <div class="info-block">
        <div class="info-label">登录链接：</div>
        <div class="info-value" id="login-url">加载中...</div>
      </div>

      <div class="btn-group">
        <button class="btn btn-primary" onclick="doLogin()">立即登录</button>
        <button class="btn btn-outline" onclick="copyLoginUrl()">复制登录链接</button>
        <a class="btn btn-outline" href="/">返回面板</a>
      </div>
    </div>

    <!-- 右侧：手动导入回调地址 -->
    <div class="panel">
      <h2>手动导入回调地址</h2>
      <p class="desc">如果浏览器最终跳到了本地回调地址但服务器没有接收到，直接复制地址栏中的完整 URL 粘贴到下方即可。</p>

      <div class="import-label">完整回调 URL</div>
      <textarea class="import-textarea" id="import-url"
        placeholder="例如 http://127.0.0.1:4097/auth/callback?accessToken=...&refreshToken=...&expiresAt=..."></textarea>

      <div class="btn-group">
        <button class="btn btn-blue" onclick="doImport()">导入回调地址</button>
      </div>
      <div class="result-msg" id="import-result"></div>
    </div>

  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
(function() {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace('#', '?'));
  const accessToken = params.get('access_token') || hashParams.get('access_token') || '';
  const refreshToken = params.get('refresh_token') || hashParams.get('refresh_token') || '';

  if (accessToken && refreshToken) {
    // ---- 回调模式：自动处理 ----
    document.getElementById('callback-mode').style.display = 'block';
    handleCallback(accessToken, refreshToken,
      params.get('expires_at') || hashParams.get('expires_at') || '');
  } else {
    // ---- 登录操作界面 ----
    document.getElementById('login-mode').style.display = 'block';
    initLoginMode();
  }

  // ---- 回调处理 ----
  async function handleCallback(at, rt, ea) {
    const title = document.getElementById('cb-title');
    const status = document.getElementById('cb-status');
    const spinner = document.getElementById('spinner');
    const actions = document.getElementById('cb-actions');
    try {
      const resp = await fetch('/oauth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: at, refreshToken: rt, expiresAt: ea, cookie: document.cookie || '' }),
      });
      const data = await resp.json();
      spinner.style.display = 'none';
      actions.hidden = false;
      if (data.success) {
        title.textContent = '授权成功!';
        status.className = 'callback-status success';
        status.textContent = data.message || '账号已添加';
      } else {
        title.textContent = '授权失败';
        status.className = 'callback-status error';
        status.textContent = data.message || '处理失败';
      }
    } catch (e) {
      spinner.style.display = 'none';
      actions.hidden = false;
      title.textContent = '授权失败';
      status.className = 'callback-status error';
      status.textContent = e.message || '未知错误';
    }
  }

  // ---- 登录界面初始化 ----
  let loginUrlStr = '';

  async function initLoginMode() {
    try {
      const r = await fetch('/api/login-link');
      const d = await r.json();
      if (d.success && d.url) {
        loginUrlStr = d.url;
        document.getElementById('login-url').textContent = loginUrlStr;
        document.getElementById('callback-url').textContent = d.callbackUrl || '';
      } else {
        document.getElementById('login-url').textContent = '获取失败，请刷新重试';
      }
    } catch (e) {
      document.getElementById('login-url').textContent = '获取失败: ' + e.message;
    }
  }

  // 立即登录
  window.doLogin = function() {
    if (loginUrlStr) {
      window.location.href = loginUrlStr;
    } else {
      showToast('登录链接尚未加载，请稍候');
    }
  };

  // 复制登录链接
  window.copyLoginUrl = function() {
    if (!loginUrlStr) { showToast('登录链接尚未加载'); return; }
    navigator.clipboard.writeText(loginUrlStr)
      .then(() => showToast('登录链接已复制到剪贴板'))
      .catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = loginUrlStr; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast('登录链接已复制');
      });
  };

  // 手动导入回调地址 — 直接发送完整 URL 给后端解析
  window.doImport = async function() {
    const raw = document.getElementById('import-url').value.trim();
    const result = document.getElementById('import-result');
    if (!raw) { showToast('请粘贴完整的回调 URL'); return; }

    result.className = 'result-msg'; result.style.display = 'block';
    result.style.background = '#f0f9ff'; result.style.color = '#1e40af';
    result.textContent = '正在导入...';

    try {
      const resp = await fetch('/api/oauth/import-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callbackUrl: raw }),
      });
      const data = await resp.json();
      if (data.success) {
        result.className = 'result-msg ok';
        result.textContent = data.message || '导入成功';
      } else {
        result.className = 'result-msg fail';
        result.textContent = data.message || '导入失败';
      }
    } catch (e) {
      result.className = 'result-msg fail';
      result.textContent = '请求失败: ' + e.message;
    }
  };

  // Toast
  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
  }
})();
</script>
</body>
</html>`;
