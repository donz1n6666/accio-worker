/**
 * 定时额度巡检 (Cron Trigger)
 * 每 5 分钟检查一次所有启用账号的额度
 */

import type { Env, PanelSettings } from '../types';
import { listEnabledAccounts, setAutoDisabled } from '../db/accounts';
import { AccioClient } from './accio-client';
import { pruneOldLogs } from '../db/logs';

/**
 * 从上游额度 API 响应中解析积分值
 * 对齐原 FastAPI 项目的 _build_quota_view + _extract_subscription_entitlement 逻辑
 */
export function parseQuotaFromData(data: Record<string, unknown>): {
  total: number;
  remaining: number;
  used: number;
} {
  // 提取 entitlement（优先 monthly > referral > daily）
  const entitlement = extractSubscriptionEntitlement(data);

  const total = Math.max(0, asInt(data.total, asInt(entitlement.total)));
  let remaining = Math.max(0, asInt(data.remaining, asInt(entitlement.remaining)));
  const used = Math.max(0, asInt(entitlement.used, Math.max(0, total - remaining)));

  let finalTotal = total;
  if (finalTotal <= 0 && (used > 0 || remaining > 0)) {
    finalTotal = used + remaining;
  }

  return { total: finalTotal, remaining, used };
}

function extractSubscriptionEntitlement(data: Record<string, unknown>): Record<string, unknown> {
  const entitlement = data.entitlement;
  if (!entitlement || typeof entitlement !== 'object') return {};

  const ent = entitlement as Record<string, unknown>;
  for (const key of ['monthly', 'referral', 'daily']) {
    const item = ent[key];
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      if (['total', 'used', 'remaining', 'nextBillingDate'].some(
        f => obj[f] !== null && obj[f] !== undefined && obj[f] !== ''
      )) {
        return obj;
      }
    }
  }
  return {};
}

function asInt(value: unknown, defaultValue: number = 0): number {
  if (value === null || value === undefined) return defaultValue;
  const n = Number(value);
  return isNaN(n) ? defaultValue : Math.floor(n);
}

async function getSettings(env: Env): Promise<PanelSettings> {
  try {
    const raw = await env.KV.get('config:settings');
    if (raw) return JSON.parse(raw) as PanelSettings;
  } catch {
    // ignore
  }
  return {
    adminPassword: env.ADMIN_PASSWORD || 'admin',
    apiAccountStrategy: 'round_robin',
    autoDisableOnEmptyQuota: true,
    autoEnableOnRecoveredQuota: true,
    sessionSecret: '',
  };
}

export async function handleScheduledEvent(env: Env): Promise<void> {
  const settings = await getSettings(env);
  const client = new AccioClient({
    baseUrl: env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: env.ACCIO_VERSION || '0.5.6',
  });

  const accounts = await listEnabledAccounts(env.DB);
  if (!accounts.length) return;

  // 并行检查所有账号额度
  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      try {
        const result = await client.queryQuota(account);
        if (!result.success) return;

        const data = result.data as Record<string, unknown> | undefined;
        const quota = parseQuotaFromData(data || {});

        // 更新额度信息（存储原始积分值）
        await env.DB.prepare(
          'UPDATE accounts SET last_quota_check_at = ?, last_remaining_quota = ?, next_quota_check_at = NULL, next_quota_check_reason = NULL, updated_at = ? WHERE id = ?',
        )
          .bind(
            Math.floor(Date.now() / 1000),
            quota.remaining,
            new Date().toISOString().replace('T', ' ').slice(0, 19),
            account.id,
          )
          .run();

        // 额度为 0 且设置了自动禁用
        if (quota.remaining <= 0 && settings.autoDisableOnEmptyQuota) {
          await setAutoDisabled(env.DB, account.id, true, '额度耗尽，已自动禁用。');
        }

        // 额度恢复且设置了自动启用
        if (quota.remaining > 0 && account.auto_disabled && settings.autoEnableOnRecoveredQuota) {
          await setAutoDisabled(env.DB, account.id, false, null);
        }
      } catch {
        // 单个账号失败不影响其他
      }
    }),
  );

  // 清理旧日志（保留 7 天）
  try {
    await pruneOldLogs(env.DB, 7);
  } catch {
    // ignore
  }
}
