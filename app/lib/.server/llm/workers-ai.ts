import {
  APICallError,
  type LanguageModelV1,
  type LanguageModelV1CallOptions,
  type LanguageModelV1CallWarning,
  type LanguageModelV1FinishReason,
  type LanguageModelV1Prompt,
  type LanguageModelV1StreamPart,
} from '@ai-sdk/provider';

/**
 * Cloudflare Workers AI provider for the Vercel AI SDK (LanguageModelV1).
 *
 * Two transports share the same request/response handling:
 *
 * - `binding`: the `AI` binding of the Pages Function / Worker
 *   (`[ai] binding = "AI"` in wrangler.toml). No key is needed, usage is
 *   billed to the account that hosts the deployment (free: 10k neurons/day).
 * - `rest`: the OpenAI-compatible REST endpoint of Workers AI, authenticated
 *   with a Cloudflare API token. Useful for local development without
 *   `wrangler login`, or for any machine outside of Cloudflare.
 *
 * Workers AI answers in two shapes depending on the model generation: the
 * newer models return OpenAI chat-completion objects/chunks (`choices[]`),
 * the older ones return `{ response: string }`. Both are handled below.
 */

export const WORKERS_AI_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
export const WORKERS_AI_GATEWAY_BASE = 'https://gateway.ai.cloudflare.com/v1';

/**
 * Minimal structural type of the `AI` binding. It is declared here instead of
 * using `Ai` from `@cloudflare/workers-types`, because that type carries a
 * model-name union that lags behind the live catalog.
 */
export interface WorkersAIBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export function isWorkersAIBinding(value: unknown): value is WorkersAIBinding {
  return typeof value === 'object' && value !== null && typeof (value as { run?: unknown }).run === 'function';
}

export interface WorkersAIBindingTransport {
  kind: 'binding';
  ai: WorkersAIBinding;

  /** optional AI Gateway id, adds caching/analytics/rate limiting in front of the model */
  gatewayId?: string;
}

export interface WorkersAIRestTransport {
  kind: 'rest';
  accountId: string;
  apiToken: string;
  gatewayId?: string;

  /** overrides the computed `/ai/v1` base URL, mostly for proxies and tests */
  baseURL?: string;
  fetch?: typeof fetch;
}

export type WorkersAITransport = WorkersAIBindingTransport | WorkersAIRestTransport;

export interface WorkersAIModelOptions {
  /** merged into every request body, e.g. `{"chat_template_kwargs":{"enable_thinking":false}}` */
  extraBody?: Record<string, unknown>;

  /**
   * Time window (ms) over which streamed tokens are merged into one chunk,
   * `0` forwards every token on its own. See {@link DEFAULT_COALESCE_MS}.
   */
  coalesceMs?: number;
}

/**
 * Workers AI emits one event per token. Each chunk that leaves this provider
 * then travels through about ten stream stages (AI SDK, watchdogs, response),
 * which costs roughly 30µs of CPU per chunk, while the Workers free plan grants
 * 10ms of CPU per request. Merging the tokens of a short window into one chunk
 * cuts that overhead by an order of magnitude without a visible delay.
 * The first token is always forwarded immediately.
 */
export const DEFAULT_COALESCE_MS = 80;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Builds the OpenAI-compatible base URL of the REST transport, either direct
 * or through an AI Gateway.
 */
export function workersAIRestBaseURL(transport: Pick<WorkersAIRestTransport, 'accountId' | 'gatewayId' | 'baseURL'>) {
  if (transport.baseURL !== undefined) {
    return transport.baseURL.replace(/\/+$/, '');
  }

  if (transport.gatewayId !== undefined) {
    return `${WORKERS_AI_GATEWAY_BASE}/${transport.accountId}/${transport.gatewayId}/workers-ai/v1`;
  }

  return `${WORKERS_AI_API_BASE}/${transport.accountId}/ai/v1`;
}

/**
 * Streams can contain reasoning blocks (`<think>…</think>`) when a model emits
 * its chain of thought inline. Bolt's message parser must never see them, so
 * they are removed while streaming, including tags split across chunks.
 */
