import { generateText, streamText as sdkStreamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- the mock provider lives in scripts/
import { startMockProvider } from '../../../../scripts/mock-openai-server.mjs';
import {
  candidateLabel,
  DEFAULT_WORKERS_AI_FALLBACK_MODELS,
  DEFAULT_WORKERS_AI_MODEL,
  getModelCandidates,
} from './model';
import { streamText, type Messages } from './stream-text';
import { createReasoningFilter, createWorkersAI, WorkersAILanguageModel, workersAIRestBaseURL } from './workers-ai';

const ENV_KEYS = [
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
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_AI_GATEWAY_ID',
  'CLOUDFLARE_AI_TRANSPORT',
  'CLOUDFLARE_AI_BASE_URL',
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  ENV_KEYS.forEach((key) => delete process.env[key]);
});

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  });
});

/* ------------------------------------------------------------------------ */
/* helpers                                                                   */
/* ------------------------------------------------------------------------ */

const messages: Messages = [{ role: 'user', content: 'hello' }];

interface MockCall {
  model: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface MockProvider {
  url: string;
  requests: string[];
  calls: MockCall[];
  close(): Promise<void>;
}

async function startMock(options?: { failModels?: string[]; failStatus?: number }): Promise<MockProvider> {
  return (await startMockProvider(options)) as unknown as MockProvider;
}

interface FakeCall {
  model: string;
  inputs: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

type FakeAnswer = { sse: string[] } | { object: unknown } | { throws: Error };

interface FakeAI {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  calls: FakeCall[];
  cancelled: number;
}

function openaiChunk(delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  })}\n\n`;
}

function nativeChunk(response: string, usage?: unknown) {
  return `data: ${JSON.stringify({ response, p: 'abc', ...(usage === undefined ? {} : { usage }) })}\n\n`;
}

function createFakeAI(answer: (model: string, inputs: Record<string, unknown>) => FakeAnswer): FakeAI {
  const fake: FakeAI = {
    calls: [],
    cancelled: 0,
    async run(model, inputs, options) {
      fake.calls.push({ model, inputs, options });

      const result = answer(model, inputs);

      if ('throws' in result) {
        throw result.throws;
      }

      if ('object' in result) {
        return result.object;
      }

      const encoder = new TextEncoder();
      const lines = [...result.sse];

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const line = lines.shift();

          if (line === undefined) {
            controller.close();

            return;
          }

          await new Promise((resolve) => setTimeout(resolve, 1));
          controller.enqueue(encoder.encode(line));
        },
        cancel() {
          fake.cancelled++;
        },
      });
    },
  };

  return fake;
}

function envWith(ai?: FakeAI): Env {
  return (ai === undefined ? {} : { AI: ai }) as unknown as Env;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let output = '';

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    output += decoder.decode(value, { stream: true });
  }

  return output;
}

/** drains the SDK text stream (the `text`/`finishReason` promises only settle once the stream is consumed) */
async function drain(result: { textStream: ReadableStream<string> }) {
  const reader = result.textStream.getReader();
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      return text;
    }

    text += value;
  }
}

/** text that reaches the browser: the `0:"..."` lines of the AI stream */
function visibleText(aiStream: string) {
  return aiStream
    .split('\n')
    .filter((line) => line.startsWith('0:'))
    .map((line) => JSON.parse(line.slice(2)) as string)
    .join('');
}

const STORY_SSE = [
  openaiChunk({ role: 'assistant', content: '' }),
  openaiChunk({ content: 'Namaste ' }),
  openaiChunk({ content: '<boltArtifact id="a" title="A"><boltAction type="file" filePath="hello.txt">hi' }),
  openaiChunk({ content: '</boltAction></boltArtifact>' }),
  openaiChunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
  'data: [DONE]\n\n',
];

/* ------------------------------------------------------------------------ */
/* reasoning filter                                                          */
/* ------------------------------------------------------------------------ */

describe('createReasoningFilter', () => {
  it('removes a think block inside a single chunk and the whitespace after it', () => {
    const filter = createReasoningFilter();

    expect(filter.process('<think>plan the file</think>\n\nHello') + filter.flush()).toBe('Hello');
  });

  it('removes a think block whose tags are split across chunks', () => {
    const filter = createReasoningFilter();
    const chunks = ['<thi', 'nk>\nI should ', 'answer</th', 'ink>', '\n', 'Hi ', 'there'];

    expect(chunks.map((chunk) => filter.process(chunk)).join('') + filter.flush()).toBe('Hi there');
  });

  it('keeps ordinary text with angle brackets, including a trailing "<"', () => {
    const filter = createReasoningFilter();
    const chunks = ['const a = <', 'div>x</div>; if (a <', ' b) {}'];

    expect(chunks.map((chunk) => filter.process(chunk)).join('') + filter.flush()).toBe(
      'const a = <div>x</div>; if (a < b) {}',
    );
  });

  it('drops everything when the model never closes its think block', () => {
    const filter = createReasoningFilter();

    expect(filter.process('<think>still thinking') + filter.flush()).toBe('');
  });
});

/* ------------------------------------------------------------------------ */
/* provider: binding transport                                               */
/* ------------------------------------------------------------------------ */

describe('WorkersAILanguageModel with the AI binding', () => {
  it('streams OpenAI-shaped chunks and reports the finish reason and usage', async () => {
    const ai = createFakeAI(() => ({ sse: STORY_SSE }));
    const model = createWorkersAI({ kind: 'binding', ai })('@cf/test/model');

    const result = await sdkStreamText({ model, prompt: 'hello', maxTokens: 100, temperature: 0.2 });

    expect(await drain(result)).toContain('boltArtifact');
    expect(await result.finishReason).toBe('stop');
    expect(await result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    const [call] = ai.calls;

    expect(call.model).toBe('@cf/test/model');
    expect(call.inputs.stream).toBe(true);
    expect(call.inputs.max_tokens).toBe(100);
    expect(call.inputs.temperature).toBe(0.2);
    expect(call.inputs.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(call.options).toBeUndefined();
  });

  it('streams the native {response} shape and infers "length" when max_tokens is used up', async () => {
    const ai = createFakeAI(() => ({
      sse: [
        nativeChunk('Hello'),
        nativeChunk(' world'),
        nativeChunk('', { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 }),
        'data: [DONE]\n\n',
      ],
    }));
    const model = createWorkersAI({ kind: 'binding', ai })('@cf/meta/llama-3.1-8b-instruct-fp8');

    const truncated = await sdkStreamText({ model, prompt: 'hello', maxTokens: 8 });

    expect(await drain(truncated)).toBe('Hello world');
    expect(await truncated.finishReason).toBe('length');

    const complete = await sdkStreamText({ model, prompt: 'hello', maxTokens: 50 });

    expect(await drain(complete)).toBe('Hello world');
    expect(await complete.finishReason).toBe('stop');
  });

  it('ignores reasoning_content deltas and strips inline <think> blocks', async () => {
    const ai = createFakeAI(() => ({
      sse: [
        openaiChunk({ role: 'assistant', content: null, reasoning_content: 'let me think' }),
        openaiChunk({ content: null, reasoning_content: ' more' }),
        openaiChunk({ content: '<think>inline' }),
        openaiChunk({ content: ' reasoning</think>\n\n' }),
        openaiChunk({ content: 'Final answer' }),
        openaiChunk({}, 'stop'),
        'data: [DONE]\n\n',
      ],
    }));
    const model = createWorkersAI({ kind: 'binding', ai })('@cf/test/reasoner');

    const result = await sdkStreamText({ model, prompt: 'hello' });

    expect(await drain(result)).toBe('Final answer');
  });

  it('merges extra body fields and passes the AI Gateway id', async () => {
    const ai = createFakeAI(() => ({ sse: STORY_SSE }));
    const model = createWorkersAI(
      { kind: 'binding', ai, gatewayId: 'my-gateway' },
      { extraBody: { chat_template_kwargs: { enable_thinking: false } } },
    )('@cf/test/model');

    await drain(await sdkStreamText({ model, prompt: 'hello' }));

    expect(ai.calls[0].inputs.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(ai.calls[0].options).toEqual({ gateway: { id: 'my-gateway' } });
  });

  it('forwards the first token at once and merges the following ones into few chunks', async () => {
    const tokens = Array.from({ length: 40 }, (_, index) => `t${index} `);
    const sse = [
      ...tokens.map((token) => openaiChunk({ content: token })),
      openaiChunk({}, 'stop'),
      'data: [DONE]\n\n',
    ];

    async function textParts(coalesceMs: number) {
      const model = createWorkersAI(
        { kind: 'binding', ai: createFakeAI(() => ({ sse })) },
        { coalesceMs },
      )('@cf/test/model');
      const result = await sdkStreamText({ model, prompt: 'hello' });
      const parts: string[] = [];
      const reader = result.fullStream.getReader();

      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          return parts;
        }

        if (value.type === 'text-delta') {
          parts.push(value.textDelta);
        }
      }
    }

    const merged = await textParts(50);

    expect(merged[0]).toBe('t0 ');
    expect(merged.length).toBeLessThan(tokens.length / 2);
    expect(merged.join('')).toBe(tokens.join(''));

    const separate = await textParts(0);

    expect(separate).toEqual(tokens);
  });

  it('rejects before streaming when the first event is an error or the answer is empty', async () => {
    const failing = createWorkersAI({
      kind: 'binding',
      ai: createFakeAI(() => ({ sse: ['data: {"errors":[{"code":3040,"message":"Capacity exceeded"}]}\n\n'] })),
    })('@cf/test/model');

    await expect(sdkStreamText({ model: failing, prompt: 'hello' })).rejects.toThrow(/Capacity exceeded/);

    const empty = createWorkersAI({
      kind: 'binding',
      ai: createFakeAI(() => ({ sse: [openaiChunk({}, 'stop'), 'data: [DONE]\n\n'] })),
    })('@cf/test/model');

    await expect(sdkStreamText({ model: empty, prompt: 'hello' })).rejects.toThrow(/empty response/);
  });

  it('explains a binding that is not logged in', async () => {
    const model = createWorkersAI({
      kind: 'binding',
      ai: createFakeAI(() => ({ throws: new Error('Not logged in.') })),
    })('@cf/test/model');

    await expect(sdkStreamText({ model, prompt: 'hello' })).rejects.toThrow(/wrangler login/);
  });

  it('cancels the upstream stream when the consumer aborts', async () => {
    const ai = createFakeAI(() => ({
      sse: [openaiChunk({ content: 'first' }), ...Array.from({ length: 200 }, () => openaiChunk({ content: 'x' }))],
    }));
    const model = createWorkersAI({ kind: 'binding', ai })('@cf/test/model');
    const abort = new AbortController();

    const result = await sdkStreamText({ model, prompt: 'hello', abortSignal: abort.signal });
    const reader = result.textStream.getReader();

    expect((await reader.read()).value).toBe('first');

    abort.abort();

    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();

          if (done) {
            return;
          }
        }
      })(),
    ).rejects.toThrow();

    expect(ai.cancelled).toBe(1);
  });

  it('answers non-streaming calls in both shapes and strips reasoning from them', async () => {
    const openaiShaped = createWorkersAI({
      kind: 'binding',
      ai: createFakeAI(() => ({
        object: {
          choices: [
            { index: 0, message: { role: 'assistant', content: '<think>hm</think>\npong' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
      })),
    })('@cf/test/model');

    const first = await generateText({ model: openaiShaped, prompt: 'ping', maxTokens: 16 });

    expect(first.text).toBe('pong');
    expect(first.finishReason).toBe('stop');
    expect(first.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });

    const native = createWorkersAI({
      kind: 'binding',
      ai: createFakeAI(() => ({ object: { response: 'pong', usage: { prompt_tokens: 3, completion_tokens: 1 } } })),
    })('@cf/test/model');

    const second = await generateText({ model: native, prompt: 'ping', maxTokens: 16 });

    expect(second.text).toBe('pong');
    expect(second.finishReason).toBe('stop');
  });
});

/* ------------------------------------------------------------------------ */
/* provider: REST transport                                                  */
/* ------------------------------------------------------------------------ */

describe('WorkersAILanguageModel with the REST API', () => {
  it('builds the account and gateway base URLs', () => {
    expect(workersAIRestBaseURL({ accountId: 'acc' })).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/v1');
    expect(workersAIRestBaseURL({ accountId: 'acc', gatewayId: 'gw' })).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/v1',
    );
    expect(workersAIRestBaseURL({ accountId: 'acc', baseURL: 'http://127.0.0.1:1/v1/' })).toBe('http://127.0.0.1:1/v1');
  });

  it('calls /chat/completions with the bearer token and streams the answer', async () => {
    const mock = await startMock();

    try {
      const model = new WorkersAILanguageModel('@cf/test/model', {
        kind: 'rest',
        accountId: 'acc',
        apiToken: 'cf-token',
        baseURL: mock.url,
      });

      const result = await sdkStreamText({ model, prompt: 'hello', maxTokens: 64, headers: { 'x-extra': '1' } });

      expect(await drain(result)).toContain('boltArtifact');
      expect(await result.finishReason).toBe('stop');

      const [call] = mock.calls;

      expect(call.model).toBe('@cf/test/model');
      expect(call.headers.authorization).toBe('Bearer cf-token');
      expect(call.headers['x-extra']).toBe('1');
      expect(call.body.stream).toBe(true);
      expect(call.body.max_tokens).toBe(64);
    } finally {
      await mock.close();
    }
  });

  it('turns HTTP errors into a rejected call', async () => {
    const mock = await startMock({ failModels: ['@cf/test/throttled'], failStatus: 429 });

    try {
      const model = new WorkersAILanguageModel('@cf/test/throttled', {
        kind: 'rest',
        accountId: 'acc',
        apiToken: 'cf-token',
        baseURL: mock.url,
      });

      await expect(sdkStreamText({ model, prompt: 'hello', maxRetries: 0 })).rejects.toThrow(/HTTP 429/);
    } finally {
      await mock.close();
    }
  });
});

/* ------------------------------------------------------------------------ */
/* model selection                                                           */
/* ------------------------------------------------------------------------ */

describe('getModelCandidates with Cloudflare Workers AI', () => {
  it('uses Workers AI with the free-plan default chain when only the binding exists', () => {
    const candidates = getModelCandidates(envWith(createFakeAI(() => ({ sse: STORY_SSE }))));

    expect(candidates.map((candidate) => candidate.modelId)).toEqual([
      DEFAULT_WORKERS_AI_MODEL,
      ...DEFAULT_WORKERS_AI_FALLBACK_MODELS,
    ]);
    expect(candidates.every((candidate) => candidate.provider === 'cloudflare')).toBe(true);
    expect(candidates.every((candidate) => candidate.transport === 'binding')).toBe(true);
    expect(candidates[0].maxTokens).toBe(8192);
    expect(candidates[0].temperature).toBe(0.2);
    expect(candidateLabel(candidates[0])).toBe(`cloudflare:binding/${DEFAULT_WORKERS_AI_MODEL}`);
  });

  it('puts the REST transport right after the binding for every model', () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acc';
    process.env.CLOUDFLARE_API_TOKEN = 'tok';
    process.env.LLM_MODEL = '@cf/a|1024';
    process.env.LLM_FALLBACK_MODELS = '@cf/b';

    const candidates = getModelCandidates(envWith(createFakeAI(() => ({ sse: STORY_SSE }))));

    expect(candidates.map(candidateLabel)).toEqual([
      'cloudflare:binding/@cf/a',
      'cloudflare:rest/@cf/a',
      'cloudflare:binding/@cf/b',
      'cloudflare:rest/@cf/b',
    ]);
    expect(candidates.map((candidate) => candidate.maxTokens)).toEqual([1024, 1024, 8192, 8192]);
  });

  it('uses only the REST API when there is no binding, and honours CLOUDFLARE_AI_TRANSPORT', () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acc';
    process.env.CLOUDFLARE_API_TOKEN = 'tok';
    process.env.LLM_MODEL = '@cf/a';

    expect(getModelCandidates(envWith()).map(candidateLabel)).toEqual(['cloudflare:rest/@cf/a']);

    process.env.CLOUDFLARE_AI_TRANSPORT = 'rest';
    expect(getModelCandidates(envWith(createFakeAI(() => ({ sse: [] })))).map(candidateLabel)).toEqual([
      'cloudflare:rest/@cf/a',
    ]);

    process.env.CLOUDFLARE_AI_TRANSPORT = 'binding';
    expect(() => getModelCandidates(envWith())).toThrow(/\[ai\] binding/);
  });

  it('explains what is missing when Workers AI is requested but unreachable', () => {
    process.env.LLM_PROVIDER = 'cloudflare';

    expect(() => getModelCandidates(envWith())).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it('keeps explicit providers ahead of the binding and lets LLM_PROVIDER force Workers AI', () => {
    const ai = createFakeAI(() => ({ sse: STORY_SSE }));

    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    expect(getModelCandidates(envWith(ai))[0].provider).toBe('anthropic');

    process.env.LLM_PROVIDER = 'workers-ai';
    expect(getModelCandidates(envWith(ai))[0].provider).toBe('cloudflare');

    delete process.env.LLM_PROVIDER;
    process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.LLM_MODEL = 'x';
    expect(getModelCandidates(envWith(ai))[0].provider).toBe('openai');
  });

  it('reads the chain from Cloudflare bindings (wrangler.toml vars) too', () => {
    const env = {
      AI: createFakeAI(() => ({ sse: STORY_SSE })),
      LLM_PROVIDER: 'cloudflare',
      LLM_MODEL: '@cf/from-vars',
      LLM_FALLBACK_MODELS: '@cf/second',
      LLM_EXTRA_BODY: '{"reasoning_effort":"low"}',
    } as unknown as Env;

    expect(getModelCandidates(env).map((candidate) => candidate.modelId)).toEqual(['@cf/from-vars', '@cf/second']);
  });
});

/* ------------------------------------------------------------------------ */
/* end to end through Bolt's streamText                                      */
/* ------------------------------------------------------------------------ */

describe('streamText on Cloudflare', () => {
  it('serves the chat from the binding with Bolt system prompt and defaults', async () => {
    const ai = createFakeAI(() => ({ sse: STORY_SSE }));
    const env = { AI: ai, LLM_PROVIDER: 'cloudflare', LLM_EXTRA_BODY: '{"seed":7}' } as unknown as Env;

    const output = await collect((await streamText(messages, env)).toAIStream());

    expect(visibleText(output)).toContain('<boltArtifact');
    expect(ai.calls).toHaveLength(1);

    const [call] = ai.calls;
    const sent = call.inputs.messages as { role: string; content: string }[];

    expect(call.model).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(sent[0].role).toBe('system');
    expect(sent[0].content).toContain('Bolt');
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'hello' });
    expect(call.inputs.max_tokens).toBe(8192);
    expect(call.inputs.temperature).toBe(0.2);
    expect(call.inputs.seed).toBe(7);
  });

  it('fails over from a throttled model to the next one', async () => {
    const ai = createFakeAI((model) =>
      model === '@cf/first' ? { throws: new Error('InferenceUpstreamError: 3036 rate limited') } : { sse: STORY_SSE },
    );

    process.env.LLM_MODEL = '@cf/first';
    process.env.LLM_FALLBACK_MODELS = '@cf/second';

    const output = await collect((await streamText(messages, envWith(ai))).toAIStream());

    expect(ai.calls.map((call) => call.model)).toEqual(['@cf/first', '@cf/second']);
    expect(visibleText(output)).toContain('Namaste');
  });

  it('falls back to the REST API when the binding is not logged in (local development)', async () => {
    const mock = await startMock();

    try {
      const ai = createFakeAI(() => ({ throws: new Error('Not logged in.') }));

      process.env.CLOUDFLARE_ACCOUNT_ID = 'acc';
      process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
      process.env.CLOUDFLARE_AI_BASE_URL = mock.url;
      process.env.LLM_MODEL = '@cf/only';

      const output = await collect((await streamText(messages, envWith(ai))).toAIStream());

      expect(ai.calls.map((call) => call.model)).toEqual(['@cf/only']);
      expect(mock.requests).toEqual(['@cf/only']);
      expect(visibleText(output)).toContain('boltArtifact');
    } finally {
      await mock.close();
    }
  });

  it('uses the enhancer model first when one is configured', async () => {
    const ai = createFakeAI(() => ({ sse: STORY_SSE }));

    process.env.LLM_MODEL = '@cf/main';
    process.env.LLM_ENHANCER_MODEL = '@cf/cheap';

    await collect((await streamText(messages, envWith(ai), undefined, '@cf/cheap')).toAIStream());

    expect(ai.calls.map((call) => call.model)).toEqual(['@cf/cheap']);
  });

  it('reports a clear error when every Workers AI model fails', async () => {
    const ai = createFakeAI(() => ({ throws: new Error('5007: No such model') }));

    process.env.LLM_MODEL = '@cf/missing';

    await expect(streamText(messages, envWith(ai))).rejects.toThrow(/No such model/);
    expect(ai.calls.map((call) => call.model)).toEqual(['@cf/missing']);
  });
});
