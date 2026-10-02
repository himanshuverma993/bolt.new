# Bolt.new ko free APIs se power dena — is repo ke liye wiring guide

> Ye guide tumhari "free API catalog" file ke saath use karne ke liye hai. Wiring **model-ID agnostic** hai:
> jo bhi OpenAI-compatible endpoint + model id tumhare paas hai, wahi yahan plug ho jata hai.
> Yahan sab kuch **is repo ke actual code** ke hisaab se likha hai (`app/lib/.server/llm/*`, `app/routes/api.*`).

---

## 0. TL;DR — 7 facts jo pura decision decide karte hain

1. **Router repo ki zaroorat nahi hai.** Bolt ke andar LLM call sirf 2 files se hoti hai: `model.ts` (kaunsa model) aur `stream-text.ts` (stream + fallback). Bas `.env.local` me `LLM_BASE_URL` + `LLM_MODEL` daalo aur free API chal jayegi. Tumhara alag router repo **optional** hai — chaaho to `LLM_BASE_URL` usi router par point kar do.
2. **Ye Bolt version tool-calling use nahi karta.** Request me `tools` / `tool_choice` bhejte hi nahi (maine actual request body capture karke verify kiya: sirf `model, max_tokens, temperature, messages, stream`). Model text me `<boltArtifact>` / `<boltAction>` tags likhta hai, jise browser parse karta hai. Isliye **native function-calling support zaroori nahi** — bas instruction-following achhi honi chahiye.
3. **Fallback chain built-in hai.** `LLM_MODEL` fail hone par `LLM_FALLBACK_MODELS` order me next model try hota hai — 401/403/429/5xx ke liye, aur **hang hone par bhi** (first-token timeout ke saath). Failover sirf **pehle token se pehle** hota hai — mid-stream switch nahi hota, warna UI me do artifacts mix ho jate.
4. **Keys server-side rehti hain.** `/api/chat` ek Remix action hai jo server par chalta hai → browser me key nahi jaati, CORS ka lafda nahi (server → provider HTTP call hai).
5. **Quota hi asli constraint hai.** Har request ke saath ~13.7k characters (~3.5-4k tokens) ka system prompt jaata hai + poori chat history. Free tiers ke RPM/TPM issi se udte hain. Isliye enhancer ke liye alag sasta model (`LLM_ENHANCER_MODEL`) aur `LLM_MAX_RETRIES=0` default rakha gaya hai.
6. **Chain ko pehle check kar sakte ho, app chalane se pehle:** `pnpm run check-llm` (CLI) ya `GET /api/llm-check` (browser) batata hai kaunsa model jawab de raha hai.
7. **Verify bina kisi key ke bhi hota hai:** `pnpm run mock-llm` + `pnpm test` (9 tests fallback, timeout, temperature, extra-body, per-model cap cover karte hain).

---

## 1. Asli flow — kahan kya lagta hai

```
Browser (Bolt UI + WebContainer)
   │  POST /api/chat        (user message + history)
   ▼
Remix action  app/routes/api.chat.ts
   │  streamText(...)                    ← async, model chain yahin open hoti hai
   ▼
app/lib/.server/llm/stream-text.ts      ← failover + timeouts + streaming
   │  getModelCandidates(env)
   ▼
app/lib/.server/llm/model.ts            ← provider + model selection (YAHAN wiring hai)
   │  HTTP (OpenAI-compatible /v1/chat/completions, stream: true)
   ▼
Free provider / Tumhara router  ──SSE──►  UI me live output + artifacts run
```

Dusre endpoint:

- `app/routes/api.enhancer.ts` — "enhance prompt" button, `LLM_ENHANCER_MODEL` set ho to pehle wahi model try karta hai.
- `app/routes/api.llm-check.ts` — diagnostics, `GET /api/llm-check?limit=3&timeoutMs=15000`.

### Files ki map (chhote se bade change ke hisaab se)

