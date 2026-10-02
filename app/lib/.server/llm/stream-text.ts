import { streamText as _streamText, convertToCoreMessages } from 'ai';
import { createScopedLogger } from '~/utils/logger';
import {
  getMaxRetries,
  getModelCandidates,
  getStreamTimeouts,
  type ModelCandidate,
  type StreamTimeouts,
} from './model';
import { getSystemPrompt } from './prompts';

interface ToolResult<Name extends string, Args, Result> {
  toolCallId: string;
  toolName: Name;
  args: Args;
  result: Result;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolInvocations?: ToolResult<string, unknown, unknown>[];
}

export type Messages = Message[];

export type StreamingOptions = Omit<Parameters<typeof _streamText>[0], 'model'>;

export interface LLMStream {
  toAIStream(): ReadableStream<Uint8Array>;
}

const logger = createScopedLogger('llm');

/**
 * Resolves the model chain and opens the first model that actually produces
 * tokens. A rejected attempt (401/403/429/5xx/network/timeout) is retried with
 * the next candidate, and an exhausted chain throws, so the route can answer
 * with a real HTTP error instead of a broken stream.
 */
export async function streamText(
  messages: Messages,
  env: Env,
  options?: StreamingOptions,
  modelOverride?: string,
): Promise<LLMStream> {
  const candidates = getModelCandidates(env, modelOverride);
  const timeouts = getStreamTimeouts(env);
  const maxRetries = getMaxRetries(env);

  const attempt = await openWithFallback(candidates, messages, options, maxRetries, timeouts);

  let stream: ReadableStream<Uint8Array> | undefined;

  return {
    toAIStream: () => (stream ??= pumpRemainingChunks(attempt, timeouts)),
  };
}

interface OpenAttempt {
  candidate: ModelCandidate;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  firstChunk: Uint8Array;
  abort: AbortController;
}

function createAttempt(
  candidate: ModelCandidate,
  messages: Messages,
  options: StreamingOptions | undefined,
  maxRetries: number,
  abortSignal: AbortSignal,
) {
  return _streamText({
    ...options,
    model: candidate.model,
    system: getSystemPrompt(),
    maxTokens: candidate.maxTokens,
    temperature: candidate.temperature,
    headers: candidate.headers,
    maxRetries,
    abortSignal,
    messages: convertToCoreMessages(messages),
  });
}

/**
 * Races a promise against a deadline and aborts the upstream request when the
 * deadline is hit, so a hanging free provider cannot block the whole chain.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, abort: AbortController, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController) {
  if (source === undefined) {
    return;
  }

  if (source.aborted) {
    target.abort();

    return;
  }

  source.addEventListener('abort', () => target.abort(), { once: true });
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function openWithFallback(
  candidates: ModelCandidate[],
  messages: Messages,
  options: StreamingOptions | undefined,
  maxRetries: number,
  timeouts: StreamTimeouts,
): Promise<OpenAttempt> {
  let lastError: unknown = undefined;

  for (const [index, candidate] of candidates.entries()) {
    const isLast = index === candidates.length - 1;
    const label = `${candidate.provider}/${candidate.modelId}`;
    const abort = new AbortController();
    const deadline = Date.now() + timeouts.firstTokenMs;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    linkAbortSignal(options?.abortSignal, abort);

    try {
      const result = await withTimeout(
        createAttempt(candidate, messages, options, maxRetries, abort.signal),
        timeouts.firstTokenMs,
        abort,
        `${label} request`,
      );

      /* an abandoned attempt rejects, so keep that promise handled */
      result.text.catch(() => undefined);

      reader = result.toAIStream().getReader();

      const chunk = await withTimeout(
        reader.read(),
        Math.max(1000, deadline - Date.now()),
        abort,
        `${label} first token`,
      );

      if (chunk.done || chunk.value === undefined) {
        throw new Error('the model returned an empty response');
      }

      logger.info(`using ${label}`);

      return { candidate, reader, firstChunk: chunk.value, abort };
    } catch (error) {
      lastError = error;

      logger.warn(`${label} failed${isLast ? '' : ', trying the next model'}:`, describeError(error));

      abort.abort();

      try {
        await reader?.cancel();
      } catch {
        /* the attempt already failed, nothing to clean up */
      }

      if (isLast) {
        break;
      }
    }
  }

  throw lastError ?? new Error('No model candidates available');
}

/**
 * Forwards the buffered first chunk and then keeps pumping the model stream.
 *
 * The idle watchdog aborts a stream that stops producing tokens. Failover is
 * not possible here: the client already received part of the response.
 */
function pumpRemainingChunks(attempt: OpenAttempt, timeouts: StreamTimeouts): ReadableStream<Uint8Array> {
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: Uint8Array) => {
        if (cancelled) {
          return;
        }

        try {
          controller.enqueue(chunk);
        } catch {
          /* the consumer cancelled the response while we were streaming */
          cancelled = true;
        }
      };

      const safeClose = () => {
        try {
          controller.close();
        } catch {
          /* the consumer cancelled the response before we finished */
        }
      };

      const fail = (error: unknown) => {
        if (cancelled) {
          return;
        }

        try {
          controller.error(error);
        } catch {
          /* the consumer is already gone */
        }
      };

      safeEnqueue(attempt.firstChunk);

      void (async () => {
        try {
          for (;;) {
            if (cancelled) {
              return;
            }

            const { done, value } = await withTimeout(
              attempt.reader.read(),
              timeouts.idleMs,
              attempt.abort,
              `${attempt.candidate.provider}/${attempt.candidate.modelId} stream`,
            );

            if (cancelled) {
              return;
            }

            if (done) {
              break;
            }

            safeEnqueue(value);
          }

          safeClose();
        } catch (error) {
          logger.error(
            `${attempt.candidate.provider}/${attempt.candidate.modelId} failed mid-stream, cannot fail over:`,
            describeError(error),
          );

          fail(error);
        }
      })();
    },

    async cancel() {
      cancelled = true;
      attempt.abort.abort();

      try {
        await attempt.reader.cancel();
      } catch {
        /* upstream is already gone */
      }
    },
  });
}