export function createReasoningFilter() {
  const OPEN = '<think>';
  const CLOSE = '</think>';

  let insideThink = false;
  let pending = '';
  let dropLeadingWhitespace = false;

  function partialTagSuffix(text: string, tag: string) {
    const maxLength = Math.min(tag.length - 1, text.length);

    for (let length = maxLength; length > 0; length--) {
      if (tag.startsWith(text.slice(-length))) {
        return text.slice(-length);
      }
    }

    return '';
  }

  function emit(text: string) {
    if (!dropLeadingWhitespace || text === '') {
      return text;
    }

    const trimmed = text.replace(/^\s+/, '');

    if (trimmed !== '') {
      dropLeadingWhitespace = false;
    }

    return trimmed;
  }

  return {
    process(delta: string): string {
      let input = pending + delta;
      let output = '';

      pending = '';

      while (input.length > 0) {
        if (insideThink) {
          const close = input.indexOf(CLOSE);

          if (close === -1) {
            pending = partialTagSuffix(input, CLOSE);

            return output;
          }

          insideThink = false;
          dropLeadingWhitespace = true;
          input = input.slice(close + CLOSE.length);
        } else {
          const open = input.indexOf(OPEN);

          if (open === -1) {
            pending = partialTagSuffix(input, OPEN);
            output += emit(input.slice(0, input.length - pending.length));

            return output;
          }

          output += emit(input.slice(0, open));
          insideThink = true;
          input = input.slice(open + OPEN.length);
        }
      }

      return output;
    },

    flush(): string {
      const rest = insideThink ? '' : emit(pending);

      pending = '';
      insideThink = false;

      return rest;
    },
  };
}

const FINISH_REASONS: Record<string, LanguageModelV1FinishReason> = {
  stop: 'stop',
  end_turn: 'stop',
  length: 'length',
  max_tokens: 'length',
  content_filter: 'content-filter',
  tool_calls: 'tool-calls',
  function_call: 'tool-calls',
};

function mapFinishReason(reason: unknown): LanguageModelV1FinishReason | undefined {
  if (typeof reason !== 'string' || reason === '') {
    return undefined;
  }

  return FINISH_REASONS[reason] ?? 'other';
}

function readUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const usage = value as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : Number.NaN;
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : Number.NaN;

  return { promptTokens, completionTokens };
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Converts the AI SDK prompt into plain chat messages. Bolt only ever sends
 * text, so images and tool parts are dropped with a warning instead of failing.
 */
function convertPrompt(prompt: LanguageModelV1Prompt, warnings: LanguageModelV1CallWarning[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const message of prompt) {
    switch (message.role) {
      case 'system': {
        messages.push({ role: 'system', content: message.content });
        break;
      }
      case 'user': {
        let dropped = false;

        const content = message.content
          .map((part) => {
            if (part.type === 'text') {
              return part.text;
            }

            dropped = true;

            return '';
          })
          .join('');

        if (dropped) {
          warnings.push({
            type: 'other',
            message: 'Workers AI provider: image parts were dropped from a user message',
          });
        }

        messages.push({ role: 'user', content });
        break;
      }
      case 'assistant': {
        const content = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

        messages.push({ role: 'assistant', content });
        break;
      }
      case 'tool': {
        warnings.push({
          type: 'other',
          message: 'Workers AI provider: tool results are not supported and were dropped',
        });
        break;
      }
    }
  }

  return messages;
}

/**
 * One chunk of a model answer, whatever shape Workers AI used for it.
 */
function interpretEvent(event: unknown): {
  text?: string;
  finishReason?: LanguageModelV1FinishReason;
  usage?: TokenUsage;
  error?: string;
} {
  if (typeof event !== 'object' || event === null) {
    return {};
  }

  const payload = event as Record<string, unknown>;

  /* `error: null` and `errors: []` (the envelope of the Cloudflare API) are not errors */
  const reportedError =
    payload.error ??
    (Array.isArray(payload.errors) ? (payload.errors.length > 0 ? payload.errors : null) : payload.errors);

  if (reportedError !== undefined && reportedError !== null) {
    return { error: describeError(reportedError) };
  }

  const result: { text?: string; finishReason?: LanguageModelV1FinishReason; usage?: TokenUsage } = {};

  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    /* OpenAI chat completion shape (newer Workers AI models and the REST endpoint) */
    const choice = payload.choices[0] as Record<string, unknown>;
    const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;

    if (typeof delta?.content === 'string') {
      result.text = delta.content;
    }

    result.finishReason = mapFinishReason(choice.finish_reason);
  } else if (typeof payload.response === 'string') {
    /* native Workers AI shape of the older text generation models */
    result.text = payload.response;
    result.finishReason = mapFinishReason(payload.finish_reason);
  }

  result.usage = readUsage(payload.usage);

  return result;
}

