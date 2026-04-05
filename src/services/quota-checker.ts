/**
 * 定时额度巡检 (Cron Trigger)
 * 每 5 分钟检查一次所有启用账号的额度
 */

import type { Env, PanelSettings } from '../types';
import { listEnabledAccounts, setAutoDisabled } from '../db/accounts';
import { AccioClient } from './accio-client';
import { pruneOldLogs } from '../db/logs';

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
    version: env.ACCIO_VERSION || '2.3.2',
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
        const subscription = data?.currentSubscription as Record<string, unknown> | undefined;
        const remaining = Number(subscription?.remainingValue ?? subscription?.remaining_value ?? 100);

        // 更新额度信息
        await env.DB.prepare(
          'UPDATE accounts SET last_quota_check_at = ?, last_remaining_quota = ?, next_quota_check_at = NULL, next_quota_check_reason = NULL, updated_at = ? WHERE id = ?',
        )
          .bind(
            Math.floor(Date.now() / 1000),
            remaining,
            new Date().toISOString().replace('T', ' ').slice(0, 19),
            account.id,
          )
          .run();

        // 额度为 0 且设置了自动禁用
        if (remaining <= 0 && settings.autoDisableOnEmptyQuota) {
          await setAutoDisabled(env.DB, account.id, true, '额度耗尽，已自动禁用。');
        }

        // 额度恢复且设置了自动启用
        if (remaining > 0 && account.auto_disabled && settings.autoEnableOnRecoveredQuota) {
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
