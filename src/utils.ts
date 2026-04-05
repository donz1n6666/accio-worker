export function nowText(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function newUtdid(): string {
  const timestamp = Date.now();
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `utd-${timestamp}-${hex}`;
}

export function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

export function generateId(): string {
  return randomHex(32);
}

export function generateApiKey(): string {
  return `sk-accio-${randomHex(48)}`;
}

export async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function maskToken(token: string, prefix = 10, suffix = 6): string {
  if (token.length <= prefix + suffix) return token;
  return `${token.slice(0, prefix)}...${token.slice(-suffix)}`;
}

export function formatTimestamp(ts: number | null): string {
  if (!ts) return '未知';
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

export function normalizeTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') {
    return null;
  }
  let ts: number;
  try {
    ts = Math.floor(Number(value));
  } catch {
    return null;
  }
  if (isNaN(ts)) return null;
  if (ts > 10_000_000_000) ts = Math.floor(ts / 1000);
  return ts;
}

export function normalizeFillPriority(value: unknown): number {
  try {
    const p = parseInt(String(value).trim(), 10);
    if (isNaN(p)) return 100;
    return Math.max(0, p);
  } catch {
    return 100;
  }
}

export function asInt(value: unknown, defaultVal = 0): number {
  try {
    const n = parseInt(String(value), 10);
    return isNaN(n) ? defaultVal : Math.max(0, n);
  } catch {
    return defaultVal;
  }
}

export function normalizeModelKey(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

export function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data, null, undefined), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}
