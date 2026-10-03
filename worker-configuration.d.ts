/**
 * Hand-maintained bindings of the Pages Function (`context.cloudflare.env`).
 * Keep it in sync with wrangler.toml and .env.example.
 */
interface Env {
  /**
   * Workers AI binding, configured in wrangler.toml (`[ai] binding = "AI"`).
   * Present on Cloudflare Pages/Workers and in `wrangler pages dev` / the Remix
   * dev proxy; absent in unit tests. The structural type is intentionally loose
   * so that new model ids type-check (see app/lib/.server/llm/workers-ai.ts).
   */
  AI?: {
    run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  };

  ANTHROPIC_API_KEY: string;

  /* provider selection: "cloudflare" (Workers AI), "openai" (any OpenAI-compatible endpoint) or "anthropic" */
  LLM_PROVIDER?: 'anthropic' | 'openai' | 'cloudflare';

  /* Workers AI through the REST API (local development without `wrangler login`, or outside Cloudflare) */
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;

  /* optional: route Workers AI calls through an AI Gateway (caching, analytics, rate limiting) */
  CLOUDFLARE_AI_GATEWAY_ID?: string;

  /* optional: "auto" (binding first, REST as fallback), "binding" or "rest" */
  CLOUDFLARE_AI_TRANSPORT?: 'auto' | 'binding' | 'rest';

  /* optional: override the REST base URL (proxies, tests) */
  CLOUDFLARE_AI_BASE_URL?: string;

  /* optional: ms window for merging streamed Workers AI tokens (CPU saver, default 80, 0 = off) */
  LLM_STREAM_COALESCE_MS?: string;

  /* optional: any OpenAI-compatible endpoint (free API router, Hugging Face, NIM, Groq, ...) */
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_FALLBACK_MODELS?: string;
  LLM_MAX_TOKENS?: string;
  LLM_MAX_RETRIES?: string;
  LLM_TEMPERATURE?: string;
  LLM_HEADERS?: string;
  LLM_EXTRA_BODY?: string;
  LLM_FIRST_TOKEN_TIMEOUT_MS?: string;
  LLM_IDLE_TIMEOUT_MS?: string;
  LLM_ENHANCER_MODEL?: string;

  /* aliases kept for the OpenAI-compatible configuration */
  OPENAI_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}
