import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- the mock provider lives in scripts/
import { startMockProvider } from '../../../../scripts/mock-openai-server.mjs';
import { getModelCandidates } from './model';
import { streamText, type Messages, type StreamingOptions } from './stream-text';

const LLM_ENV_KEYS = [
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_FALLBACK_MODELS',
  'LLM_MAX_TOKENS',
  'LLM_MAX_RETRIES',
  'LLM_TEMPERATURE',
  'LLM_HEADERS',
  'LLM_EXTRA_BODY',
  'LLM_FIRST_TOKEN_TIMEOUT_MS',
  'LLM_IDLE_TIMEOUT_MS',
  'LLM_ENHANCER_MODEL',
  'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
] as const;

interface MockCall {
  model: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface MockProvider {
  url: string;
  port: number;
  requests: string[];
  calls: MockCall[];
  close(): Promise<void>;
}

interface MockOptions {
  failModels?: string[];
  stallModels?: string[];
  stallAfterFirstChunkModels?: string[];
}

const messages: Messages = [{ role: 'user', content: 'hello' }];
const env = {} as Env;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(LLM_ENV_KEYS.map((key) => [key, process.env[key]]));
  LLM_ENV_KEYS.forEach((key) => delete process.env[key]);
});

afterEach(() => {
  LLM_ENV_KEYS.forEach((key) => {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  });
});

async function startMock(options?: MockOptions): Promise<MockProvider> {
  return (await startMockProvider(options)) as unknown as MockProvider;
}

/** Opens the stream and returns its readable side, the way the routes use it. */
async function open(
  options?: StreamingOptions,
  modelOverride?: string,
  currentMessages: Messages = messages,
): Promise<ReadableStream<Uint8Array>> {
  const stream = await streamText(currentMessages, env, options, modelOverride);

  return stream.toAIStream();
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let output = '';
  const reader = stream.getReader();

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    output += decoder.decode(value, { stream: true });
  }

  return output;
}

function useOpenAI(baseURL: string) {
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_BASE_URL = baseURL;
  process.env.LLM_API_KEY = 'test-key';
}

describe('streamText with an OpenAI-compatible provider', () => {
  it('falls back to the next model when the primary one is throttled', async () => {
    const mock = await startMock({ failModels: ['mock-fail', 'mock-fail-2'] });

    try {
      useOpenAI(mock.url);
      process.env.LLM_MODEL = 'mock-fail';
      process.env.LLM_FALLBACK_MODELS = 'mock-fail-2, mock-ok';

      const output = await collect(await open());

      expect(mock.requests).toEqual(['mock-fail', 'mock-fail-2', 'mock-ok']);
      expect(output).toContain('boltArtifact');
      expect(output).toContain('hello.txt');
    } finally {
      await mock.close();
    }
  });

  it('fails when every candidate is throttled', async () => {
    const mock = await startMock({ failModels: ['mock-fail'] });

    try {
      useOpenAI(mock.url);
      process.env.LLM_MODEL = 'mock-fail';

      await expect(open()).rejects.toThrow(/429|Too Many Requests/i);
      expect(mock.requests).toEqual(['mock-fail']);
    } finally {
      await mock.close();
    }
  });

  it('sends the configured max tokens and enhancer model', async () => {
    const mock = await startMock();

    try {
      useOpenAI(mock.url);
      process.env.LLM_MODEL = 'mock-main';
      process.env.LLM_MAX_TOKENS = '1024';

      const candidates = getModelCandidates(env);

      expect(candidates.map((candidate) => candidate.modelId)).toEqual(['mock-main']);
      expect(candidates[0].maxTokens).toBe(1024);

      const output = await collect(await open(undefined, 'mock-enhancer'));

      expect(output).toContain('boltArtifact');
      expect(mock.requests).toEqual(['mock-enhancer']);
      expect(mock.calls[0]?.body.max_tokens).toBe(1024);
    } finally {
      await mock.close();
    }
  });

  it('fails over when the first model hangs before its first token', async () => {
    const mock = await startMock({ stallModels: ['mock-stall'] });

    try {
      useOpenAI(mock.url);
      process.env.LLM_MODEL = 'mock-stall';
      process.env.LLM_FALLBACK_MODELS = 'mock-ok';
      process.env.LLM_FIRST_TOKEN_TIMEOUT_MS = '1000';

      const output = await collect(await open());

      expect(mock.requests).toEqual(['mock-stall', 'mock-ok']);
      expect(output).toContain('boltArtifact');
    } finally {
      await mock.close();
    }
  });

  it('stops a stream that goes silent in the middle', async () => {
    const mock = await startMock({ stallAfterFirstChunkModels: ['mock-stall-mid'] });

    try {
      useOpenAI(mock.url);
      process.env.LLM_MODEL = 'mock-stall-mid';
      process.env.LLM_IDLE_TIMEOUT_MS = '1000';

      await expect(collect(await open())).rejects.toThrow(/timed out/i);
      expect(mock.requests).toEqual(['mock-stall-mid']);
    } finally {
      await mock.close();
    }
  });

  it('sends the OpenAI-compatible defaults: temperature, extra body and per-model caps', async () => {
    const mock = await startMock();

    try {
      useOpenAI(mock.url);
      process.env.LLM_MODEL = 'mock-ok|1024';
      process.env.LLM_FALLBACK_MODELS = 'mock-ok-2|2048';
      process.env.LLM_HEADERS = '{"x-bolt-test":"yes"}';
      process.env.LLM_EXTRA_BODY = '{"chat_template_kwargs":{"enable_thinking":false}}';

      const output = await collect(await open());

      expect(output).toContain('boltArtifact');

      const [call] = mock.calls;

      expect(mock.calls).toHaveLength(1);
      expect(call.model).toBe('mock-ok');
      expect(call.body.max_tokens).toBe(1024);
      expect(call.body.temperature).toBe(0.2);
      expect(call.body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(call.headers['x-bolt-test']).toBe('yes');

      const candidates = getModelCandidates(env);

      expect(candidates.map((candidate) => candidate.maxTokens)).toEqual([1024, 2048]);
    } finally {
      await mock.close();
    }
  });

  it('honours an explicit temperature', async () => {
    const mock = await startMock();

    try {
      useOpenAI(mock.url);
      process.env.LLM_MODEL = 'mock-ok';
      process.env.LLM_TEMPERATURE = '0';

      await collect(await open());

      expect(mock.calls[0]?.body.temperature).toBe(0);
    } finally {
      await mock.close();
    }
  });

  it('requires a model id for the OpenAI-compatible provider', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.LLM_API_KEY = 'test-key';

    expect(() => getModelCandidates(env)).toThrow(/LLM_MODEL/);
  });

  it('keeps working with the Anthropic defaults', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const candidates = getModelCandidates(env);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].provider).toBe('anthropic');
    expect(candidates[0].modelId).toBe('claude-3-5-sonnet-20240620');
  });
});
