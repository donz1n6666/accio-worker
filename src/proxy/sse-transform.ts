/**
 * SSE 流式转换 — 将上游 phoenix-gw SSE 转为 Anthropic Messages SSE
 *
 * Workers 版本使用 TransformStream + ReadableStream
 */

const SUPPORTED_ANTHROPIC_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-opus-4-6',
]);

interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
}

interface StreamSummary {
  model: string;
  usage: UsageSummary;
  stop_reason: string;
  content_blocks: number;
  text_chars: number;
  thinking_chars: number;
  tool_use_blocks: number;
  tool_json_chars: number;
}

function newSummary(model: string): StreamSummary {
  return {
    model,
    usage: { input_tokens: 0, output_tokens: 0 },
    stop_reason: 'end_turn',
    content_blocks: 0,
    text_chars: 0,
    thinking_chars: 0,
    tool_use_blocks: 0,
    tool_json_chars: 0,
  };
}

function formatSSE(eventName: string, payload: Record<string, unknown>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function fallbackMessageStart(model: string): Record<string, unknown> {
  return {
    type: 'message_start',
    message: {
      id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function asInt(value: unknown): number {
  const n = Number(value || 0);
  return isNaN(n) ? 0 : Math.max(0, Math.floor(n));
}

// ---- Fragment extraction (for Gemini/OpenAI-wrapped responses) ----

interface Fragment {
  kind: 'text' | 'thinking' | 'signature' | 'tool_use' | 'finish';
  text?: string;
  signature?: string;
  id?: string;
  name?: string;
  args_json?: string;
  stop_reason?: string;
  usage?: UsageSummary;
}

function mapVendorFinishReason(value: unknown): string | null {
  const n = String(value || '').trim().toLowerCase();
  if (!n) return null;
  if (['stop', 'stop_sequence', 'end_turn'].includes(n)) return 'end_turn';
  if (['max_tokens', 'length'].includes(n)) return 'max_tokens';
  if (['tool_use', 'tool_calls', 'function_call'].includes(n)) return 'tool_use';
  return null;
}

function extractContentFragments(raw: Record<string, unknown>): Fragment[] {
  const fragments: Fragment[] = [];

  // Gemini format: candidates[].content.parts[]
  const candidates = raw.candidates;
  if (Array.isArray(candidates) && candidates.length) {
    const candidate = (typeof candidates[0] === 'object' && candidates[0] !== null)
      ? candidates[0] as Record<string, unknown>
      : {};
    const content = (typeof candidate.content === 'object' && candidate.content !== null)
      ? candidate.content as Record<string, unknown>
      : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];

    for (const part of parts) {
      if (typeof part !== 'object' || part === null) continue;
      const p = part as Record<string, unknown>;

      if (p.text !== undefined) {
        const kind = p.thought ? 'thinking' : 'text';
        fragments.push({ kind, text: String(p.text || '') });
        const sig = p.thoughtSignature || p.thought_signature;
        if (sig) fragments.push({ kind: 'signature', signature: String(sig) });
        continue;
      }

      const fc = p.functionCall || p.function_call;
      if (typeof fc === 'object' && fc !== null) {
        const call = fc as Record<string, unknown>;
        let argsValue: unknown = call.args ?? call.argsJson;
        fragments.push({
          kind: 'tool_use',
          id: String(call.id || call.callId || call.name || crypto.randomUUID().replace(/-/g, '')),
          name: String(call.name || ''),
          args_json: typeof argsValue === 'string' ? argsValue : JSON.stringify(argsValue || {}),
        });
      }
    }

    const finishReason = mapVendorFinishReason(
      candidate.finishReason || raw.finishReason,
    );
    // usage
    const uMeta = raw.usageMetadata || raw.usage_metadata;
    let usage: UsageSummary | undefined;
    if (typeof uMeta === 'object' && uMeta !== null) {
      const u = uMeta as Record<string, unknown>;
      const prompt = asInt(u.promptTokenCount || u.prompt_token_count);
      const comp = asInt(u.candidatesTokenCount || u.candidates_token_count);
      const thought = asInt(u.thoughtsTokenCount || u.thoughts_token_count);
      if (prompt > 0 || comp > 0 || thought > 0) {
        usage = { input_tokens: prompt, output_tokens: comp + thought };
      }
    }
    if (finishReason || usage) {
      const frag: Fragment = { kind: 'finish' };
      if (finishReason) frag.stop_reason = finishReason;
      if (usage) frag.usage = usage;
      fragments.push(frag);
    }
    return fragments;
  }

  // OpenAI format: choices[].delta
  const choices = raw.choices;
  if (Array.isArray(choices) && choices.length) {
    const choice = (typeof choices[0] === 'object' && choices[0] !== null)
      ? choices[0] as Record<string, unknown>
      : {};
    const delta = (typeof choice.delta === 'object' && choice.delta !== null)
      ? choice.delta as Record<string, unknown>
      : {};

    if (delta.content !== undefined) {
      fragments.push({ kind: 'text', text: String(delta.content || '') });
    }

    const finishReason = mapVendorFinishReason(choice.finish_reason);
    if (finishReason) {
      fragments.push({ kind: 'finish', stop_reason: finishReason });
    }
  }

  return fragments;
}

// ---- Main SSE Transformer ----

/**
 * 创建将上游 SSE 流转为 Anthropic Messages SSE 的 TransformStream
 */
export function createAnthropicSSETransform(
  model: string,
  onComplete?: (summary: StreamSummary) => void,
): {
  transform: TransformStream<Uint8Array, Uint8Array>;
  summary: StreamSummary;
} {
  const summary = newSummary(model);
  const encoder = new TextEncoder();
  const normalizedModel = model.trim().toLowerCase();
  const strictWrapped = SUPPORTED_ANTHROPIC_MODELS.has(normalizedModel) || normalizedModel.startsWith('claude');

  let started = false;
  let nextBlockIndex = 0;
  let activeBlockType: string | null = null;
  let activeBlockIndex = -1;
  let gotMessageStop = false;
  let lineBuffer = '';

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

        const payload = parseJsonSafe(jsonText);
        if (!payload) continue;

        // Handle wrapped events
        const wrappedRaw = payload.raw_response_json;

        if (strictWrapped) {
          if (payload.turn_complete) continue;
          if (wrappedRaw === undefined) continue;

          const rawEvent = typeof wrappedRaw === 'string'
            ? parseJsonSafe(wrappedRaw)
            : (typeof wrappedRaw === 'object' && wrappedRaw !== null ? wrappedRaw as Record<string, unknown> : null);

          if (!rawEvent || !rawEvent.type) continue;

          const eventName = String(rawEvent.type);
          if (eventName === 'message_stop') gotMessageStop = true;

          if (!started && eventName !== 'message_start') {
            started = true;
            controller.enqueue(encoder.encode(formatSSE('message_start', fallbackMessageStart(model))));
          }
          if (eventName === 'message_start') {
            started = true;
            const msg = rawEvent.message as Record<string, unknown> | undefined;
            if (msg) msg.model = model;
          }

          updateSummaryFromEvent(summary, eventName, rawEvent);
          controller.enqueue(encoder.encode(formatSSE(eventName, rawEvent)));
          continue;
        }

        // Non-strict (Gemini/OpenAI) path
        let rawEvent: Record<string, unknown> | null = null;
        if (wrappedRaw !== undefined) {
          rawEvent = typeof wrappedRaw === 'string'
            ? parseJsonSafe(wrappedRaw)
            : (typeof wrappedRaw === 'object' && wrappedRaw !== null ? wrappedRaw as Record<string, unknown> : null);
        }
        if (!rawEvent) rawEvent = payload;

        // If it's an Anthropic event
        if (rawEvent.type) {
          const eventName = String(rawEvent.type);
          if (eventName === 'message_stop') gotMessageStop = true;
          if (!started && eventName !== 'message_start') {
            started = true;
            controller.enqueue(encoder.encode(formatSSE('message_start', fallbackMessageStart(model))));
          }
          if (eventName === 'message_start') started = true;
          updateSummaryFromEvent(summary, eventName, rawEvent);
          controller.enqueue(encoder.encode(formatSSE(eventName, rawEvent)));
          continue;
        }

        // Extract fragments from Gemini/OpenAI
        const fragments = extractContentFragments(rawEvent);

        for (const frag of fragments) {
          if (!started) {
            started = true;
            controller.enqueue(encoder.encode(formatSSE('message_start', fallbackMessageStart(model))));
          }

          if (frag.kind === 'text' || frag.kind === 'thinking') {
            if (activeBlockType !== frag.kind) {
              if (activeBlockType !== null) {
                controller.enqueue(encoder.encode(formatSSE('content_block_stop', {
                  type: 'content_block_stop', index: activeBlockIndex,
                })));
              }
              activeBlockType = frag.kind;
              activeBlockIndex = nextBlockIndex++;
              const blockPayload = frag.kind === 'thinking'
                ? { type: 'content_block_start', index: activeBlockIndex, content_block: { type: 'thinking', thinking: '' } }
                : { type: 'content_block_start', index: activeBlockIndex, content_block: { type: 'text', text: '' } };
              controller.enqueue(encoder.encode(formatSSE('content_block_start', blockPayload)));
            }

            const deltaPayload = frag.kind === 'thinking'
              ? { type: 'content_block_delta', index: activeBlockIndex, delta: { type: 'thinking_delta', thinking: frag.text || '' } }
              : { type: 'content_block_delta', index: activeBlockIndex, delta: { type: 'text_delta', text: frag.text || '' } };
            controller.enqueue(encoder.encode(formatSSE('content_block_delta', deltaPayload)));

            if (frag.kind === 'text') summary.text_chars += (frag.text || '').length;
            else summary.thinking_chars += (frag.text || '').length;
          } else if (frag.kind === 'signature' && activeBlockType === 'thinking') {
            controller.enqueue(encoder.encode(formatSSE('content_block_delta', {
              type: 'content_block_delta', index: activeBlockIndex,
              delta: { type: 'signature_delta', signature: frag.signature || '' },
            })));
          } else if (frag.kind === 'tool_use') {
            if (activeBlockType !== null) {
              controller.enqueue(encoder.encode(formatSSE('content_block_stop', {
                type: 'content_block_stop', index: activeBlockIndex,
              })));
              activeBlockType = null;
            }
            const toolIndex = nextBlockIndex++;
            summary.tool_use_blocks++;
            controller.enqueue(encoder.encode(formatSSE('content_block_start', {
              type: 'content_block_start', index: toolIndex,
              content_block: { type: 'tool_use', id: frag.id, name: frag.name, input: {} },
            })));
            if (frag.args_json) {
              controller.enqueue(encoder.encode(formatSSE('content_block_delta', {
                type: 'content_block_delta', index: toolIndex,
                delta: { type: 'input_json_delta', partial_json: frag.args_json },
              })));
              summary.tool_json_chars += frag.args_json.length;
            }
            controller.enqueue(encoder.encode(formatSSE('content_block_stop', {
              type: 'content_block_stop', index: toolIndex,
            })));
          } else if (frag.kind === 'finish') {
            if (activeBlockType !== null) {
              controller.enqueue(encoder.encode(formatSSE('content_block_stop', {
                type: 'content_block_stop', index: activeBlockIndex,
              })));
              activeBlockType = null;
            }
            const msgDelta: Record<string, unknown> = { type: 'message_delta' };
            if (frag.stop_reason) {
              msgDelta.delta = { stop_reason: frag.stop_reason, stop_sequence: null };
              summary.stop_reason = frag.stop_reason;
            }
            if (frag.usage) {
              msgDelta.usage = frag.usage;
              summary.usage.input_tokens = Math.max(summary.usage.input_tokens, frag.usage.input_tokens);
              summary.usage.output_tokens = Math.max(summary.usage.output_tokens, frag.usage.output_tokens);
            }
            controller.enqueue(encoder.encode(formatSSE('message_delta', msgDelta)));
          }
        }
      }
    },

    flush(controller) {
      if (activeBlockType !== null) {
        controller.enqueue(encoder.encode(formatSSE('content_block_stop', {
          type: 'content_block_stop', index: activeBlockIndex,
        })));
      }
      if (started && !gotMessageStop && !strictWrapped) {
        controller.enqueue(encoder.encode(formatSSE('message_stop', { type: 'message_stop' })));
      }
      if (onComplete) onComplete(summary);
    },
  });

  return { transform, summary };
}

