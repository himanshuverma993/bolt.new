import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { env as processEnv } from 'node:process';
import { createScopedLogger } from '~/utils/logger';
import { getAPIKey } from './api-key';

const logger = createScopedLogger('llm');

const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-20240620';
const DEFAULT_MAX_TOKENS = 8192;

export type LLMProvider = 'anthropic' | 'openai';

export interface ModelCandidate {
  provider: LLMProvider;
  modelId: string;
  model: LanguageModel;
  maxTokens: number;
  headers?: Record<string, string>;
}

/**
 * Reads a configuration value from `process.env` (dev server / `.env.local`)
 * or from the Cloudflare bindings (production / `wrangler pages dev`).
 *
 * The first non-empty value wins, and `keys` are checked in order so that an
 * alias can be used (e.g. `LLM_API_KEY` then `OPENAI_API_KEY`).
 */
function readEnv(cloudflareEnv: Env | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const fromProcess = processEnv?.[key];
    const fromCloudflare = (cloudflareEnv as Record<string, unknown> | undefined)?.[key];

    for (const value of [fromProcess, fromCloudflare]) {
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim();
      }
    }
  }

  return undefined;
}

function readInt(cloudflareEnv: Env | undefined, key: string, fallback: number, minimum: number): number {
  const raw = readEnv(cloudflareEnv, key);

  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function readMaxTokens(cloudflareEnv: Env | undefined): number {
  return readInt(cloudflareEnv, 'LLM_MAX_TOKENS', DEFAULT_MAX_TOKENS, 1);
}

/**
 * How many times a single model is retried on transient errors before Bolt
 * fails over to the next model. Defaults to `0`, because free tiers usually
 * get throttled with 429s and a different model is the better answer.
 */
export function getMaxRetries(cloudflareEnv: Env | undefined): number {
  return readInt(cloudflareEnv, 'LLM_MAX_RETRIES', 0, 0);
}

function readHeaders(cloudflareEnv: Env | undefined): Record<string, string> | undefined {
  const raw = readEnv(cloudflareEnv, 'LLM_HEADERS');

  if (raw === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
    }

    logger.warn('LLM_HEADERS must be a JSON object, ignoring it');
  } catch (error) {
    logger.warn('Could not parse LLM_HEADERS as JSON, ignoring it', error);
  }

  return undefined;
}

function parseModelList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((modelId) => modelId.trim())
    .filter((modelId) => modelId !== '');
}

/**
 * Builds the ordered list of models that Bolt will try for a request.
 *
 * `LLM_PROVIDER` selects `anthropic` or `openai` and is auto-detected when unset.
 * The OpenAI-compatible provider reads `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`,
 * `LLM_FALLBACK_MODELS`, `LLM_MAX_TOKENS`, `LLM_MAX_RETRIES` and `LLM_HEADERS`
 * from `.env.local` or from the Cloudflare bindings. See FREE-API-SETUP.md for
 * ready to use examples with free providers and routers.
 *
 * `ANTHROPIC_API_KEY` and the `OPENAI_*` aliases keep working, so the default
 * Bolt setup is unchanged when none of these variables are set.
 */
export function getModelCandidates(cloudflareEnv: Env, primaryOverride?: string): ModelCandidate[] {
  const maxTokens = readMaxTokens(cloudflareEnv);
  const headers = readHeaders(cloudflareEnv);

  const providerSetting = readEnv(cloudflareEnv, 'LLM_PROVIDER')?.toLowerCase();
  const anthropicKey = getAPIKey(cloudflareEnv);
  const openAIKey = readEnv(cloudflareEnv, 'LLM_API_KEY', 'OPENAI_API_KEY');
  const baseURL = readEnv(cloudflareEnv, 'LLM_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE');

  const useOpenAI =
    providerSetting === 'openai' ||
    (providerSetting !== 'anthropic' && baseURL !== undefined) ||
    (providerSetting !== 'anthropic' && openAIKey !== undefined && anthropicKey === undefined);

  const primaryModel = primaryOverride ?? readEnv(cloudflareEnv, 'LLM_MODEL', 'OPENAI_MODEL');
  const fallbackModels = parseModelList(readEnv(cloudflareEnv, 'LLM_FALLBACK_MODELS'));

  if (useOpenAI) {
    if (openAIKey === undefined && baseURL === undefined) {
      throw new Error(
        'Missing LLM_API_KEY (or OPENAI_API_KEY): set it in .env.local before using the OpenAI-compatible provider.',
      );
    }

    const modelIds = [primaryModel, ...fallbackModels].filter((modelId): modelId is string => modelId !== undefined);

    if (modelIds.length === 0) {
      throw new Error(
        'Missing LLM_MODEL: set it in .env.local (e.g. LLM_MODEL=auto when using a local router) or with any model id your endpoint supports.',
      );
    }

    const openai = createOpenAI({
      apiKey: openAIKey,
      baseURL,
      compatibility: 'compatible',
    });

    return [...new Set(modelIds)].map((modelId) => ({
      provider: 'openai' as const,
      modelId,
      model: openai(modelId),
      maxTokens,
      headers,
    }));
  }

  if (anthropicKey === undefined) {
    throw new Error(
      'Missing ANTHROPIC_API_KEY: set it in .env.local, or configure an OpenAI-compatible endpoint with LLM_PROVIDER/LLM_BASE_URL/LLM_MODEL.',
    );
  }

  const anthropicBaseURL = readEnv(cloudflareEnv, 'ANTHROPIC_BASE_URL');
  const modelIds = [primaryModel ?? DEFAULT_ANTHROPIC_MODEL, ...fallbackModels];

  const anthropic = createAnthropic({
    apiKey: anthropicKey,
    baseURL: anthropicBaseURL,
  });

  /* required for 8192 max tokens with claude-3-5-sonnet, not sent to custom proxies */
  const anthropicHeaders = {
    ...(anthropicBaseURL === undefined ? { 'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15' } : {}),
    ...headers,
  };

  return [...new Set(modelIds)].map((modelId) => ({
    provider: 'anthropic' as const,
    modelId,
    model: anthropic(modelId),
    maxTokens,
    headers: anthropicHeaders,
  }));
}

/**
 * Optional cheap/fast model for the prompt enhancer (`/api/enhancer`), so that
 * utility calls do not consume the quota of the main coding model.
 */
export function getEnhancerModel(cloudflareEnv: Env): string | undefined {
  return readEnv(cloudflareEnv, 'LLM_ENHANCER_MODEL');
}

/**
 * Kept for backwards compatibility: returns a single Anthropic model.
 */
export function getAnthropicModel(apiKey: string) {
  return createAnthropic({ apiKey })(DEFAULT_ANTHROPIC_MODEL);
}
