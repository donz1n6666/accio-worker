/**
 * /v1/models 和 /v1beta/models 路由
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { authenticateProxyRequest } from '../auth';
import { jsonResponse } from '../utils';
import {
  getModelCatalog,
  buildOpenAIModelsPayload,
  buildGeminiModelsPayload,
  buildGeminiModelPayload,
} from '../services/model-catalog';

const models = new Hono<{ Bindings: Env }>();

// ---- OpenAI /v1/models ----

models.get('/v1/models', async (c) => {
  const auth = await authenticateProxyRequest(c);
  if (!auth) {
    return jsonResponse(
      { error: { type: 'authentication_error', message: '无效的 API Key' } },
      401,
    );
  }

  const catalog = await getModelCatalog(c.env);
  return jsonResponse(buildOpenAIModelsPayload(catalog));
});

// ---- Gemini /v1beta/models ----

models.get('/v1beta/models', async (c) => {
  const auth = await authenticateProxyRequest(c);
  if (!auth) {
    return jsonResponse(
      { error: { code: 401, message: '无效的 API Key', status: 'UNAUTHENTICATED' } },
      401,
    );
  }

  const catalog = await getModelCatalog(c.env);
  return jsonResponse(buildGeminiModelsPayload(catalog));
});

models.get('/v1beta/models/:modelName', async (c) => {
  const auth = await authenticateProxyRequest(c);
  if (!auth) {
    return jsonResponse(
      { error: { code: 401, message: '无效的 API Key', status: 'UNAUTHENTICATED' } },
      401,
    );
  }

  const modelName = c.req.param('modelName');
  const catalog = await getModelCatalog(c.env);
  const payload = buildGeminiModelPayload(catalog, modelName);
  if (!payload) {
    return jsonResponse(
      { error: { code: 404, message: `模型 ${modelName} 不存在`, status: 'NOT_FOUND' } },
      404,
    );
  }
  return jsonResponse(payload);
});

export default models;
