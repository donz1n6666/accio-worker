// ---- Cloudflare Bindings ----

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ADMIN_PASSWORD?: string;
  ACCIO_BASE_URL?: string;
  ACCIO_VERSION?: string;
  ACCIO_CALLBACK_HOST?: string;
  ACCIO_CALLBACK_PORT?: string;
}

// ---- Account ----

export interface Account {
  id: string;
  name: string;
  access_token: string;
  refresh_token: string;
  utdid: string;
  fill_priority: number;
  expires_at: number | null;
  cookie: string | null;
  manual_enabled: boolean;
  auto_disabled: boolean;
  auto_disabled_reason: string | null;
  last_quota_check_at: number | null;
  last_remaining_quota: number | null;
  next_quota_check_at: number | null;
  next_quota_check_reason: string | null;
  disabled_models: Record<string, string>;
  added_at: string;
  updated_at: string;
}

// ---- API Key ----

export interface ApiKey {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  rate_limit: number;
  allowed_models: string;
  enabled: boolean;
  last_used_at: string | null;
  total_calls: number;
  created_at: string;
}

// ---- Auth ----

export type AuthType = 'admin' | 'api_key';

export interface AuthResult {
  type: AuthType;
  apiKeyId?: string;
  allowedModels: string; // '*' 或逗号分隔
}

// ---- Settings ----

export interface PanelSettings {
  adminPassword: string;
  apiAccountStrategy: string; // 'round_robin' | 'fill'
  autoDisableOnEmptyQuota: boolean;
  autoEnableOnRecoveredQuota: boolean;
  sessionSecret: string;
}

export const DEFAULT_SETTINGS: PanelSettings = {
  adminPassword: 'admin',
  apiAccountStrategy: 'round_robin',
  autoDisableOnEmptyQuota: true,
  autoEnableOnRecoveredQuota: true,
  sessionSecret: '',
};

// ---- Usage Stats ----

export interface UsageBucket {
  calls: number;
  successCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  lastUsedAt: string;
  lastStopReason: string;
}

// ---- Proxy ----

export interface ProxyAccount {
  id: string;
  name: string;
  access_token: string;
  utdid: string;
  fill_priority: number;
  last_remaining_quota: number | null;
  disabled_models: Record<string, string>;
}

// ---- Model Catalog ----

export interface ModelCatalogEntry {
  provider: string;
  providerDisplayName: string;
  modelName: string;
  modelDisplayName: string;
  group: string;
  multimodal: boolean;
  visible: boolean;
  thinkLevel: string | null;
  contextWindow: number;
  isDefault: boolean;
  tenant: string | null;
  iaiTag: string | null;
  empId: string | null;
  priceApiType: string | null;
}
