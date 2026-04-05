/**
 * 模型目录服务
 * 从上游 API 获取模型列表，KV 缓存 60s
 */

import type { Env, ModelCatalogEntry } from '../types';
import { AccioClient } from './accio-client';
import { listEnabledAccounts } from '../db/accounts';

const CACHE_KEY = 'cache:model_catalog';
const CACHE_TTL = 60; // seconds

function asInt(value: unknown, defaultVal = 0): number {
  try {
    const n = parseInt(String(value), 10);
    return isNaN(n) ? defaultVal : n;
  } catch {
    return defaultVal;
  }
}

function normalizeModelName(value: unknown): string {
  return String(value || '').trim();
}

export function normalizeGeminiModelName(value: unknown): string {
  const normalized = normalizeModelName(value);
  if (normalized.toLowerCase().startsWith('models/')) {
    return normalized.slice(7).trim();
  }
  return normalized;
}

export function isImageGenerationModel(modelName: unknown): boolean {
  return normalizeModelName(modelName).toLowerCase().includes('image-preview');
}

export function extractModelCatalog(payload: Record<string, unknown>): ModelCatalogEntry[] {
  const data = payload.data;
  if (!Array.isArray(data)) return [];

  const catalog: ModelCatalogEntry[] = [];

  for (const providerItem of data) {
    if (typeof providerItem !== 'object' || providerItem === null) continue;
    const item = providerItem as Record<string, unknown>;
    const provider = String(item.provider || '').trim().toLowerCase();
    const providerDisplayName = String(item.providerDisplayName || provider).trim();
    const modelList = item.modelList;
    if (!Array.isArray(modelList)) continue;

    for (const modelItem of modelList) {
      if (typeof modelItem !== 'object' || modelItem === null) continue;
      const m = modelItem as Record<string, unknown>;
      const modelName = String(m.modelName || '').trim();
      if (!modelName) continue;

      catalog.push({
        provider,
        providerDisplayName,
        modelName,
        modelDisplayName: String(m.modelDisplayName || modelName),
        group: String(m.group || '').trim(),
        multimodal: !!m.multimodal,
        visible: !!m.visible,
        thinkLevel: m.thinkLevel ? String(m.thinkLevel) : null,
        contextWindow: asInt(m.contextWindow),
        isDefault: !!m.isDefault,
        tenant: m.tenant ? String(m.tenant) : null,
        iaiTag: m.iaiTag ? String(m.iaiTag) : null,
        empId: m.empId ? String(m.empId) : null,
        priceApiType: m.priceApiType ? String(m.priceApiType) : null,
      });
    }
  }

  catalog.sort((a, b) => {
    const pa = a.provider;
    const pb = b.provider;
    if (pa !== pb) return pa < pb ? -1 : 1;
    const va = a.visible ? 0 : 1;
    const vb = b.visible ? 0 : 1;
    if (va !== vb) return va - vb;
    return a.modelName < b.modelName ? -1 : a.modelName > b.modelName ? 1 : 0;
  });

  return catalog;
}

export function listModelNames(
  catalog: ModelCatalogEntry[],
  provider?: string,
): Set<string> {
  const providerKey = (provider || '').trim().toLowerCase();
  const names = new Set<string>();
  for (const item of catalog) {
    if (providerKey && item.provider !== providerKey) continue;
    const name = item.modelName.trim();
    if (name) names.add(name);
  }
  return names;
}

export function listProxyModelNames(catalog: ModelCatalogEntry[]): Set<string> {
  const names = new Set<string>();
  for (const item of catalog) {
    const name = normalizeModelName(item.modelName);
    if (!name || isImageGenerationModel(name)) continue;
    names.add(name);
  }
  return names;
}

export function buildOpenAIModelsPayload(catalog: ModelCatalogEntry[]): Record<string, unknown> {
  return {
    object: 'list',
    data: catalog
      .filter((item) => {
        const name = normalizeModelName(item.modelName);
        return name && !isImageGenerationModel(name);
      })
      .map((item) => ({
        id: item.modelName,
        object: 'model',
        owned_by: item.provider || 'unknown',
        display_name: item.modelDisplayName,
        provider_display_name: item.providerDisplayName,
        group: item.group,
        multimodal: item.multimodal,
        visible: item.visible,
        context_window: item.contextWindow,
        is_default: item.isDefault,
      })),
  };
}

export function buildGeminiModelPayload(
  catalog: ModelCatalogEntry[],
  modelName: string,
): Record<string, unknown> | null {
  const normalizedTarget = normalizeGeminiModelName(modelName);
  if (!normalizedTarget) return null;

  for (const item of catalog) {
    if (item.provider !== 'gemini') continue;
    const candidateName = normalizeGeminiModelName(item.modelName);
    if (candidateName !== normalizedTarget) continue;

    const outputLimit = isImageGenerationModel(candidateName) ? 8192 : 16384;
    return {
      name: `models/${candidateName}`,
      baseModelId: candidateName,
      displayName: item.modelDisplayName || candidateName,
      description: `${item.providerDisplayName || 'Gemini'} 动态模型`,
      inputTokenLimit: item.contextWindow || 1_000_000,
      outputTokenLimit: outputLimit,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      multimodal: item.multimodal,
      visible: item.visible,
      group: item.group,
      isDefault: item.isDefault,
    };
  }
  return null;
}

export function buildGeminiModelsPayload(catalog: ModelCatalogEntry[]): Record<string, unknown> {
  const models: Array<Record<string, unknown>> = [];
  for (const item of catalog) {
    if (item.provider !== 'gemini') continue;
    const payload = buildGeminiModelPayload([item], item.modelName);
    if (payload) models.push(payload);
  }
  return { models };
}

/**
 * 获取模型目录（带 KV 缓存）
 */
export async function getModelCatalog(env: Env): Promise<ModelCatalogEntry[]> {
  // 1. 尝试从 KV 缓存读取
  try {
    const cached = await env.KV.get(CACHE_KEY);
    if (cached) {
      return JSON.parse(cached) as ModelCatalogEntry[];
    }
  } catch {
    // ignore cache errors
  }

  // 2. 从上游获取
  const catalog = await fetchModelCatalogFromUpstream(env);

  // 3. 存入 KV 缓存
  if (catalog.length) {
    try {
      await env.KV.put(CACHE_KEY, JSON.stringify(catalog), {
        expirationTtl: CACHE_TTL,
      });
    } catch {
      // ignore cache write errors
    }
  }

  return catalog;
}

async function fetchModelCatalogFromUpstream(env: Env): Promise<ModelCatalogEntry[]> {
  const client = new AccioClient({
    baseUrl: env.ACCIO_BASE_URL || 'https://phoenix-gw.alibaba.com',
    version: env.ACCIO_VERSION || '0.5.6',
  });

  // 用第一个可用账号来查询模型目录
  const accounts = await listEnabledAccounts(env.DB);
  if (!accounts.length) return [];

  const account = accounts[0];
  try {
    const result = await client.queryLlmConfig(account);
    if (!result.success) return [];
    return extractModelCatalog(result);
  } catch {
    return [];
  }
}
