# Bolt.new ko free APIs se power dena — is repo ke liye wiring guide

> Ye guide tumhari us "free API catalog" file ke saath use karne ke liye hai. Wiring **model-ID agnostic** hai:
> jo bhi OpenAI-compatible endpoint + model id tumhare paas hai, wahi yahan plug ho jata hai.
> Yahan sab kuch **is repo ke actual code** ke hisaab se likha hai (`app/lib/.server/llm/*`, `app/routes/api.*`).

---

## 0. TL;DR — 6 facts jo pura decision decide karte hain

1. **Router repo ki zaroorat nahi hai.** Bolt ke andar LLM call sirf 2 files se hoti hai: `model.ts` (kaunsa model) aur `stream-text.ts` (stream + fallback). Bas `.env.local` me `LLM_BASE_URL` + `LLM_MODEL` daalo aur free API chal jayegi. Tumhara alag router repo **optional** hai — chaaho to `LLM_BASE_URL` usi router par point kar do.
2. **Ye Bolt version tool-calling use nahi karta.** Request me `tools` / `tool_choice` bhejte hi nahi (maine actual request body capture karke verify kiya: sirf `model, max_tokens, temperature, messages, stream`). Model text me `<boltArtifact>` / `<boltAction>` tags likhta hai, jise browser parse karta hai. Isliye **native function-calling support zaroori nahi** — bas instruction-following achhi honi chahiye.
3. **Fallback chain built-in hai.** `LLM_MODEL` fail hone par `LLM_FALLBACK_MODELS` order me next model try hota hai (429/401/403/timeout par). Failover sirf **pehle token se pehle** hota hai — mid-stream switch nahi hota, warna UI me do artifacts mix ho jate.
4. **Keys server-side rehti hain.** `/api/chat` ek Remix action hai jo server par chalta hai → browser me key nahi jaati, CORS ka lafda nahi (ye sirf server → provider HTTP call hai).
5. **Quota hi asli constraint hai.** Har request ke saath ~13.7k characters (~3.5-4k tokens) ka system prompt jaata hai + poori chat history. Free tiers ke RPM/TPM issi se udte hain. Isliye enhancer ke liye alag sasta model (`LLM_ENHANCER_MODEL`) aur `LLM_MAX_RETRIES=0` default rakha gaya hai.
6. **Verify karne ka tareeka bina key ke bhi hai:** `scripts/mock-openai-server.mjs` + `pnpm test` (5 tests chain verify karte hain).

---

## 1. Asli flow — kahan kya lagta hai

```
Browser (Bolt UI + WebContainer)
   │  POST /api/chat        (user message + history)
   ▼
Remix action  app/routes/api.chat.ts
   │  streamText(...)
   ▼
app/lib/.server/llm/stream-text.ts      ← fallback + streaming logic
   │  getModelCandidates(env)
   ▼
app/lib/.server/llm/model.ts            ← provider + model selection (YAHAN wiring hai)
   │  HTTP (OpenAI-compatible /v1/chat/completions, stream: true)
   ▼
Free provider / Tumhara router  ──SSE──►  UI me live output + artifacts run
```

Dusra endpoint: `app/routes/api.enhancer.ts` ("enhance prompt" button) bhi wahi chain use karta hai, bas
`LLM_ENHANCER_MODEL` set ho to pehle wahi model try hota hai.

### Files ki map (chhote se bade change ke hisaab se)

| Kya badalna hai | File |
| --- | --- |
| Provider / base URL / model / fallback chain | `.env.local` (`.env.example` copy karo) |
| Naye env vars ka type | `worker-configuration.d.ts` |
| Provider logic (default model, key aliases) | `app/lib/.server/llm/model.ts` |
| Output token cap / segments | `app/lib/.server/llm/constants.ts` (`MAX_TOKENS = 8192`, `MAX_RESPONSE_SEGMENTS = 2`) |
| System prompt (model ki "personality") | `app/lib/.server/llm/prompts.ts` |

---

## 2. Setup

### 2.1 Basic

```bash
pnpm install
cp .env.example .env.local     # phir .env.local me apna block enable karo
pnpm run dev                   # http://localhost:5173
```

`.env.local` me comment hata kar **ek** block chalao. Blocks:
`1` Anthropic (default), `2` OpenAI-compatible provider (HF router jaise), `3` local router, `4` mock (bina key).

