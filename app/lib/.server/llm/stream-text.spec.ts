import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- the mock provider lives in scripts/
import { startMockProvider } from '../../../../scripts/mock-openai-server.mjs';
import { getModelCandidates } from './model';
import { streamText, type Messages } from './stream-text';

const LLM_ENV_KEYS = [
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_FALLBACK_MODELS',
  'LLM_MAX_TOKENS',
  'LLM_MAX_RETRIES',
  'LLM_ENHANCER_MODEL',
  'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
] as const;

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

describe('streamText with an OpenAI-compatible provider', () => {
  it('falls back to the next model when the primary one is throttled', async () => {
    const mock = await startMockProvider({ failModels: ['mock-fail', 'mock-fail-2'] });

    try {
      process.env.LLM_PROVIDER = 'openai';
      process.env.LLM_BASE_URL = mock.url;
      process.env.LLM_API_KEY = 'test-key';
      process.env.LLM_MODEL = 'mock-fail';
      process.env.LLM_FALLBACK_MODELS = 'mock-fail-2, mock-ok';

      const output = await collect(streamText(messages, env).toAIStream());

      expect(mock.requests).toEqual(['mock-fail', 'mock-fail-2', 'mock-ok']);
      expect(output).toContain('boltArtifact');
      expect(output).toContain('hello.txt');
    } finally {
      await mock.close();
    }
  });

  it('fails when every candidate is throttled', async () => {
    const mock = await startMockProvider({ failModels: ['mock-fail'] });

    try {
      process.env.LLM_PROVIDER = 'openai';
      process.env.LLM_BASE_URL = mock.url;
      process.env.LLM_API_KEY = 'test-key';
      process.env.LLM_MODEL = 'mock-fail';

      await expect(collect(streamText(messages, env).toAIStream())).rejects.toThrow();
      expect(mock.requests).toEqual(['mock-fail']);
    } finally {
      await mock.close();
    }
  });

  it('sends the configured max tokens and enhancer model', async () => {
    const mock = await startMockProvider();

    try {
      process.env.LLM_PROVIDER = 'openai';
      process.env.LLM_BASE_URL = mock.url;
      process.env.LLM_API_KEY = 'test-key';
      process.env.LLM_MODEL = 'mock-main';
      process.env.LLM_MAX_TOKENS = '1024';

      const candidates = getModelCandidates(env);

      expect(candidates.map((candidate) => candidate.modelId)).toEqual(['mock-main']);
      expect(candidates[0].maxTokens).toBe(1024);

      const output = await collect(streamText(messages, env, undefined, 'mock-enhancer').toAIStream());
      expect(output).toContain('boltArtifact');
      expect(mock.requests).toEqual(['mock-enhancer']);
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
