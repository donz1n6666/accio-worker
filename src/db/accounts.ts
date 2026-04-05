import type { Account, Env } from '../types';
import {
  generateId,
  newUtdid,
  normalizeTimestamp,
  normalizeFillPriority,
  nowText,
} from '../utils';

// ---- Row Mapping ----

interface AccountRow {
  id: string;
  name: string;
  access_token: string;
  refresh_token: string;
  utdid: string;
  fill_priority: number;
  expires_at: number | null;
  cookie: string | null;
  manual_enabled: number;
  auto_disabled: number;
  auto_disabled_reason: string | null;
  last_quota_check_at: number | null;
  last_remaining_quota: number | null;
  next_quota_check_at: number | null;
  next_quota_check_reason: string | null;
  disabled_models: string;
  added_at: string;
  updated_at: string;
}

function rowToAccount(row: AccountRow): Account {
  let disabledModels: Record<string, string> = {};
  try {
    disabledModels = JSON.parse(row.disabled_models || '{}');
  } catch {
    disabledModels = {};
  }
  return {
    id: row.id,
    name: row.name,
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    utdid: row.utdid,
    fill_priority: row.fill_priority,
    expires_at: row.expires_at,
    cookie: row.cookie,
    manual_enabled: !!row.manual_enabled,
    auto_disabled: !!row.auto_disabled,
    auto_disabled_reason: row.auto_disabled_reason,
    last_quota_check_at: row.last_quota_check_at,
    last_remaining_quota: row.last_remaining_quota,
    next_quota_check_at: row.next_quota_check_at,
    next_quota_check_reason: row.next_quota_check_reason,
    disabled_models: disabledModels,
    added_at: row.added_at,
    updated_at: row.updated_at,
  };
}

function accountToPublicJson(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    name: account.name,
    fillPriority: account.fill_priority,
    expiresAt: account.expires_at,
    manualEnabled: account.manual_enabled,
    autoDisabled: account.auto_disabled,
    autoDisabledReason: account.auto_disabled_reason,
    lastQuotaCheckAt: account.last_quota_check_at,
    lastRemainingQuota: account.last_remaining_quota,
    nextQuotaCheckAt: account.next_quota_check_at,
    nextQuotaCheckReason: account.next_quota_check_reason,
    disabledModels: account.disabled_models,
    addedAt: account.added_at,
    updatedAt: account.updated_at,
  };
}

// ---- CRUD ----

export async function listAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db
    .prepare('SELECT * FROM accounts ORDER BY added_at, name, id')
    .all<AccountRow>();
  return (results || []).map(rowToAccount);
}

export async function getAccount(
  db: D1Database,
  id: string,
): Promise<Account | null> {
  const row = await db
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .bind(id)
    .first<AccountRow>();
  return row ? rowToAccount(row) : null;
}

export async function saveAccount(
  db: D1Database,
  account: Account,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO accounts
       (id, name, access_token, refresh_token, utdid, fill_priority,
        expires_at, cookie, manual_enabled, auto_disabled, auto_disabled_reason,
        last_quota_check_at, last_remaining_quota, next_quota_check_at, next_quota_check_reason,
        disabled_models, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      account.id,
      account.name,
      account.access_token,
      account.refresh_token,
      account.utdid,
      account.fill_priority,
      account.expires_at,
      account.cookie,
      account.manual_enabled ? 1 : 0,
      account.auto_disabled ? 1 : 0,
      account.auto_disabled_reason,
      account.last_quota_check_at,
      account.last_remaining_quota,
      account.next_quota_check_at,
      account.next_quota_check_reason,
      JSON.stringify(account.disabled_models),
      account.added_at,
      account.updated_at,
    )
    .run();
}