/**
 * Turns the server-sent events of Workers AI into AI SDK stream parts.
 *
 * It is a single transform on purpose: the Workers free plan has a small CPU
 * budget per request, and every extra stream hop costs a little of it.
 */
function createStreamTransform(
  maxTokens: number | undefined,
  coalesceMs: number = DEFAULT_COALESCE_MS,
): TransformStream<Uint8Array, LanguageModelV1StreamPart> {
  const decoder = new TextDecoder();
  const filter = createReasoningFilter();

  let buffer = '';
  let finishReason: LanguageModelV1FinishReason | undefined;
  let usage: TokenUsage | undefined;
  let sawText = false;

  /* token coalescing, see DEFAULT_COALESCE_MS */
  let pendingText = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let terminated = false;
  let activeController: TransformStreamDefaultController<LanguageModelV1StreamPart> | undefined;

  function flushText() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    if (pendingText === '' || terminated || activeController === undefined) {
      return;
    }

    const textDelta = pendingText;

    pendingText = '';

    try {
      activeController.enqueue({ type: 'text-delta', textDelta });
    } catch {
      /* the readable side was cancelled or errored while a batch was pending */
      terminated = true;
    }
  }

  function queueText(text: string) {
    pendingText += text;

    if (coalesceMs <= 0 || !sawText) {
      sawText = true;
      flushText();

      return;
    }

    if (timer === undefined) {
      timer = setTimeout(flushText, coalesceMs);
    }
  }

  function handleLine(line: string, controller: TransformStreamDefaultController<LanguageModelV1StreamPart>) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;

    if (!trimmed.startsWith('data:')) {
      return;
    }

    const data = trimmed.slice(5).trim();

    if (data === '' || data === '[DONE]') {
      return;
    }

    let event: unknown;

    try {
      event = JSON.parse(data);
    } catch {
      /* keep-alives or partial garbage are ignored, the next event will be fine */
      return;
    }

    const { text, finishReason: reason, usage: eventUsage, error } = interpretEvent(event);

    if (error !== undefined) {
      flushText();
      controller.enqueue({ type: 'error', error: new Error(`Workers AI stream error: ${error}`) });

      return;
    }

    if (reason !== undefined) {
      finishReason = reason;
    }

    if (eventUsage !== undefined) {
      usage = eventUsage;
    }

    if (text !== undefined && text !== '') {
      const visible = filter.process(text);

      if (visible !== '') {
        queueText(visible);
      }
    }
  }

  return new TransformStream<Uint8Array, LanguageModelV1StreamPart>({
    start(controller) {
      activeController = controller;
    },

    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      let newline = buffer.indexOf('\n');

      while (newline !== -1) {
        handleLine(buffer.slice(0, newline), controller);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    },

    flush(controller) {
      buffer += decoder.decode();

      if (buffer !== '') {
        handleLine(buffer, controller);
        buffer = '';
      }

      const rest = filter.flush();

      if (rest !== '') {
        queueText(rest);
      }

      flushText();
      terminated = true;

      controller.enqueue({
        type: 'finish',
        finishReason: resolveFinishReason(finishReason, usage, maxTokens, sawText),
        usage: usage ?? { promptTokens: Number.NaN, completionTokens: Number.NaN },
      });
    },
  });
}

/**
 * The native shape does not always carry a finish reason. When the model
 * produced exactly `max_tokens` the answer was most likely cut off, and Bolt
 * then asks the model to continue.
 */
