/**
 * 构建上游 Accio 请求体
 * 对应 Python: anthropic_proxy.build_accio_request
 */

import { normalizeModelKey } from '../utils';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function extractSystemText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'object' && item !== null && 'text' in item) {
      parts.push(String((item as Record<string, unknown>).text || ''));
    }
  }
  return parts.filter(Boolean).join('\n');
}

function normalizeStopSequences(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v || '').trim()).filter(Boolean);
}

function sanitizeToolCallId(value: unknown): string {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function guessImageMimeType(url: string): string {
  const lower = url.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

// ---- Message Conversion ----

interface ContentPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inline_data?: { mime_type: string; data: string };
  file_data?: { file_uri: string; mime_type: string };
  functionCall?: { id: string; name: string; argsJson: string };
  functionResponse?: { id: string; name: string; responseJson: string };
}

interface ContentEntry {
  role: string;
  parts: ContentPart[];
  metadata?: Record<string, unknown>;
}

function convertMessages(messages: Array<Record<string, unknown>>): ContentEntry[] {
  const contents: ContentEntry[] = [];

  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const role = String(message.role || '');
    const contentBlocks = message.content;

    if (role === 'assistant') {
      const parts: ContentPart[] = [];
      let thoughtSignature: string | null = null;

      if (Array.isArray(contentBlocks)) {
        for (const block of contentBlocks) {
          if (typeof block !== 'object' || block === null) continue;
          const b = block as Record<string, unknown>;
          const blockType = String(b.type || '');

          if (['text', 'input_text', 'output_text'].includes(blockType)) {
            parts.push({ text: String(b.text || ''), thought: false });
          } else if (blockType === 'image' && typeof b.source === 'object' && b.source !== null) {
            const source = b.source as Record<string, unknown>;
            if (source.type === 'base64') {
              parts.push({
                thought: false,
                inline_data: {
                  mime_type: String(source.media_type || ''),
                  data: String(source.data || ''),
                },
              });
            } else if (source.type === 'url' && source.url) {
              parts.push({
                thought: false,
                file_data: {
                  file_uri: String(source.url),
                  mime_type: String(source.media_type || guessImageMimeType(String(source.url))),
                },
              });
            }
          } else if (blockType === 'thinking') {
            const part: ContentPart = {
              text: String(b.thinking || ''),
              thought: true,
            };
            if (b.signature) {
              part.thoughtSignature = String(b.signature);
              thoughtSignature = String(b.signature);
            }
            parts.push(part);
          } else if (['tool_use', 'tool_call', 'function_call'].includes(blockType)) {
            const func = (typeof b.function === 'object' && b.function !== null)
              ? b.function as Record<string, unknown>
              : null;
            let toolName = String(b.name || '');
            let inputValue: unknown = b.input;
            if (func) {
              if (!toolName) toolName = String(func.name || '');
              if (inputValue === undefined) inputValue = func.arguments ?? func.arguments_json;
            }
            if (inputValue === undefined) inputValue = b.arguments ?? b.arguments_json;

            parts.push({
              thought: false,
              functionCall: {
                id: sanitizeToolCallId(b.id || b.call_id || b.tool_call_id || crypto.randomUUID().replace(/-/g, '')),
                name: toolName,
                argsJson: typeof inputValue === 'string'
                  ? inputValue
                  : JSON.stringify(inputValue || {}),
              },
            });
          }
        }
      } else {
        parts.push({ text: String(contentBlocks || ''), thought: false });
      }

      const content: ContentEntry = {
        role: 'model',
        parts: parts.length ? parts : [{ text: '', thought: false }],
      };
      if (thoughtSignature) {
        content.metadata = { textThoughtSignature: thoughtSignature };
      }
      contents.push(content);
      continue;
    }

    if (role !== 'user') continue;

    const toolParts: ContentPart[] = [];
    const textParts: ContentPart[] = [];

    if (Array.isArray(contentBlocks)) {
      for (const block of contentBlocks) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        const blockType = String(b.type || '');

        if (blockType === 'text') {
          textParts.push({ text: String(b.text || ''), thought: false });
        } else if (blockType === 'image' && typeof b.source === 'object' && b.source !== null) {
          const source = b.source as Record<string, unknown>;
          if (source.type === 'base64') {
            textParts.push({
              thought: false,
              inline_data: {
                mime_type: String(source.media_type || ''),
                data: String(source.data || ''),
              },
            });
          } else if (source.type === 'url' && source.url) {
            textParts.push({
              thought: false,
              file_data: {
                file_uri: String(source.url),
                mime_type: String(source.media_type || guessImageMimeType(String(source.url))),
              },
            });
          }
        } else if (blockType === 'tool_result') {
          const resultContent = extractToolResultText(b.content);
          toolParts.push({
            thought: false,
            functionResponse: {
              id: sanitizeToolCallId(b.tool_use_id || b.tool_call_id || b.id || crypto.randomUUID().replace(/-/g, '')),
              name: String(b.name || 'unknown'),
              responseJson: JSON.stringify({
                content: resultContent,
                is_error: !!(b.is_error),
              }),
            },
          });
        }
      }
    } else {
      textParts.push({ text: String(contentBlocks || ''), thought: false });
    }

    if (toolParts.length) {
      contents.push({ role: 'tool', parts: toolParts });
    }
    if (textParts.length) {
      if (toolParts.length) {
        contents.push({ role: 'model', parts: [{ text: '', thought: false }] });
      }
      contents.push({ role: 'user', parts: textParts });
    }
  }

  return contents;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text')
      .map((item) => String((item as Record<string, unknown>).text || ''));
    if (texts.length) return texts.join('\n');
    return JSON.stringify(content);
  }
  if (typeof content === 'object' && content !== null) {
    return JSON.stringify(content);
  }
  return '';
}

