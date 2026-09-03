# FinSearch Raw News Items — the `news-story v2` Contract (Phase B)

**Audience:** both teams — AF producer (`Main/backend/api/signals_views.py`, Agentic-FinSearch) and ATL consumer (`dashboard/backend/integrations/news_sentiment.py`).
**Status (2026-07-16):** **live on both sides.** AF PR #359 shipped the producer and is deployed (wire shape verified against prod); ATL PR #110 shipped the consumer, closing the window in which ATL PR #107 — merged at a commit predating the `headline`/`url` rename — read the retired keys while the panel silently served the Phase-A fallback. The drift guard has since been extended to the two projections that lacked one: the panel `signals` block (#119 → #120) and the per-step backtest projection (#122).
**Design rationale:** `docs/superpowers/specs/2026-07-14-finsearch-news-story-contract-design.md`.
**Companion:** [`finsearch-news-sentiment.md`](finsearch-news-sentiment.md) — Phase A, the signals endpoint this contract's vocabulary is anchored to.

---

## The `news-story v2` vocabulary

Every AF **news** endpoint emits stories in this shape; every consumer reads it
by key. New sources are normalized into it **at AF's API boundary** — consumers
never see per-source dialects.

**Per-story fields** (each element of `items[]`; a signals story speaks the same nouns):

| field | type | notes |
|-------|------|-------|
| `headline` | str | story title (disk-native `title`, renamed at the boundary) |
| `url` | str | story link (disk-native `link`, renamed at the boundary) |
| `source` | str | outlet/provider — distinguishes sources as they're added |
| `published` | float | epoch seconds |
| `tickers` | str[] | 0..N symbols; `[]` = general-market story |

Items-only per-story extras (absent from a signals story): `guid`, `description`, `editorial_score`.

> `editorial_score` was named `score` until news-story v2 (2026-07-14). It was
> renamed because a bare `score` collided semantically across the two news
> endpoints: on **items** it is an editorial-prominence weight, while on
> **signals** the same word meant a directional sentiment read in −1…1. The
> signals endpoint's key became `sentiment_score` in the same change.

**Response-level field:** `schema_version` (int, currently `2`) — sits at the
top of the response body, **not** inside each story. Intended evolution valve:
fields are added additively; a breaking change bumps the version.

> **It is a producer-side convention only — no consumer reads it at runtime.**
> ATL parses stories by key and ignores `schema_version` entirely, so a rename
> is not *detected* by the version number. Don't mistake the presence of this
> field for a consumer that gates on it. (ATL's fixtures now pin
> `schema_version == 2` in `test_news_sentiment_fixture.py`, but that is a
> test-time contract check, not a runtime gate.)
>
> **What each layer actually catches — updated after the v2 rename shipped:**
> - A rename of a field ATL *projects* (`headline`/`url`/`source`/`published`/
>   `tickers`) makes every story fail to project; the panel falls back to Phase
>   A. `_alarm_if_all_dropped` (0 usable entries from a non-empty batch) logs an
>   `ERROR`, and on the panel escalates the payload to `degraded`. This is what
>   happened on 2026-07-14 with `title`/`link` → `headline`/`url`.
>   **There is no longer a single drift check to point at:** the same helper now
>   guards four projections across two entry points (panel feed, panel `signals`,
>   Phase-A fallback, backtest step). The story triple `headline`/`source`/`url`
>   is read through the shared `_story_fields`, so one rename trips the panel
>   *and* the backtest — with different visibility on each. See "Drift escalates
>   `status`…" under Consumer rules.
> - A rename of a field ATL *doesn't* read — such as `score` →
>   `editorial_score` itself — is invisible here: `_feed_from_items` never
>   touches it, so no drift check can fire. What protects this case is entirely
>   producer-side: `editorial_score` is in AF's `REQUIRED_FIELDS`, so a
>   pre-rename batch trips the batch-level poison pill, `_load_items` returns
>   `None`, and the endpoint **404s rather than serving a v1 batch at all**.
>   (This is also why AF deliberately does *not* salt the items ETag with the
>   schema version, unlike the signals ETag: no pre-rename batch is servable, so
>   there is no stale representation for a salt to invalidate.)

