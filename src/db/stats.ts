import { nowText } from '../utils';

export async function recordMessage(
  db: D1Database,
  params: {
    accountId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    success: boolean;
    stopReason?: string;
    apiKeyId?: string;
  },
): Promise<void> {
  const now = nowText();

  // Upsert per-account-model stats
  await db
    .prepare(
      `INSERT INTO usage_stats (account_id, model, calls, success_calls, failed_calls, input_tokens, output_tokens, last_used_at, last_stop_reason)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, model) DO UPDATE SET
         calls = calls + 1,
         success_calls = success_calls + ?,
         failed_calls = failed_calls + ?,
         input_tokens = input_tokens + ?,
         output_tokens = output_tokens + ?,
         last_used_at = ?,
         last_stop_reason = COALESCE(?, last_stop_reason)`,
    )
    .bind(
      params.accountId,
      params.model,
      params.success ? 1 : 0,
      params.success ? 0 : 1,
      params.inputTokens,
      params.outputTokens,
      now,
      params.stopReason || null,
      // ON CONFLICT params
      params.success ? 1 : 0,
      params.success ? 0 : 1,
      params.inputTokens,
      params.outputTokens,
      now,
      params.stopReason || null,
    )
    .run();

  // Update global stats
  const batch = [
    db.prepare("UPDATE global_stats SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'total_calls'"),
    db.prepare(
      `UPDATE global_stats SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ?`,
    ).bind(params.success ? 'success_calls' : 'failed_calls'),
    db.prepare(
      "UPDATE global_stats SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT) WHERE key = 'input_tokens'",
    ).bind(params.inputTokens),
    db.prepare(
      "UPDATE global_stats SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT) WHERE key = 'output_tokens'",
    ).bind(params.outputTokens),
    db.prepare("UPDATE global_stats SET value = ? WHERE key = 'last_used_at'").bind(now),
  ];
  if (params.stopReason) {
    batch.push(
      db.prepare("UPDATE global_stats SET value = ? WHERE key = 'last_stop_reason'").bind(params.stopReason),
    );
  }
  await db.batch(batch);
}

export async function getSnapshot(
  db: D1Database,
  accountNames: Record<string, string>,
): Promise<Record<string, unknown>> {
  // Global stats
  const { results: globalRows } = await db
    .prepare('SELECT key, value FROM global_stats')
    .all<{ key: string; value: string }>();
  const globals: Record<string, string> = {};
  for (const row of globalRows || []) {
    globals[row.key] = row.value;
  }

  // Per-model stats
  const { results: modelRows } = await db
    .prepare(
      `SELECT model,
              SUM(calls) AS calls,
              SUM(success_calls) AS success_calls,
              SUM(failed_calls) AS failed_calls,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              MAX(last_used_at) AS last_used_at
       FROM usage_stats GROUP BY model ORDER BY SUM(calls) DESC`,
    )
    .all<Record<string, unknown>>();

  // Per-account stats
  const { results: accountRows } = await db
    .prepare(
      `SELECT account_id,
              SUM(calls) AS calls,
              SUM(success_calls) AS success_calls,
              SUM(failed_calls) AS failed_calls,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              MAX(last_used_at) AS last_used_at
       FROM usage_stats GROUP BY account_id ORDER BY SUM(calls) DESC`,
    )
    .all<Record<string, unknown>>();

  return {
    totals: {
      calls: parseInt(globals.total_calls || '0', 10),
      successCalls: parseInt(globals.success_calls || '0', 10),
      failedCalls: parseInt(globals.failed_calls || '0', 10),
      inputTokens: parseInt(globals.input_tokens || '0', 10),
      outputTokens: parseInt(globals.output_tokens || '0', 10),
      lastUsedAt: globals.last_used_at || '-',
      lastStopReason: globals.last_stop_reason || '-',
    },
    models: (modelRows || []).map((r) => ({
      name: r.model,
      calls: Number(r.calls || 0),
      successCalls: Number(r.success_calls || 0),
      failedCalls: Number(r.failed_calls || 0),
      inputTokens: Number(r.input_tokens || 0),
      outputTokens: Number(r.output_tokens || 0),
      lastUsedAt: r.last_used_at || '-',
    })),
    accounts: (accountRows || []).map((r) => ({
      id: r.account_id,
      name: accountNames[String(r.account_id)] || `已删除账号 ${String(r.account_id).slice(0, 8)}`,
      calls: Number(r.calls || 0),
      successCalls: Number(r.success_calls || 0),
      failedCalls: Number(r.failed_calls || 0),
      inputTokens: Number(r.input_tokens || 0),
      outputTokens: Number(r.output_tokens || 0),
      lastUsedAt: r.last_used_at || '-',
    })),
  };
}
