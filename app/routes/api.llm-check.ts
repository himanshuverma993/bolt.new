import { type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { generateText } from 'ai';
import { getModelCandidates } from '~/lib/.server/llm/model';

/**
 * Diagnostics endpoint: pings up to `limit` configured models and reports which
 * ones answer. Useful right after filling `.env.local`, because it separates
 * "provider unreachable" from "model id wrong" without touching the UI.
 *
 * Endpoint: `GET /api/llm-check`, with the optional query params `limit` and
 * `timeoutMs`, for example `/api/llm-check?limit=5&timeoutMs=20000`.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const limit = clamp(Number(url.searchParams.get('limit') ?? 3), 1, 10);
  const timeoutMs = clamp(Number(url.searchParams.get('timeoutMs') ?? 15000), 1000, 60000);

  let candidates;

  try {
    candidates = getModelCandidates(context.cloudflare.env).slice(0, limit);
  } catch (error) {
    return json({ ok: false, error: describe(error), results: [] }, 400);
  }

  const results = [];

  for (const candidate of candidates) {
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    try {
      const { text } = await generateText({
        model: candidate.model,
        prompt: 'Reply with the single word: pong',
        maxTokens: 16,
        temperature: candidate.temperature,
        headers: candidate.headers,
        abortSignal: abort.signal,
        maxRetries: 0,
      });

      results.push({
        model: candidate.modelId,
        provider: candidate.provider,
        ok: true,
        ms: Date.now() - started,
        reply: text.trim().slice(0, 80),
      });
    } catch (error) {
      results.push({
        model: candidate.modelId,
        provider: candidate.provider,
        ok: false,
        ms: Date.now() - started,
        error: describe(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const ok = results.some((result) => result.ok);

  return json({ ok, results }, ok ? 200 : 503);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Number.isFinite(value) ? Math.min(Math.max(value, minimum), maximum) : minimum;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
