# Reference Repositories — Manifest

Vendored read-only reference sources. **Pinned at clone time (2026-09-03).**
Re-sync with `scripts/sync-reference.sh`.

> These are for **reading and architectural reference only**. Nothing here is
> imported, linked, or compiled into `apps/` or `packages/`. See the license
> column — one of them is AGPL-3.0 and must never be linked.

| Repo | Upstream | Pinned SHA | Upstream date | License | Size |
|---|---|---|---|---|---|
| `TradingAgents/` | [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | `9dee508c44662702281a8dbaad1f7b42179b5ba7` | 2026-09-01 | Apache-2.0 | 8.2M |
| `ai-hedge-fund/` | [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | `eff8a7320fcf0b473b135690fa1a5b0d9b022a83` | 2026-08-07 | MIT | 1.4M |
| `openalgo/` | [marketcalls/openalgo](https://github.com/marketcalls/openalgo) | `adbde8d4d550ba9b42158747ece3a2141a3147dc` | 2026-09-03 | **AGPL-3.0** :warning: | 50M |
| `AgenticTrading/` | [Open-Finance-Lab/AgenticTrading](https://github.com/Open-Finance-Lab/AgenticTrading) | `43ab8e6ea09a5bd50bbbc6ec4fc5bad2a56ccf01` | 2026-09-02 | OpenMDW-1.0 (SecureFinAI Lab) | 80M |

Also vendored in the workspace root (pre-existing, both MIT):

| Dir | Upstream | What it is |
|---|---|---|
| `../ai-trading-claude/` | [zubair-trabzada/ai-trading-claude](https://github.com/zubair-trabzada/ai-trading-claude) | 16 Claude Code skills + 5 agent specs, prompt-only |
| `../InvestSkill/` | [yennanliu/InvestSkill](https://github.com/yennanliu/InvestSkill) | 26 analysis frameworks, v1.11.0, prompt-only |

---

## :warning: License handling

**`openalgo` is AGPL-3.0.** The AGPL's network-use clause means that linking it
into our application — or deriving code from it — would oblige us to release our
entire application source under AGPL to every user who interacts with it over a
network.

**Rule:** OpenAlgo may be *run* as a **separate self-hosted process** that we talk
to over HTTP, exactly as we would talk to any third-party broker. That is arm's
length and does not create a derivative work. We may **read** it to understand the
Indian broker landscape. We must **never** copy code from it into this repo, and
must never `import`/`require`/link it.

`AgenticTrading` is under OpenMDW-1.0, a model/data-weights licence — check its
terms before reusing anything beyond ideas.

`TradingAgents` (Apache-2.0) and `ai-hedge-fund` (MIT) are both permissive; code
may be adapted **with attribution** and the upstream licence text retained.

---

## What we actually use from each

### `TradingAgents/` — the topology reference (most valuable)

Read these files; they are the concrete implementation of the desk metaphor:

| Path | Why |
|---|---|
| `tradingagents/graph/conditional_logic.py` | The exact debate-termination rules. Bull/Bear alternate until `count >= 2 x max_debate_rounds`; risk trio (Aggressive -> Conservative -> Neutral) rotates until `count >= 3 x max_risk_discuss_rounds`. We copy this control-flow shape. |
| `tradingagents/graph/setup.py` | How the LangGraph node/edge graph is wired. |
| `tradingagents/graph/reflection.py` | **The learning loop.** After outcome is known, a cheap model writes 2-4 sentences citing raw return *and alpha vs benchmark*, stored verbatim and re-read by future analysts. |
| `tradingagents/agents/utils/memory.py` | Append-only markdown decision log, `<!-- ENTRY_END -->` delimiter, `pending` -> resolved lifecycle, entry-count rotation. Simple and durable. |
| `tradingagents/agents/schemas.py` | Pydantic structured-output schemas for the three *decision* agents only (Research Manager, Trader, Portfolio Manager) — analysts stay prose. Good split; we go further and structure everything. |
| `tradingagents/agents/risk_mgmt/` | Three risk debaters: `aggressive_debator`, `conservative_debator`, `neutral_debator`. Richer than a single risk agent. |
| `tradingagents/dataflows/` | Adapter patterns for yfinance, FRED, Reddit, StockTwits, Alpha Vantage, Polymarket. |
| `tradingagents/default_config.py` | Env-override table with fail-loud coercion (`treu` raises, doesn't silently default). Copy this habit. |

### `ai-hedge-fund/` — the persona layer
`hedge_fund/` — 14 investor-persona agents (Buffett, Munger, Graham, Burry, Wood,
Taleb, Lynch, Ackman, Fisher, Druckenmiller, Damodaran, Pabrai, Jhunjhunwala) and
the discretionary-pod vs systematic-pod split behind one interface.

### `openalgo/` — Indian broker landscape (read only)
36 broker plugins. Read `broker/` to learn each Indian broker's auth flow, order
payload shape, and WebSocket contract before writing our own `IndiaBrokerAdapter`.

### `AgenticTrading/` — evaluation discipline
Backtest + paper-sim harness, decision-log inspection, benchmark comparison.
Reference for our Evaluator subsystem.
