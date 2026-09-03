# CommonStack Integration — Preliminary Demo Report

Date: 2026-06-24
Scope: Validate API integration for a **historical backtest leaderboard** only.
This is **not** a model performance benchmark, not a live leaderboard, not paper
trading. Short window, single run per model.

---

## A. Model availability

Source: `GET https://api.commonstack.ai/v1/models` (60 models returned). Pricing
is exact from the API (per-token, converted to per-1M). The catalog returns **no
context-window field**.

| Provider | Requested family | Exact slug | Available | Input $/1M | Output $/1M | Status |
|---|---|---|---|---|---|---|
| OpenAI | GPT-5.5 | `openai/gpt-5.5` | ✅ | 5.00 | 30.00 | stable |
| Google | Gemini 3.1 Pro Preview | `google/gemini-3.1-pro-preview` | ✅ | 2.00 | 12.00 | **preview** |
| Anthropic | Claude Sonnet 4.6 | `anthropic/claude-sonnet-4-6` | ✅ | 3.00 | 15.00 | stable |
| xAI | Grok 4.20 Reasoning | `x-ai/grok-4.20-reasoning` | ❌ (listed, no channel) | 1.25 | 2.50 | unavailable |
| DeepSeek | DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` | ✅ | 0.435 | 0.87 | stable |
| Alibaba | Qwen3.7 Plus | `qwen/qwen3.7-plus` | ✅ | 0.40 | 1.60 | stable |

**No silent substitutions made.** Grok 4.20 Reasoning is in the catalog but every
call returns `model_not_found` / "no available channel for model
`grok-4.20-0309-reasoning` under group default (distributor)" on **both** the
Anthropic- and OpenAI-compatible routes — i.e. an upstream/account issue, not a
client bug. Closest available xAI alternatives (NOT selected, for discussion):

- `x-ai/grok-4.20-non-reasoning` (same release, non-reasoning) — 1.25 / 2.50
- `x-ai/grok-4.1-fast-reasoning` — 0.20 / 0.50

---

## B. Compatibility results (connectivity probe)

One controlled call per model, Anthropic-compatible route
(`POST /v1/messages`), JSON-only prompt, `max_tokens=150`, `temperature=0`,
no tools, no retry.

| Model | Slug | HTTP | Latency | Valid JSON | Usage returned | in/out tok | Est. cost |
|---|---|---|---|---|---|---|---|
| GPT-5.5 | `openai/gpt-5.5` | 200 | 3.1s | yes | yes | 43/48 | $0.00166 |
| Gemini 3.1 Pro Preview | `google/gemini-3.1-pro-preview` | 200 | 22.9s | yes | yes | 42/224 | $0.00277 |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4-6` | 200 | 2.8s | yes | yes | 63/21 | $0.00050 |
| Grok 4.20 Reasoning | `x-ai/grok-4.20-reasoning` | 503/500 | — | — | — | — | — |
| DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` | 200 | 5.5s | yes | yes | 42/145 | $0.00014 |
| Qwen3.7 Plus | `qwen/qwen3.7-plus` | 200 | 2.7s | yes | yes | 52/150 | $0.00026 |

**Protocol finding:** the Anthropic-compatible route works for non-Anthropic
models (DeepSeek, OpenAI, Google, Qwen) — responses come back in Anthropic shape
(`content[0].text`, `usage.input_tokens/output_tokens`), so the existing harness
needs **no refactor**. Usage and `model` are returned consistently. Gemini
latency is notably high (~23s) and it emitted more tokens than `max_tokens`
(thinking-style output counted as output tokens).

---

## C. Micro-backtest setup

Full leaderboard pipeline (`LLMAgentStrategy` → `PortfolioManager` →
`make_trading_decision_with_llm` → CommonStack), real Alpaca hourly bars.

- Date: **2026-04-15** (one historical trading day; ~1 week warmup for indicators)
- Assets: **AAPL, MSFT**
- Decisions per model: **5** (last 5 hourly timestamps)
- Initial capital: **$100,000**, identical for all
- Mode: `safe_trading`; identical prompt + constraints + transaction-cost assumptions
- One run per model, no resampling, no prompt variants
- Per-request output ceiling: **600 tokens** (`LLM_MAX_OUTPUT_TOKENS=600`)
- Route: Anthropic-compatible via CommonStack
- Pre-flight upper-bound estimate: **$0.28** (cap $5.00) → proceeded
- Grok excluded (unavailable)

---

## D. Preliminary output

Demo view (gitignored, open locally):
`dashboard/storage/data/temp/demo_leaderboard.html`
Raw results: `dashboard/storage/data/temp/micro_results.json`

> **Preliminary Integration Demo — short historical window for API and
> leaderboard validation. Not a model performance benchmark.**

Ordered by return (NOT an endorsement of trading skill):

| # | Model | Status | Final Value | Return | Trades | in/out tok | Est. cost |
|---|---|---|---|---|---|---|---|
| 1 | Gemini 3.1 Pro Preview | ok | $100,164.70 | +0.165% | 5 | 10,166/8,935 | $0.1276 |
| 2 | GPT-5.5 | ok | $100,163.61 | +0.164% | 2 | 7,973/2,874 | $0.1261 |
| 3 | Claude Sonnet 4.6 | ok | $100,089.76 | +0.090% | 2 | 9,578/2,231 | $0.0622 |
| 4 | DeepSeek V4 Pro | ok* | $100,000.00 | 0.000% | 0 | 7,831/3,000 | $0.0060 |
| 5 | Qwen3.7 Plus | ok* | $100,000.00 | 0.000% | 0 | 9,084/3,000 | $0.0084 |

\* Connected and billed, but produced **0 parseable trades** — see Known Issues.
Sharpe/max-drawdown are computed but not meaningful over 5 intraday points.

---

## E. Known issues

1. **Grok 4.20 Reasoning unavailable** — listed in catalog but no upstream channel
   for our account/group (`model_not_found` on both routes). Blocks the 6th model.
2. **Output-ceiling truncation** — DeepSeek V4 Pro and Qwen3.7 Plus emitted the
   full 600-token ceiling on every call (3,000 = 5×600) and their decision JSON was
   truncated → no actions parsed. Verbose/reasoning models need a higher ceiling or
   a more compact output contract. (Prompt-engineering intentionally deferred.)
3. **GPT-5.5 intermittent empty/non-JSON responses** under the Anthropic-compatible
   route on some steps ("No JSON found"), though it still completed 2 valid trades.
   Worth checking whether the OpenAI-compatible route is more reliable for it.
4. **Gemini latency ~23s/call** and over-emits output tokens (thinking counted as
   output) — affects cost/throughput for a full benchmark.
5. **No context-window metadata** from `/v1/models`.
6. **Slug/gateway coupling (latent)** — the existing `claude_haiku_4_5` entry uses
   the native Anthropic id `claude-haiku-4-5-20251001`. With `COMMONSTACK_API_KEY`
   set, recomputing it would route to CommonStack, where the correct slug is
   `anthropic/claude-haiku-4-5`. Not hit in this demo (cached), but needs a decision
   on which gateway is canonical. (Left unchanged.)
7. **Preview alias** — `google/gemini-3.1-pro-preview` is preview; behavior/pricing
   may change without notice.

---

## F. Questions for CommonStack

1. Can stable or **pinned** model versions be provided (vs. moving preview aliases)?
2. What are the **recommended exact model IDs** for each of the six families?
3. **Grok 4.20 Reasoning**: why "no available channel under group default", and how
   do we enable it on our account? Is there an ETA?
4. Are **preview aliases auto-updated** (e.g. `gemini-3.1-pro-preview`)? How do we
   detect changes?
5. Is **usage/cost returned consistently** across all providers and both protocol
   routes? (We see it consistently so far; please confirm for reasoning models.)
6. Is **platform-mediated, capped access for approved research users** permitted
   under our account (i.e. may we proxy our quota to third parties)?
7. Do you support **subkeys / project keys / per-key budgets / model allowlists**?
8. Recommended route per provider (Anthropic- vs OpenAI-compatible), especially for
   reasoning models and for GPT-5.5 structured output?

---

## Run summary

- **Files changed (committed):**
  - `dashboard/backend/infrastructure/llm/backtest_harness.py` — `make_llm_client()` (CommonStack-aware), env-configurable output ceiling (default 2000 unchanged)
  - `dashboard/backend/domain/leaderboard/strategies/llm_agent.py` — use `make_llm_client()`, drop unused imports
  - `dashboard/backend/infrastructure/llm/token_cost.py` — pricing rows for verified slugs
  - `dashboard/config/leaderboard.json` — 5 verified model entries (Grok excluded)
  - `.env.example` — `COMMONSTACK_API_KEY` / `COMMONSTACK_BASE_URL`
  - `docs/commonstack-integration-demo-report.md` — this report
  - (earlier task) `docs/api/model-proxy-api-design.md` — proxy design only; **not implemented**
- **Gitignored temp (not committed):** probe scripts, raw responses, `micro_results.json`, `demo_leaderboard.html` under `dashboard/storage/data/temp/`.
- **Tests:** harness 29/29; combined harness + token_cost + leaderboard **51/51 passed**.
- **Total API calls:** 34 (31 successful, 3 failed Grok).
- **Total tokens:** 44,916 in / 20,707 out.
- **Estimated total spend:** **≈ $0.34** (caps: $1.00 connectivity, $5.00 micro — both respected).
- **Blockers:** Grok 4.20 Reasoning unavailable; DeepSeek/Qwen truncated by output ceiling; GPT-5.5 occasional non-JSON.
- **Secret safety:** `dashboard/.env` is git-ignored and untracked; key never printed, logged, or committed; proxy untouched.
- **Safe to show tonight?** **Yes** — 5/6 models verified end-to-end through the real pipeline, cost negligible, results clearly labeled as a preliminary integration demo.
