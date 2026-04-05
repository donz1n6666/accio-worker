/**
 * 自动数据库迁移
 * Worker 首次启动时自动执行建表 SQL，使用 KV 标记避免重复执行
 */

const MIGRATION_VERSION = '1'; // 递增此版本号以触发重新迁移
const KV_KEY = 'db_migration_version';

const MIGRATION_SQL = `
-- 账号表
CREATE TABLE IF NOT EXISTS accounts (
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
);

-- API Key 表
CREATE TABLE IF NOT EXISTS api_keys (
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
);

-- 调用统计 (聚合表，按 account+model 维度)
CREATE TABLE IF NOT EXISTS usage_stats (
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
);

-- 全局统计
CREATE TABLE IF NOT EXISTS global_stats (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '0'
);

-- API 日志表
CREATE TABLE IF NOT EXISTS api_logs (
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
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_stats_account ON usage_stats(account_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_accounts_enabled ON accounts(manual_enabled, auto_disabled);
`;

const SEED_SQL = `
INSERT OR IGNORE INTO global_stats (key, value) VALUES ('total_calls', '0');
INSERT OR IGNORE INTO global_stats (key, value) VALUES ('success_calls', '0');
INSERT OR IGNORE INTO global_stats (key, value) VALUES ('failed_calls', '0');
INSERT OR IGNORE INTO global_stats (key, value) VALUES ('input_tokens', '0');
INSERT OR IGNORE INTO global_stats (key, value) VALUES ('output_tokens', '0');
INSERT OR IGNORE INTO global_stats (key, value) VALUES ('last_used_at', '');
INSERT OR IGNORE INTO global_stats (key, value) VALUES ('last_stop_reason', '');
`;

/**
 * 检查并执行自动迁移
 * 使用 KV 存储迁移版本号，避免每次请求都执行
 * D1 的 exec() 支持一次执行多条 SQL 语句
 */
export async function autoMigrate(db: D1Database, kv: KVNamespace): Promise<void> {
  try {
    // 检查 KV 中的迁移版本
    const currentVersion = await kv.get(KV_KEY);
    if (currentVersion === MIGRATION_VERSION) {
      return; // 已经是最新版本，跳过
    }

    console.log(`[migrate] 执行数据库迁移 v${MIGRATION_VERSION}...`);

    // D1 exec() 支持多语句，一次性执行建表 + 索引
    await db.exec(MIGRATION_SQL);

    // 执行种子数据
    await db.exec(SEED_SQL);

    // 标记迁移完成
    await kv.put(KV_KEY, MIGRATION_VERSION);
    console.log(`[migrate] 数据库迁移 v${MIGRATION_VERSION} 完成`);
  } catch (e) {
    console.error('[migrate] 数据库迁移失败:', e);
    // 不抛出异常，避免阻塞正常请求
    // 下次请求会重试
  }
}