| Kya badalna hai | File |
| --- | --- |
| Provider / base URL / model / fallback chain | `.env.local` (`.env.example` copy karo) |
| Naye env vars ka type | `worker-configuration.d.ts` |
| Provider logic (defaults, aliases, limits) | `app/lib/.server/llm/model.ts` |
| Failover + timeouts + streaming | `app/lib/.server/llm/stream-text.ts` |
| Output token cap / segments | `app/lib/.server/llm/constants.ts` (`MAX_TOKENS = 8192`, `MAX_RESPONSE_SEGMENTS = 2`) |
| System prompt (model ki "personality") | `app/lib/.server/llm/prompts.ts` |

---

## 2. Setup

### 2.1 Basic

```bash
pnpm install
cp .env.example .env.local     # phir .env.local me apna block enable karo
pnpm run check-llm             # chain verify karo (recommended)
pnpm run dev                   # http://localhost:5173
```

`.env.local` me comment hata kar **ek** block chalao. Blocks:
`1` Anthropic (default), `2` Hugging Face router, `3` local router, `4` mock (bina key).

### 2.2 Approach A — direct free provider (recommended)

Kon sa bhi OpenAI-compatible endpoint `LLM_BASE_URL` me daal do. Kuch common ones (base URL ke aage
`/chat/completions` **nahi** lagana — AI SDK khud lagata hai):

| Provider | Base URL | Notes |
| --- | --- | --- |
| Hugging Face router | `https://router.huggingface.co/v1` | HF token chahiye (Inference Providers permission). Model id format: `org/model:provider` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `nvapi-...` key, build.nvidia.com se |
| ModelScope | `https://api-inference.modelscope.cn/v1` | Alibaba ka free tier (RPD limit provider se confirm karo) |
| Groq | `https://api.groq.com/openai/v1` | fast inference, RPM/RPD limits |
| Cerebras | `https://api.cerebras.ai/v1` | fast inference, free tier |
| OpenRouter | `https://openrouter.ai/api/v1` | `:free` models; `LLM_HEADERS` me referer optional |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1` | URL me account id daalni padti hai |
| Together | `https://api.together.xyz/v1` | |
| Fireworks | `https://api.fireworks.ai/inference/v1` | |
| Google Gemini (OpenAI-compat) | `https://generativelanguage.googleapis.com/v1beta/openai/` | |

Provider docs se base URL/limits ek baar confirm kar lena — limits badalte rehte hain.

```env
LLM_PROVIDER=openai
LLM_BASE_URL=https://router.huggingface.co/v1
LLM_API_KEY=hf_xxx
LLM_MODEL=zai-org/GLM-5.3:together
LLM_FALLBACK_MODELS=moonshotai/Kimi-K3:cerebras,deepseek-ai/DeepSeek-V4-Pro:fireworks-ai
LLM_ENHANCER_MODEL=zai-org/GLM-5.3-Flash:together
```

**Model ID exactly waisa likho jo provider ke catalog me hai** (case-sensitive, suffix bhi). Naya model add
karne ke liye code change nahi chahiye — sirf env var.

### 2.3 Approach B — tumhara apna router (dusra repo)

```env
LLM_PROVIDER=openai
LLM_BASE_URL=http://127.0.0.1:8787/v1     # tumhare router ka port
LLM_API_KEY=jo-bhi-router-expect-kare
LLM_MODEL=auto                            # router khud decide kare
```

Fayde: fallback/costing/rate-limit logic router me rahega, bolt sirf ek client.
**Is setup me bolt ke andar wali chain mostly bypass ho jaati hai** — `LLM_FALLBACK_MODELS` sirf tab kaam aayega
jab router poora down ho; router ke andar ke models ka failover router khud handle karega.

**⚠️ Sandbox/localhost warning (ye asli gotcha hai):** ye call **server-side** hoti hai. Agar bolt kisi cloud
sandbox (jaise ye Arena workspace, e2b, Codespaces) me chal raha hai aur router tumhare laptop par, to
`127.0.0.1` ka matlab **sandbox** hai, tumhara laptop nahi. Options:

