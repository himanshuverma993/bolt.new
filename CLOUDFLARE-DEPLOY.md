# Bolt.new ko Cloudflare par chalana — free Workers AI ke saath

> Is guide me poora system **Cloudflare ke servers** par chalta hai: UI + API = Cloudflare Pages (Functions),
> model = **Cloudflare Workers AI** (free plan, koi credit card nahi, koi bahar ka API key nahi).
> Sab kuch is repo ke actual code ke hisaab se likha hai (`wrangler.toml`, `app/lib/.server/llm/*`).
> OpenAI-compatible free APIs (HF router, local router) ke liye [FREE-API-SETUP.md](./FREE-API-SETUP.md) dekho.

---

## 0. TL;DR — 8 facts

1. **Deploy = repo ko Cloudflare Pages se connect karo, bas.** Build command `pnpm run build`, output `build/client`.
   `wrangler.toml` me AI binding + model chain pehle se hai, isliye dashboard me **koi key/variable dalne ki zaroorat nahi**.
2. **Model Workers AI se aata hai** — `context.cloudflare.env.AI` binding ke through, request Cloudflare ke andar hi rehti hai.
   Adapter `app/lib/.server/llm/workers-ai.ts` me hai; chain `model.ts` me (`LLM_PROVIDER=cloudflare`).
3. **Default chain (sab free-plan models):** `@cf/google/gemma-4-26b-a4b-it` → `@cf/qwen/qwen2.5-coder-32b-instruct`
   → `@cf/meta/llama-4-scout-17b-16e-instruct`; enhancer `@cf/meta/llama-3.1-8b-instruct-fp8`. Pehla fail/throttle ho to agla.
4. **Free quota: 10,000 neurons/day** (00:00 UTC reset). Gemma par ek typical Bolt request ≈ 100 neurons → **~100 requests/din**.
   Lambi chat me input badhta hai (history + files), to per-request cost bhi badhta hai (§4).
5. **Local dev bhi same binding se:** `npx wrangler login` → `pnpm run dev`. Ya `.env.local` me account id + API token → bina login.
6. **Verify:** deploy ke baad `https://<project>.pages.dev/api/llm-check` kholo — har model/transport ka OK/FAIL JSON me.
7. **Ek honest caveat — CPU time.** Workers Free plan par Functions ko **10 ms CPU/request** milta hai (soft limit). Streaming
   adapter is budget ke hisaab se optimize hai (tokens 80 ms window me merge hote hain), par bahut lambe jawab ispe bhi upar ja sakte
   hain. Agar logs me `Exceeded CPU Time Limits` / Error 1102 dikhe to §4.3 ke options hain (Workers Paid $5/mo = 30 s CPU).
8. **Is sandbox se real Workers AI call test nahi ho sakta tha** (outbound network blocked). Jo verify hua: adapter ke 27 unit tests,
   real `workerd` runtime me (`wrangler pages dev`) binding → REST failover end-to-end mock ke saath, build, typecheck, lint.
   **Pehla real test tumhara deploy hoga** — §6 follow karo, 2 minute lagte hain.

---

## 1. Architecture — kya kahan chalta hai

```
Browser ──► Cloudflare Pages
             ├─ static assets (build/client)          ← Remix client bundle
             └─ Pages Function  functions/[[path]].ts ← Remix server (SSR + /api/*)
                   └─ /api/chat → stream-text.ts → model.ts (chain) → workers-ai.ts
                          ├─ transport "binding": env.AI.run(model, {messages, stream:true})   ← default, zero keys
                          └─ transport "rest":    POST api.cloudflare.com/.../ai/v1/chat/completions (Bearer token)
                                                                                                  ← local dev / fallback
```

- **Binding** = `wrangler.toml` ka `[ai] binding = "AI"`. Pages Function ke andar `context.cloudflare.env.AI` milta hai.
  Usage us account par bill hota hai jisme project deploy hai (free: 10k neurons/day).
- **REST** = wahi models, OpenAI-compatible endpoint se, `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` ke saath.
  Laptop par bina `wrangler login`, ya kisi aur host par chalane ke liye. Dono set ho to order: har model ke liye pehle binding, phir REST.
- Adapter dono response shapes handle karta hai: naye models OpenAI chunks (`choices[].delta`) bhejte hain, purane
  `{response: "..."}`. `<think>…</think>` blocks stream me hi strip hote hain (Bolt ka parser unhe kabhi nahi dekhta),
  `reasoning_content` ignore hota hai, `max_tokens` hamesha bheja jata hai (Workers AI ka default sirf 256 hai).
