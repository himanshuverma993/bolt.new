/**
 * Tiny OpenAI-compatible mock provider.
 *
 * Run it with "node scripts/mock-openai-server.mjs" to verify Bolt's wiring
 * without any provider key. It listens on http://0.0.0.0:8788/v1 and streams a
 * small Bolt artifact back. A matching `.env.local` looks like this:
 *
 *   `LLM_PROVIDER=openai`
 *   `LLM_BASE_URL=http://127.0.0.1:8788/v1`
 *   `LLM_API_KEY=mock`
 *   `LLM_MODEL=mock-fail`
 *   `LLM_FALLBACK_MODELS=mock-ok`
 *
 * With that setup the first model answers with HTTP 429 and Bolt fails over to
 * the second one, which is exactly the path the unit tests exercise.
 *
 * Environment variables for the CLI: PORT (default 8788), FAIL_MODELS with the
 * comma separated model ids that answer HTTP 429, and RESPONSE with the text
 * streamed back by the working model.
 */
import { createServer } from 'node:http';

export const DEFAULT_MOCK_RESPONSE = `Namaste! Main ek mock OpenAI-compatible provider hoon.

<boltArtifact id="mock-artifact" title="Mock artifact">
<boltAction type="file" filePath="hello.txt">namaste from the mock provider
</boltAction>
</boltArtifact>`;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function chunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: 'mock-completion',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function readBody(req) {
  const chunks = [];

  for await (const part of req) {
    chunks.push(part);
  }

  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/**
 * Starts an OpenAI-compatible HTTP server.
 *
 * Failures can be simulated per model, which is what the unit tests use:
 * `failModels` answers with `failStatus`, `stallModels` never answers, and
 * `stallAfterFirstChunkModels` sends one content chunk and then goes silent.
 *
 * @param {object} [options] configuration, every field is optional
 * @param {number} [options.port] 0 picks a free port, which the tests rely on
 * @param {string[]} [options.failModels] model ids answered with `failStatus`
 * @param {number} [options.failStatus] HTTP status for those models, default 429
 * @param {string[]} [options.stallModels] model ids whose request never answers
 * @param {string[]} [options.stallAfterFirstChunkModels] model ids that go silent mid-stream
 * @param {string} [options.response] text streamed by the working model
 * @param {(message: string) => void} [options.log] logger, silent by default
 * @returns {Promise<object>} handle with `url`, `port`, `requests`, `calls` and `close`
 */
export function startMockProvider(options = {}) {
  const failModels = options.failModels ?? ['mock-fail'];
  const failStatus = options.failStatus ?? 429;
  const stallModels = options.stallModels ?? [];
  const stallAfterFirstChunkModels = options.stallAfterFirstChunkModels ?? [];
  const response = options.response ?? DEFAULT_MOCK_RESPONSE;
  const log = options.log ?? (() => undefined);
  const requests = [];
  const calls = [];

  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/v1/') !== true) {
      sendJson(res, 404, { error: { message: `Unknown path ${req.url}` } });

      return;
    }

    let body = {};

    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: { message: 'Invalid JSON body' } });

      return;
    }

    const model = body.model ?? 'mock';
    requests.push(model);
    calls.push({ model, headers: req.headers, body });
    log(`[mock] ${req.method} ${req.url} model=${model} stream=${body.stream === true}`);

    if (stallModels.includes(model)) {
      log(`[mock] -> holding the connection open for model=${model}`);

      return;
    }

    if (failModels.includes(model)) {
      log(`[mock] -> ${failStatus} for model=${model}`);
      sendJson(res, failStatus, {
        error: { message: `Mock failure for ${model}`, type: 'rate_limit_error' },
      });

      return;
    }

    if (stallAfterFirstChunkModels.includes(model)) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ content: 'partial ' }));
      log(`[mock] -> sent one chunk and went silent for model=${model}`);

      return;
    }

    if (body.stream !== true) {
      sendJson(res, 200, {
        id: 'mock-completion',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: response }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    for (const word of response.split(/(?<=\s)/)) {
      res.write(chunk({ content: word }));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    res.write(chunk({}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;

      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        port,
        requests,
        calls,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

const isCli = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  const { port } = await startMockProvider({
    port: Number(process.env.PORT ?? 8788),
    failModels: (process.env.FAIL_MODELS ?? 'mock-fail')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean),
    response: process.env.RESPONSE,
    log: console.log,
  });

  console.log(`[mock] OpenAI-compatible mock listening on http://0.0.0.0:${port}/v1`);
}