- router bhi usi machine/sandbox me chalao, ya
- router ko public URL/tunnel (cloudflared, ngrok) se expose karo aur wahi `LLM_BASE_URL` do, ya
- Approach A use karo (free provider direct) — sabse simple.

**⚠️ Aur bhi bada gotcha — sandbox ka outbound network block:** kuch cloud sandboxes sirf allowlisted hosts
(npm, github, pypi) tak hi jaane dete hain. Wahan se `router.huggingface.co`, `api.groq.com`, `openrouter.ai`,
`integrate.api.nvidia.com` jaise hosts **reachable hi nahi** honge. Error aisa dikhega:

```
AI_APICallError: Cannot connect to API: fetch failed
... OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to router.huggingface.co:443
```

Ye key/model ki galti **nahi** hai — network block hai. Aise sandbox me sirf **mock provider** test hota hai
(`pnpm run mock-llm`); real provider test apni machine par karo.

### 2.4 Approach C — multiple providers ek saath

Ek waqt me ek `LLM_BASE_URL` chalta hai (chain usi endpoint ke andar rehti hai). Multiple providers chahiye to:

- **ya** ek router/gateway (Approach B) jo providers ko aggregate kare,
- **ya** `.env.local` badal ke restart karo,
- **ya** code me `getModelCandidates()` extend karo (provider ke hisaab se alag base URL) — wiring point wahi ek function hai.

---

## 3. Env vars — poora reference

| Env var | Default | Kaam |
| --- | --- | --- |
| `LLM_PROVIDER` | auto-detect | `openai` (OpenAI-compatible) ya `anthropic` |
| `LLM_BASE_URL` | — | OpenAI-compatible endpoint (`OPENAI_BASE_URL`, `OPENAI_API_BASE` alias) |
| `LLM_API_KEY` | — | (`OPENAI_API_KEY` alias) |
| `LLM_MODEL` | — | Primary model id (`OPENAI_MODEL` alias), `model|maxTokens` syntax supported |
| `LLM_FALLBACK_MODELS` | — | Comma-separated order, same syntax, **Anthropic par bhi** chalta hai |
| `LLM_MAX_TOKENS` | `8192` | Per segment output cap |
| `LLM_MAX_RETRIES` | `0` | Same model ko kitni baar retry (0 = turant next model) |
| `LLM_TEMPERATURE` | `0.2` OpenAI / `0` Anthropic | Free TGI backends kabhi `0` reject karte hain, isliye 0.2 |
| `LLM_HEADERS` | — | Extra headers JSON me |
| `LLM_EXTRA_BODY` | — | Extra request-body fields JSON, har request me merge (vendor knobs jaise `chat_template_kwargs`) |
| `LLM_FIRST_TOKEN_TIMEOUT_MS` | `120000` | First token + cold start ka budget; isse zyada lage to next model |
| `LLM_IDLE_TIMEOUT_MS` | `60000` | Stream beech me chup ho jaye to itne me abort |
| `LLM_ENHANCER_MODEL` | — | Prompt-enhancer ke liye alag (sasta/fast) model |
| `ANTHROPIC_API_KEY` | — | Default setup |
| `ANTHROPIC_BASE_URL` | — | Anthropic proxy use karna ho to (beta header tab auto-drop hota hai) |

Request body me `tools` kabhi nahi jaata. Per-model cap example:

```env
LLM_MODEL=big-coder-model:free|8192
LLM_FALLBACK_MODELS=small-model:free|4096,another-model:free
```

### Behavior (exact)

1. `streamText()` **eager** hai: model chain tab hi open hoti hai jab stream banti hai, aur pehla model jo
   **pehla token** de deta hai, wahi use hota hai.