- Provider failure (login nahi, 429, model nahi mila, khali jawab) **pehle token se pehle** throw hota hai → chain agle model par
  jaati hai. Mid-stream switch nahi hota (UI me do artifacts mix ho jate).

---

## 2. Deploy — step by step

### 2.1 Git integration (recommended — tum repo upload karo, baaki Cloudflare)

1. Repo GitHub par push karo (jo branch deploy karni hai).
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → repo select.
3. Build settings:

   | Setting | Value |
   | --- | --- |
   | Framework preset | `Remix` (ya `None`, dono chalega) |
   | Build command | `pnpm run build` |
   | Build output directory | `build/client` |
   | Root directory | `/` |

4. **Environment variables (build)** — zaroori nahi, par safe side:
   `NODE_VERSION = 20`. (Repo me `.tool-versions` → `nodejs 20.15.1` hai, V2 build system ise khud padh leta hai;
   pnpm version `package.json` ke `packageManager: pnpm@9.4.0` se aata hai — na aaye to `PNPM_VERSION = 9.4.0` add karo.)
5. **Save and Deploy.** Pehli build ~2-4 min. Build log me end me `Compiling Functions` dikhega — yahi Remix server hai.
6. Deploy ke baad project → **Settings → Bindings** me `AI` (Workers AI) dikhna chahiye, aur **Variables and Secrets** me
   `LLM_PROVIDER`, `LLM_MODEL`, ... — ye sab `wrangler.toml` se aaye hain (dashboard me read-only dikhenge; badalne ke liye
   `wrangler.toml` edit karke push karo, redeploy apne aap).
7. `https://<project>.pages.dev/api/llm-check` kholo (§6), phir chat.

> `wrangler.toml` tabhi uthta hai jab project **Build system V2** par ho (naye projects default V2). Agar bindings tab me `AI`
> nahi dikh raha: Settings → Builds → Build system version → V2, phir "Retry deployment".

### 2.2 CLI se deploy (alternative)

```bash
npx wrangler login              # browser me Cloudflare login
pnpm run deploy                 # = pnpm run build && wrangler pages deploy
```

Pehli baar project ka naam puchega (`bolt`, `wrangler.toml` ke `name` se). Isme bhi `[ai]` + `[vars]` wrangler.toml se jaate hain.

### 2.3 Secrets (optional)

Sirf tab chahiye jab REST fallback ya AI Gateway bhi deploy par chahiye (binding ke liye kuch nahi chahiye):

```bash
npx wrangler pages secret put CLOUDFLARE_ACCOUNT_ID --project-name bolt
npx wrangler pages secret put CLOUDFLARE_API_TOKEN  --project-name bolt
```

ya Dashboard → project → Settings → Variables and Secrets → Add → type **Secret**. Secrets `wrangler.toml` me kabhi mat likho.

---

## 3. Models — default chain, cost, alternatives

Sab numbers Cloudflare ki pricing/models pages se (Oct 2026). "Per request" = 5k input + 2k output tokens ka estimate
(Bolt ka system prompt hi ~3.5-4k tokens hai). Live list: <https://developers.cloudflare.com/workers-ai/models/>

| Model id | Context | Neurons / M tokens (in / out) | ≈ Neurons per Bolt request | Note |
| --- | --- | --- | --- | --- |
| `@cf/google/gemma-4-26b-a4b-it` **(default)** | 256k | 9,091 / 27,273 | **~100** | Thinking default off → clean output, sasta, lamba context |
| `@cf/zai-org/glm-4.7-flash` | 131k | 5,500 / 36,400 | ~100 + thinking tokens | Thinking default **on** → `LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}` lagao |
| `@cf/qwen/qwen3-30b-a3b-fp8` | 32k | 4,625 / 30,475 | ~85 | Thinking model; same `enable_thinking:false` recommended |
| `@cf/meta/llama-4-scout-17b-16e-instruct` (fallback 2) | 131k | 24,545 / 77,273 | ~280 | Generalist, lamba context |
| `@cf/qwen/qwen2.5-coder-32b-instruct` (fallback 1) | 32k | 60,000 / 90,909 | ~480 | Strong coder, par mehenga — isliye fallback |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 128k | 31,876 / 50,488 | ~260 | |
| `@cf/nvidia/nemotron-3-120b-a12b` | — | 45,455 / 136,364 | ~500 | Bada reasoning model |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 24k | 26,668 / 204,805 | ~540 | Output bahut mehenga |
| `@cf/meta/llama-3.1-8b-instruct-fp8` (enhancer) | 32k | 4,119 / 34,868 | ~10-15 (chhote prompts) | Sirf "enhance prompt" button ke liye |

**Mat use karo (free plan par):**

