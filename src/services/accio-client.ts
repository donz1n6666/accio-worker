import type { Account } from '../types';

export interface AccioClientConfig {
  baseUrl: string;
  version: string;
  timeout?: number;
}

function getHeaders(
  utdid: string,
  version: string,
  opts?: { accept?: string; cna?: string; userAgent?: string },
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-language': 'zh',
    'x-utdid': utdid,
    'x-app-version': version,
    'x-os': 'win32',
    accept: opts?.accept || 'application/json, text/plain, */*',
  };
  if (opts?.cna) headers['x-cna'] = opts.cna;
  if (opts?.userAgent) headers['user-agent'] = opts.userAgent;
  return headers;
}

function extractCookieValue(cookieText: string | null, key: string): string | null {
  if (!cookieText) return null;
  let normalized = cookieText;
  for (let i = 0; i < 2; i++) {
    const decoded = decodeURIComponent(normalized);
    if (decoded === normalized) break;
    normalized = decoded;
  }
  for (const part of normalized.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;
    const name = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (name === key) return value || null;
  }
  return null;
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeout = 15000,
): Promise<Record<string, unknown>> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    clearTimeout(timer);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      const text = await response.text();
      payload = {
        success: false,
        message: `HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const obj = payload as Record<string, unknown>;
      if (!response.ok) {
        obj.success = false;
        if (!obj.message) obj.message = `HTTP ${response.status}`;
      }
      return obj;
    }

    return {
      success: response.ok,
      data: payload,
      message: response.ok ? '' : `HTTP ${response.status}`,
    };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

export class AccioClient {
  constructor(private config: AccioClientConfig) {}

  buildLoginUrl(callbackUrl: string, state?: string): string {
    const params = new URLSearchParams({
      return_url: callbackUrl,
      state: state || crypto.randomUUID().replace(/-/g, ''),
    });
    return `https://www.accio.com/login?${params}`;
  }

  async refreshToken(account: Account): Promise<Record<string, unknown>> {
    return requestJson(
      `${this.config.baseUrl}/api/auth/refresh_token`,
      {
        method: 'POST',
        headers: getHeaders(account.utdid, this.config.version),
        body: JSON.stringify({
          utdid: account.utdid,
          version: this.config.version,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
        }),
      },
      (this.config.timeout || 15) * 1000,
    );
  }

  async queryQuota(account: Account): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      accessToken: account.access_token,
      utdid: account.utdid,
      version: this.config.version,
    });
    return requestJson(
      `${this.config.baseUrl}/api/entitlement/currentSubscription?${params}`,
      {
        method: 'GET',
        headers: {
          ...getHeaders(account.utdid, this.config.version, {
            accept: '*/*',
            cna: extractCookieValue(account.cookie, 'cna') || undefined,
            userAgent: 'node',
          }),
          'accept-language': '*',
          'sec-fetch-mode': 'cors',
        },
      },
      (this.config.timeout || 15) * 1000,
    );
  }

  async queryUserinfo(account: Account): Promise<Record<string, unknown>> {
    return requestJson(
      `${this.config.baseUrl}/api/auth/userinfo`,
      {
        method: 'POST',
        headers: getHeaders(account.utdid, this.config.version, {
          accept: '*/*',
          cna: extractCookieValue(account.cookie, 'cna') || undefined,
          userAgent: 'node',
        }),
        body: JSON.stringify({
          utdid: account.utdid,
          version: this.config.version,
          accessToken: account.access_token,
        }),
      },
      (this.config.timeout || 15) * 1000,
    );
  }

  async queryInvitation(account: Account): Promise<Record<string, unknown>> {
    return requestJson(
      `${this.config.baseUrl}/api/invitation/query`,
      {
        method: 'POST',
        headers: getHeaders(account.utdid, this.config.version, {
          accept: '*/*',
          cna: extractCookieValue(account.cookie, 'cna') || undefined,
          userAgent: 'node',
        }),
        body: JSON.stringify({
          utdid: account.utdid,
          version: this.config.version,
          accessToken: account.access_token,
        }),
      },
      (this.config.timeout || 15) * 1000,
    );
  }

  async queryChannel(account: Account): Promise<Record<string, unknown>> {
    return requestJson(
      `${this.config.baseUrl}/api/channel/query`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: '*/*',
          'user-agent': 'node',
        },
        body: JSON.stringify({ accessToken: account.access_token }),
      },
      (this.config.timeout || 15) * 1000,
    );
  }

  async queryLlmConfig(account: Account): Promise<Record<string, unknown>> {
    return requestJson(
      `${this.config.baseUrl}/api/llm/config`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'node',
        },
        body: JSON.stringify({ token: account.access_token }),
      },
      (this.config.timeout || 15) * 1000,
    );
  }

  async activateAccount(account: Account): Promise<Record<string, unknown>> {
    const [userinfo, invitation, channel] = await Promise.all([
      this.queryUserinfo(account),
      this.queryInvitation(account),
      this.queryChannel(account),
    ]);

    const userinfoSuccess = !!userinfo.success;
    const invitationSuccess = !!invitation.success;
    const channelSuccess = !!channel.success;
    const required = userinfoSuccess && invitationSuccess;

    let message: string;
    if (required && channelSuccess) message = '账号激活完成';
    else if (required) message = '账号激活完成，渠道查询未成功';
    else message = '账号激活未完成，请检查激活步骤结果';

    return {
      success: required,
      message,
      steps: [
        { key: 'userinfo', success: userinfoSuccess, message: String(userinfo.message || '') },
        { key: 'invitation', success: invitationSuccess, message: String(invitation.message || '') },
        { key: 'channel', success: channelSuccess, message: String(channel.message || '') },
      ],
    };
  }

  /**
   * 调用上游 generateContent API（流式）
   * 返回原始 Response，调用方处理流
   */
  async generateContent(
    account: Account,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`${this.config.baseUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        utdid: account.utdid,
        version: this.config.version,
        'user-agent': 'node',
      },
      body: JSON.stringify(body),
    });
  }
}