function resolveFinishReason(
  reported: LanguageModelV1FinishReason | undefined,
  usage: TokenUsage | undefined,
  maxTokens: number | undefined,
  sawText: boolean,
): LanguageModelV1FinishReason {
  if (reported !== undefined) {
    return reported;
  }

  if (usage !== undefined && maxTokens !== undefined && usage.completionTokens >= maxTokens) {
    return 'length';
  }

  return sawText ? 'stop' : 'unknown';
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** `instanceof` alone is not enough: the dev proxy can hand back a stream from another realm */
function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    value instanceof ReadableStream ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { getReader?: unknown }).getReader === 'function' &&
      typeof (value as { pipeThrough?: unknown }).pipeThrough === 'function')
  );
}

export class WorkersAILanguageModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1' as const;
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = false;
  readonly provider: string;

  constructor(
    readonly modelId: string,
    private readonly _transport: WorkersAITransport,
    private readonly _options: WorkersAIModelOptions = {},
  ) {
    this.provider = `workers-ai.${_transport.kind}`;
  }

  async doGenerate(options: LanguageModelV1CallOptions) {
    const { inputs, warnings } = this._prepare(options);
    const raw = await this._request(inputs, false, options);

    if (isReadableStream(raw)) {
      /* a model that streams regardless: collect the parts and flatten them */
      const collected = await collectParts(raw.pipeThrough(createStreamTransform(options.maxTokens, 0)));

      return { ...collected, rawCall: { rawPrompt: inputs, rawSettings: {} }, warnings };
    }

    const { text, finishReason, usage, error } = interpretEvent(raw);

    if (error !== undefined) {
      throw new Error(`Workers AI returned an error for ${this.modelId}: ${error}`);
    }

    const filter = createReasoningFilter();
    const visible = filter.process(text ?? '') + filter.flush();

    return {
      text: visible,
      finishReason: resolveFinishReason(finishReason, usage, options.maxTokens, visible !== ''),
      usage: usage ?? { promptTokens: Number.NaN, completionTokens: Number.NaN },
      rawCall: { rawPrompt: inputs, rawSettings: {} },
      warnings,
    };
  }

  async doStream(options: LanguageModelV1CallOptions) {
    const { inputs, warnings } = this._prepare(options);
    const raw = await this._request(inputs, true, options);

    let source: ReadableStream<Uint8Array>;

    if (isReadableStream(raw)) {
      source = raw;
    } else if (raw instanceof Response) {
      if (raw.body === null) {
        throw new Error(`Workers AI returned an empty body for ${this.modelId}`);
      }

      source = raw.body;
    } else {
      /* the model ignored `stream: true`, replay its complete answer as one SSE event */
      source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(raw)}\n\n`));
          controller.close();
        },
      });
    }

    const parts = source.pipeThrough(createStreamTransform(options.maxTokens, this._options.coalesceMs), {
      signal: options.abortSignal,
    });

    /**
     * Wait for the first part before handing the stream over: an error or an
     * empty answer then rejects this call, which lets the caller fail over to
     * the next model instead of streaming a broken response to the browser.
     */
    const stream = await openStream(parts, this.modelId);

    return { stream, rawCall: { rawPrompt: inputs, rawSettings: {} }, warnings };
  }

  private _prepare(options: LanguageModelV1CallOptions) {
    if (options.mode.type !== 'regular') {
      throw new Error(`Workers AI provider: ${options.mode.type} mode is not supported`);
    }

    const warnings: LanguageModelV1CallWarning[] = [];
    const messages = convertPrompt(options.prompt, warnings);
    const inputs: Record<string, unknown> = { messages };

    if (options.maxTokens !== undefined) {
      inputs.max_tokens = options.maxTokens;
    }

    if (options.temperature !== undefined) {
      inputs.temperature = options.temperature;
    }

    if (options.topP !== undefined) {
      inputs.top_p = options.topP;
    }

    if (options.frequencyPenalty !== undefined) {
      inputs.frequency_penalty = options.frequencyPenalty;
    }

    if (options.presencePenalty !== undefined) {
      inputs.presence_penalty = options.presencePenalty;
    }

    if (options.seed !== undefined) {
      inputs.seed = options.seed;
    }

    if (options.stopSequences !== undefined && options.stopSequences.length > 0) {
      inputs.stop = options.stopSequences;
    }

    return { inputs: { ...inputs, ...(this._options.extraBody ?? {}) }, warnings };
  }

  private async _request(inputs: Record<string, unknown>, stream: boolean, options: LanguageModelV1CallOptions) {
    if (this._transport.kind === 'binding') {
      return this._runBinding(this._transport, { ...inputs, stream }, options.abortSignal);
    }

    return this._runRest(this._transport, { model: this.modelId, ...inputs, stream }, options);
  }

  private async _runBinding(
    transport: WorkersAIBindingTransport,
    inputs: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Workers AI request was aborted');
    }

    const runOptions = transport.gatewayId === undefined ? undefined : { gateway: { id: transport.gatewayId } };

    try {
      return await transport.ai.run(this.modelId, inputs, runOptions);
    } catch (error) {
      /* in local dev the proxied error message carries a full stack trace: keep the first line */
      const detail = describeError(error)
        .split('\n')[0]
        .replace(/^Error:\s*/, '')
        .slice(0, 300);
      const hint = /not logged in|login|authentication/i.test(detail)
        ? ' (local development: run "npx wrangler login", or set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN to use the REST API)'
        : '';

      throw new Error(`Workers AI binding failed for ${this.modelId}: ${detail}${hint}`, { cause: error });
    }
  }

  private async _runRest(
    transport: WorkersAIRestTransport,
    body: Record<string, unknown>,
    options: LanguageModelV1CallOptions,
  ) {
    const url = `${workersAIRestBaseURL(transport)}/chat/completions`;
    const fetchImpl = transport.fetch ?? fetch;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${transport.apiToken}`,
    };

    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value !== undefined) {
        headers[name] = value;
      }
    }

    let response: Response;

    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.abortSignal,
      });
    } catch (error) {
      if (options.abortSignal?.aborted) {
        throw error;
      }

      throw new APICallError({
        message: `Workers AI REST request failed: ${describeError(error)}`,
        url,
        requestBodyValues: body,
        cause: error,
        isRetryable: true,
      });
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');

      throw new APICallError({
        message: `Workers AI REST request failed with HTTP ${response.status}: ${responseBody.slice(0, 400)}`,
        url,
        requestBodyValues: body,
        statusCode: response.status,
        responseBody,
        isRetryable: isRetryableStatus(response.status),
      });
    }

    if (body.stream === true) {
      return response;
    }

    return (await response.json()) as unknown;
  }
}

