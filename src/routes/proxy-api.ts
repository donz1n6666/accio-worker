/**
 * 代理 API 路由
 * 处理 Anthropic / OpenAI / Gemini 三种格式的请求
 */

import { Hono } from 'hono';
import type { Env, PanelSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { authenticateProxyRequest, isModelAllowed } from '../auth';
import { jsonResponse } from '../utils';
import { selectProxyAccount, ProxySelectionError } from '../proxy/scheduler';
import {
  buildAccioRequest,
  buildAccioRequestFromOpenAI,
  buildAccioRequestFromGemini,
} from '../proxy/upstream';
import {
  createAnthropicSSETransform,
  createOpenAIChatSSETransform,
} from '../proxy/sse-transform';
import type { StreamSummary } from '../proxy/sse-transform';
import { AccioClient } from '../services/accio-client';
import { recordMessage } from '../db/stats';
import { recordLog } from '../db/logs';
import { normalizeGeminiModelName } from '../services/model-catalog';

const proxyApi = new Hono<{ Bindings: Env }>();

// ---- Helpers ----

function anthropicErrorPayload(message: string, errorType = 'api_error'): Record<string, unknown> {
  return { type: 'error', error: { type: errorType, message } };
}

function openaiErrorPayload(message: string, errorType = 'invalid_request_error', code?: string): Record<string, unknown> {
  const err: Record<string, unknown> = { message, type: errorType };
  if (code) err.code = code;
  return { error: err };
}

function geminiErrorPayload(statusCode: number, message: string, errorStatus = 'INVALID_ARGUMENT'): Record<string, unknown> {
  return { error: { code: statusCode, message, status: errorStatus } };
}

async function getSettings(env: Env): Promise<PanelSettings> {
  try {
    const raw = await env.KV.get('config:settings');
    if (raw) return JSON.parse(raw) as PanelSettings;
  } catch { /* ignore */ }
  return {
    ...DEFAULT_SETTINGS,
    adminPassword: env.ADMIN_PASSWORD || DEFAULT_SETTINGS.adminPassword,
  };
}

function recordStreamComplete(
  env: Env,
  summary: StreamSummary,
  meta: {
    event: string;
    accountId: string;
    accountName: string;
    model: string;
    startedAt: number;
    apiKeyId?: string;
  },
) {
  const usage = summary.usage;
  const durationMs = Date.now() - meta.startedAt;
  const emptyResponse = summary.text_chars === 0 && summary.thinking_chars === 0 && summary.tool_use_blocks === 0;

  // waitUntil not available here, so fire-and-forget
  recordMessage(env.DB, {
    accountId: meta.accountId,
    model: meta.model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    success: true,
    stopReason: summary.stop_reason,
    apiKeyId: meta.apiKeyId,
  }).catch(() => {});

  recordLog(env.DB, {
    level: emptyResponse ? 'warn' : 'info',
    event: meta.event,
    accountName: meta.accountName,
    accountId: meta.accountId,
    model: meta.model,
    stream: true,
    success: true,
    emptyResponse,
    stopReason: summary.stop_reason,
    statusCode: '200',
    message: emptyResponse ? '上游返回空内容' : '',
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    durationMs,
    apiKeyId: meta.apiKeyId,
  }).catch(() => {});
}

function decodeNonStreamResponse(
  sseText: string,
  model: string,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  let stopReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;

  const lines = sseText.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const jsonText = line.slice(5).trim();
    if (jsonText === '[DONE]') continue;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(jsonText);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== 'object') continue;

    const eventName = String(payload.type || '');

    if (eventName === 'message_start') {
      const msg = payload.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, unknown> | undefined;
      if (usage) {
        inputTokens = Math.max(inputTokens, Number(usage.input_tokens || 0));
        outputTokens = Math.max(outputTokens, Number(usage.output_tokens || 0));
      }
    } else if (eventName === 'content_block_start') {
      const block = payload.content_block as Record<string, unknown> | undefined;
      if (!block) continue;
      const blockType = String(block.type || '');
      if (blockType === 'text') content.push({ type: 'text', text: '' });
      else if (blockType === 'thinking') content.push({ type: 'thinking', thinking: '', signature: '' });
      else if (blockType === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: String(block.id || ''),
          name: String(block.name || ''),
          input: {},
          _input: '',
        });
      }
    } else if (eventName === 'content_block_delta') {
      if (!content.length) continue;
      const delta = payload.delta as Record<string, unknown> | undefined;
      if (!delta) continue;
      const last = content[content.length - 1];
      if (delta.text !== undefined) last.text = String(last.text || '') + String(delta.text);
      if (delta.thinking !== undefined) last.thinking = String(last.thinking || '') + String(delta.thinking);
      if (delta.signature !== undefined) last.signature = String(delta.signature);
      if (delta.partial_json !== undefined) last._input = String(last._input || '') + String(delta.partial_json);
    } else if (eventName === 'content_block_stop') {
      if (!content.length) continue;
      const last = content[content.length - 1];
      if (last.type === 'tool_use' && last._input) {
        try {
          last.input = JSON.parse(String(last._input));
        } catch { /* ignore */ }
      }
      delete last._input;
    } else if (eventName === 'message_delta') {
      const delta = payload.delta as Record<string, unknown> | undefined;
      if (delta?.stop_reason) stopReason = String(delta.stop_reason);
      const usage = payload.usage as Record<string, unknown> | undefined;
      if (usage) {
        inputTokens = Math.max(inputTokens, Number(usage.input_tokens || 0));
        outputTokens = Math.max(outputTokens, Number(usage.output_tokens || 0));
      }
    }
  }

  // Clean up
  for (const block of content) {
    delete block._input;
    if (block.type === 'thinking' && !block.signature) {
      delete block.signature;
    }
  }

  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ====================================================================
