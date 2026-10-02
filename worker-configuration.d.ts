interface Env {
  ANTHROPIC_API_KEY: string;

  /* optional: any OpenAI-compatible endpoint (free API router, Hugging Face, NIM, Groq, ...) */
  LLM_PROVIDER?: 'anthropic' | 'openai';
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