2. Fail hone wala attempt log hota hai: `warn llm openai/<model> failed, trying the next model: Too Many Requests`.
3. Jo serve karta hai wo log hota hai: `INFO llm using openai/<model>`.
4. **Sab** fail → `/api/chat` **HTTP 500** deta hai + JSON body me hint (pehle broken 200 stream milti thi).
5. Mid-stream fail → failover nahi (error), kyunki partial output already chala gaya.
6. Client cancel (Stop button / tab band) → upstream request abort ho jaati hai.

---

## 4. Free models me se kya choose karo (is repo ke constraints)

Model chunne ke 4 asli criteria (aur ek jo **matter nahi** karta):

| Criteria | Kyun | Minimum |
| --- | --- | --- |
| **Strong instruction following** | Output ko `<boltArtifact>` / `<boltAction type="file">` format me likhna padta hai | achha "coder" model |
| **Streaming (SSE)** | Bolt live stream karta hai; bina stream ke UX kharab + timeouts | `stream: true` support |
| **Output length** | `max_tokens: 8192` bhejta hai; chhota cap wale routes truncate karenge | ≥ 8k, warna `model|4096` se cap karo |
| **Long context** | Bada project = badi history | 128k+ long tasks ke liye |
| ~~Vision~~ | Is Bolt version me image attach feature **nahi** hai | zaroorat nahi |
| ~~Native tool calling~~ | Request me tools hi nahi jaate | **matter nahi karta** |

Role-wise mapping (tumhari catalog file ke naam use karte hue):

```env
# reasoning / planner: Nemotron jaisa bada model
LLM_MODEL=glm-5.3:free

# coder (main): Kimi / DeepSeek / Qwen coder family
LLM_FALLBACK_MODELS=moonshotai/Kimi-K3,deepseek-ai/DeepSeek-V4-Pro

# long-context single-shot: Gemini Flash series (jab bade context wala kaam ho)

# bulk/fast chatter + enhancer: Groq / Cerebras / Flash models
LLM_ENHANCER_MODEL=zai-org/GLM-5.3-Flash:together
```

Practical tip: **primary = sabse reliable free route**, fallbacks = **dusre providers** ke same-tier models.
Ek hi provider ke 3 models rakhne se quota wall par teeno ek saath gir jate hain.

---

## 5. Quota bachane ke rules (free tier me ye sabse important hai)

1. **`LLM_ENHANCER_MODEL` set karo.** Enhance button har click par ek poori request karta hai.
2. **System prompt fixed cost hai:** har request me ~13.7k chars (~3.5-4k tokens) + poori history jaati hai.
3. **Batch instructions:** "color badlo + mobile responsive karo + restart karo" ek hi message me.
4. **`LLM_MAX_TOKENS` chhota karo** agar provider ka output cap chhota hai; warna request 400 de sakti hai.
5. **`MAX_RESPONSE_SEGMENTS = 2`**: ek user message par max ~2 segments; runaway output rukta hai.
6. **`LLM_MAX_RETRIES=0`** rakho: 429 par same model ko dobara maarna quota waste hai.
7. Lambi chat = har message par poori history dobara → naya chat shuru karna sasta padta hai.

---

## 6. Verify kaise karo

### 6.1 Bina kisi key ke (mock provider) — 2 minute

```bash
pnpm run mock-llm      # terminal 1: http://0.0.0.0:8788/v1
pnpm run dev           # terminal 2: .env.local me block 4 enable karke
```

Browser me `http://localhost:5173` → kuch bhi prompt karo. Expect:

- UI me text + `hello.txt` artifact action
- server log: `WARN llm ... mock-fail failed, trying the next model: Too Many Requests` → `INFO llm using openai/mock-ok`
- `mock-fail` sirf **ek** baar hit hota hai (retries 0)

Automated:

```bash
pnpm test           # 33 tests (9 stream/fallback + 24 parser)
pnpm run typecheck
pnpm run lint       # clean
pnpm run build
```

### 6.2 Real provider ke saath — order ye rakho

**Step 1 — provider ko alag se curl karo** (bolt se pehle), key/model galti turant pakadne ke liye:

```bash
curl -sS https://router.huggingface.co/v1/chat/completions \
  -H "Authorization: Bearer $HF_TOKEN" -H 'content-type: application/json' \
  -d '{"model":"zai-org/GLM-5.3:together","messages":[{"role":"user","content":"say ok"}],"stream":false}' | head -c 400
```

**Step 2 — `.env.local` bharo, phir chain check karo:**

```bash
pnpm run check-llm                  # har model ko ping karta hai, first-token time batata hai
pnpm run check-llm -- --timeout 30000 --limit 3
```

Output aisa aata hai:

```
[check-llm] endpoint: https://router.huggingface.co/v1
[check-llm] models:   zai-org/GLM-5.3:together -> moonshotai/Kimi-K3:cerebras

  zai-org/GLM-5.3:together ... OK (first token in 812ms)
  moonshotai/Kimi-K3:cerebras ... FAILED after 1204ms
      HTTP 429: {"error":"Rate limit exceeded"}
```

**Step 3 — app chalao aur browser me `/api/llm-check` bhi dekh lo** (dev server se hi chalta hai, UI ki
zaroorat nahi): `http://localhost:5173/api/llm-check` → JSON me `ok: true/false` + har model ka result.

**Step 4 — Bolt me chhota prompt:** "ek index.html banao jisme hello likha ho" → artifact banna chahiye.
Server log me `using openai/<model>` confirm karta hai kaunsa free model serve kar raha hai.

### 6.3 Hugging Face ke saath test karne ka exact recipe

1. HF pe token banao: **Settings → Access Tokens**, permission me **"Make calls to Inference Providers"** on hona chahiye.
2. Model choose karo: kisi bhi model page par "Inference Providers" section dekho — wahan `provider` ka naam milta hai.
   Id banti hai `org/model:provider` (e.g. `zai-org/GLM-5.3:together`, `moonshotai/Kimi-K3:cerebras`).
3. `.env.local`:

```env
LLM_PROVIDER=openai
LLM_BASE_URL=https://router.huggingface.co/v1
LLM_API_KEY=hf_xxxxxxxx
LLM_MODEL=zai-org/GLM-5.3:together
LLM_FALLBACK_MODELS=moonshotai/Kimi-K3:cerebras,deepseek-ai/DeepSeek-V4-Pro:fireworks-ai
LLM_MAX_RETRIES=0
LLM_ENHANCER_MODEL=zai-org/GLM-5.3-Flash:together
```

4. `pnpm run check-llm` → phir `pnpm run dev`.
5. Free tier tips: HF router par limits **per provider account** lagti hain; 429 aaye to fallback list me
   **dusre provider** (`:cerebras`, `:fireworks-ai`, `:groq`...) ke models rakho, aur enhancer ko chhote model pe daalo.

---

## 7. Troubleshooting

| Symptom | Wajah / Fix |
| --- | --- |
| `401` / `403` | Key galat ya permission missing (HF token me "Inference Providers" on hona chahiye; NIM key `nvapi-` se) |
| `404` / `model not found` | Model id exactly provider ke catalog wala likho (case + `:provider` suffix). Router ho to `auto` try karo |
| `429` baar-baar | Chain me dusre providers ke models daalo / `LLM_ENHANCER_MODEL` alag karo / RPM-TPM check karo |
| **`fetch failed` + `SSL_ERROR_SYSCALL`, ya HTTP 000** | **Network block** (sandbox allowlist/firewall) — key/model ki galti nahi. Apni machine par chalao, ya sirf mock se test karo |
| `AI_APICallError: ... 400 ... is not a valid model` type error | Provider ka apna message hota hai — `LLM_FALLBACK_MODELS` next model try kar lega, par id theek karna better hai |
| Model artifact tags nahi likhta, prose likh raha | Model kamzor hai — coder/instruct variant try karo |
| Stream beech me atak jata hai | `LLM_IDLE_TIMEOUT_MS` kam karo (default 60s), provider ka streaming support check karo |
| Cold start 2-3 min lagta hai | `LLM_FIRST_TOKEN_TIMEOUT_MS` badhao (default 120s) ya koi warm/smaller model primary rakho |
| `LLM_MODEL` required error | Approach A/B me `LLM_MODEL` set karna bhool gaye ho |
| Env change hua par asar nahi | Dev server restart karo; file ka naam exactly `.env.local` hona chahiye |
| `pnpm run start` (wrangler) me vars nahi mile | `.env.local` file exist karni chahiye — `bindings.sh` usse `--binding` banata hai |
| Production deploy me vars | `pnpm run deploy` ke baad Cloudflare Pages project settings me same env vars daalo |
| Thunder client/CORS | CORS issue nahi aayega — key server par hai, browser sirf `/api/chat` call karta hai |