- `@cf/zai-org/glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `@cf/moonshotai/kimi-k2.6`, `kimi-k2.7-code`,
  `@cf/deepseek-ai/deepseek-v4-*` — pricing page ke hisaab se **Workers Paid billing zaroori** hai; free account par error aayega.
- `@cf/openai/gpt-oss-20b` / `120b` — sirf Responses API (`/v1/responses`) aur non-streaming; Bolt chat-completions streaming
  use karta hai.

**Chain badalni ho:** `wrangler.toml` → `[vars]` → `LLM_MODEL` / `LLM_FALLBACK_MODELS` edit → push (Git deploy) ya `pnpm run deploy`.
`model|maxTokens` syntax yahan bhi chalta hai, e.g. `LLM_FALLBACK_MODELS = "@cf/qwen/qwen3-30b-a3b-fp8|4096"`.
Model-specific body fields `LLM_EXTRA_BODY` se (JSON, har request me merge, binding aur REST dono par).

---

## 4. Free plan limits — honest numbers

### 4.1 Workers AI neurons

- **10,000 neurons/day** har account ko (Free aur Paid dono), reset **00:00 UTC**. Upar jaane par request error deti hai;
  Paid plan par overage $0.011 / 1,000 neurons.
- Gemma par ~100 neurons/request → ~100 requests/din. Baad ke turns me Bolt poori history + file contents bhejta hai, to
  input 10-15k tokens tak ja sakta hai → 150-200 neurons/request. Fallback models 3-5x mehenge hain — chain tabhi unpar jaati hai
  jab Gemma fail/throttle ho.
- Quota khatam → UI me error aata hai jisme hint hai ("free allowance ... resets at 00:00 UTC").
- Quota bachane ke rules [FREE-API-SETUP.md §5](./FREE-API-SETUP.md#5-quota-bachane-ke-rules-free-tier-me-ye-sabse-important-hai)
  yahan bhi lagu: nayi chat jaldi shuru karo, enhancer alag sasta model (already set), `LLM_MAX_RETRIES=0` (already set).

### 4.2 Pages / Functions

- Functions requests: **100,000/day** (Workers Free) — chat app ke liye kaafi. Static assets unlimited.
- Builds: 500/month, ek saath ek build.
- Memory 128 MB, request/response streaming — koi issue nahi.

### 4.3 CPU time — sabse important caveat

- Workers Free: **10 ms CPU per request** (Paid: default 30 s). CPU time ≠ wall time: model ka wait count nahi hota, sirf JS
  execution. Cloudflare ise *soft* enforce karta hai (bursts allow), lagatar upar jaane par request **Error 1102** se cut hoti hai.
- Streaming path ka measured cost (Node par, same code): parsing ~3 µs/token, plus ~21 µs per chunk jo downstream stream stages
  (AI SDK + watchdogs + response) me jaata hai. Isliye adapter tokens ko **80 ms window me merge** karta hai (pehla token turant):
  ~5-6 µs/token → 3k-token jawab ≈ 15-20 ms CPU (bina merge ke ~75 ms hota). Page ka SSR alag request hai (chhota).
- Agar Functions logs/metrics me `Exceeded CPU Time Limits` dikhe:
  1. `LLM_STREAM_COALESCE_MS = "150"` (vars me) — aur kam chunks, UI par farak mehsoos nahi hota.
  2. `LLM_MAX_TOKENS = "4096"` — chhote segments (Bolt `length` par khud continue karta hai, max 2 segments).
  3. **Workers Paid ($5/month)** — 30 s CPU; Workers AI ke free neurons same rehte hain. Ye hi sabse reliable fix hai agar
     heavy use karna hai.

### 4.4 Model availability

Workers AI ka catalog badalta rehta hai (naye models aate hain, purane deprecate). `No such model` (code 5007) aaye to
models page se naya id lekar `wrangler.toml` update karo. Chain hone ki wajah se ek model ke hatne par app band nahi hoti.

---

## 5. Local development — 3 options

Teeno me models `wrangler.toml` se aate hain (`pnpm run dev` Remix ke Cloudflare proxy se `[ai]` + `[vars]` padhta hai).
Local AI calls bhi **tumhare account ke neurons** use karti hain (wrangler khud warn karta hai).

**A. `wrangler login` (sabse simple)**

```bash
npx wrangler login
pnpm run dev                   # http://localhost:5173 — binding remote Workers AI par jaati hai
```

**B. API token (bina login; CI/dusri machine ke liye bhi)**

1. Account ID: Dashboard → Workers & Pages → Overview → right side "Account ID".
2. Token: Dashboard → My Profile → API Tokens → Create Token → template **"Workers AI"** (Read) → Create.
3. `.env.local`:

   ```env
   CLOUDFLARE_ACCOUNT_ID=...
   CLOUDFLARE_API_TOKEN=...
   ```

   Ab `pnpm run dev` me **dono** transport chalte hain: wrangler yahi env vars apni auth ke liye padhta hai (binding), aur app REST
   fallback ke liye. `pnpm run check-llm` REST se poori chain ping karta hai (binding sirf Cloudflare runtime me hoti hai).

**C. Production-like (`wrangler pages dev`, wahi runtime jo Pages par chalta hai)**

```bash
pnpm run build && pnpm run start        # http://localhost:8788
```

Binding ke liye `wrangler login` ya shell me `export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...`;
`.env.local` ki values `bindings.sh` se `--binding` ban kar jaati hain (REST transport). `.env.local` na ho to bhi start hota hai.

Koi aur provider (HF router, Anthropic) local par chahiye to `.env.local` me uska block enable karo — `.env.local` ki values
`wrangler.toml` vars ko override karti hain (`process.env` pehle padha jata hai).

---

## 6. Verify kaise karo

1. **`GET /api/llm-check`** (deploy ya local, dono):

   ```
   https://<project>.pages.dev/api/llm-check?limit=3&timeoutMs=20000
   ```

   ```json
   {"ok":true,"results":[{"model":"@cf/google/gemma-4-26b-a4b-it","provider":"cloudflare","transport":"binding","ok":true,"ms":1830,"reply":"pong"}, ...]}
   ```

   `ok:false` + `error` me exact wajah hoti hai (login, token, model id, quota).
2. **Chat:** app kholo → "Build a todo app with React" → artifact + files aane chahiye, preview chalni chahiye.
3. **Logs:** Dashboard → project → Logs (real-time) ya `npx wrangler pages deployment tail --project-name bolt`.
   Line `INFO llm using cloudflare:binding/@cf/google/gemma-4-26b-a4b-it` = sahi model/transport chala.
   `WARN llm ... failed, trying the next model` = failover hua (wajah saath me).
4. **Bina deploy, bina key:** `pnpm test` (60 tests; Workers AI adapter ke 27) + `pnpm run mock-llm` ke saath
   [FREE-API-SETUP.md §6.1](./FREE-API-SETUP.md#61-bina-kisi-key-ke-mock-provider--2-minute).

---

## 7. Env reference (Cloudflare-specific)

| Var | Kahan | Default | Kaam |
| --- | --- | --- | --- |
| `LLM_PROVIDER` | wrangler.toml | `cloudflare` | `cloudflare` / `openai` / `anthropic`. Unset ho to auto-detect: OpenAI endpoint → Anthropic key → Workers AI (binding ya CF creds) |
| `LLM_MODEL`, `LLM_FALLBACK_MODELS` | wrangler.toml | Gemma chain | Workers AI model ids (`@cf/...`), `model\|maxTokens` syntax |
| `LLM_ENHANCER_MODEL` | wrangler.toml | `@cf/meta/llama-3.1-8b-instruct-fp8` | Enhance-prompt button ke liye sasta model |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | secret / `.env.local` | — | REST transport (local dev, fallback). Wrangler bhi inhe local binding auth ke liye use karta hai |
| `CLOUDFLARE_AI_TRANSPORT` | var | `auto` | `auto` (binding → REST), `binding`, `rest` |
| `CLOUDFLARE_AI_GATEWAY_ID` | var | — | Calls [AI Gateway](https://developers.cloudflare.com/ai-gateway/) se route (analytics, rate limit, cache); binding aur REST dono |
| `CLOUDFLARE_AI_BASE_URL` | var | account REST URL | REST base override (proxy/test). *Note:* `CLOUDFLARE_API_BASE_URL` wrangler ka apna var hai, wo mat use karo |
| `LLM_STREAM_COALESCE_MS` | var | `80` | Streamed tokens itne ms merge (CPU saver), `0` = har token alag |
| `LLM_EXTRA_BODY` | var | — | JSON, har request body me merge (e.g. `chat_template_kwargs`, `reasoning_effort`) |
| `LLM_MAX_TOKENS`, `LLM_TEMPERATURE` (0.2), `LLM_MAX_RETRIES` (0), timeouts | var | — | Same jaise [FREE-API-SETUP.md §3](./FREE-API-SETUP.md#3-env-vars--poora-reference) |

Precedence: `process.env` (`.env.local`, sirf local) → Cloudflare env (`[vars]` + secrets). `ANTHROPIC_API_KEY` set hone par bhi
`LLM_PROVIDER=cloudflare` (wrangler.toml) jeet-ta hai; Anthropic chahiye to var badlo.

---

## 8. Troubleshooting

| Symptom | Wajah / fix |
| --- | --- |
| `Not logged in.` (local) | `npx wrangler login`, ya `.env.local` me `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (§5) |
| `TypeError: fetch failed` binding par (local) | Machine se api.cloudflare.com reachable nahi (proxy/firewall) |
| `5007: No such model` / `No such model` | Model id catalog se hat gaya ya typo — models page se id lo, `wrangler.toml` update |
| `429`, `quota`, `3036`, `3040`, "neurons" | Daily free neurons khatam ya model par capacity nahi; 00:00 UTC reset; chain agle model par jaati hai |
| Dashboard Bindings me `AI` nahi | Build system V1 par project, ya `wrangler.toml` me `pages_build_output_dir` nahi — V2 set karo, redeploy |
| `Error 1102` / `Exceeded CPU Time Limits` | §4.3 — coalesce window badhao, max tokens ghatao, ya Workers Paid |
| Build fail: Node/pnpm | `NODE_VERSION=20`, `PNPM_VERSION=9.4.0` build env me |
| Jawab me `<think>` text | Adapter strip karta hai; phir bhi dikhe to us model ke liye `LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}` |
| Khali jawab / sirf finish | Model chat-completions streaming support nahi karta (gpt-oss) ya paid-only hai — §3 |
| Artifacts galat format (files nahi bante) | Chhota model system prompt follow nahi kar raha — primary ko Gemma hi rakho, ya `glm-4.7-flash` try karo |
| `wrangler` "out-of-date" warning | Intentional: Remix 2.10 ka dev proxy wrangler 3 chahta hai; 3.114.17 Pages + Workers AI dono support karta hai |

