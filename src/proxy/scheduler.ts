/**
 * 账号调度器
 * 支持 round_robin（轮询）和 fill（优先填充）两种策略
 */

import type { Account, Env, PanelSettings } from '../types';
import { listEnabledAccounts } from '../db/accounts';
import { AccioClient } from '../services/accio-client';

// 全局轮询索引（Workers 每个 isolate 独立，但单次请求内有效）
let roundRobinIndex = 0;

export interface SchedulerResult {
  account: Account;
  quota: Record<string, unknown>;
}

export class ProxySelectionError extends Error {
  constructor(
    public statusCode: number,
    public override message: string,
  ) {
    super(message);
    this.name = 'ProxySelectionError';
  }
}

function isModelDisabledForAccount(
  account: Account,
  modelName: string | null,
): string | null {
  if (!modelName) return null;
  const key = modelName.trim().toLowerCase();
  if (!key) return null;
  return account.disabled_models[key] || null;
}

function filterCandidates(
  accounts: Account[],
  modelName: string | null,
): Account[] {
  return accounts.filter((account) => {
    if (!account.manual_enabled || account.auto_disabled) return false;
    if (modelName && isModelDisabledForAccount(account, modelName)) return false;
    return true;
  });
}

async function checkQuota(
  client: AccioClient,
  account: Account,
): Promise<Record<string, unknown>> {
  try {
    const result = await client.queryQuota(account);
    const data = result.data as Record<string, unknown> | undefined;
    const subscription = data?.currentSubscription as Record<string, unknown> | undefined;

    if (!result.success) {
      return {
        success: false,
        message: String(result.message || '额度查询失败'),
        remaining_value: 0,
        used_value: 0,
      };
    }

    // Extract remaining/used from subscription data
    let remainingValue = 100;
    let usedValue = 0;
    if (subscription) {
      const remaining = subscription.remainingValue ?? subscription.remaining_value;
      const used = subscription.usedValue ?? subscription.used_value;
      if (remaining !== undefined) remainingValue = Number(remaining);
      if (used !== undefined) usedValue = Number(used);
    }

    return {
      success: true,
      message: '',
      remaining_value: remainingValue,
      used_value: usedValue,
    };
  } catch (e) {
    return {
      success: false,
      message: `额度查询异常: ${String(e)}`,
      remaining_value: 0,
      used_value: 0,
    };
  }
}

function fillSortKey(account: Account, quota: Record<string, unknown>): [number, number, string, string] {
  return [
    account.fill_priority,
    Number(quota.remaining_value || 0),
    account.name,
    account.id,
  ];
}

function compareFillSortKey(
  a: [number, number, string, string],
  b: [number, number, string, string],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return a[3] < b[3] ? -1 : 1;
}

/**
 * 选择代理账号
 */
export async function selectProxyAccount(
  env: Env,
  settings: PanelSettings,
  modelName: string | null = null,
): Promise<SchedulerResult> {
  const client = new AccioClient({
    baseUrl: env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: env.ACCIO_VERSION || '0.5.6',
  });

  const allEnabled = await listEnabledAccounts(env.DB);
  const candidates = filterCandidates(allEnabled, modelName);

  if (!candidates.length) {
    throw new ProxySelectionError(
      503,
      modelName
        ? `当前没有已启用账号可用于模型 ${modelName}。`
        : '当前没有已启用的账号可供 API 调用。',
    );
  }

  const errors: string[] = [];
  const strategy = settings.apiAccountStrategy;

  if (strategy === 'fill') {
    // 优先填充: 并行查询所有候选账号额度
    const results = await Promise.allSettled(
      candidates.map(async (account) => {
        const quota = await checkQuota(client, account);
        return { account, quota };
      }),
    );

    const available: Array<{ account: Account; quota: Record<string, unknown> }> = [];

    for (const result of results) {
      if (result.status === 'rejected') {
        errors.push(String(result.reason));
        continue;
      }
      const { account, quota } = result.value;
      if (account.auto_disabled) {
        errors.push(`${account.name}: ${account.auto_disabled_reason || '账号已自动禁用。'}`);
        continue;
      }
      if (!quota.success) {
        errors.push(`${account.name}: ${String(quota.message || '额度查询失败')}`);
        continue;
      }
      if (Number(quota.remaining_value) <= 0) {
        errors.push(`${account.name}: 剩余额度为 0%`);
        continue;
      }
      available.push({ account, quota });
    }

    if (available.length) {
      available.sort((a, b) =>
        compareFillSortKey(
          fillSortKey(a.account, a.quota),
          fillSortKey(b.account, b.quota),
        ),
      );
      return available[0];
    }

    throw new ProxySelectionError(
      503,
      errors[0] || '当前没有可用账号可供 API 调用。',
    );
  }

  // round_robin: 顺序尝试
  const startIndex = roundRobinIndex % candidates.length;
  const indexOrder = Array.from({ length: candidates.length }, (_, i) =>
    (startIndex + i) % candidates.length,
  );

  for (const index of indexOrder) {
    const account = candidates[index];
    const quota = await checkQuota(client, account);

    if (account.auto_disabled) {
      errors.push(`${account.name}: ${account.auto_disabled_reason || '账号已自动禁用。'}`);
      continue;
    }
    if (!quota.success) {
      errors.push(`${account.name}: ${String(quota.message || '额度查询失败')}`);
      continue;
    }
    if (Number(quota.remaining_value) <= 0) {
      errors.push(`${account.name}: 剩余额度为 0%`);
      continue;
    }

    roundRobinIndex = (index + 1) % candidates.length;
    return { account, quota };
  }

  roundRobinIndex = 0;
  throw new ProxySelectionError(
    503,
    errors[0] || '当前没有可用账号可供 API 调用。',
  );
}
