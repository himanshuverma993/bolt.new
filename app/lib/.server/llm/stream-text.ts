import { streamText as _streamText, convertToCoreMessages } from 'ai';
import { createScopedLogger } from '~/utils/logger';
import { MAX_TOKENS } from './constants';
import { getMaxRetries, getModelCandidates, type ModelCandidate } from './model';
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

const logger = createScopedLogger('llm');

export interface LLMStream {
  toAIStream(): ReadableStream<Uint8Array>;
}

export function streamText(
  messages: Messages,
  env: Env,
  options?: StreamingOptions,
  modelOverride?: string,
): LLMStream {
  const candidates = getModelCandidates(env, modelOverride);

  return {
    toAIStream: () => streamWithFallback(candidates, messages, options, getMaxRetries(env)),
  };
}

function createAttempt(candidate: ModelCandidate, messages: Messages, options?: StreamingOptions, maxRetries = 0) {
  return _streamText({
    model: candidate.model,
    system: getSystemPrompt(),
    maxTokens: candidate.maxTokens || MAX_TOKENS,
    headers: candidate.headers,
    maxRetries,
    messages: convertToCoreMessages(messages),
    ...options,
  });
}

/**
 * Streams from the first model that produces output, falling back to the next
 * candidate when a provider rejects the request (401/403/429/quota/timeouts).
 *
 * Failover only happens *before* the first token reaches the client. Once a
 * partial response has been sent we cannot restart it, otherwise the browser
 * would receive two interleaved artifacts.
 */
function streamWithFallback(
  candidates: ModelCandidate[],
  messages: Messages,
  options?: StreamingOptions,
  maxRetries = 0,
): ReadableStream<Uint8Array> {
  let cancelled = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastError: unknown = undefined;

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

      for (const [index, candidate] of candidates.entries()) {
        if (cancelled) {
          return;
        }

        const isLast = index === candidates.length - 1;
        let attemptReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let started = false;

        try {
          const result = await createAttempt(candidate, messages, options, maxRetries);

          /* when an attempt is abandoned this promise rejects, so keep it handled */
          result.text.catch(() => undefined);

          attemptReader = result.toAIStream().getReader();
          activeReader = attemptReader;

          const firstChunk = await attemptReader.read();

          if (cancelled) {
            return;
          }

          if (firstChunk.done || firstChunk.value === undefined) {
            throw new Error('The model returned an empty response');
          }

          /* failover is only safe before the first byte reaches the client */
          started = true;
          logger.info(`using ${candidate.provider}/${candidate.modelId}`);
          safeEnqueue(firstChunk.value);

          for (;;) {
            const { done, value } = await attemptReader.read();

            if (cancelled) {
              return;
            }

            if (done) {
              break;
            }

            safeEnqueue(value);
          }

          activeReader = undefined;

          try {
            controller.close();
          } catch {
            /* the consumer cancelled the response before we finished */
          }

          return;
        } catch (error) {
          activeReader = undefined;
          lastError = error;

          if (cancelled) {
            return;
          }

          if (started) {
            logger.error(
              `${candidate.provider}/${candidate.modelId} failed mid-stream, cannot fail over to another model`,
              error,
            );
            controller.error(error);

            return;
          }

          logger.warn(
            `${candidate.provider}/${candidate.modelId} failed${isLast ? '' : ', trying the next model'}:`,
            error instanceof Error ? error.message : error,
          );

          try {
            await attemptReader?.cancel();
          } catch {
            /* the attempt already failed, nothing to clean up */
          }

          if (isLast) {
            break;
          }
        }
      }

      if (!cancelled) {
        controller.error(lastError ?? new Error('No model candidates available'));
      }
    },

    async cancel() {
      cancelled = true;

      try {
        await activeReader?.cancel();
      } catch {
        /* upstream is already gone */
      }
    },
  });
}