### 2.2 Approach A — direct free provider (recommended)

Kon sa bhi OpenAI-compatible endpoint `LLM_BASE_URL` me daal do. Kuch common ones (base URL ke aage
`/chat/completions` **nahi** lagana — AI SDK khud lagata hai):

| Provider | Base URL | Notes |
| --- | --- | --- |
| Hugging Face router | `https://router.huggingface.co/v1` | HF token chahiye (Inference Providers permission). Model id format: `org/model:provider` (e.g. `zai-org/GLM-5.3:together`) |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `nvapi-...` key, build.nvidia.com se |
| ModelScope | `https://api-inference.modelscope.cn/v1` | Alibaba ka free tier (RPD limit provider se confirm karo) |
| Groq | `https://api.groq.com/openai/v1` | fast inference, RPM/RPD limits |
| Cerebras | `https://api.cerebras.ai/v1` | fast inference, free tier |
| OpenRouter | `https://openrouter.ai/api/v1` | `:free` models ke liye; `LLM_HEADERS` me referer optional |
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
LLM_MAX_TOKENS=8192
LLM_MAX_RETRIES=0
LLM_ENHANCER_MODEL=zai-org/GLM-5.3-Flash:together
```

**Model ID exactly waisa likho jo provider ke catalog me hai** (case-sensitive, suffix bhi). Naya model add
karne ke liye code change nahi chahiye — sirf env var.

### 2.3 Approach B — tumhara apna router (dusra repo)

**Agar dono cheezein ek hi machine/sandbox me chal rahi hain:**

```env
LLM_PROVIDER=openai
LLM_BASE_URL=http://127.0.0.1:8787/v1     # tumhare router ka port
LLM_API_KEY=jo-bhi-router-expect-kare
LLM_MODEL=auto                            # router khud decide kare
```

Fayde: fallback/costing/rate-limit logic router me rahega, bolt sirf ek client.
**Is setup me bolt ke andar wali chain mostly bypass ho jaati hai** — `LLM_FALLBACK_MODELS` sirf tab kaam aayega
jab router poora down ho; router ke andar ke models ka failover router khud handle karega.

**⚠️ Sandbox/localhost warning:** ye call **server-side** hoti hai. Agar bolt kisi cloud sandbox (jaise ye
Arena workspace / e2b) me chal raha hai aur router tumhare laptop par, to `127.0.0.1` ka matlab sandbox hai,
tumhara laptop nahi. Options:

- router bhi usi sandbox/machine me chalao, ya
- router ko public URL/tunnel (cloudflared, ngrok) ke through expose karo aur wahi `LLM_BASE_URL` do, ya
- Approach A use karo (free provider direct) — sabse simple.

### 2.4 Approach C — multiple providers ek saath

Ek waqt me ek `LLM_BASE_URL` chalta hai (chain usi endpoint ke andar rehti hai). Multiple providers chahiye to:

- **ya** ek router/gateway (Approach B) jo providers ko aggregate kare,
- **ya** `.env.local` badal ke restart karo,
- **ya** code me `getModelCandidates()` extend karo (e.g. provider ke hisaab se alag base URL) — wiring point wahi ek function hai.

---

## 3. Fallback chain + retries (exact behaviour)

| Env var | Default | Kaam |
| --- | --- | --- |
| `LLM_PROVIDER` | auto-detect | `openai` (OpenAI-compatible) ya `anthropic` |
| `LLM_BASE_URL` | — | OpenAI-compatible endpoint (`OPENAI_BASE_URL` alias bhi chalta hai) |
| `LLM_API_KEY` | — | (`OPENAI_API_KEY` alias) |
| `LLM_MODEL` | — | Primary model id (`OPENAI_MODEL` alias) |
| `LLM_FALLBACK_MODELS` | — | Comma-separated, order me try hote hain |
| `LLM_MAX_TOKENS` | `8192` | Per segment output cap |
| `LLM_MAX_RETRIES` | `0` | Same model ko kitni baar retry karna hai (0 = turant next model) |
| `LLM_HEADERS` | — | Extra headers JSON me |
| `LLM_ENHANCER_MODEL` | — | Prompt-enhancer ke liye alag (sasta/fast) model |
| `ANTHROPIC_BASE_URL` | — | Anthropic proxy use karna ho to |

Behaviour:

1. `LLM_MODEL` par request → error aayi (429/401/403/5xx/empty response) aur **abhi ek bhi token client ko
   nahi gaya** → next fallback model.
2. Har failed attempt log hota hai: `warn llm openai/<model> failed, trying the next model: Too Many Requests`.
3. Jo model actual me serve karta hai wo log hota hai: `INFO llm using openai/<model>` (dev me `VITE_LOG_LEVEL` default `debug`).
4. **Sab** fail → HTTP 500 (UI me generic error).
5. Mid-stream fail → failover nahi, error (kyunki partial output already ja chuka hai).

**Anthropic default waisa hi kaam karta hai:** `ANTHROPIC_API_KEY` set hai aur koi `LLM_*` nahi → `claude-3-5-sonnet-20240620`.

---

## 4. Free models me se kya choose karo (is repo ke constraints)

Model chunne ke 4 asli criteria (aur ek jo **matter nahi** karta):

| Criteria | Kyun | Minimum |
| --- | --- | --- |
| **Strong instruction following** | Output ko `<boltArtifact>` / `<boltAction type="file">` format me likhna padta hai | achha "coder" model |
| **Streaming (SSE)** | Bolt live stream karta hai; bina stream ke UX kharab + timeouts | `stream: true` support |
| **Output length** | `max_tokens: 8192` bhejta hai; chhota cap wale routes truncate karenge | ≥ 8k, warna `LLM_MAX_TOKENS` ghatao |
| **Long context** | Bada project = badi history | 128k+ long tasks ke liye |
| ~~Vision~~ | Is Bolt version me image attach feature **nahi** hai | zaroorat nahi |
| ~~Native tool calling~~ | Request me tools hi nahi jaate | **matter nahi karta** |

Role-wise mapping (tumhari catalog file ke naam use karte hue) — inhe env vars me daalo:

```env
# planner / reasoning: Nemotron jaisa bada model
LLM_MODEL=glm-5.3:free

