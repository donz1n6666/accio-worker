/**
 * 自动数据库迁移
 * Worker 首次启动时自动执行建表 SQL，使用 KV 标记避免重复执行
 */

const MIGRATION_VERSION = '2';
const KV_KEY = 'db_migration_version';

const MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    utdid TEXT NOT NULL,
    fill_priority INTEGER NOT NULL DEFAULT 100,
    expires_at INTEGER,
    cookie TEXT,
    manual_enabled INTEGER NOT NULL DEFAULT 1,
    auto_disabled INTEGER NOT NULL DEFAULT 0,
    auto_disabled_reason TEXT,
    last_quota_check_at INTEGER,
    last_remaining_quota INTEGER,
    next_quota_check_at INTEGER,
    next_quota_check_reason TEXT,
    disabled_models TEXT NOT NULL DEFAULT '{}',
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    rate_limit INTEGER NOT NULL DEFAULT 0,
    allowed_models TEXT NOT NULL DEFAULT '*',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_used_at TEXT,
    total_calls INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS usage_stats (
    account_id TEXT NOT NULL,
    model TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    success_calls INTEGER NOT NULL DEFAULT 0,
    failed_calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    last_stop_reason TEXT,
    PRIMARY KEY (account_id, model)
  )`,

  `CREATE TABLE IF NOT EXISTS global_stats (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '0'
  )`,

  `CREATE TABLE IF NOT EXISTS api_logs (
    id TEXT PRIMARY KEY,
    level TEXT NOT NULL DEFAULT 'info',
    event TEXT,
    account_name TEXT,
    account_id TEXT,
    model TEXT,
    stream INTEGER NOT NULL DEFAULT 1,
    success INTEGER NOT NULL DEFAULT 0,
    empty_response INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT,
    status_code TEXT,
    message TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    api_key_id TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_stats_account ON usage_stats(account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_enabled ON accounts(manual_enabled, auto_disabled)`,
];

const SEED_STATEMENTS = [
  `INSERT OR IGNORE INTO global_stats (key, value) VALUES ('total_calls', '0')`,
  `INSERT OR IGNORE INTO global_stats (key, value) VALUES ('success_calls', '0')`,
  `INSERT OR IGNORE INTO global_stats (key, value) VALUES ('failed_calls', '0')`,
  `INSERT OR IGNORE INTO global_stats (key, value) VALUES ('input_tokens', '0')`,
  `INSERT OR IGNORE INTO global_stats (key, value) VALUES ('output_tokens', '0')`,
  `INSERT OR IGNORE INTO global_stats (key, value) VALUES ('last_used_at', '')`,
  `INSERT OR IGNORE INTO global_stats (key, value) VALUES ('last_stop_reason', '')`,
];

/**
 * 检查并执行自动迁移
 * 使用 KV 存储迁移版本号，避免每次请求都执行
 */
export async function autoMigrate(db: D1Database, kv: KVNamespace): Promise<void> {
  try {
    const currentVersion = await kv.get(KV_KEY);
    if (currentVersion === MIGRATION_VERSION) {
      return;
    }

    console.log(`[migrate] 执行数据库迁移 v${MIGRATION_VERSION}...`);

    // 使用 batch 批量执行，每条都是独立的 prepared statement
    const batch = [
      ...MIGRATION_STATEMENTS.map(sql => db.prepare(sql)),
      ...SEED_STATEMENTS.map(sql => db.prepare(sql)),
    ];
    await db.batch(batch);

    await kv.put(KV_KEY, MIGRATION_VERSION);
    console.log(`[migrate] 数据库迁移 v${MIGRATION_VERSION} 完成`);
  } catch (e) {
    console.error('[migrate] 数据库迁移失败:', e);
  }
}
