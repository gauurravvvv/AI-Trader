Architecture
============

The lab stacks a backtest engine, REST API, and web dashboard. Data flows from Alpaca through backtests into SQLite, then through the API to the frontend.

System diagram
--------------

.. code-block:: text

   ┌─────────────────────────────────────────────────────────────┐
   │ Backtest Engine (dashboard/scripts/backtest_hourly_agent.py)│
   │ ├─ Fetch Alpaca hourly bars                                 │
   │ ├─ Run agent + baseline logic                               │
   │ ├─ Write 3 runs (agent, buy-and-hold, DJIA)                 │
   │ └─ Store in dashboard/storage/data/backtest.db (SQLite)     │
   └────────────────┬────────────────────────────────────────────┘
                    │
   ┌────────────────▼────────────────────────────────────────────┐
   │ REST API (dashboard/backend/app.py)                         │
   │ ├─ GET  /health                                             │
   │ ├─ GET  /runs, /runs/{id}/equity, /compare                  │
   │ ├─ POST /backtest/run, GET /backtest/status                 │
   │ ├─ GET  /ticker                                             │
   │ ├─ GET  /paper/account, /paper/positions, …                 │
   │ └─ GET  /config/defaults                                    │
   └────────────────┬────────────────────────────────────────────┘
                    │
   ┌────────────────▼────────────────────────────────────────────┐
   │ Web Dashboard (dashboard/frontend/)                         │
   │ ├─ index.html, app.js, styles.css                           │
   │ └─ images/                                                  │
   └─────────────────────────────────────────────────────────────┘

API surface (summary)
---------------------

+---------------------------+------------------------------------------+
| Endpoint                  | Purpose                                  |
+===========================+==========================================+
| ``GET /health``           | Health check                             |
| ``GET /runs``             | List backtest runs                       |
| ``GET /runs/{id}/equity`` | Equity curve for a run                   |
| ``GET /compare``          | Compare multiple runs                    |
| ``POST /backtest/run``    | Start a backtest                         |
| ``GET /backtest/status``  | Poll backtest job status                 |
| ``GET /ticker``           | Market quote data                        |
| ``GET /paper/*``          | Paper-trading account, positions, trades |
| ``GET /config/defaults``  | Default UI / run configuration           |
| ``/api/v2/*``             | Agent API (:doc:`agent_api`)             |
+---------------------------+------------------------------------------+

LLM integration example code lives in ``dashboard/backend/llm_integration_example.py`` (reference only, not wired into the main app path).

Related documentation
---------------------

* Discord → backtest → dashboard workflow (and future paper trading from Discord):
  ``docs/architecture/discord-to-backtest.md``
* Multi-agent orchestration, agent pools, and DAG workflows:
  :doc:`../orchestration/index`.