async function openStream(stream: ReadableStream<LanguageModelV1StreamPart>, modelId: string) {
  const reader = stream.getReader();
  const first = await reader.read();

  if (first.done) {
    throw new Error(`Workers AI returned an empty response for ${modelId}`);
  }

  if (first.value.type === 'error') {
    await reader.cancel().catch(() => undefined);

    throw first.value.error instanceof Error ? first.value.error : new Error(describeError(first.value.error));
  }

  if (first.value.type === 'finish') {
    await reader.cancel().catch(() => undefined);

    throw new Error(
      `Workers AI returned an empty response for ${modelId} (finish reason: ${first.value.finishReason})`,
    );
  }

  const firstPart = first.value;

  return new ReadableStream<LanguageModelV1StreamPart>({
    start(controller) {
      controller.enqueue(firstPart);
    },

    async pull(controller) {
      const { done, value } = await reader.read();

      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },

    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function collectParts(stream: ReadableStream<LanguageModelV1StreamPart>) {
  const reader = stream.getReader();

  let text = '';
  let finishReason: LanguageModelV1FinishReason = 'unknown';
  let usage: TokenUsage = { promptTokens: Number.NaN, completionTokens: Number.NaN };

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value.type === 'text-delta') {
      text += value.textDelta;
    } else if (value.type === 'finish') {
      finishReason = value.finishReason;
      usage = value.usage;
    } else if (value.type === 'error') {
      throw value.error instanceof Error ? value.error : new Error(describeError(value.error));
    }
  }

  return { text, finishReason, usage };
}

/**
 * Factory used by `model.ts`: one model instance per candidate.
 */
export function createWorkersAI(transport: WorkersAITransport, options?: WorkersAIModelOptions) {
  return (modelId: string): LanguageModelV1 => new WorkersAILanguageModel(modelId, transport, options);
}