// Anthropic Messages API: POST /v1/messages
// ====================================================================

proxyApi.post('/v1/messages', async (c) => {
  const auth = await authenticateProxyRequest(c);
  if (!auth) {
    return jsonResponse(
      anthropicErrorPayload('无效的 API Key，请使用管理员密码或有效 API Key 作为 x-api-key 或 Bearer Token。', 'authentication_error'),
      401,
    );
  }

  const startedAt = Date.now();
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonResponse(anthropicErrorPayload('请求体必须是合法的 JSON。', 'invalid_request_error'), 400);
  }

  const model = String(body.model || 'claude-sonnet-4-6');
  const requestedStream = !!body.stream;

  if (!isModelAllowed(auth, model)) {
    return jsonResponse(
      anthropicErrorPayload(`您的 API Key 不允许使用模型 ${model}。`, 'invalid_request_error'),
      403,
    );
  }

  const settings = await getSettings(c.env);

  let account, quota;
  try {
    const result = await selectProxyAccount(c.env, settings, null);
    account = result.account;
    quota = result.quota;
  } catch (e) {
    if (e instanceof ProxySelectionError) {
      c.executionCtx.waitUntil(
        recordLog(c.env.DB, {
          level: 'error', event: 'v1_messages', success: false,
          model, stream: requestedStream,
          message: e.message, statusCode: e.statusCode,
          stopReason: 'proxy_selection_failed',
          apiKeyId: auth.apiKeyId,
        }),
      );
      return jsonResponse(anthropicErrorPayload(e.message), e.statusCode);
    }
    throw e;
  }

  const client = new AccioClient({
    baseUrl: c.env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  const accioBody = buildAccioRequest(body, {
    token: account.access_token,
    utdid: account.utdid,
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await client.generateContent(account, accioBody);
  } catch (e) {
    c.executionCtx.waitUntil(
      Promise.all([
        recordMessage(c.env.DB, {
          accountId: account.id, model, inputTokens: 0, outputTokens: 0,
          success: false, stopReason: 'request_exception', apiKeyId: auth.apiKeyId,
        }),
        recordLog(c.env.DB, {
          level: 'error', event: 'v1_messages', success: false,
          accountName: account.name, accountId: account.id, model,
          stream: requestedStream, message: `上游请求失败: ${e}`,
          statusCode: 502, stopReason: 'request_exception', apiKeyId: auth.apiKeyId,
          durationMs: Date.now() - startedAt,
        }),
      ]),
    );
    return jsonResponse(anthropicErrorPayload(`上游请求失败: ${e}`), 502);
  }

  const responseHeaders: Record<string, string> = {
    'x-accio-account-id': account.id,
  };

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => '');
    c.executionCtx.waitUntil(
      Promise.all([
        recordMessage(c.env.DB, {
          accountId: account.id, model, inputTokens: 0, outputTokens: 0,
          success: false, stopReason: 'upstream_error', apiKeyId: auth.apiKeyId,
        }),
        recordLog(c.env.DB, {
          level: 'error', event: 'v1_messages', success: false,
          accountName: account.name, accountId: account.id, model,
          stream: requestedStream, message: text.slice(0, 500) || '上游返回错误。',
          statusCode: upstreamResponse.status, stopReason: 'upstream_error',
          apiKeyId: auth.apiKeyId, durationMs: Date.now() - startedAt,
        }),
      ]),
    );
    return jsonResponse(
      anthropicErrorPayload(text.slice(0, 500) || '上游返回错误。'),
      upstreamResponse.status,
      responseHeaders,
    );
  }

  if (requestedStream) {
    const { transform } = createAnthropicSSETransform(model, (summary) => {
      c.executionCtx.waitUntil(
        Promise.resolve(recordStreamComplete(c.env, summary, {
          event: 'v1_messages', accountId: account.id, accountName: account.name,
          model, startedAt, apiKeyId: auth.apiKeyId,
        })),
      );
    });

    const readable = upstreamResponse.body!.pipeThrough(transform);
    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...responseHeaders,
      },
    });
  }

  // Non-stream: collect SSE, decode to single message
  const sseText = await upstreamResponse.text();
  const { transform } = createAnthropicSSETransform(model);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Pass SSE through the transform to get normalized events
  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  }).pipeThrough(transform).getReader();

  let normalizedSSE = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    normalizedSSE += decoder.decode(value, { stream: true });
  }
  normalizedSSE += decoder.decode();

  const result = decodeNonStreamResponse(normalizedSSE, model);
  const usage = result.usage as Record<string, unknown>;

  c.executionCtx.waitUntil(
    Promise.all([
      recordMessage(c.env.DB, {
        accountId: account.id, model,
        inputTokens: Number(usage.input_tokens || 0),
        outputTokens: Number(usage.output_tokens || 0),
        success: true, stopReason: String(result.stop_reason || 'end_turn'),
        apiKeyId: auth.apiKeyId,
      }),
      recordLog(c.env.DB, {
        level: 'info', event: 'v1_messages', success: true,
        accountName: account.name, accountId: account.id, model,
        stream: false, stopReason: String(result.stop_reason || 'end_turn'),
        statusCode: '200',
        inputTokens: Number(usage.input_tokens || 0),
        outputTokens: Number(usage.output_tokens || 0),
        durationMs: Date.now() - startedAt,
        apiKeyId: auth.apiKeyId,
      }),
    ]),
  );

  return jsonResponse(result, 200, responseHeaders);
});

