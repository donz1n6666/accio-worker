import type { Context } from 'hono';
import type { Env, AuthResult, PanelSettings } from './types';
import { sha256 } from './utils';

/**
 * 从请求中提取 API Key
 * 支持: x-api-key, x-goog-api-key, Authorization: Bearer, ?key=, ?api_key=
 */
export function extractApiKey(c: Context<{ Bindings: Env }>): string {
  // x-api-key
  const xApiKey = c.req.header('x-api-key')?.trim();
  if (xApiKey) return xApiKey;

  // x-goog-api-key (Gemini 风格)
  const googApiKey = c.req.header('x-goog-api-key')?.trim();
  if (googApiKey) return googApiKey;

  // Authorization: Bearer
  const auth = c.req.header('authorization')?.trim();
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  // URL query: ?key= or ?api_key=
  const url = new URL(c.req.url);
  for (const key of ['key', 'api_key', 'x-api-key']) {
    const val = url.searchParams.get(key);
    if (val) return val.trim();
  }

  return '';
}

/**
 * 获取管理员密码
 */
export async function getAdminPassword(env: Env): Promise<string> {
  // 优先用 secret
  if (env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD;

  // 其次从 KV 读取设置
  try {
    const raw = await env.KV.get('config:settings');
    if (raw) {
      const settings = JSON.parse(raw) as PanelSettings;
      if (settings.adminPassword) return settings.adminPassword;
    }
  } catch {
    // ignore
  }

  return 'admin';
}

/**
 * 认证 API 代理请求
 * 管理员密码或有效 API Key 均可通过
 */
export async function authenticateProxyRequest(
  c: Context<{ Bindings: Env }>,
): Promise<AuthResult | null> {
  const apiKey = extractApiKey(c);
  if (!apiKey) return null;

  // 1. 检查管理员密码
  const adminPassword = await getAdminPassword(c.env);
  if (apiKey === adminPassword) {
    return { type: 'admin', allowedModels: '*' };
  }

  // 2. 查 API Key 表
  const keyHash = await sha256(apiKey);
  const row = await c.env.DB.prepare(
    'SELECT id, allowed_models, enabled FROM api_keys WHERE key_hash = ?',
  )
    .bind(keyHash)
    .first<{ id: string; allowed_models: string; enabled: number }>();

  if (!row || !row.enabled) return null;

  // 异步更新最后使用时间（不阻塞请求）
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      'UPDATE api_keys SET last_used_at = datetime("now"), total_calls = total_calls + 1 WHERE id = ?',
    )
      .bind(row.id)
      .run(),
  );

  return {
    type: 'api_key',
    apiKeyId: row.id,
    allowedModels: row.allowed_models || '*',
  };
}

/**
 * 认证管理后台请求
 * 仅管理员密码可通过
 */
export async function authenticateAdminRequest(
  c: Context<{ Bindings: Env }>,
): Promise<boolean> {
  const apiKey = extractApiKey(c);
  if (!apiKey) return false;

  const adminPassword = await getAdminPassword(c.env);
  return apiKey === adminPassword;
}

/**
 * 检查模型是否在 API Key 的允许范围内
 */
export function isModelAllowed(auth: AuthResult, model: string): boolean {
  if (auth.allowedModels === '*') return true;
  const allowed = auth.allowedModels
    .split(',')
    .map((m) => m.trim().toLowerCase());
  return allowed.includes(model.trim().toLowerCase());
}