# coder (main): Kimi / DeepSeek / Qwen coder family
LLM_FALLBACK_MODELS=moonshotai/Kimi-K3,deepseek-ai/DeepSeek-V4-Pro

# long-context single-shot tasks: Gemini Flash series
# (inhe chain me daalo jab bade context wala kaam ho)

# bulk/fast chatter + enhancer: Groq / Cerebras / Flash models
LLM_ENHANCER_MODEL=zai-org/GLM-5.3-Flash:together
```

Practical tip: **primary = sabse reliable free route**, fallbacks = dusre providers ke same-tier models.
Ek hi provider ke 3 models rakhne se quota wall par teeno ek saath gir jate hain.

---

## 5. Quota bachane ke rules (free tier me ye sabse important hai)

1. **`LLM_ENHANCER_MODEL` set karo.** Enhance button har click par ek poori request karta hai; sasta model = bacha hua quota.
2. **System prompt fixed cost hai:** har request me ~13.7k chars (~3.5-4k tokens) system prompt + poori history jaati hai. Lambi chat = har message par dobara wo sab tokens.
3. **Batch instructions** (README me bhi likha hai): "color badlo + mobile responsive karo + restart karo" ek hi message me.
4. **`LLM_MAX_TOKENS` chhota karo** (e.g. 4096) agar provider ka output cap chhota hai; warna request 400 de sakti hai.
5. **`MAX_RESPONSE_SEGMENTS = 2`** (`app/lib/.server/llm/constants.ts`): ek user message par max ~2 segments; isse runaway output rukta hai.
6. **`LLM_MAX_RETRIES=0`** default rakho: 429 par same model ko dobara maarna quota waste hai, next model better hai.
7. Bade files chat me paste mat karo; poora project context me chala jata hai.

---

## 6. Verify kaise karo

### 6.1 Bina kisi key ke (mock provider) — 2 minute

```bash
# terminal 1
node scripts/mock-openai-server.mjs

# terminal 2  (.env.local me block 4 enable karo)
pnpm run dev
```

Browser me `http://localhost:5173` kholo, kuch bhi prompt karo. Expect:

- UI me text + `hello.txt` file ka artifact action
- server log: `INFO llm using openai/mock-ok` (pehla `mock-fail` 429 dega → fallback prove ho jayega)
- `mock-fail` sirf **ek hi baar** hit hoga (retries 0 hain)

Automated:

```bash
pnpm test           # 29 tests, including fallback chain + mock provider
pnpm run typecheck
pnpm run lint       # (repo me pehle se ek pre-existing error hai: Menu.client.tsx unused import)
```

