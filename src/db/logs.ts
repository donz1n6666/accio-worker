import { generateId, nowText } from '../utils';

export async function recordLog(
  db: D1Database,
  payload: Record<string, unknown>,
): Promise<void> {
  const id = generateId();
  const now = nowText();

  await db
    .prepare(
      `INSERT INTO api_logs
       (id, level, event, account_name, account_id, model, stream, success,
        empty_response, stop_reason, status_code, message,
        input_tokens, output_tokens, duration_ms, api_key_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      String(payload.level || 'info'),
      String(payload.event || ''),
      String(payload.accountName || '-'),
      String(payload.accountId || ''),
      String(payload.model || '-'),
      payload.stream ? 1 : 0,
      payload.success ? 1 : 0,
      payload.emptyResponse ? 1 : 0,
      String(payload.stopReason || ''),
      String(payload.statusCode || ''),
      String(payload.message || '').slice(0, 500),
      Number(payload.inputTokens || 0),
      Number(payload.outputTokens || 0),
      Number(payload.durationMs || 0),
      payload.apiKeyId ? String(payload.apiKeyId) : null,
      now,
    )
    .run();
}

export async function getRecentLogs(
  db: D1Database,
  limit = 200,
): Promise<Array<Record<string, unknown>>> {
  const { results } = await db
    .prepare(
      'SELECT * FROM api_logs ORDER BY created_at DESC LIMIT ?',
    )
    .bind(limit)
    .all<Record<string, unknown>>();

  return (results || []).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    level: row.level,
    event: row.event,
    accountName: row.account_name,
    accountId: row.account_id,
    model: row.model,
    stream: !!row.stream,
    success: !!row.success,
    emptyResponse: !!row.empty_response,
    stopReason: row.stop_reason || '-',
    statusCode: row.status_code || '-',
    message: row.message || '-',
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    durationMs: Number(row.duration_ms || 0),
    apiKeyId: row.api_key_id || null,
  }));
}

/**
 * 清理超过 N 天的日志
 */
export async function pruneOldLogs(
  db: D1Database,
  daysToKeep = 7,
): Promise<number> {
  const cutoff = new Date(Date.now() - daysToKeep * 86400000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  const result = await db
    .prepare('DELETE FROM api_logs WHERE created_at < ?')
    .bind(cutoff)
    .run();

  return result.meta?.changes ?? 0;
}
