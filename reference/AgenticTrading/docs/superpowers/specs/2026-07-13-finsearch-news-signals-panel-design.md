# FinSearch News & Signals — Adapter + Home Panel (Plan 1 completion) — Design Spec

- **Date:** 2026-07-13
- **Owner:** Felix (FlyMiss)
- **Repo:** agent-trading-lab (one cross-repo task lands in Agentic-FinSearch)
- **Status:** Design — written under the AFK planning loop; open forks are decided with rationale below and flagged for Felix's review in the PR
- **Programme:** Plan 1 of 3 (Plan 2 = agent-API foundation, **shipped**; Plan 3 = FinSearch as a trading agent, sibling spec `2026-07-13-finsearch-leaderboard-agent-design.md`)
- **Base contract:** `docs/integrations/finsearch-news-sentiment.md` (PR #97, merged 2026-07-13) — the producer endpoint, auth, projection, and error model defined there are **normative** for this spec and not restated.

## 1. Goal

Finish Plan 1's consumer half. Two deliverables:

1. **The adapter** — `dashboard/backend/integrations/news_sentiment.py`, the one unbuilt piece of the news→sentiment→ATL bridge. It populates the fail-closed `news_sentiment` slot that `execution/backtest_backend.py::load_news_sentiment` already imports (v2 context envelope).
2. **A Home panel** — a new panel on the dashboard home view (`/app`, `#homeView`): **latest fetched news feed on the left, identified signals on the right**. This is the first user-visible surface for the bridge: an auditable, sourced read of what the agents will trade on.

The framing is unchanged from the programme charter: **measurement, not alpha-seeking** — we are building the apparatus that lets a human observe the same sourced signal an agent consumes, not shipping a money-maker. Every displayed row links to its source (truth-infrastructure requirement, carried over from the 2026-06-23 plan).

## 2. What exists today (evidence)

| Piece | State | Where |
|---|---|---|
| Producer endpoint | **Live + bearer-gated**, `?as_of` + `?tickers`, ETag conditional GET | `GET https://agenticfinsearch.org/api/signals/news/` (FinSearch `api/signals_views.py`) |
| Consumer seam | Fail-closed loader; `news_sentiment` always present in the v2 context envelope, `{}` until the adapter exists | `execution/backtest_backend.py:25-40,133,145-146` |
| Consumer type | `NewsSentimentEntry` (7 fields, no `rationale`) | `api/v2/models.py:19-26` |
| Frontend surface | **None** — no route or UI mentions news/sentiment | grep across `api/routers/*`, `app.js` |
| Home view | 4-card CSS grid + mock live-activity feed with show/hide lifecycle hooks | `app.html:363-472`, `home-page.js` (`onHomePageShow`/`onHomePageHide`) |
| Feed scaffold | Orphaned but complete live-feed widget (cards, LIVE dot, "Updated Ns ago", rotation, `destroy()`) | `dashboard/frontend/market-events/*` (scripts still loaded by `app.html:1507-1510`; container/init removed) |
| TTL cache | Generic thread-safe TTL cache (name notwithstanding) | `cache.py` (`PaperTradingCache`) |
| Raw news feed | **No endpoint** (descoped 2026-07-06, spec D3). Raw `items-*.jsonl` sit on the droplet, 90-day retention, full item fields | FinSearch `Heartbeat/news_heartbeat.py:854-881`, `prune_old_digests` |

Cadence reality (sets UX expectations): **new raw news arrives once daily** (heartbeat 11:00 UTC, plus occasional same-day supplementals); the signals sweep re-processes every 20 min but only produces a new artifact when a new batch exists. The panel is a "today's read" surface, not a real-time ticker — it must show staleness honestly (`staleness_hours` is already server-computed).

## 3. Resolved forks

| Fork | Decision | Rationale |
|---|---|---|
| **Display surface** | New panel on **`/app` Home** (`#homeView`), not the landing page and not a new top-level tab. | Felix's 2026-07-13 instruction ("a new panel in the homepage") supersedes the 2026-06-23 "top-level News Sentiment tab" decision. The landing page (`/`) is static marketing with no live-data surface; `#homeView` is the real home and already has the live-panel lifecycle pattern. If the panel outgrows the card, promoting it to a tab is a three-edit change (nav button, page-view div, `navigateToPage` branch) — deferred until warranted. |
| **Feed data source** | **Phased.** Phase A (MVP): left column = the signals artifact's representative stories (one real, sourced story per signalled ticker — headline/source/url/published are already in the signals artifact). Phase B: a small FinSearch endpoint serving the raw `items-*.jsonl` feed; left column upgrades to the true "latest fetched news feed". | Phase A needs **zero FinSearch changes** and ships user value immediately. Phase B is what Felix literally asked for ("latest fetched news feed") — the data already exists on disk with 90-day retention; only a read path is missing. Reversing the D3 descope is now justified by a concrete product need that didn't exist in June. |
| **Key custody** | The browser **never** calls FinSearch. ATL backend proxies via a new `/api/news/*` router; `FINGPT_API_KEY` stays server-side. | The endpoint is bearer-gated; shipping the key in `app.js` would publish it. Proxying also lets ATL cache (420s TTL — see the Panel-refresh fork) so one browser reload doesn't fan out to the droplet. |
| **`rationale` contract gap** | **Add `rationale: str \| None = None` to `NewsSentimentEntry`** (additive), and project it in the adapter. | PR #97 flagged this: the producer's one-line directional reasoning is currently dropped before the agent sees it, narrowing the "auditable, sourced signal" thesis. Additive + optional = existing consumers unaffected; the panel's right column wants it anyway; the agent can fold it into the `reasoning` field that already persists. This spec accepts ownership of the `api/v2/models.py` change. |
| **Adapter shape** | **One module, two consumers.** A shared fetch core (auth header, `?as_of`/`?tickers`, ETag revalidation, bounded memo) consumed by (a) `get_news_sentiment(universe, timestamp)` for backtest stepping and (b) the panel proxy for "latest". | The projection and error model are identical; only the artifact-selection key differs (`as_of=<step date>` vs. latest). Two modules would duplicate the fail-closed mapping. |
| **Timestamp type** | `get_news_sentiment` accepts **`str \| datetime`** — coercing ISO-8601 strings first. | The v2 step envelope serializes timestamps to ISO **strings** (`external_run_service.py:429-431`; the existing loader tests pass string literals). An adapter assuming `datetime` would crash into the fail-closed loader and silently no-op the whole feature with green CI. The contract doc's reference sketch shares this wrong assumption and gets corrected when the adapter lands. |
| **Memo policy** | Keys dated **strictly before today (UTC)**: hard memo, no repeat HTTP (including negative-cached config errors). Today's key and the "latest" read: always revalidate via ETag. Transport failures **never** serve a cached body. Memo bounded (64 entries, evict oldest). | Past artifacts are immutable for our purposes and a 401 must not turn a 161-step backtest into 161 live calls; but a 404 cached before the daily heartbeat lands must not stick for the process lifetime, and stale data presented as fresh during an outage is worse than an honest gap. |
| **Panel refresh** | Fetch on Home show + re-poll every 5 min while visible; stop when hidden. Server cache TTL is **420s — deliberately above the poll interval** so a client's own re-poll lands inside the cached window. | Data changes at most every 20 min; anything faster is theater. `home-page.js` already has the exact show/hide lifecycle hooks to copy. A TTL equal to the poll interval would expire just as each poll fires, defeating the cache. |
| **Panel auth posture** | Same posture as the leaderboard read (`/api/v1/leaderboard`): public read, no session required. | The panel shows published, non-user data. Implementer verifies against `middleware.py`'s enforcement list and mirrors whatever the leaderboard route does. |

## 4. Architecture

### 4.1 Backend — adapter module

`dashboard/backend/integrations/news_sentiment.py` (new module; the `integrations/` package already exists — `discord_bot.py` lives there):

- `fetch_signals(*, as_of: str | None, tickers: list[str]) -> dict | None` — the one HTTP core. Sends `Authorization: Bearer <FINGPT_API_KEY>`, `timeout≈10s`, honors the error table in the base contract (401/503/400 → log loud, `404` → quiet miss, network → quiet-ish). Keeps a small in-process memo keyed on `(resolved as_of, tickers-key)` + the last `ETag` per key for `If-None-Match` revalidation — a 161-step backtest touching ~30 distinct dates must not issue 161 cold fetches.
- `get_news_sentiment(universe, timestamp) -> {"news_sentiment": {...}, "news_overview": str | None}` — the contract-doc interface, projecting `signals[TICKER]` → `NewsSentimentEntry` shape **including the new `rationale`**, with `age_hours` referenced to `timestamp` (never wall-clock).
- `get_latest_panel_payload(tickers) -> dict` — the panel-facing read: latest artifact (no `as_of`), passthrough of the display-relevant body (`news_overview`, `generated_at`, `staleness_hours`, `status`, `status_reason`, and per-ticker signals **including `rationale` and `published`**), plus the Phase-A feed list derived from representative stories sorted by `published` desc.

Domain-boundary note: the module path is **frozen by the shipped seam** — `execution/backtest_backend.py:33` already imports `dashboard.backend.integrations.news_sentiment.get_news_sentiment`, and the merged contract doc names the same path. `docs/architecture/dashboard-target-structure.md` describes `integrations/` as an out-of-band entrypoint tier (dependency direction `integrations → domain`), which this module — an HTTP adapter imported *by* `execution/` and `api/` — inverts. Decision: honor the frozen seam with one small module now and record the tension here; if a second producer adapter ever appears, split the HTTP core into `infrastructure/` and leave this path as a thin re-export. Must not import `api/` or `execution/`.

### 4.2 Backend — panel proxy route

New router `dashboard/backend/api/routers/news.py`, mounted in `api/router.py` under `/api`:

```
GET /api/news/signals            → get_latest_panel_payload(DJIA_30)
```

One route, one payload, one panel fetch. Caching via `cache.py`'s TTL cache — reused through a new `shared_ttl_cache` alias (the class is generic; the `paper_trading_cache` name is legacy from its first consumer) with a namespaced `news:signals` key and `TTL_NEWS = 420`. A single-flight lock covers the cold-cache fetch so concurrent misses at a TTL boundary share one upstream call instead of stampeding the bearer-gated producer. Failures are **negative-cached** on a short TTL (`TTL_NEWS_UNAVAILABLE = 30`) — otherwise, during a sustained producer outage, every request would re-enter the lock and re-attempt the ~10s HTTP call one at a time (the lock becomes full serialization, not just dedup, and can exhaust the sync threadpool); the short TTL still lets the panel recover within ~30s of the producer returning. The route is deliberately a sync `def` (FastAPI threadpools it; converting to `async def` without moving the blocking HTTP call would stall the event loop — commented in code). Fail-closed: on any adapter failure the route returns `200` with the single-sourced `UNAVAILABLE_PAYLOAD` (defined once in the adapter, reused by the route) — the panel renders an honest empty state, never a 500.

**Route-contract freezes:** adding this route requires updating `tests/test_app_composition.py::EXPECTED_FULL_CONTRACT` **and** adding a golden set per the `test_router_move.py` convention — both in the same PR, or every open PR's CI goes red (the exact failure mode of PRs #88–#91).

### 4.3 Frontend — the panel

New section on `#homeView`, below the hero/dash grid: a full-width card (`.home-dash-card` styling family) titled from `news_overview`, with an internal two-column split:

- **Left — the feed column**: story rows (headline → source link, source name, relative time from `published`). **Phase A labels it "Today's signal stories"** — on a quiet day only a handful of tickers signal, so presenting one-story-per-signalled-ticker as "Latest news" would look broken or redundant against the right column. Phase B renames it "Latest news" when the raw-items endpoint genuinely powers it. Every row's headline is an `<a>` to the story URL (**mandatory** — truth-infra requirement). The `feed` array is served backend-side even in Phase A (derivable from `signals` there) so the wire format and frontend don't change when Phase B swaps the source.
- **Right — "Signals"**: per-ticker rows — ticker, sentiment chip (bullish/bearish/neutral), score, `rationale`, `n_articles`; row links to the same source story.
- Header shows "Updated Xh ago" from `staleness_hours`; a `degraded` status renders a visible badge with `status_reason`; the `unavailable` state renders "News signals are currently unavailable" (no fake emptiness).
- Lifecycle: init/start on `onHomePageShow`, stop on `onHomePageHide` (copy `home-page.js` pattern); 5-min re-poll while visible.
- **Reuse the existing frontend helpers** — `escapeHtml` (`app.js:484`, attribute-safe: escapes quotes, which matters for `href="…"` injection), the `API` fetch wrapper (`app.js:920-981`, centralizes error mapping + headers), and `formatMarketEventRelativeTime` (`market-events/marketEventRelativeTime.js`) for row times. A locally reinvented escaper or time formatter is a review-blocker: the first is an XSS hazard, the second guarantees visual drift. **`escapeHtml` is necessary but NOT sufficient for a URL:** it does not scheme-validate, so a `javascript:` value in a story `url`/`link` survives it and executes on click (the producer's `clean_text` does not validate scheme either). Every outbound link must pass through an http(s)-only `safeUrl()` guard *before* `escapeHtml` (see the plan's Task 6 snippet) — the sourced-link requirement is not an excuse to interpolate an unvalidated href.
- Implementation may resurrect the orphaned `market-events/` widget (its card/feed/"Updated Ns ago" chrome is exactly this shape) or build fresh with `.section-card` conventions — implementer's call; the mock `mockMarketEvents.js` path must not ship as the data source either way.

### 4.4 Cross-repo Phase B — FinSearch raw-feed endpoint

Small FinSearch-side PR (own review cycle in that repo), sibling of `news_signals`:

```
GET /api/news/items/   ?limit=50 [&as_of=YYYY-MM-DD]
```

- Serves the newest `items-*.jsonl` batch (fields: `guid,title,link,source,published,description,tickers,score`), same `@require_bearer_auth` + `@ratelimit` + `@condition` idioms as `signals_views.py`, newest-by-`(stem_date, mtime, name)` selection reused.
- **Curation decision:** serve validation-gated items only (the `validation_gate` trust boundary: parse, required fields, published-sanity, text caps) but **not** the subject/roundup gates — the panel wants the fetched feed, lightly sanitized, not the signals pipeline's curated subset. Cap the response (`limit`, default 50, newest first).
- Needs a `RAW_ITEMS_DIR`-style setting (the `digests/` dir isn't exposed to Django today). Retention (90d) already suffices; no retention change.
- ATL side then extends `get_latest_panel_payload` to source the left column from it (falling back to Phase-A representative stories if the endpoint is missing/erroring — fail-closed all the way down).

### 4.5 Env & config

- `FINGPT_API_KEY` — required in ATL's **Render env** (secret) and local `dashboard/.env`; add to `.env.example` with a one-line comment. Same key as the FinSearch backend (coarse gate, per the base contract).
- `FINSEARCH_SIGNALS_URL` — optional override of the producer base URL (default the live endpoint); makes local dev against a fixture server or staging possible without code edits.

## 5. Testing

- **Offline-first:** copy `signals-v2.schema.json` + `signals-fixture.json` from the FinSearch repo into `dashboard/backend/tests/fixtures/` (per the base contract). All adapter tests run against the fixture — no network, no key, CI-safe.
- Adapter: projection field-by-field (incl. `rationale`, `age_hours` against a simulated step timestamp), every error-table row (401/503/400/404/degraded/network → correct fail-closed output + log level), and the memo-policy invariants: **an ISO-string timestamp exactly as the real call site passes it**; a past-date key fetched once; a config error (401) negative-cached for past dates; today's 404 NOT sticking after the artifact appears; a transport failure never serving a cached body.
- `test_execution_backends.py::test_news_sentiment_fail_closed_when_plan1_absent` must be rewritten when the module lands (its module-absent premise becomes false, and it would otherwise call the real adapter — a live HTTP request from CI): simulate absence via a `None` entry in `sys.modules`.
- Contract: `NewsSentimentEntry` accepts entries with and without `rationale` (additive proof); v2 envelope test extended.
- `docs/integrations/finsearch-news-sentiment.md` is updated in the same PRs that change what it documents: the `rationale` row + design-note when the field ships, and the reference sketch's datetime assumption when the string-coercing adapter ships — the "normative" doc must never lag the shipped contract.
- Route: panel payload shape, cache hit path, unavailable state; **both** route-contract freezes updated.
- Frontend: manual verification via the `verify`/`run` flow (panel renders fixture data locally; empty state renders when the adapter is stubbed to fail).
- FinSearch Phase B: endpoint tests mirroring `test_signals_endpoint.py` (auth, as_of, limit, 404-empty, conditional GET).

## 6. Out of scope (explicit)

- Injecting `news_sentiment` into the **internal** `LLMAgentStrategy` prompt or `/api/v1` snapshots — today it reaches only the v2 context envelope, and changing what leaderboard models see mid-contest would invalidate cross-entry comparability. Revisit deliberately (new contest season) — see the sibling Plan 3 spec's future-work section.
- Live paper-trading signal injection (the programme's stated future) — designed-for: the adapter's `get_news_sentiment(universe, timestamp=now)` already answers "what do we know right now", which is exactly the paper-trading call shape.
- Wider-than-DJIA-30 universes; SSE push; per-user news preferences; historical feed browsing.

## 7. Open questions flagged for Felix (non-blocking)

1. Phase B endpoint shape: is `limit=50` of the newest batch enough, or do you want cross-batch pagination (history browsing)? Spec assumes newest-batch-only.
2. Panel placement within Home: the spec says full-width section below the dash grid; if you'd rather swap out one of the four existing cards, that's a layout-only change.
