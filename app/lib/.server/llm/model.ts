import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { env as processEnv } from 'node:process';
import { createScopedLogger } from '~/utils/logger';
import { getAPIKey } from './api-key';
import {
  createWorkersAI,
  DEFAULT_COALESCE_MS,
  isWorkersAIBinding,
  type WorkersAIBinding,
  type WorkersAITransport,
} from './workers-ai';

const logger = createScopedLogger('llm');

const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-20240620';
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Workers AI defaults: every model below is available on the Workers Free plan
 * (10k neurons/day) and answers with plain content, no inline reasoning.
 * Gemma 4 is the cheapest strong option (~130 neurons per Bolt request), the
 * fallbacks are a proven coder model and a long-context generalist.
 */
export const DEFAULT_WORKERS_AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const DEFAULT_WORKERS_AI_FALLBACK_MODELS = [
  '@cf/qwen/qwen2.5-coder-32b-instruct',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
];

/* free TGI backends behind the Hugging Face router tend to reject temperature 0 */
const DEFAULT_OPENAI_TEMPERATURE = 0.2;

/* free providers can cold start, so the first token gets a longer budget */
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export type LLMProvider = 'anthropic' | 'openai' | 'cloudflare';

export type CloudflareTransport = 'binding' | 'rest';

export interface ModelCandidate {
  provider: LLMProvider;

  /** only set for Workers AI: how the model is reached */
  transport?: CloudflareTransport;
  modelId: string;
  model: LanguageModel;
  maxTokens: number;
  headers?: Record<string, string>;
  temperature?: number;
}

export interface StreamTimeouts {
  firstTokenMs: number;
  idleMs: number;
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

function readNumber(cloudflareEnv: Env | undefined, key: string, fallback: number, minimum: number): number {
  const raw = readEnv(cloudflareEnv, key);

  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function readJsonObject(cloudflareEnv: Env | undefined, key: string): Record<string, unknown> | undefined {
  const raw = readEnv(cloudflareEnv, key);

  if (raw === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);

    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    logger.warn(`${key} must be a JSON object, ignoring it`);
  } catch (error) {
    logger.warn(`could not parse ${key} as JSON, ignoring it`, error);
  }

  return undefined;
}

/**
 * Splits a model spec into the model id and an optional output cap.
 *
 * The `model|maxTokens` syntax lets a chain mix models with different limits,
 * for example `LLM_FALLBACK_MODELS=small-model:free|4096,big-model:free`.
 */
function parseModelSpec(spec: string): { modelId: string; maxTokens?: number } {
  const separator = spec.lastIndexOf('|');

  if (separator > 0) {
    const modelId = spec.slice(0, separator).trim();
    const tokens = Number.parseInt(spec.slice(separator + 1).trim(), 10);

    if (modelId !== '' && Number.isFinite(tokens) && tokens > 0) {
      return { modelId, maxTokens: tokens };
    }
  }

  return { modelId: spec.trim() };
}

function parseModelSpecs(raw: string | undefined): { modelId: string; maxTokens?: number }[] {
  return (raw ?? '')
    .split(',')
    .map((spec) => parseModelSpec(spec))
    .filter((spec) => spec.modelId !== '');
}

/**
 * Merges `LLM_EXTRA_BODY` into every outgoing JSON request.
 *
 * Free providers often need vendor specific fields that the OpenAI schema does
 * not know about, e.g. `{"chat_template_kwargs":{"enable_thinking":false}}`.
 */
function withExtraBody(extra: Record<string, unknown> | undefined): typeof fetch | undefined {
  if (extra === undefined) {
    return undefined;
  }

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== 'string') {
      return fetch(input, init);
    }

    try {
      const body = JSON.parse(init.body);
      const headers = new Headers(init.headers);

      headers.delete('content-length');

      return fetch(input, { ...init, headers, body: JSON.stringify({ ...body, ...extra }) });
    } catch {
      logger.warn('LLM_EXTRA_BODY could not be merged into the request body, sending it unchanged');

      return fetch(input, init);
    }
  };
}

/**
 * Max output tokens per segment: `LLM_MAX_TOKENS`, default 8192.
 */
export function getMaxTokens(cloudflareEnv: Env | undefined): number {
  return readNumber(cloudflareEnv, 'LLM_MAX_TOKENS', DEFAULT_MAX_TOKENS, 1);
}