**Disk vs. wire:** on-disk batches (`items-*.jsonl`) stay RSS-native
(`title`/`link` — the scraper's format, validated by the ported
`validation_gate` trust boundary). Only the wire projection renames.

## `GET /api/news/items/` (AF)

The newest raw items batch — **broad by design**: not run through the signals
relevance gate, may include non-Dow tickers and general-market stories. It
powers ATL's Home-panel "Latest news" column.

- **Auth:** Bearer token (same gate as `/api/signals/news/`); missing/wrong → 401.
- **Params:** `?limit=` only — default 50, clamped to [1, 200]; non-integer → `400 {"error": "bad_limit"}`. There is deliberately **no `?tickers=` filter** (the sibling signals endpoint has one; this feed is intentionally unfiltered).
- **Response 200:**

  ```json
  {
    "schema_version": 2,
    "items": [ { "guid": "…", "headline": "…", "url": "…", "source": "…",
                 "published": 1752473600.0, "description": "…",
                 "tickers": ["AAPL"], "editorial_score": 0.7 } ],
    "count": 1,
    "batch": "items-2026-07-14.jsonl"
  }
  ```

  Items sorted newest-first by `published`. No dedup (unlike the signals path's `collapse_dup_titles`).
- **Fail-closed 404** `{"error": "no_items"}`: unconfigured/empty dir, unreadable/oversized/poisoned batch, or zero valid stories. Never 500s on bad input.
- **Caching:** `Cache-Control: public, max-age=300`; `ETag` (varies with batch + limit) and `Last-Modified` (default-limit variant only) support conditional GET → 304.

## Consumer rules (ATL, and any future reader)

- Read stories **by key**; ignore unknown keys (additive evolution).
- Fail closed: a malformed **item** is dropped (logged), a malformed **body** falls back to the Phase-A representative feed — the panel never regresses below Phase A and never errors out.
- `tickers[]` stays a list on the wire; ATL's panel currently collapses it to `tickers[0] | null` for its single chip (multi-chip display deferred). A `[]` general-market story therefore renders with **no ticker chip** — the meta line is joined from non-empty segments, so the separator collapses with it.
- **Alarm on wholesale drift, in the logs *and* in the UI.** Because the fallback is silent by design, a consumer must distinguish *one* bad story from *the contract moved*. ATL logs `ERROR` when a non-empty batch projects to zero usable entries; an empty batch is "no news", not drift. This is the safety net the 2026-07-14 rename slipped past. The check (`_alarm_if_all_dropped`) is a property of *projection*, not of the items endpoint, so it guards the Phase-A fallback too — that path needs it at least as much, since when the signals vocabulary drifts there is nothing left to fall back to and the feed goes blank rather than merely stale.
- **Drift escalates `status` to `degraded` — on the panel path.** A log line only reaches whoever is reading logs, and on 2026-07-14 nobody was — the panel looked healthy, because the fallback made it look healthy. So panel drift also sets `status: "degraded"` and appends a reader-facing `status_reason` (`news feed incomplete — upstream story format changed`), which the Home panel already renders as a badge. Two rules keep the badge worth reading: it stays dark on a quiet news day (an empty artifact drops nothing, so it isn't drift), and a drift reason is *appended to* the producer's own `status_reason` rather than replacing it — "a source timed out" and "the wire shape moved" are independent failures and the badge should not let the later one erase the earlier.
- **The backtest path alarms but cannot escalate — it is log-only, and that is a gap, not a design.** `_alarm_if_all_dropped` returns a bool and leaves the consequence to each caller; the three panel callers OR it into `degraded`, while `get_news_sentiment` (#122) **discards** it. Not an oversight: a backtest step has no badge and no reader, and the only status field in reach is `RunManifest.news_sentiment_source`, a provenance field that would have to cosplay as a status flag to carry this. So the step's `news_sentiment` slot just goes empty — which is exactly what a genuinely quiet step looks like. Wiring a real channel is **issue #123**; until it lands, drift on a backtest run is visible *only* in the logs, and by this repo's own doctrine a log nobody reads is not an alarm. **Don't read the helper's presence as a promise that drift reaches a human** — it reports, and reporting is only as loud as the channel the caller gives it.
- **Pin the wire shape in a fixture, not in inline test dicts.** ATL records it once in `dashboard/backend/tests/fixtures/items-wire-fixture.json` (key set verified against prod) and drives the adapter's happy path from it, so a rename must visibly edit that file. Fixtures written inline beside the code they test drift *with* the code and stay green.

## Known gaps

**No cross-repo contract test.** Nothing in ATL's test suite can *catch* a producer rename — the producer is mocked, so AF and ATL can only drift apart between deploys. The fixture makes the assumed shape reviewable and the drift `ERROR` makes a break visible within one poll of the panel, but neither is a cross-repo contract test. If this seam breaks a third time, the fix is a canary that exercises the real endpoint (or an AF-published fixture ATL diffs in CI), not more mocked coverage.

**Backtest drift has no channel** (issue #123). The alarm fires there, but nothing carries it to a reader — see the log-only bullet under Consumer rules. A backtest run whose news went silent mid-way is, today, indistinguishable from a run over a quiet news week unless someone reads the logs.

## Traceability

| Decision | Anchor |
|----------|--------|
| Vocabulary anchored to the live signals endpoint's nouns | design spec §"Anchor rationale" |
| Rename at producer boundary, disk stays RSS-native | design spec §"The contract"; AF `signals_views.py` `_ITEMS_WIRE_RENAMES` |
| Broad feed, no `?tickers=` | design spec §"Deliberately settled / deferred" |
| Fallback/fail-closed consumer behavior | ATL `news_sentiment.py` `get_latest_panel_payload` docstring |
| Drift `ERROR` vs. per-item warning | ATL `test_items_all_dropped_logs_drift_error` / `test_partial_malformed_items_does_not_log_drift_error` |
| Drift alarm covers the fallback, not just items | ATL `_alarm_if_all_dropped`; `test_representative_fallback_all_dropped_logs_drift_error` |
| Panel `signals` is projected, not passed through raw (a `sentiment_score` rename would have painted "NaN" into every chip — no drop, no log) | ATL issue #119 → PR #120; `_project_panel_signals`, `_PANEL_SIGNAL_KEYS`; `test_panel_signal_missing_sentiment_score_is_dropped_not_rendered_nan` |
| Panel feed and panel `signals` keep independent required-key sets | ATL `_PANEL_SIGNAL_KEYS` comment; `test_panel_signals_drift_survives_a_healthy_items_feed` |
| Backtest step projection isolates the bad ticker instead of blanking every ticker | ATL PR #122; `_project_step_signals`; `test_one_malformed_step_signal_does_not_blank_the_other_tickers` |
| Escalation asymmetry: panel drift → badge, backtest drift → log only | ATL `_alarm_if_all_dropped` docstring; `test_every_step_signal_dropped_alarms_instead_of_reading_as_a_quiet_news_day`; open issue #123 |
| Universe filtering is not drift (a narrow `?tickers=` run must not cry wolf) | ATL `test_universe_filter_alone_is_not_drift` |
| "Non-empty raw" half of the predicate (no crying wolf on a quiet news day) | ATL `test_items_empty_list_does_not_log_drift_error` / `test_empty_signals_artifact_does_not_log_drift_error` |
| Recorded wire shape + its coherence with the signals fixtures | ATL `items-wire-fixture.json`; `test_news_sentiment_fixture.py` |