---

## 8. Is repo me kya add/change hua (diff summary)

| File | Change |
| --- | --- |
| `app/lib/.server/llm/model.ts` | Env-driven provider/model selection + fallback candidates + retries + temperature + `LLM_HEADERS`/`LLM_EXTRA_BODY` + per-model `\|maxTokens` + aliases; Anthropic default untouched |
| `app/lib/.server/llm/stream-text.ts` | Async `streamText()` jo **eager failover** karta hai: har attempt ka first-token timeout, hang/429/401/5xx par next model, abort + reader cancel, idle watchdog, mid-stream error, chain exhausted par throw |
| `app/routes/api.chat.ts` | 500 par JSON body me actionable hint (`check-llm` / `llm-check` ka reference) + logger |
| `app/routes/api.enhancer.ts` | Enhancer ke liye optional `LLM_ENHANCER_MODEL` |
| `app/routes/api.llm-check.ts` | **Naya** diagnostics endpoint: `GET /api/llm-check` |
| `scripts/check-provider.mjs` | **Naya** CLI preflight: `pnpm run check-llm` |
| `scripts/mock-openai-server.mjs` | Mock provider + failure modes: 429, hang (stall), mid-stream silence; request capture |
| `app/lib/.server/llm/stream-text.spec.ts` | **Naye** 9 tests: failover order, all-fail, first-token timeout, mid-stream idle timeout, temperature, extra body, headers, per-model cap, enhancer override, Anthropic default |
| `worker-configuration.d.ts`, `.env.example` | Naye env bindings + 4 ready blocks + tuning reference |
| `eslint.config.mjs` | Ignore pattern fix: `build/` (remix output) ab lint nahi hota — pehle lint 4+ min leta tha, ab ~3s |
| `app/components/sidebar/Menu.client.tsx` | Pre-existing unused import hata diya, lint green |
| `package.json` / `pnpm-lock.yaml` | `@ai-sdk/openai@0.0.44` (ai@3.3.4-matched) + `check-llm`/`mock-llm` scripts |

---

## 9. Honest caveats

- **Is sandbox me main real inference test nahi kar saka** — yahan ka outbound network allowlisted hai (only
  npm/github/pypi reachable; HF, NIM, Groq, OpenRouter, OpenAI, Anthropic sab blocked). Jo verify hua: code
  path, streaming, failover, timeouts, cancellation, per-model caps, diagnostics endpoint, CLI — sab mock
  provider ke saath end-to-end. **Real HF test tumhe apni machine par karna hoga** (recipe §6.3 me hai).
- Tumhari catalog file ke **limits/availability main verify nahi kar sakta** — provider ke dashboard/docs se
  confirm karo. Model IDs provider ke live catalog se match karo.
- Base URLs aur model id formats standard hain, par providers inhe badalte rehte hain — `check-llm` se pehle check.
- Is Bolt version me **koi model picker UI nahi hai** — model selection server-side env se hoti hai. Picker
  chahiye to `model.ts` + `/api/chat` ko extend karna padega.
- Failover ki hard limit: **pehle token ke baad** error aayi to message adhoora reh sakta hai — ye architecture
  ka tradeoff hai (warna UI me do responses mix ho jaate).
