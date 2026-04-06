/**
 * 管理后台 API 路由
 */

import { Hono } from 'hono';
import type { Env, PanelSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { authenticateAdminRequest, getAdminPassword } from '../auth';
import { jsonResponse, asInt } from '../utils';
import {
  listAccounts,
  getAccount,
  deleteAccount,
  renameAccount,
  setManualEnabled,
  setAutoDisabled,
  setFillPriority,
  setDisabledModel,
  clearDisabledModels,
  upsertFromCallback,
  importAccounts,
  accountToPublicJson,
  updateTokens,
} from '../db/accounts';
import {
  listApiKeys,
  getApiKey,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  apiKeyToPublicJson,
} from '../db/api-keys';
import { getSnapshot } from '../db/stats';
import { getRecentLogs } from '../db/logs';
import { AccioClient } from '../services/accio-client';
import { parseQuotaFromData } from '../services/quota-checker';
import { getModelCatalog } from '../services/model-catalog';

const admin = new Hono<{ Bindings: Env }>();

// ---- Auth middleware ----
admin.use('*', async (c, next) => {
  const ok = await authenticateAdminRequest(c);
  if (!ok) {
    return jsonResponse({ success: false, message: '请先输入管理员密码登录' }, 401);
  }
  return next();
});

// ===== 设置 =====

admin.get('/settings', async (c) => {
  let settings: PanelSettings;
  try {
    const raw = await c.env.KV.get('config:settings');
    settings = raw ? JSON.parse(raw) : { ...DEFAULT_SETTINGS };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  // 用实际密码覆盖
  settings.adminPassword = await getAdminPassword(c.env);
  return jsonResponse({ success: true, data: settings });
});

admin.patch('/settings', async (c) => {
  const body = await c.req.json<Partial<PanelSettings>>();
  let existing: PanelSettings;
  try {
    const raw = await c.env.KV.get('config:settings');
    existing = raw ? JSON.parse(raw) : { ...DEFAULT_SETTINGS };
  } catch {
    existing = { ...DEFAULT_SETTINGS };
  }

  if (body.adminPassword !== undefined) existing.adminPassword = body.adminPassword;
  if (body.apiAccountStrategy !== undefined) {
    if (['round_robin', 'fill'].includes(body.apiAccountStrategy)) {
      existing.apiAccountStrategy = body.apiAccountStrategy;
    }
  }
  if (body.autoDisableOnEmptyQuota !== undefined) existing.autoDisableOnEmptyQuota = body.autoDisableOnEmptyQuota;
  if (body.autoEnableOnRecoveredQuota !== undefined) existing.autoEnableOnRecoveredQuota = body.autoEnableOnRecoveredQuota;

  await c.env.KV.put('config:settings', JSON.stringify(existing));
  return jsonResponse({ success: true, data: existing });
});

// ===== 账号 CRUD =====

admin.get('/accounts', async (c) => {
  const accounts = await listAccounts(c.env.DB);
  return jsonResponse({
    success: true,
    data: accounts.map(accountToPublicJson),
  });
});

admin.get('/accounts/:id', async (c) => {
  const account = await getAccount(c.env.DB, c.req.param('id'));
  if (!account) return jsonResponse({ success: false, message: '账号不存在' }, 404);
  return jsonResponse({ success: true, data: accountToPublicJson(account) });
});

admin.delete('/accounts/:id', async (c) => {
  const deleted = await deleteAccount(c.env.DB, c.req.param('id'));
  if (!deleted) return jsonResponse({ success: false, message: '账号不存在' }, 404);
  return jsonResponse({ success: true });
});

admin.patch('/accounts/:id/name', async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) return jsonResponse({ success: false, message: '名称不能为空' }, 400);
  await renameAccount(c.env.DB, c.req.param('id'), name.trim());
  return jsonResponse({ success: true });
});

admin.patch('/accounts/:id/enabled', async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  await setManualEnabled(c.env.DB, c.req.param('id'), !!enabled);
  // 手动启用时清除自动禁用
  if (enabled) {
    await setAutoDisabled(c.env.DB, c.req.param('id'), false, null);
  }
  return jsonResponse({ success: true });
});

admin.patch('/accounts/:id/priority', async (c) => {
  const { priority } = await c.req.json<{ priority: number }>();
  await setFillPriority(c.env.DB, c.req.param('id'), asInt(priority, 100));
  return jsonResponse({ success: true });
});

admin.post('/accounts/:id/disable-model', async (c) => {
  const { model, reason } = await c.req.json<{ model: string; reason: string }>();
  if (!model?.trim()) return jsonResponse({ success: false, message: '模型名称不能为空' }, 400);
  await setDisabledModel(c.env.DB, c.req.param('id'), model.trim(), reason || '手动禁用');
  return jsonResponse({ success: true });
});

admin.post('/accounts/:id/clear-disabled-models', async (c) => {
  await clearDisabledModels(c.env.DB, c.req.param('id'));
  return jsonResponse({ success: true });
});

