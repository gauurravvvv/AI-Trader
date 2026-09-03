# Reference Repositories — Manifest

Six read-only vendored sources. **Pinned at vendor time (2026-09-03).**
Re-sync with `../scripts/sync-reference.sh`.

> Everything here is for **reading and architectural reference only**. Nothing is
> imported, linked, or compiled into the application. Each repo's `.git` is
> stripped so this workspace is a single self-contained tree — the pinned SHA
> below is the provenance record, and the sync script re-clones from it.

| Repo | Upstream | Pinned SHA | Upstream date | License | Size |
|---|---|---|---|---|---|
| `TradingAgents/` | [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | `9dee508c44662702281a8dbaad1f7b42179b5ba7` | 2026-09-01 | Apache-2.0 | 8.2M |
| `ai-hedge-fund/` | [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | `eff8a7320fcf0b473b135690fa1a5b0d9b022a83` | 2026-08-07 | MIT | 1.4M |
| `openalgo/` | [marketcalls/openalgo](https://github.com/marketcalls/openalgo) | `adbde8d4d550ba9b42158747ece3a2141a3147dc` | 2026-09-03 | **AGPL-3.0** :warning: | 50M |
| `AgenticTrading/` | [Open-Finance-Lab/AgenticTrading](https://github.com/Open-Finance-Lab/AgenticTrading) | `43ab8e6ea09a5bd50bbbc6ec4fc5bad2a56ccf01` | 2026-09-02 | OpenMDW-1.0 (SecureFinAI Lab) | 80M |
| `InvestSkill/` | [yennanliu/InvestSkill](https://github.com/yennanliu/InvestSkill) | `22a285674ca2fdc9687eca90a62a0c94bbebefb2` | 2026-09-02 | MIT | 8.4M |
| `ai-trading-claude/` | [zubair-trabzada/ai-trading-claude](https://github.com/zubair-trabzada/ai-trading-claude) | `c6d7252211a72405cefaff3e62d27a032c58348c` | 2026-04-07 | MIT | 664K |

The last two are **prompt toolkits** — markdown skills with no runtime — while the
first four are **codebases**. That is the only distinction between them, and it is
not a reason to store them differently: all six are read-only vendored OSS we
mined for patterns and will never import.

---

## :warning: License handling

**`openalgo` is AGPL-3.0.** The network-use clause means linking it into our
application — or deriving code from it — would oblige us to release our entire
application source under AGPL to every user who reaches it over a network.

**Rule:** OpenAlgo may be *run* as a **separate self-hosted process** we talk to
over HTTP, exactly as we would talk to any third-party broker. That is arm's
length and does not create a derivative work. We may **read** it to understand
the Indian broker landscape. We must **never** copy code from it into this repo,
and must never `import`/`require`/link it.

`AgenticTrading` is under OpenMDW-1.0, a model/data-weights licence — check its
terms before reusing anything beyond ideas.

`TradingAgents` (Apache-2.0), `ai-hedge-fund`, `InvestSkill`, and
`ai-trading-claude` (all MIT) are permissive; code may be adapted **with
attribution** and the upstream licence text retained.

---

## What we actually use from each

### `TradingAgents/` — the topology reference (most valuable)

| Path | Why |
|---|---|
| `tradingagents/graph/conditional_logic.py` | The exact debate-termination rules. Bull/Bear alternate until `count >= 2 x max_debate_rounds`; the risk trio (Aggressive -> Conservative -> Neutral) rotates until `count >= 3 x max_risk_discuss_rounds`. We copy this control-flow shape. |
| `tradingagents/graph/setup.py` | How the LangGraph node/edge graph is wired. |
| `tradingagents/graph/reflection.py` | **The learning loop.** Once the outcome is known, a cheap model writes 2-4 sentences citing raw return *and alpha vs benchmark*, stored verbatim and re-read by future analysts. |
| `tradingagents/agents/utils/memory.py` | Append-only markdown decision log, `<!-- ENTRY_END -->` delimiter, `pending` -> resolved lifecycle, entry-count rotation. Simple and durable. |
| `tradingagents/agents/schemas.py` | Pydantic structured output for the three *decision* agents only; analysts stay prose. Good split — we go further and structure everything. |
| `tradingagents/agents/risk_mgmt/` | Three risk debaters: aggressive, conservative, neutral. Richer than a single risk agent. |
| `tradingagents/dataflows/` | Adapter patterns for yfinance, FRED, Reddit, StockTwits, Alpha Vantage, Polymarket. |
| `tradingagents/default_config.py` | Env-override table with fail-loud coercion (`treu` raises, doesn't silently default). Copy this habit. |

### `ai-hedge-fund/` — the persona layer
`hedge_fund/` — 14 investor-persona agents (Buffett, Munger, Graham, Burry, Wood,
Taleb, Lynch, Ackman, Fisher, Druckenmiller, Damodaran, Pabrai, Jhunjhunwala) and
the discretionary-pod vs systematic-pod split behind one interface.

### `openalgo/` — Indian broker landscape (read only)
36 broker plugins. Read `broker/` for each Indian broker's auth flow, order
payload shape, and WebSocket contract before writing our own India adapter.

### `AgenticTrading/` — evaluation discipline
Backtest and paper-sim harness, decision-log inspection, benchmark comparison.
Reference for our Evaluator subsystem.

### `InvestSkill/` — the analytical frameworks (v1.11.0)
26 advertised frameworks across 27 skill directories, dual-published as
`plugins/us-stock-analysis/skills/<n>/SKILL.md` and portable `prompts/<n>.md`.
Four ideas became load-bearing:

| Path | Becomes |
|---|---|
| `prompts/result-validator.md` | The **Auditor** agent — scores an analysis 0-100 across data quality, methodology, signal consistency, risk coverage, transparency, and may downgrade or reverse the signal. |
| `prompts/position-ladder.md` | The **Execution Planner** — share floor/ceiling, ATR-spaced rungs, trim/re-add cycle, thesis-break gate, do-not-ladder list, suitability score. |
| `prompts/full-report.md` | The 5-phase pipeline and its 25/25/20/15/15 weighting. |
| Every skill's `Thesis Invalidation` / `Re-run this analysis when` block | The **Monitor's** watch conditions — a monitoring spec written as a prompt, which we turn into database rows. |

### `ai-trading-claude/` — the scoring rubrics
16 Claude Code skills plus 5 agent specs, prompt-only. Source of the weighted
composite (25/25/20/15/15, inverted risk axis), the 5 x 20 sub-dimension rubric
shape that makes two runs comparable, the discovery-brief-then-fan-out pattern
that became our shared ContextPacket, and the contrarian-flag handling in
`agents/trade-sentiment.md`.

Two defects worth knowing if you ever install it: six of its sixteen skills and
all five agent files ship **without YAML frontmatter** so they will not register
with Claude Code, and `trade-analyze` inlines its own agent prompts rather than
invoking the five files in `agents/` — those are unwired documentation.