// ====================================================================
// OpenAI Chat Completions: POST /v1/chat/completions
// ====================================================================

proxyApi.post('/v1/chat/completions', async (c) => {
  const auth = await authenticateProxyRequest(c);
  if (!auth) {
    return jsonResponse(
      openaiErrorPayload('无效的 API Key。', 'authentication_error', 'invalid_api_key'),
      401,
    );
  }

  const startedAt = Date.now();
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonResponse(openaiErrorPayload('请求体必须是合法的 JSON。'), 400);
  }

  const model = String(body.model || 'claude-sonnet-4-6');
  const requestedStream = !!body.stream;

  if (!isModelAllowed(auth, model)) {
    return jsonResponse(
      openaiErrorPayload(`您的 API Key 不允许使用模型 ${model}。`, 'invalid_request_error', 'model_not_allowed'),
      403,
    );
  }

  const settings = await getSettings(c.env);

  let account, quota;
  try {
    const result = await selectProxyAccount(c.env, settings, null);
    account = result.account;
    quota = result.quota;
  } catch (e) {
    if (e instanceof ProxySelectionError) {
      c.executionCtx.waitUntil(
        recordLog(c.env.DB, {
          level: 'error', event: 'v1_chat_completions', success: false,
          model, stream: requestedStream, message: e.message,
          statusCode: e.statusCode, stopReason: 'proxy_selection_failed',
          apiKeyId: auth.apiKeyId,
        }),
      );
      return jsonResponse(openaiErrorPayload(e.message, 'server_error'), e.statusCode);
    }
    throw e;
  }

  const client = new AccioClient({
    baseUrl: c.env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  const accioBody = buildAccioRequestFromOpenAI(body, {
    token: account.access_token,
    utdid: account.utdid,
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await client.generateContent(account, accioBody);
  } catch (e) {
    c.executionCtx.waitUntil(
      Promise.all([
        recordMessage(c.env.DB, {
          accountId: account.id, model, inputTokens: 0, outputTokens: 0,
          success: false, stopReason: 'request_exception', apiKeyId: auth.apiKeyId,
        }),
        recordLog(c.env.DB, {
          level: 'error', event: 'v1_chat_completions', success: false,
          accountName: account.name, accountId: account.id, model,
          stream: requestedStream, message: `上游请求失败: ${e}`,
          statusCode: 502, stopReason: 'request_exception',
          apiKeyId: auth.apiKeyId, durationMs: Date.now() - startedAt,
        }),
      ]),
    );
    return jsonResponse(openaiErrorPayload(`上游请求失败: ${e}`, 'server_error'), 502);
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => '');
    c.executionCtx.waitUntil(
      Promise.all([
        recordMessage(c.env.DB, {
          accountId: account.id, model, inputTokens: 0, outputTokens: 0,
          success: false, stopReason: 'upstream_error', apiKeyId: auth.apiKeyId,
        }),
        recordLog(c.env.DB, {
          level: 'error', event: 'v1_chat_completions', success: false,
          accountName: account.name, accountId: account.id, model,
          stream: requestedStream, message: text.slice(0, 500) || '上游返回错误。',
          statusCode: upstreamResponse.status, stopReason: 'upstream_error',
          apiKeyId: auth.apiKeyId, durationMs: Date.now() - startedAt,
        }),
      ]),
    );
    return jsonResponse(
      openaiErrorPayload(text.slice(0, 500) || '上游返回错误。', 'server_error'),
      upstreamResponse.status,
    );
  }

  if (requestedStream) {
    // First pipe through Anthropic transform, then OpenAI transform
    const { transform: anthropicTransform } = createAnthropicSSETransform(model);
    const openaiTransform = createOpenAIChatSSETransform(model, (summary) => {
      c.executionCtx.waitUntil(
        Promise.resolve(recordStreamComplete(c.env, summary, {
          event: 'v1_chat_completions', accountId: account.id,
          accountName: account.name, model, startedAt, apiKeyId: auth.apiKeyId,
        })),
      );
    });

    const readable = upstreamResponse.body!
      .pipeThrough(anthropicTransform)
      .pipeThrough(openaiTransform);

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  // Non-stream: collect and build a full chat completion response
  const sseText = await upstreamResponse.text();
  const { transform: anthropicTransform } = createAnthropicSSETransform(model);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  }).pipeThrough(anthropicTransform).getReader();

  let normalizedSSE = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    normalizedSSE += decoder.decode(value, { stream: true });
  }
  normalizedSSE += decoder.decode();

  const anthropicResult = decodeNonStreamResponse(normalizedSSE, model);
  const anthropicUsage = anthropicResult.usage as Record<string, unknown>;
  const anthropicContent = anthropicResult.content as Array<Record<string, unknown>>;

  // Build OpenAI chat completion from Anthropic result
  let contentText = '';
  const toolCalls: Array<Record<string, unknown>> = [];
  let toolCallIndex = 0;

  for (const block of anthropicContent || []) {
    if (block.type === 'text') {
      contentText += String(block.text || '');
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: String(block.id || `call_${crypto.randomUUID().replace(/-/g, '')}`),
        type: 'function',
        index: toolCallIndex++,
        function: {
          name: String(block.name || ''),
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
        },
      });
    }
  }

  const stopReason = String(anthropicResult.stop_reason || 'end_turn');
  let finishReason = 'stop';
  if (toolCalls.length || stopReason === 'tool_use') finishReason = 'tool_calls';
  else if (stopReason === 'max_tokens') finishReason = 'length';

  const choiceMessage: Record<string, unknown> = {
    role: 'assistant',
    content: contentText || null,
  };
  if (toolCalls.length) choiceMessage.tool_calls = toolCalls;

  const chatCompletion = {
    id: `chatcmpl_${crypto.randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: choiceMessage,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: Number(anthropicUsage.input_tokens || 0),
      completion_tokens: Number(anthropicUsage.output_tokens || 0),
      total_tokens: Number(anthropicUsage.input_tokens || 0) + Number(anthropicUsage.output_tokens || 0),
    },
  };

  c.executionCtx.waitUntil(
    Promise.all([
      recordMessage(c.env.DB, {
        accountId: account.id, model,
        inputTokens: Number(anthropicUsage.input_tokens || 0),
        outputTokens: Number(anthropicUsage.output_tokens || 0),
        success: true, stopReason,
        apiKeyId: auth.apiKeyId,
      }),
      recordLog(c.env.DB, {
        level: 'info', event: 'v1_chat_completions', success: true,
        accountName: account.name, accountId: account.id, model,
        stream: false, stopReason, statusCode: '200',
        inputTokens: Number(anthropicUsage.input_tokens || 0),
        outputTokens: Number(anthropicUsage.output_tokens || 0),
        durationMs: Date.now() - startedAt,
        apiKeyId: auth.apiKeyId,
      }),
    ]),
  );

  return jsonResponse(chatCompletion);
});

// Alias without /v1 prefix
proxyApi.post('/chat/completions', async (c) => {
  // Rewrite to /v1/chat/completions internally
  const url = new URL(c.req.url);
  url.pathname = '/v1/chat/completions';
  const newRequest = new Request(url.toString(), c.req.raw);
  // Route will be handled by the main app
  return c.env.DB ? proxyApi.fetch(newRequest, c.env, c.executionCtx) : jsonResponse({ error: 'internal' }, 500);
});

// ====================================================================
// OpenAI Responses API: POST /v1/responses
// ====================================================================

proxyApi.post('/v1/responses', async (c) => {
  // OpenAI Responses API - we convert to chat completions format internally
  const auth = await authenticateProxyRequest(c);
  if (!auth) {
    return jsonResponse(
      openaiErrorPayload('无效的 API Key。', 'authentication_error', 'invalid_api_key'),
      401,
    );
  }

  const startedAt = Date.now();
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonResponse(openaiErrorPayload('请求体必须是合法的 JSON。'), 400);
  }

  const model = String(body.model || 'claude-sonnet-4-6');
  const requestedStream = !!body.stream;

  if (!isModelAllowed(auth, model)) {
    return jsonResponse(
      openaiErrorPayload(`您的 API Key 不允许使用模型 ${model}。`, 'invalid_request_error', 'model_not_allowed'),
      403,
    );
  }

  // Convert Responses API input to messages format
  const input = body.input;
  const messages: Array<Record<string, unknown>> = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (typeof item === 'object' && item !== null) {
        messages.push(item as Record<string, unknown>);
      }
    }
  }

  const chatBody: Record<string, unknown> = {
    model,
    messages,
    max_tokens: body.max_output_tokens || body.max_tokens || 8192,
    stream: false, // Responses API builds full response
  };
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
  if (body.tools) chatBody.tools = body.tools;

  const settings = await getSettings(c.env);

  let account, quota;
  try {
    const result = await selectProxyAccount(c.env, settings, null);
    account = result.account;
    quota = result.quota;
  } catch (e) {
    if (e instanceof ProxySelectionError) {
      return jsonResponse(openaiErrorPayload(e.message, 'server_error'), e.statusCode);
    }
    throw e;
  }

  const client = new AccioClient({
    baseUrl: c.env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  const accioBody = buildAccioRequestFromOpenAI(chatBody, {
    token: account.access_token,
    utdid: account.utdid,
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await client.generateContent(account, accioBody);
  } catch (e) {
    return jsonResponse(openaiErrorPayload(`上游请求失败: ${e}`, 'server_error'), 502);
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => '');
    return jsonResponse(
      openaiErrorPayload(text.slice(0, 500) || '上游返回错误。', 'server_error'),
      upstreamResponse.status,
    );
  }

  // Collect and convert
  const sseText = await upstreamResponse.text();
  const { transform: anthropicTransform } = createAnthropicSSETransform(model);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const reader = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  }).pipeThrough(anthropicTransform).getReader();

  let normalizedSSE = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    normalizedSSE += decoder.decode(value, { stream: true });
  }
  normalizedSSE += decoder.decode();

  const anthropicResult = decodeNonStreamResponse(normalizedSSE, model);
  const anthropicUsage = anthropicResult.usage as Record<string, unknown>;
  const anthropicContent = anthropicResult.content as Array<Record<string, unknown>>;

  // Build Responses API output
  const outputItems: Array<Record<string, unknown>> = [];
  let outputText = '';

  for (const block of anthropicContent || []) {
    if (block.type === 'text') {
      const text = String(block.text || '');
      outputText += text;
      outputItems.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      });
    } else if (block.type === 'tool_use') {
      outputItems.push({
        type: 'function_call',
        id: String(block.id || ''),
        call_id: String(block.id || ''),
        name: String(block.name || ''),
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
      });
    }
  }

  const responsesPayload = {
    id: `resp_${crypto.randomUUID().replace(/-/g, '')}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    output: outputItems,
    output_text: outputText,
    usage: {
      input_tokens: Number(anthropicUsage.input_tokens || 0),
      output_tokens: Number(anthropicUsage.output_tokens || 0),
      total_tokens: Number(anthropicUsage.input_tokens || 0) + Number(anthropicUsage.output_tokens || 0),
    },
    status: 'completed',
  };

  c.executionCtx.waitUntil(
    Promise.all([
      recordMessage(c.env.DB, {
        accountId: account.id, model,
        inputTokens: Number(anthropicUsage.input_tokens || 0),
        outputTokens: Number(anthropicUsage.output_tokens || 0),
        success: true, stopReason: String(anthropicResult.stop_reason || 'end_turn'),
        apiKeyId: auth.apiKeyId,
      }),
      recordLog(c.env.DB, {
        level: 'info', event: 'v1_responses', success: true,
        accountName: account.name, accountId: account.id, model,
        stream: false, stopReason: String(anthropicResult.stop_reason || 'end_turn'),
        statusCode: '200',
        inputTokens: Number(anthropicUsage.input_tokens || 0),
        outputTokens: Number(anthropicUsage.output_tokens || 0),
        durationMs: Date.now() - startedAt,
        apiKeyId: auth.apiKeyId,
      }),
    ]),
  );

  return jsonResponse(responsesPayload);
});