### 6.2 Real provider ke saath — order ye rakho

1. **Pehle provider ko alag se curl karo** (bolt se pehle), taaki key/model galti turant pakdi jaye:

```bash
curl -sS https://router.huggingface.co/v1/chat/completions \
  -H "Authorization: Bearer $HF_TOKEN" -H 'content-type: application/json' \
  -d '{"model":"zai-org/GLM-5.3:together","messages":[{"role":"user","content":"say ok"}],"stream":false}' | head -c 400
```

2. `.env.local` me wahi base URL + model daalo, `pnpm run dev` **restart** karo (env change par Vite restart karta hai, par doubt ho to manually karo).
3. Bolt me chhota prompt: "ek index.html banao jisme hello likha ho" → artifact banna chahiye.
4. Server log me `using openai/<model>` check karo — yahi confirm karta hai ki kaunsa free model serve kar raha hai.

---

## 7. Troubleshooting

| Symptom | Wajah / Fix |
| --- | --- |
| `401` / `403` | Key galat ya permission missing (HF token me "Inference Providers" on hona chahiye; NIM key `nvapi-` se start hoti hai) |
| `404` / `model not found` | Model id exactly provider ke catalog wala likho (case + `:provider` suffix). Router ho to `auto` try karo |
| `429` baar-baar | Chain me models add karo / `LLM_ENHANCER_MODEL` alag karo / RPM-TPM limits check karo |
| Model artifact tags nahi likhta, prose likh raha | Model kamzor hai — coder/instruct variant try karo. `prompts.ts` ka format instruction strong hai, par weak models todte hain |
| Stream atak jata hai / hang | Provider streaming support ya SSE proxy block; pehle curl se `"stream":true` test karo |
| `LLM_MODEL` required error | Approach A/B me `LLM_MODEL` set karna bhool gaye ho |
| Env change hua par asar nahi | Dev server restart karo; `.env.local` (naam exactly yahi) use hota hai, `bindings.sh` bhi isi ko padhta hai |
| `pnpm run start` (wrangler) me vars nahi mile | `.env.local` file exist karni chahiye — `bindings.sh` usse `--binding` banata hai |
| Production deploy me vars | `pnpm run deploy` ke baad Cloudflare Pages project settings me same env vars daalo (ya `wrangler pages secret put`) |

---

## 8. Is repo me kya add/change hua (diff summary)

| File | Change |
| --- | --- |
| `app/lib/.server/llm/model.ts` | Env-driven provider/model selection + fallback candidates + retries + `LLM_HEADERS`/aliases; Anthropic default untouched; missing-key par saaf error |
| `app/lib/.server/llm/stream-text.ts` | OpenAI/Anthropic dono ke liye streaming; **pre-token failover**; pre-token failures par next candidate; cancellation-safe (upstream `SwitchableStream` response finish par cancel karta hai) |
| `app/routes/api.enhancer.ts` | Enhancer ke liye optional `LLM_ENHANCER_MODEL` |
| `worker-configuration.d.ts` | Naye optional env bindings |
| `.env.example` | 4 ready blocks (Anthropic, provider, router, mock) |
| `scripts/mock-openai-server.mjs` | OpenAI-compatible mock provider (bina key test ke liye) |
| `app/lib/.server/llm/stream-text.spec.ts` | 5 tests: fallback order, all-fail, max tokens, enhancer override, Anthropic default |
| `package.json` / `pnpm-lock.yaml` | `@ai-sdk/openai@0.0.44` (ai@3.3.4 ke saath version-matched: provider 0.0.17) |

---

## 9. Honest caveats

- **Maine koi real inference test nahi kiya** (is workspace me kisi provider ki key nahi hai). Jo verify hua: code path, streaming, fallback, cancellation, mock provider ke saath end-to-end — sab tests me pass.
- Tumhari catalog file ke **limits/availability main verify nahi kar sakta** — provider ke dashboard/docs se confirm karo. Model IDs bhi provider ke live catalog se match karo.
- Base URLs standard aur well-known hain, par links/quotas badalte rehte hain — ek baar curl se check kar lo.
- Is Bolt version me **koi model picker UI nahi hai** — model selection server-side env se hoti hai (jaisa is guide me hai). Picker chahiye to `app/lib/.server/llm/model.ts` + `/api/chat` ko extend karna padega.