admin.post('/accounts/:id/refresh-token', async (c) => {
  const account = await getAccount(c.env.DB, c.req.param('id'));
  if (!account) return jsonResponse({ success: false, message: '账号不存在' }, 404);

  const client = new AccioClient({
    baseUrl: c.env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  const result = await client.refreshToken(account);
  if (!result.success) {
    return jsonResponse({ success: false, message: String(result.message || '刷新失败') });
  }

  const data = result.data as Record<string, unknown> | undefined;
  if (data) {
    await updateTokens(
      c.env.DB,
      account.id,
      String(data.accessToken || account.access_token),
      String(data.refreshToken || account.refresh_token),
      data.expiresAt,
    );
  }

  return jsonResponse({ success: true, message: 'Token 已刷新' });
});

// ---- 切换账号（重定向到本地回调地址） ----

admin.get('/accounts/:id/switch', async (c) => {
  const account = await getAccount(c.env.DB, c.req.param('id'));
  if (!account) return jsonResponse({ success: false, message: '账号不存在' }, 404);

  if (!account.access_token) {
    return jsonResponse({ success: false, message: '账号缺少 accessToken' }, 400);
  }

  const callbackHost = c.env.ACCIO_CALLBACK_HOST || '127.0.0.1';
  const callbackPort = c.env.ACCIO_CALLBACK_PORT || '4097';
  const callbackUrl = `http://${callbackHost}:${callbackPort}/auth/callback`;

  const params = new URLSearchParams();
  params.set('accessToken', account.access_token);
  if (account.refresh_token) params.set('refreshToken', account.refresh_token);
  if (account.expires_at !== null) params.set('expiresAt', String(account.expires_at));
  if (account.cookie) params.set('cookie', account.cookie);

  const targetUrl = `${callbackUrl}?${params.toString()}`;
  return c.redirect(targetUrl, 307);
});

admin.post('/accounts/:id/activate', async (c) => {
  const account = await getAccount(c.env.DB, c.req.param('id'));
  if (!account) return jsonResponse({ success: false, message: '账号不存在' }, 404);

  const client = new AccioClient({
    baseUrl: c.env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  const result = await client.activateAccount(account);
  return jsonResponse(result);
});

admin.post('/accounts/:id/check-quota', async (c) => {
  const account = await getAccount(c.env.DB, c.req.param('id'));
  if (!account) return jsonResponse({ success: false, message: '账号不存在' }, 404);

  const client = new AccioClient({
    baseUrl: c.env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  const result = await client.queryQuota(account);
  if (result.success) {
    const data = result.data as Record<string, unknown> | undefined;
    const quota = parseQuotaFromData(data || {});

    // 更新数据库中的额度值
    await c.env.DB.prepare(
      'UPDATE accounts SET last_quota_check_at = ?, last_remaining_quota = ?, updated_at = ? WHERE id = ?',
    ).bind(
      Math.floor(Date.now() / 1000),
      quota.remaining,
      new Date().toISOString().replace('T', ' ').slice(0, 19),
      c.req.param('id'),
    ).run();

    return jsonResponse({
      success: true,
      total: quota.total,
      remaining: quota.remaining,
      used: quota.used,
      remainingText: quota.total > 0 ? `${quota.remaining}/${quota.total}` : String(quota.remaining),
    });
  }
  return jsonResponse(result);
});

// ---- OAuth 回调 ----

admin.post('/accounts/callback', async (c) => {
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

  return jsonResponse({
    success: true,
    created,
    data: accountToPublicJson(account),
  });
});

// ---- 批量导入 ----

admin.post('/accounts/import', async (c) => {
  const body = await c.req.json<{ accounts: Array<Record<string, unknown>> }>();
  if (!Array.isArray(body.accounts) || !body.accounts.length) {
    return jsonResponse({ success: false, message: '请提供账号列表' }, 400);
  }
  const result = await importAccounts(c.env.DB, body.accounts);
  return jsonResponse({ success: true, data: result });
});

// ===== API Key CRUD =====

admin.get('/keys', async (c) => {
  const keys = await listApiKeys(c.env.DB);
  return jsonResponse({
    success: true,
    data: keys.map(apiKeyToPublicJson),
  });
});

admin.post('/keys', async (c) => {
  const body = await c.req.json<{
    name: string;
    rateLimit?: number;
    allowedModels?: string;
  }>();

  if (!body.name?.trim()) {
    return jsonResponse({ success: false, message: '名称不能为空' }, 400);
  }

  const { key, apiKey } = await createApiKey(c.env.DB, {
    name: body.name.trim(),
    rateLimit: body.rateLimit,
    allowedModels: body.allowedModels,
  });

  return jsonResponse({
    success: true,
    data: {
      ...apiKeyToPublicJson(apiKey),
      key, // 仅创建时返回一次原始 key
    },
  });
});

admin.patch('/keys/:id', async (c) => {
  const body = await c.req.json<{
    name?: string;
    rateLimit?: number;
    allowedModels?: string;
    enabled?: boolean;
  }>();

  const updated = await updateApiKey(c.env.DB, c.req.param('id'), body);
  if (!updated) return jsonResponse({ success: false, message: 'API Key 不存在' }, 404);
  return jsonResponse({ success: true });
});

admin.delete('/keys/:id', async (c) => {
  const deleted = await deleteApiKey(c.env.DB, c.req.param('id'));
  if (!deleted) return jsonResponse({ success: false, message: 'API Key 不存在' }, 404);
  return jsonResponse({ success: true });
});

// ===== 统计和日志 =====

admin.get('/stats', async (c) => {
  const accounts = await listAccounts(c.env.DB);
  const accountNames: Record<string, string> = {};
  for (const a of accounts) accountNames[a.id] = a.name;
  const snapshot = await getSnapshot(c.env.DB, accountNames);
  return jsonResponse({ success: true, data: snapshot });
});

admin.get('/logs', async (c) => {
  const limit = asInt(c.req.query('limit'), 200);
  const logs = await getRecentLogs(c.env.DB, Math.min(limit, 1000));
  return jsonResponse({ success: true, data: logs });
});

// ===== 模型目录 =====

admin.get('/models', async (c) => {
  const catalog = await getModelCatalog(c.env);
  return jsonResponse({ success: true, data: catalog });
});

export default admin;