// ====================================================================
// Gemini API: POST /v1beta/models/:model:generateContent
//             POST /v1beta/models/:model:streamGenerateContent
// ====================================================================

proxyApi.post('/v1beta/models/:modelAction', async (c) => {
  const auth = await authenticateProxyRequest(c);
  if (!auth) {
    return jsonResponse(
      geminiErrorPayload(401, '无效的 API Key', 'UNAUTHENTICATED'),
      401,
    );
  }

  const startedAt = Date.now();
  const modelAction = c.req.param('modelAction');

  // Parse "model-name:action"
  const colonIdx = modelAction.lastIndexOf(':');
  if (colonIdx < 0) {
    return jsonResponse(geminiErrorPayload(400, '无效的请求路径', 'INVALID_ARGUMENT'), 400);
  }
  const rawModelName = modelAction.slice(0, colonIdx);
  const action = modelAction.slice(colonIdx + 1);

  if (!['generateContent', 'streamGenerateContent'].includes(action)) {
    return jsonResponse(geminiErrorPayload(400, `不支持的操作: ${action}`, 'INVALID_ARGUMENT'), 400);
  }

  const isStream = action === 'streamGenerateContent' || c.req.query('alt') === 'sse';
  const modelName = normalizeGeminiModelName(rawModelName);

  if (!isModelAllowed(auth, modelName)) {
    return jsonResponse(
      geminiErrorPayload(403, `您的 API Key 不允许使用模型 ${modelName}。`, 'PERMISSION_DENIED'),
      403,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return jsonResponse(geminiErrorPayload(400, '请求体必须是合法的 JSON。', 'INVALID_ARGUMENT'), 400);
  }

  const settings = await getSettings(c.env);

  let account, quota;
  try {
    const result = await selectProxyAccount(c.env, settings, modelName);
    account = result.account;
    quota = result.quota;
  } catch (e) {
    if (e instanceof ProxySelectionError) {
      c.executionCtx.waitUntil(
        recordLog(c.env.DB, {
          level: 'error', event: 'gemini_generate_content', success: false,
          model: modelName, stream: isStream, message: e.message,
          statusCode: e.statusCode, stopReason: 'proxy_selection_failed',
          apiKeyId: auth.apiKeyId,
        }),
      );
      return jsonResponse(geminiErrorPayload(e.statusCode, e.message, 'UNAVAILABLE'), e.statusCode);
    }
    throw e;
  }

  const client = new AccioClient({
    baseUrl: c.env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  const accioBody = buildAccioRequestFromGemini(body, modelName, {
    token: account.access_token,
    utdid: account.utdid,
    version: c.env.ACCIO_VERSION || '0.5.6',
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await client.generateContent(account, accioBody);
  } catch (e) {
    c.executionCtx.waitUntil(
      Promise.all([
        recordMessage(c.env.DB, {
          accountId: account.id, model: modelName, inputTokens: 0, outputTokens: 0,
          success: false, stopReason: 'request_exception', apiKeyId: auth.apiKeyId,
        }),
        recordLog(c.env.DB, {
          level: 'error', event: 'gemini_generate_content', success: false,
          accountName: account.name, accountId: account.id, model: modelName,
          stream: isStream, message: `上游请求失败: ${e}`,
          statusCode: 502, stopReason: 'request_exception',
          apiKeyId: auth.apiKeyId, durationMs: Date.now() - startedAt,
        }),
      ]),
    );
    return jsonResponse(geminiErrorPayload(502, `上游请求失败: ${e}`, 'UNAVAILABLE'), 502);
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => '');
    c.executionCtx.waitUntil(
      Promise.all([
        recordMessage(c.env.DB, {
          accountId: account.id, model: modelName, inputTokens: 0, outputTokens: 0,
          success: false, stopReason: 'upstream_error', apiKeyId: auth.apiKeyId,
        }),
        recordLog(c.env.DB, {
          level: 'error', event: 'gemini_generate_content', success: false,
          accountName: account.name, accountId: account.id, model: modelName,
          stream: isStream, message: text.slice(0, 500) || '上游返回错误。',
          statusCode: upstreamResponse.status, stopReason: 'upstream_error',
          apiKeyId: auth.apiKeyId, durationMs: Date.now() - startedAt,
        }),
      ]),
    );
    return jsonResponse(
      geminiErrorPayload(upstreamResponse.status, text.slice(0, 500) || '上游返回错误。', 'UNAVAILABLE'),
      upstreamResponse.status,
    );
  }

  if (isStream) {
    // Gemini SSE: pass upstream SSE through and convert to Gemini format
    // The upstream already returns Gemini-like SSE, we just forward with some normalization
    const { transform } = createGeminiSSETransform(modelName, (summary) => {
      c.executionCtx.waitUntil(
        Promise.resolve(recordStreamComplete(c.env, summary, {
          event: 'gemini_generate_content', accountId: account.id,
          accountName: account.name, model: modelName, startedAt,
          apiKeyId: auth.apiKeyId,
        })),
      );
    });

    const readable = upstreamResponse.body!.pipeThrough(transform);
    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  // Non-stream: collect SSE, build a single Gemini response
  const sseText = await upstreamResponse.text();
  const geminiResult = buildGeminiNonStreamResponse(sseText, modelName);

  c.executionCtx.waitUntil(
    Promise.all([
      recordMessage(c.env.DB, {
        accountId: account.id, model: modelName,
        inputTokens: Number((geminiResult.usageMetadata as Record<string, unknown>)?.promptTokenCount || 0),
        outputTokens: Number((geminiResult.usageMetadata as Record<string, unknown>)?.candidatesTokenCount || 0),
        success: true, stopReason: 'end_turn',
        apiKeyId: auth.apiKeyId,
      }),
      recordLog(c.env.DB, {
        level: 'info', event: 'gemini_generate_content', success: true,
        accountName: account.name, accountId: account.id, model: modelName,
        stream: false, stopReason: 'end_turn', statusCode: '200',
        inputTokens: Number((geminiResult.usageMetadata as Record<string, unknown>)?.promptTokenCount || 0),
        outputTokens: Number((geminiResult.usageMetadata as Record<string, unknown>)?.candidatesTokenCount || 0),
        durationMs: Date.now() - startedAt,
        apiKeyId: auth.apiKeyId,
      }),
    ]),
  );

  return jsonResponse(geminiResult);
});

// ---- Gemini SSE Transform ----

function createGeminiSSETransform(
  model: string,
  onComplete?: (summary: StreamSummary) => void,
): { transform: TransformStream<Uint8Array, Uint8Array> } {
  const encoder = new TextEncoder();
  let lineBuffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let textChars = 0;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      lineBuffer += text;

      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue;

        const jsonText = line.startsWith('data:') ? line.slice(5).trim() : line;
        if (jsonText === '[DONE]') continue;

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(jsonText);
        } catch {
          continue;
        }

        // Extract from wrapped response
        const wrappedRaw = payload.raw_response_json;
        let rawEvent: Record<string, unknown> | null = null;

        if (wrappedRaw !== undefined) {
          rawEvent = typeof wrappedRaw === 'string'
            ? (() => { try { return JSON.parse(wrappedRaw); } catch { return null; } })()
            : (typeof wrappedRaw === 'object' && wrappedRaw !== null ? wrappedRaw as Record<string, unknown> : null);
        }
        if (!rawEvent) rawEvent = payload;
        if (rawEvent.turn_complete) continue;

        // Build Gemini-format event
        const candidates = rawEvent.candidates;
        if (Array.isArray(candidates) && candidates.length) {
          // Already Gemini format, forward as-is
          const geminiEvent = { candidates: rawEvent.candidates, usageMetadata: rawEvent.usageMetadata || rawEvent.usage_metadata };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(geminiEvent)}\n\n`));

          // Track usage
          const uMeta = rawEvent.usageMetadata || rawEvent.usage_metadata;
          if (typeof uMeta === 'object' && uMeta !== null) {
            const u = uMeta as Record<string, unknown>;
            inputTokens = Math.max(inputTokens, Number(u.promptTokenCount || u.prompt_token_count || 0));
            outputTokens = Math.max(outputTokens, Number(u.candidatesTokenCount || u.candidates_token_count || 0));
          }

          // Track text chars
          const candidate = candidates[0] as Record<string, unknown>;
          const content = candidate?.content as Record<string, unknown>;
          const parts = Array.isArray(content?.parts) ? content.parts : [];
          for (const part of parts) {
            if (typeof part === 'object' && part !== null && (part as Record<string, unknown>).text) {
              textChars += String((part as Record<string, unknown>).text || '').length;
            }
          }
          continue;
        }

        // Anthropic-wrapped event: convert to Gemini format
        if (rawEvent.type) {
          const eventType = String(rawEvent.type);
          if (eventType === 'content_block_delta') {
            const delta = rawEvent.delta as Record<string, unknown> | undefined;
            if (delta) {
              const parts: Array<Record<string, unknown>> = [];
              if (delta.text !== undefined) {
                parts.push({ text: String(delta.text || '') });
                textChars += String(delta.text || '').length;
              }
              if (delta.thinking !== undefined) {
                parts.push({ text: String(delta.thinking || ''), thought: true });
              }
              if (parts.length) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  candidates: [{ content: { role: 'model', parts } }],
                })}\n\n`));
              }
            }
          } else if (eventType === 'message_delta') {
            const usage = rawEvent.usage as Record<string, unknown> | undefined;
            if (usage) {
              inputTokens = Math.max(inputTokens, Number(usage.input_tokens || 0));
              outputTokens = Math.max(outputTokens, Number(usage.output_tokens || 0));
            }
            const finishReason = (rawEvent.delta as Record<string, unknown>)?.stop_reason;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              candidates: [{ finishReason: finishReason === 'max_tokens' ? 'MAX_TOKENS' : 'STOP' }],
              usageMetadata: {
                promptTokenCount: inputTokens,
                candidatesTokenCount: outputTokens,
                totalTokenCount: inputTokens + outputTokens,
              },
            })}\n\n`));
          }
        }
      }
    },

    flush(controller) {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      if (onComplete) {
        onComplete({
          model,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          stop_reason: 'end_turn',
          content_blocks: 0,
          text_chars: textChars,
          thinking_chars: 0,
          tool_use_blocks: 0,
          tool_json_chars: 0,
        });
      }
    },
  });

  return { transform };
}

function buildGeminiNonStreamResponse(
  sseText: string,
  model: string,
): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = 'STOP';

  const lines = sseText.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const jsonText = line.slice(5).trim();
    if (jsonText === '[DONE]') continue;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(jsonText);
    } catch {
      continue;
    }

    // Handle wrapped events
    const wrappedRaw = payload.raw_response_json;
    let rawEvent: Record<string, unknown> | null = null;
    if (wrappedRaw !== undefined) {
      rawEvent = typeof wrappedRaw === 'string'
        ? (() => { try { return JSON.parse(wrappedRaw); } catch { return null; } })()
        : (typeof wrappedRaw === 'object' && wrappedRaw !== null ? wrappedRaw as Record<string, unknown> : null);
    }
    if (!rawEvent) rawEvent = payload;

    // Gemini native format
    const candidates = rawEvent.candidates;
    if (Array.isArray(candidates) && candidates.length) {
      const candidate = candidates[0] as Record<string, unknown>;
      const content = candidate?.content as Record<string, unknown>;
      const rawParts = Array.isArray(content?.parts) ? content.parts : [];
      for (const part of rawParts) {
        if (typeof part === 'object' && part !== null) {
          parts.push(part as Record<string, unknown>);
        }
      }
      if (candidate?.finishReason) finishReason = String(candidate.finishReason);
      const uMeta = rawEvent.usageMetadata || rawEvent.usage_metadata;
      if (typeof uMeta === 'object' && uMeta !== null) {
        const u = uMeta as Record<string, unknown>;
        inputTokens = Math.max(inputTokens, Number(u.promptTokenCount || u.prompt_token_count || 0));
        outputTokens = Math.max(outputTokens, Number(u.candidatesTokenCount || u.candidates_token_count || 0));
      }
      continue;
    }

    // Anthropic event format
    if (rawEvent.type) {
      const eventType = String(rawEvent.type);
      if (eventType === 'content_block_delta') {
        const delta = rawEvent.delta as Record<string, unknown> | undefined;
        if (delta?.text !== undefined) {
          // Accumulate into existing text part or create new
          const lastPart = parts.length ? parts[parts.length - 1] : null;
          if (lastPart && lastPart.text !== undefined && !lastPart.thought) {
            lastPart.text = String(lastPart.text || '') + String(delta.text);
          } else {
            parts.push({ text: String(delta.text || '') });
          }
        }
        if (delta?.thinking !== undefined) {
          const lastPart = parts.length ? parts[parts.length - 1] : null;
          if (lastPart && lastPart.thought) {
            lastPart.text = String(lastPart.text || '') + String(delta.thinking);
          } else {
            parts.push({ text: String(delta.thinking || ''), thought: true });
          }
        }
      } else if (eventType === 'message_delta') {
        const usage = rawEvent.usage as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = Math.max(inputTokens, Number(usage.input_tokens || 0));
          outputTokens = Math.max(outputTokens, Number(usage.output_tokens || 0));
        }
        const delta = rawEvent.delta as Record<string, unknown>;
        if (delta?.stop_reason === 'max_tokens') finishReason = 'MAX_TOKENS';
        if (delta?.stop_reason === 'tool_use') finishReason = 'TOOL_CALLS';
      }
    }
  }

  return {
    candidates: [{
      content: {
        role: 'model',
        parts: parts.length ? parts : [{ text: '' }],
      },
      finishReason,
    }],
    usageMetadata: {
      promptTokenCount: inputTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: inputTokens + outputTokens,
    },
    modelVersion: model,
  };
}

export default proxyApi;