function updateSummaryFromEvent(
  summary: StreamSummary,
  eventName: string,
  payload: Record<string, unknown>,
): void {
  if (eventName === 'message_start') {
    const msg = payload.message as Record<string, unknown> | undefined;
    if (msg) {
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage) {
        summary.usage.input_tokens = Math.max(summary.usage.input_tokens, asInt(usage.input_tokens));
        summary.usage.output_tokens = Math.max(summary.usage.output_tokens, asInt(usage.output_tokens));
      }
    }
  } else if (eventName === 'content_block_start') {
    summary.content_blocks++;
    const block = payload.content_block as Record<string, unknown> | undefined;
    if (block && block.type === 'tool_use') summary.tool_use_blocks++;
  } else if (eventName === 'content_block_delta') {
    const delta = payload.delta as Record<string, unknown> | undefined;
    if (delta) {
      if (delta.text !== undefined) summary.text_chars += String(delta.text || '').length;
      if (delta.thinking !== undefined) summary.thinking_chars += String(delta.thinking || '').length;
      if (delta.partial_json !== undefined) summary.tool_json_chars += String(delta.partial_json || '').length;
    }
  } else if (eventName === 'message_delta') {
    const usage = payload.usage as Record<string, unknown> | undefined;
    if (usage) {
      summary.usage.input_tokens = Math.max(summary.usage.input_tokens, asInt(usage.input_tokens));
      summary.usage.output_tokens = Math.max(summary.usage.output_tokens, asInt(usage.output_tokens));
    }
    const delta = payload.delta as Record<string, unknown> | undefined;
    if (delta && delta.stop_reason) summary.stop_reason = String(delta.stop_reason);
  }
}

