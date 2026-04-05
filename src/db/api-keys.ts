import type { ApiKey } from '../types';
import { generateId, generateApiKey, sha256, nowText } from '../utils';

interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  rate_limit: number;
  allowed_models: string;
  enabled: number;
  last_used_at: string | null;
  total_calls: number;
  created_at: string;
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key_hash: row.key_hash,
    key_prefix: row.key_prefix,
    rate_limit: row.rate_limit,
    allowed_models: row.allowed_models,
    enabled: !!row.enabled,
    last_used_at: row.last_used_at,
    total_calls: row.total_calls,
    created_at: row.created_at,
  };
}

function apiKeyToPublicJson(key: ApiKey): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.key_prefix,
    rateLimit: key.rate_limit,
    allowedModels: key.allowed_models,
    enabled: key.enabled,
    lastUsedAt: key.last_used_at,
    totalCalls: key.total_calls,
    createdAt: key.created_at,
  };
}

// ---- CRUD ----

export async function listApiKeys(db: D1Database): Promise<ApiKey[]> {
  const { results } = await db
    .prepare('SELECT * FROM api_keys ORDER BY created_at DESC')
    .all<ApiKeyRow>();
  return (results || []).map(rowToApiKey);
}

export async function getApiKey(
  db: D1Database,
  id: string,
): Promise<ApiKey | null> {
  const row = await db
    .prepare('SELECT * FROM api_keys WHERE id = ?')
    .bind(id)
    .first<ApiKeyRow>();
  return row ? rowToApiKey(row) : null;
}

/**
 * 创建 API Key
 * 返回原始 key（仅此一次）和 key 元数据
 */
export async function createApiKey(
  db: D1Database,
  params: {
    name: string;
    rateLimit?: number;
    allowedModels?: string;
  },
): Promise<{ key: string; apiKey: ApiKey }> {
  const id = generateId();
  const rawKey = generateApiKey();
  const keyHash = await sha256(rawKey);
  const keyPrefix = rawKey.slice(0, 16) + '...';
  const now = nowText();

  const apiKey: ApiKey = {
    id,
    name: params.name || '未命名 Key',
    key_hash: keyHash,
    key_prefix: keyPrefix,
    rate_limit: params.rateLimit || 0,
    allowed_models: params.allowedModels || '*',
    enabled: true,
    last_used_at: null,
    total_calls: 0,
    created_at: now,
  };

  await db
    .prepare(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, rate_limit, allowed_models, enabled, total_calls, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`,
    )
    .bind(
      apiKey.id,
      apiKey.name,
      apiKey.key_hash,
      apiKey.key_prefix,
      apiKey.rate_limit,
      apiKey.allowed_models,
      apiKey.created_at,
    )
    .run();

  return { key: rawKey, apiKey };
}

export async function updateApiKey(
  db: D1Database,
  id: string,
  updates: {
    name?: string;
    rateLimit?: number;
    allowedModels?: string;
    enabled?: boolean;
  },
): Promise<boolean> {
  const existing = await getApiKey(db, id);
  if (!existing) return false;

  const name = updates.name ?? existing.name;
  const rateLimit = updates.rateLimit ?? existing.rate_limit;
  const allowedModels = updates.allowedModels ?? existing.allowed_models;
  const enabled = updates.enabled ?? existing.enabled;

  await db
    .prepare(
      'UPDATE api_keys SET name = ?, rate_limit = ?, allowed_models = ?, enabled = ? WHERE id = ?',
    )
    .bind(name, rateLimit, allowedModels, enabled ? 1 : 0, id)
    .run();

  return true;
}

export async function deleteApiKey(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM api_keys WHERE id = ?')
    .bind(id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export { apiKeyToPublicJson };