/**
 * How many times a single model is retried on transient errors before Bolt
 * fails over to the next model. Defaults to `0`, because free tiers usually
 * get throttled with 429s and a different model is the better answer.
 */
export function getMaxRetries(cloudflareEnv: Env | undefined): number {
  return readNumber(cloudflareEnv, 'LLM_MAX_RETRIES', 0, 0);
}

/**
 * Stream watchdogs, both optional and configurable per deployment.
 *
 * `firstTokenMs` covers the whole attempt until the first token arrives (model
 * cold starts included), `idleMs` aborts a stream that stops producing tokens.
 */
export function getStreamTimeouts(cloudflareEnv: Env | undefined): StreamTimeouts {
  return {
    firstTokenMs: readNumber(cloudflareEnv, 'LLM_FIRST_TOKEN_TIMEOUT_MS', DEFAULT_FIRST_TOKEN_TIMEOUT_MS, 1000),
    idleMs: readNumber(cloudflareEnv, 'LLM_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS, 1000),
  };
}

/**
 * Optional cheap/fast model for the prompt enhancer (`/api/enhancer`), so that
 * utility calls do not consume the quota of the main coding model.
 */
export function getEnhancerModel(cloudflareEnv: Env): string | undefined {
  return readEnv(cloudflareEnv, 'LLM_ENHANCER_MODEL');
}

/**
 * Human readable name of a candidate for logs and diagnostics, for example
 * `cloudflare:binding/@cf/google/gemma-4-26b-a4b-it` or `openai/gpt-4o`.
 */
export function candidateLabel(candidate: Pick<ModelCandidate, 'provider' | 'transport' | 'modelId'>) {
  const transport = candidate.transport === undefined ? '' : `:${candidate.transport}`;

  return `${candidate.provider}${transport}/${candidate.modelId}`;
}

function dedupe<T extends { modelId: string; transport?: string }>(items: T[]): T[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = `${item.transport ?? ''}|${item.modelId}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

export interface CloudflareAIConfig {
  binding?: WorkersAIBinding;
  accountId?: string;
  apiToken?: string;
  gatewayId?: string;
  baseURL?: string;
  transport: 'auto' | CloudflareTransport;
}

/**
 * Reads everything needed to reach Workers AI.
 *
 * The `AI` binding comes from wrangler.toml (`[ai] binding = "AI"`) and is the
 * zero-config path on Cloudflare. `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`
 * enable the REST API, which also works on a laptop without `wrangler login`.
 */
export function getCloudflareAIConfig(cloudflareEnv: Env | undefined): CloudflareAIConfig {
  const binding = (cloudflareEnv as { AI?: unknown } | undefined)?.AI;
  const transportSetting = readEnv(cloudflareEnv, 'CLOUDFLARE_AI_TRANSPORT')?.toLowerCase();

  return {
    binding: isWorkersAIBinding(binding) ? binding : undefined,
    accountId: readEnv(cloudflareEnv, 'CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID'),
    apiToken: readEnv(cloudflareEnv, 'CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'),
    gatewayId: readEnv(cloudflareEnv, 'CLOUDFLARE_AI_GATEWAY_ID'),
    baseURL: readEnv(cloudflareEnv, 'CLOUDFLARE_AI_BASE_URL'),
    transport: transportSetting === 'binding' || transportSetting === 'rest' ? transportSetting : 'auto',
  };
}

const PROVIDER_ALIASES: Record<string, LLMProvider> = {
  anthropic: 'anthropic',
  openai: 'openai',
  cloudflare: 'cloudflare',
  'cloudflare-ai': 'cloudflare',
  'workers-ai': 'cloudflare',
  workersai: 'cloudflare',
};

function normalizeProvider(value: string | undefined): LLMProvider | undefined {
  return value === undefined ? undefined : PROVIDER_ALIASES[value.toLowerCase()];
}

function cloudflareTransports(config: CloudflareAIConfig): WorkersAITransport[] {
  const transports: WorkersAITransport[] = [];

  if (config.transport !== 'rest' && config.binding !== undefined) {
    transports.push({ kind: 'binding', ai: config.binding, gatewayId: config.gatewayId });
  }

  if (config.transport !== 'binding' && config.accountId !== undefined && config.apiToken !== undefined) {
    transports.push({
      kind: 'rest',
      accountId: config.accountId,
      apiToken: config.apiToken,
      gatewayId: config.gatewayId,
      baseURL: config.baseURL,
    });
  }

  return transports;
}

function buildCloudflareCandidates(
  cloudflareEnv: Env,
  config: CloudflareAIConfig,
  primaryModel: string | undefined,
  fallbackModels: string | undefined,
  defaultMaxTokens: number,
): ModelCandidate[] {
  const transports = cloudflareTransports(config);

  if (transports.length === 0) {
    const why =
      config.transport === 'rest'
        ? 'CLOUDFLARE_AI_TRANSPORT=rest needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.'
        : config.transport === 'binding'
          ? 'CLOUDFLARE_AI_TRANSPORT=binding needs the AI binding: add `[ai] binding = "AI"` to wrangler.toml.'
          : 'Workers AI is not reachable: deploy with the `[ai] binding = "AI"` from wrangler.toml, or set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (see CLOUDFLARE-DEPLOY.md).';

    throw new Error(why);
  }

  /* zero-config: a complete free-plan chain when no model is configured at all */
  const specs =
    primaryModel === undefined
      ? [
          { modelId: DEFAULT_WORKERS_AI_MODEL },
          ...DEFAULT_WORKERS_AI_FALLBACK_MODELS.map((modelId) => ({ modelId })),
          ...parseModelSpecs(fallbackModels),
        ]
      : [...parseModelSpecs(primaryModel), ...parseModelSpecs(fallbackModels)];

  const extraBody = readJsonObject(cloudflareEnv, 'LLM_EXTRA_BODY');
  const headers = readJsonObject(cloudflareEnv, 'LLM_HEADERS') as Record<string, string> | undefined;
  const temperature = readNumber(cloudflareEnv, 'LLM_TEMPERATURE', DEFAULT_OPENAI_TEMPERATURE, 0);
  const coalesceMs = readNumber(cloudflareEnv, 'LLM_STREAM_COALESCE_MS', DEFAULT_COALESCE_MS, 0);
  const factories = transports.map((transport) => ({
    transport,
    create: createWorkersAI(transport, { extraBody, coalesceMs }),
  }));

  const candidates: ModelCandidate[] = [];

  /**
   * Order: every transport of a model before the next model. The binding is
   * first because it needs no secret; the REST API takes over when the binding
   * is unavailable (local dev without `wrangler login`) or fails.
   */
  for (const spec of specs) {
    for (const { transport, create } of factories) {
      candidates.push({
        provider: 'cloudflare',
        transport: transport.kind,
        modelId: spec.modelId,
        model: create(spec.modelId),
        maxTokens: spec.maxTokens ?? defaultMaxTokens,
        headers,
        temperature,
      });
    }
  }

  return dedupe(candidates);
}

/**
 * Builds the ordered list of models that Bolt will try for a request.
 *
 * `LLM_PROVIDER` selects `cloudflare` (Workers AI), `openai` (any
 * OpenAI-compatible endpoint) or `anthropic`, and is auto-detected when unset:
 * an OpenAI-compatible endpoint wins when `LLM_BASE_URL`/`LLM_API_KEY` are set,
 * then `ANTHROPIC_API_KEY`, then Workers AI when its binding or credentials
 * exist. See CLOUDFLARE-DEPLOY.md and FREE-API-SETUP.md for ready to use setups.
 *
 * `ANTHROPIC_API_KEY` and the `OPENAI_*` aliases keep working, so the default
 * Bolt setup is unchanged when none of these variables are set.
 */
export function getModelCandidates(cloudflareEnv: Env, primaryOverride?: string): ModelCandidate[] {
  const defaultMaxTokens = getMaxTokens(cloudflareEnv);
  const headers = readJsonObject(cloudflareEnv, 'LLM_HEADERS') as Record<string, string> | undefined;

  const providerSetting = normalizeProvider(readEnv(cloudflareEnv, 'LLM_PROVIDER'));
  const anthropicKey = getAPIKey(cloudflareEnv);
  const openAIKey = readEnv(cloudflareEnv, 'LLM_API_KEY', 'OPENAI_API_KEY');
  const baseURL = readEnv(cloudflareEnv, 'LLM_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE');
  const cloudflare = getCloudflareAIConfig(cloudflareEnv);
  const cloudflareAvailable =
    cloudflare.binding !== undefined || (cloudflare.accountId !== undefined && cloudflare.apiToken !== undefined);

  let provider: LLMProvider | undefined = providerSetting;

  if (provider === undefined) {
    if (baseURL !== undefined || (openAIKey !== undefined && anthropicKey === undefined)) {
      provider = 'openai';
    } else if (anthropicKey !== undefined) {
      provider = 'anthropic';
    } else if (cloudflareAvailable) {
      provider = 'cloudflare';
    }
  }

  const primaryModel = primaryOverride ?? readEnv(cloudflareEnv, 'LLM_MODEL', 'OPENAI_MODEL');
  const fallbackModels = readEnv(cloudflareEnv, 'LLM_FALLBACK_MODELS');

  if (provider === 'cloudflare') {
    return buildCloudflareCandidates(cloudflareEnv, cloudflare, primaryModel, fallbackModels, defaultMaxTokens);
  }

  if (provider === 'openai') {
    if (openAIKey === undefined && baseURL === undefined) {
      throw new Error(
        'Missing LLM_API_KEY (or OPENAI_API_KEY): set it in .env.local before using the OpenAI-compatible provider.',
      );
    }

    const specs = [...parseModelSpecs(primaryModel), ...parseModelSpecs(fallbackModels)];

    if (specs.length === 0) {
      throw new Error(
        'Missing LLM_MODEL: set it in .env.local (e.g. LLM_MODEL=auto when using a local router) or with any model id your endpoint supports.',
      );
    }

    const openai = createOpenAI({
      apiKey: openAIKey,
      baseURL,
      compatibility: 'compatible',
      fetch: withExtraBody(readJsonObject(cloudflareEnv, 'LLM_EXTRA_BODY')),
    });

    return dedupe(
      specs.map((spec) => ({
        provider: 'openai' as const,
        modelId: spec.modelId,
        model: openai(spec.modelId),
        maxTokens: spec.maxTokens ?? defaultMaxTokens,
        headers,
        temperature: readNumber(cloudflareEnv, 'LLM_TEMPERATURE', DEFAULT_OPENAI_TEMPERATURE, 0),
      })),
    );
  }

  if (anthropicKey === undefined) {
    throw new Error(
      provider === 'anthropic'
        ? 'Missing ANTHROPIC_API_KEY: set it in .env.local, or configure another provider with LLM_PROVIDER.'
        : 'No LLM provider configured. On Cloudflare the `[ai] binding = "AI"` from wrangler.toml (or CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN) enables Workers AI; alternatively set ANTHROPIC_API_KEY, or LLM_PROVIDER/LLM_BASE_URL/LLM_MODEL for an OpenAI-compatible endpoint.',
    );
  }

  const anthropicBaseURL = readEnv(cloudflareEnv, 'ANTHROPIC_BASE_URL');
  const specs = parseModelSpecs(primaryModel);

  if (specs.length === 0) {
    specs.push({ modelId: DEFAULT_ANTHROPIC_MODEL });
  }

  const anthropic = createAnthropic({
    apiKey: anthropicKey,
    baseURL: anthropicBaseURL,
  });

  /* required for 8192 max tokens with claude-3-5-sonnet, not sent to custom proxies */
  const anthropicHeaders = {
    ...(anthropicBaseURL === undefined ? { 'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15' } : {}),
    ...headers,
  };

  return dedupe(
    [...specs, ...parseModelSpecs(fallbackModels)].map((spec) => ({
      provider: 'anthropic' as const,
      modelId: spec.modelId,
      model: anthropic(spec.modelId),
      maxTokens: spec.maxTokens ?? defaultMaxTokens,
      headers: anthropicHeaders,
      temperature: readNumber(cloudflareEnv, 'LLM_TEMPERATURE', 0, 0),
    })),
  );
}

/**
 * Kept for backwards compatibility: returns a single Anthropic model.
 */
export function getAnthropicModel(apiKey: string) {
  return createAnthropic({ apiKey })(DEFAULT_ANTHROPIC_MODEL);
}