// ---- OpenAI Chat SSE Transform ----

export function createOpenAIChatSSETransform(
  model: string,
  onComplete?: (summary: StreamSummary) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const anthropicTransform = createAnthropicSSETransform(model);
  const summary = anthropicTransform.summary;
  const encoder = new TextEncoder();
  const completionId = `chatcmpl_${crypto.randomUUID().replace(/-/g, '')}`;
  const created = Math.floor(Date.now() / 1000);

  let emittedRole = false;
  let finishEmitted = false;
  let activeToolIndex = -1;
  let anthropicLineBuffer = '';

  function buildChunk(choices: Array<Record<string, unknown>>): string {
    return `data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices,
    })}\n\n`;
  }

  function mapFinishReason(stopReason: string, hasTools: boolean): string {
    const n = stopReason.trim().toLowerCase();
    if (hasTools || n === 'tool_use' || n === 'function_call') return 'tool_calls';
    if (n === 'max_tokens' || n === 'length') return 'length';
    return 'stop';
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      anthropicLineBuffer += text;

      const lines = anthropicLineBuffer.split('\n');
      anthropicLineBuffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('event:') && !line.startsWith('data:')) continue;

        // Parse Anthropic SSE events
        if (line.startsWith('event:')) continue; // skip event line, we process data

        if (!line.startsWith('data:')) continue;
        const jsonText = line.slice(5).trim();
        const payload = parseJsonSafe(jsonText);
        if (!payload || !payload.type) continue;

        const eventName = String(payload.type);

        if (!emittedRole) {
          emittedRole = true;
          controller.enqueue(encoder.encode(buildChunk([
            { index: 0, delta: { role: 'assistant' }, finish_reason: null },
          ])));
        }

        if (eventName === 'content_block_start') {
          const block = payload.content_block as Record<string, unknown> | undefined;
          if (block && block.type === 'tool_use') {
            activeToolIndex++;
            controller.enqueue(encoder.encode(buildChunk([{
              index: 0,
              delta: {
                tool_calls: [{
                  index: activeToolIndex,
                  id: String(block.id || crypto.randomUUID().replace(/-/g, '')),
                  type: 'function',
                  function: { name: String(block.name || ''), arguments: '' },
                }],
              },
              finish_reason: null,
            }])));
          }
        } else if (eventName === 'content_block_delta') {
          const delta = payload.delta as Record<string, unknown> | undefined;
          if (delta) {
            if (delta.text !== undefined) {
              controller.enqueue(encoder.encode(buildChunk([{
                index: 0,
                delta: { content: String(delta.text || '') },
                finish_reason: null,
              }])));
            }
            if (delta.partial_json !== undefined && activeToolIndex >= 0) {
              controller.enqueue(encoder.encode(buildChunk([{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: activeToolIndex,
                    function: { arguments: String(delta.partial_json || '') },
                  }],
                },
                finish_reason: null,
              }])));
            }
          }
        } else if (eventName === 'message_delta') {
          const delta = payload.delta as Record<string, unknown> | undefined;
          if (delta && delta.stop_reason) {
            finishEmitted = true;
            controller.enqueue(encoder.encode(buildChunk([{
              index: 0,
              delta: {},
              finish_reason: mapFinishReason(String(delta.stop_reason), summary.tool_use_blocks > 0),
            }])));
          }
        }
      }
    },

    flush(controller) {
      if (!emittedRole) {
        controller.enqueue(encoder.encode(buildChunk([
          { index: 0, delta: { role: 'assistant' }, finish_reason: null },
        ])));
      }
      if (!finishEmitted) {
        controller.enqueue(encoder.encode(buildChunk([{
          index: 0,
          delta: {},
          finish_reason: mapFinishReason(summary.stop_reason, summary.tool_use_blocks > 0),
        }])));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      if (onComplete) onComplete(summary);
    },
  });

  return transform;
}

export type { StreamSummary };