function ensureAlternatingRoles(contents: ContentEntry[]): ContentEntry[] {
  if (contents.length <= 1) return contents;

  const side = (role: string) => (role === 'model' ? 'model' : 'user');
  const result = [contents[0]];

  for (let i = 1; i < contents.length; i++) {
    const prev = result[result.length - 1];
    const curr = contents[i];
    if (side(prev.role) === side(curr.role)) {
      const fillerRole = side(curr.role) === 'user' ? 'model' : 'user';
      result.push({ role: fillerRole, parts: [{ text: '', thought: false }] });
    }
    result.push(curr);
  }

  return result;
}

// ---- Build Request ----

export function buildAccioRequest(
  body: Record<string, unknown>,
  opts: { token: string; utdid: string; version: string },
): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    utdid: opts.utdid,
    version: opts.version,
    token: opts.token,
    empid: String(body.empid || ''),
    tenant: String(body.tenant || ''),
    iai_tag: String(body.iai_tag || body.iaiTag || ''),
    stream: true,
    model: body.model || DEFAULT_MODEL,
    request_id: String(body.request_id || body.requestId || `req-${crypto.randomUUID()}`),
    message_id: String(body.message_id || body.messageId || ''),
    incremental: true,
    max_output_tokens: body.max_tokens || 8192,
    contents: [],
    stop_sequences: normalizeStopSequences(body.stop_sequences || body.stop),
    properties: typeof body.properties === 'object' && body.properties !== null
      ? { ...(body.properties as Record<string, unknown>) }
      : {},
  };

  const systemText = extractSystemText(body.system);
  if (systemText) requestBody.system_instruction = systemText;

  if (body.temperature !== undefined) requestBody.temperature = body.temperature;
  if (body.top_p !== undefined) requestBody.top_p = body.top_p;
  if (body.response_format !== undefined) requestBody.response_format = body.response_format;

  // Thinking config
  const thinking = body.thinking as Record<string, unknown> | undefined;
  if (thinking && typeof thinking === 'object') {
    const thinkingType = String(thinking.type || '').trim().toLowerCase();
    if (thinkingType === 'enabled') {
      requestBody.include_thoughts = true;
      requestBody.thinking_level = 'high';
      if (thinking.budget_tokens !== undefined) {
        requestBody.thinking_budget = thinking.budget_tokens;
      }
    }
  }

  // Tools
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length) {
    requestBody.tools = tools
      .filter((t) => typeof t === 'object' && t !== null && (t as Record<string, unknown>).name)
      .map((t) => {
        const tool = t as Record<string, unknown>;
        return {
          name: String(tool.name || ''),
          description: String(tool.description || ''),
          parametersJson: JSON.stringify(tool.input_schema || {}),
        };
      });
  }

  const messages = (body.messages || []) as Array<Record<string, unknown>>;
  const converted = convertMessages(messages);
  requestBody.contents = ensureAlternatingRoles(converted);

  return requestBody;
}