---

## 9. Is repo me kya add/change hua

| File | Change |
| --- | --- |
| `wrangler.toml` | `[ai] binding = "AI"` + `[vars]` (provider, model chain, enhancer, retries). Ab ye deploy ka source of truth hai |
| `app/lib/.server/llm/workers-ai.ts` | **Naya** Workers AI provider (AI SDK `LanguageModelV1`): binding + REST transport, dono response shapes, SSE parser, `<think>` filter, finish-reason/`max_tokens` handling, token coalescing, first-event error → throw (failover) |
| `app/lib/.server/llm/model.ts` | Provider `cloudflare` (auto-detect + `LLM_PROVIDER`), default free chain, binding→REST candidate order, `CLOUDFLARE_*` vars, `candidateLabel()` |
| `app/lib/.server/llm/stream-text.ts` | Logs me transport dikhta hai (`cloudflare:binding/...`) |
| `app/lib/.server/llm/switchable-stream.ts` | Close ke baad late chunk par error log nahi (pre-existing race) |
| `app/routes/api.chat.ts`, `api.llm-check.ts`, `api.enhancer.ts` | Quota hint, `transport` field, enhancer output se `[object Object]` fix |
| `app/lib/.server/llm/workers-ai.spec.ts` | **Naye** 27 tests: filter, binding, coalescing (dono shapes, usage, abort, errors, gateway, extra body), REST (URL, bearer, 429), selection order, end-to-end failover |
| `scripts/check-provider.mjs` | `pnpm run check-llm` ab Workers AI REST bhi check karta hai |
| `worker-configuration.d.ts`, `.env.example` | `AI` binding + `CLOUDFLARE_*` vars + Cloudflare block |
| `package.json` | `wrangler@3.114.17`, `@cloudflare/workers-types` latest, `@ai-sdk/provider` (types) |

---

## 10. Honest caveats

- **Real inference yahan test nahi hui** — sandbox se Cloudflare API reachable nahi. Verified: unit tests (fake binding + mock REST),
  real `workerd` runtime me binding fail → REST failover → streamed response, build/typecheck/lint. Deploy ke baad `/api/llm-check`
  pehla real check hai; kuch bhi fail ho to us JSON ka `error` field bhejo.
- **Quality Claude jaisi nahi hogi.** Gemma 4 26B (A4B MoE) free models me best balance hai, par Bolt ka 13k-char system prompt
  follow karne me kabhi slip karega (artifact format). Chain + "fix it" prompt se kaam chal jata hai; heavy use ke liye paid
  model/plan dekho.
- Pricing, neuron rates, free-plan eligibility aur CPU limits Cloudflare docs ke **Oct 2026** snapshot se hain — ye badalte rehte hain.
- Pehla request (cold start) 2-6 s le sakta hai; first-token timeout 120 s hai, isliye chain galat model par jaldi nahi bhaagti.
