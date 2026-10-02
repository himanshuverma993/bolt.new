#!/usr/bin/env node
/**
 * Preflight check for the configured LLM chain.
 *
 * Reads `.env.local`, then pings every model in `LLM_MODEL` and
 * `LLM_FALLBACK_MODELS` (the `model|maxTokens` syntax is supported) and prints
 * which ones answer. This is the fastest way to separate "wrong key or URL"
 * from "wrong model id" before starting the dev server.
 *
 * Run it from the repo root, optionally with a timeout and a model limit.
 * The exit code is 1 when no model answers, 0 otherwise.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_PROMPT = 'Reply with the single word: pong';

function parseArgs(argv) {
  const options = { env: '.env.local', timeout: DEFAULT_TIMEOUT_MS, limit: Number.POSITIVE_INFINITY };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--env' && next !== undefined) {
      options.env = next;
      index++;
    } else if (arg === '--timeout' && next !== undefined) {
      options.timeout = Number(next);
      index++;
    } else if (arg === '--limit' && next !== undefined) {
      options.limit = Number(next);
      index++;
    }
  }

  return options;
}

function parseEnvFile(path) {
  let raw;

  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  const values = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');

    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function parseModelSpecs(raw) {
  return (raw ?? '')
    .split(',')
    .map((spec) => spec.trim())
    .filter((spec) => spec !== '')
    .map((spec) => {
      const separator = spec.lastIndexOf('|');

      if (separator > 0) {
        const tokens = Number.parseInt(spec.slice(separator + 1).trim(), 10);

        if (Number.isFinite(tokens) && tokens > 0) {
          return { modelId: spec.slice(0, separator).trim(), maxTokens: tokens };
        }
      }

      return { modelId: spec, maxTokens: undefined };
    });
}

function pick(env, keys) {
  for (const key of keys) {
    const value = process.env[key] ?? env[key];

    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return undefined;
}

/**
 * Sends one streaming chat completion and resolves as soon as the first content
 * delta arrives.
 */
async function pingModel({ baseURL, apiKey, modelId, maxTokens, extraBody, timeoutMs }) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: DEFAULT_PROMPT }],
        max_tokens: maxTokens ?? 32,
        stream: true,
        ...(extraBody ?? {}),
      }),
      signal: abort.signal,
    });

    if (!response.ok) {
      const detail = await response.text();

      return { ok: false, ms: Date.now() - started, error: `HTTP ${response.status}: ${detail.slice(0, 200)}` };
    }

    const reader = response.body?.getReader();

    if (reader === undefined) {
      return { ok: false, ms: Date.now() - started, error: 'the provider sent no response body' };
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      if (buffer.includes('"content"') || buffer.includes('"delta"')) {
        abort.abort();

        return { ok: true, ms: Date.now() - started };
      }
    }

    return { ok: false, ms: Date.now() - started, error: 'the stream ended without any content' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return { ok: false, ms: Date.now() - started, error: detail };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const envPath = resolve(process.cwd(), options.env);
  const fileEnv = parseEnvFile(envPath);

  if (fileEnv === undefined) {
    console.error(`[check-llm] ${envPath} not found. Copy .env.example to .env.local first.`);
    process.exitCode = 1;

    return;
  }

  const baseURL = pick(fileEnv, ['LLM_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE']);
  const apiKey = pick(fileEnv, ['LLM_API_KEY', 'OPENAI_API_KEY']);
  const primary = pick(fileEnv, ['LLM_MODEL', 'OPENAI_MODEL']);

  if (baseURL === undefined || primary === undefined) {
    const provider = pick(fileEnv, ['LLM_PROVIDER']);

    console.log(
      provider === 'anthropic' || pick(fileEnv, ['ANTHROPIC_API_KEY']) === undefined
        ? '[check-llm] no OpenAI-compatible endpoint configured (LLM_BASE_URL / LLM_MODEL missing).'
        : '[check-llm] Anthropic is configured; run the app and use GET /api/llm-check for Anthropic diagnostics.',
    );

    return;
  }

  const specs = [...parseModelSpecs(primary), ...parseModelSpecs(pick(fileEnv, ['LLM_FALLBACK_MODELS']))].slice(
    0,
    options.limit,
  );

  let extraBody;

  const rawExtra = pick(fileEnv, ['LLM_EXTRA_BODY']);

  if (rawExtra !== undefined) {
    try {
      extraBody = JSON.parse(rawExtra);
    } catch {
      console.warn('[check-llm] LLM_EXTRA_BODY is not valid JSON, ignoring it');
    }
  }

  console.log(`[check-llm] endpoint: ${baseURL}`);
  console.log(`[check-llm] models:   ${specs.map((spec) => spec.modelId).join(' -> ')}`);
  console.log('');

  let anyOk = false;

  for (const spec of specs) {
    process.stdout.write(`  ${spec.modelId} ... `);

    const result = await pingModel({
      baseURL,
      apiKey,
      modelId: spec.modelId,
      maxTokens: spec.maxTokens,
      extraBody,
      timeoutMs: options.timeout,
    });

    if (result.ok) {
      anyOk = true;
      console.log(`OK (first token in ${result.ms}ms)`);
    } else {
      console.log(`FAILED after ${result.ms}ms`);
      console.log(`      ${result.error}`);
    }
  }

  console.log('');

  if (anyOk) {
    console.log('[check-llm] at least one model answered, the chain is usable.');
  } else {
    console.error('[check-llm] no model answered. Check the base URL, the key and the model ids.');
    process.exitCode = 1;
  }
}

await main();