// ---- OpenAI → Anthropic Conversion ----

function convertOpenAIMessages(body: Record<string, unknown>): {
  systemText: string;
  messages: Array<Record<string, unknown>>;
} {
  const rawMessages = body.messages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(rawMessages)) return { systemText: '', messages: [] };

  const systemParts: string[] = [];
  const converted: Array<Record<string, unknown>> = [];

  for (const msg of rawMessages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const role = String(msg.role || 'user').trim().toLowerCase();

    if (role === 'system' || role === 'developer') {
      const text = extractContentText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'assistant') {
      converted.push({ role: 'assistant', content: msg.content });
      continue;
    }

    if (role === 'tool') {
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(msg.tool_call_id || ''),
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          is_error: !!(msg.is_error),
        }],
      });
      continue;
    }

    converted.push({ role: 'user', content: msg.content });
  }

  return { systemText: systemParts.join('\n'), messages: converted };
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text')
    .map((item) => String((item as Record<string, unknown>).text || ''))
    .join('\n');
}

export function buildAccioRequestFromOpenAI(
  body: Record<string, unknown>,
  opts: { token: string; utdid: string; version: string },
): Record<string, unknown> {
  const { systemText, messages } = convertOpenAIMessages(body);

  const anthropicBody: Record<string, unknown> = {
    model: body.model,
    messages,
    max_tokens: body.max_completion_tokens || body.max_tokens || 8192,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop,
    response_format: body.response_format,
    properties: typeof body.properties === 'object' ? body.properties : {},
  };
  if (systemText) anthropicBody.system = systemText;

  // Convert OpenAI tools to Anthropic format
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools)) {
    anthropicBody.tools = tools
      .filter((t) => typeof t === 'object' && t !== null && String((t as Record<string, unknown>).type) === 'function')
      .map((t) => {
        const tool = t as Record<string, unknown>;
        const func = (tool.function || tool) as Record<string, unknown>;
        return {
          name: String(func.name || ''),
          description: String(func.description || ''),
          input_schema: func.parameters || func.input_schema || {},
        };
      });
  }

  return buildAccioRequest(anthropicBody, opts);
}

// ---- Gemini → Accio Conversion ----

function normalizeGeminiContents(value: unknown): ContentEntry[] {
  if (!Array.isArray(value)) return [];
  const contents: ContentEntry[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const rawParts = Array.isArray(obj.parts) ? obj.parts : [];
    const parts: ContentPart[] = rawParts
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map((p) => {
        const part: ContentPart = {};
        if (p.text !== undefined) part.text = String(p.text || '');
        if (p.thought !== undefined) part.thought = !!p.thought;
        const sig = p.thoughtSignature || p.thought_signature;
        if (sig) part.thoughtSignature = String(sig);

        const inlineData = p.inlineData || p.inline_data;
        if (typeof inlineData === 'object' && inlineData !== null) {
          const d = inlineData as Record<string, unknown>;
          part.inline_data = {
            mime_type: String(d.mimeType || d.mime_type || ''),
            data: String(d.data || ''),
          };
        }

        const functionCall = p.functionCall || p.function_call;
        if (typeof functionCall === 'object' && functionCall !== null) {
          const fc = functionCall as Record<string, unknown>;
          let argsValue: unknown = fc.argsJson;
          if (argsValue === undefined) argsValue = fc.args || {};
          part.functionCall = {
            id: String(fc.id || fc.callId || fc.name || crypto.randomUUID().replace(/-/g, '')),
            name: String(fc.name || ''),
            argsJson: typeof argsValue === 'string' ? argsValue : JSON.stringify(argsValue),
          };
        }

        const functionResponse = p.functionResponse || p.function_response;
        if (typeof functionResponse === 'object' && functionResponse !== null) {
          const fr = functionResponse as Record<string, unknown>;
          let respValue: unknown = fr.responseJson;
          if (respValue === undefined) respValue = fr.response || {};
          part.functionResponse = {
            id: String(fr.id || fr.callId || fr.name || crypto.randomUUID().replace(/-/g, '')),
            name: String(fr.name || ''),
            responseJson: typeof respValue === 'string' ? respValue : JSON.stringify(respValue),
          };
        }

        return part;
      })
      .filter((p) => Object.keys(p).length > 0);

    const rawRole = String(obj.role || 'user').trim().toLowerCase();
    const role = rawRole === 'assistant' || rawRole === 'model' ? 'model' : rawRole === 'tool' ? 'tool' : 'user';

    contents.push({
      role,
      parts: parts.length ? parts : [{ text: '' }],
    });
  }
  return contents;
}