export async function deleteAccount(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM accounts WHERE id = ?')
    .bind(id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function updateTokens(
  db: D1Database,
  id: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: unknown,
): Promise<void> {
  await db
    .prepare(
      'UPDATE accounts SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE id = ?',
    )
    .bind(accessToken, refreshToken, normalizeTimestamp(expiresAt), nowText(), id)
    .run();
}

export async function setManualEnabled(
  db: D1Database,
  id: string,
  enabled: boolean,
): Promise<void> {
  await db
    .prepare(
      'UPDATE accounts SET manual_enabled = ?, updated_at = ? WHERE id = ?',
    )
    .bind(enabled ? 1 : 0, nowText(), id)
    .run();
}

export async function setAutoDisabled(
  db: D1Database,
  id: string,
  autoDisabled: boolean,
  reason: string | null,
): Promise<void> {
  await db
    .prepare(
      'UPDATE accounts SET auto_disabled = ?, auto_disabled_reason = ?, updated_at = ? WHERE id = ?',
    )
    .bind(autoDisabled ? 1 : 0, autoDisabled ? reason : null, nowText(), id)
    .run();
}

export async function renameAccount(
  db: D1Database,
  id: string,
  name: string,
): Promise<void> {
  await db
    .prepare('UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?')
    .bind(name, nowText(), id)
    .run();
}

export async function setFillPriority(
  db: D1Database,
  id: string,
  priority: number,
): Promise<void> {
  await db
    .prepare(
      'UPDATE accounts SET fill_priority = ?, updated_at = ? WHERE id = ?',
    )
    .bind(normalizeFillPriority(priority), nowText(), id)
    .run();
}

export async function setDisabledModel(
  db: D1Database,
  id: string,
  modelName: string,
  reason: string,
): Promise<void> {
  const account = await getAccount(db, id);
  if (!account) return;
  const models = { ...account.disabled_models };
  const key = modelName.trim().toLowerCase();
  if (!key) return;
  models[key] = reason;
  await db
    .prepare(
      'UPDATE accounts SET disabled_models = ?, updated_at = ? WHERE id = ?',
    )
    .bind(JSON.stringify(models), nowText(), id)
    .run();
}

export async function clearDisabledModels(
  db: D1Database,
  id: string,
): Promise<void> {
  await db
    .prepare(
      'UPDATE accounts SET disabled_models = ?, updated_at = ? WHERE id = ?',
    )
    .bind('{}', nowText(), id)
    .run();
}

// ---- Enabled Accounts ----

export async function listEnabledAccounts(
  db: D1Database,
): Promise<Account[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM accounts WHERE manual_enabled = 1 AND auto_disabled = 0 ORDER BY fill_priority, name, id',
    )
    .all<AccountRow>();
  return (results || []).map(rowToAccount);
}

// ---- Import (从回调) ----

export async function upsertFromCallback(
  db: D1Database,
  params: {
    accessToken: string;
    refreshToken: string;
    expiresAt: unknown;
    cookie: string | null;
  },
): Promise<{ account: Account; created: boolean }> {
  const now = nowText();

  // 先查找是否有相同 token 的账号
  let existing = await db
    .prepare('SELECT * FROM accounts WHERE access_token = ? LIMIT 1')
    .bind(params.accessToken)
    .first<AccountRow>();

  if (!existing) {
    existing = await db
      .prepare('SELECT * FROM accounts WHERE refresh_token = ? LIMIT 1')
      .bind(params.refreshToken)
      .first<AccountRow>();
  }

  if (existing) {
    const account = rowToAccount(existing);
    account.access_token = params.accessToken;
    account.refresh_token = params.refreshToken;
    account.expires_at = normalizeTimestamp(params.expiresAt);
    account.cookie = params.cookie || account.cookie;
    account.updated_at = now;
    await saveAccount(db, account);
    return { account, created: false };
  }

  // 新建账号
  const nextName = await getNextAccountName(db);
  const account: Account = {
    id: generateId(),
    name: nextName,
    access_token: params.accessToken,
    refresh_token: params.refreshToken,
    utdid: newUtdid(),
    fill_priority: 100,
    expires_at: normalizeTimestamp(params.expiresAt),
    cookie: params.cookie,
    manual_enabled: true,
    auto_disabled: false,
    auto_disabled_reason: null,
    last_quota_check_at: null,
    last_remaining_quota: null,
    next_quota_check_at: null,
    next_quota_check_reason: null,
    disabled_models: {},
    added_at: now,
    updated_at: now,
  };
  await saveAccount(db, account);
  return { account, created: true };
}

async function getNextAccountName(db: D1Database): Promise<string> {
  const { results } = await db
    .prepare("SELECT name FROM accounts WHERE name LIKE '账号%'")
    .all<{ name: string }>();
  let maxIndex = 0;
  for (const row of results || []) {
    const suffix = row.name.slice(2);
    const num = parseInt(suffix, 10);
    if (!isNaN(num) && num > maxIndex) maxIndex = num;
  }
  return `账号${maxIndex + 1}`;
}

// ---- Import (批量) ----

export async function importAccounts(
  db: D1Database,
  payloads: Array<Record<string, unknown>>,
): Promise<{
  createdCount: number;
  updatedCount: number;
  failureCount: number;
  failures: string[];
}> {
  let createdCount = 0;
  let updatedCount = 0;
  const failures: string[] = [];

  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    const name = String(payload.name || payload.名称 || '未命名账号');
    const accessToken = String(payload.accessToken || '');
    const refreshToken = String(payload.refreshToken || '');

    if (!accessToken) {
      failures.push(`第 ${i + 1} 项: 缺少 accessToken`);
      continue;
    }
    if (!refreshToken) {
      failures.push(`第 ${i + 1} 项: 缺少 refreshToken`);
      continue;
    }

    try {
      const { created } = await upsertFromCallback(db, {
        accessToken,
        refreshToken,
        expiresAt: payload.expiresAt,
        cookie: payload.cookie ? String(payload.cookie) : null,
      });

      if (created) {
        // 如果有自定义名称，更新
        if (name && name !== '未命名账号') {
          const accounts = await listAccounts(db);
          const newest = accounts[accounts.length - 1];
          if (newest) await renameAccount(db, newest.id, name);
        }
        createdCount++;
      } else {
        updatedCount++;
      }
    } catch (e) {
      failures.push(`第 ${i + 1} 项: ${String(e)}`);
    }
  }

  return {
    createdCount,
    updatedCount,
    failureCount: failures.length,
    failures,
  };
}

export { accountToPublicJson };