export function buildAccioRequestFromGemini(
  body: Record<string, unknown>,
  model: string,
  opts: { token: string; utdid: string; version: string },
): Record<string, unknown> {
  const generationConfig = (typeof body.generationConfig === 'object' && body.generationConfig !== null)
    ? body.generationConfig as Record<string, unknown>
    : (typeof body.generation_config === 'object' && body.generation_config !== null)
      ? body.generation_config as Record<string, unknown>
      : {};

  const requestBody: Record<string, unknown> = {
    utdid: opts.utdid,
    version: opts.version,
    token: opts.token,
    empid: String(body.empid || ''),
    tenant: String(body.tenant || ''),
    iai_tag: String(body.iai_tag || body.iaiTag || ''),
    stream: true,
    model,
    request_id: String(body.request_id || body.requestId || `req-${crypto.randomUUID()}`),
    message_id: String(body.message_id || body.messageId || ''),
    incremental: true,
    max_output_tokens: Number(generationConfig.maxOutputTokens || body.max_output_tokens || body.maxOutputTokens || 8192),
    contents: normalizeGeminiContents(body.contents),
    include_thoughts: false,
    stop_sequences: [],
    properties: {},
  };

  // System instruction
  const systemInstruction = body.system_instruction || body.systemInstruction;
  if (systemInstruction) {
    if (typeof systemInstruction === 'string') {
      requestBody.system_instruction = systemInstruction;
    } else if (typeof systemInstruction === 'object' && systemInstruction !== null) {
      const si = systemInstruction as Record<string, unknown>;
      const parts = si.parts as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(parts)) {
        requestBody.system_instruction = parts
          .filter((p) => p.text !== undefined)
          .map((p) => String(p.text || ''))
          .join('\n');
      }
    }
  }

  // Temperature / topP / topK
  if (generationConfig.temperature !== undefined || body.temperature !== undefined) {
    requestBody.temperature = generationConfig.temperature ?? body.temperature;
  }
  if (generationConfig.topP !== undefined || body.topP !== undefined) {
    requestBody.top_p = generationConfig.topP ?? body.topP;
  }

  // Tools
  const rawTools = body.tools;
  if (Array.isArray(rawTools)) {
    const tools: Array<Record<string, unknown>> = [];
    for (const item of rawTools) {
      if (typeof item !== 'object' || item === null) continue;
      const t = item as Record<string, unknown>;

      if (t.name) {
        tools.push({
          name: String(t.name),
          description: String(t.description || ''),
          parametersJson: JSON.stringify(t.parameters_json || t.parametersJson || {}),
        });
        continue;
      }

      const declarations = t.functionDeclarations || t.function_declarations;
      if (Array.isArray(declarations)) {
        for (const decl of declarations) {
          if (typeof decl !== 'object' || decl === null || !(decl as Record<string, unknown>).name) continue;
          const d = decl as Record<string, unknown>;
          tools.push({
            name: String(d.name),
            description: String(d.description || ''),
            parametersJson: JSON.stringify(d.parameters || {}),
          });
        }
      }
    }
    if (tools.length) requestBody.tools = tools;
  }

  return requestBody;
}
