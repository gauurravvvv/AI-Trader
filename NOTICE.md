# Third-Party Notices

## Scope of the MIT license

The MIT license in [LICENSE](LICENSE) covers **only** the original work in this
repository:

```
docs/    scripts/    README.md    LICENSE    NOTICE.md    .gitignore
```

It does **not** cover anything under `reference/`. Every directory there is an
unmodified third-party copy that remains under its own upstream license,
reproduced in full inside that directory.

---

Everything under `reference/` is an **unmodified upstream copy**, vendored for
reading only. Each retains its own license, reproduced in full inside its own
directory. None of it is imported, linked, or compiled into any original work in
this repository — the relationship is *mere aggregation* in the sense of
GPL §5 / AGPL §5, not derivation.

| Directory | Upstream | License | Pinned commit |
|---|---|---|---|
| `reference/TradingAgents/` | [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | Apache-2.0 | `9dee508c44662702281a8dbaad1f7b42179b5ba7` |
| `reference/ai-hedge-fund/` | [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | MIT | `eff8a7320fcf0b473b135690fa1a5b0d9b022a83` |
| `reference/openalgo/` | [marketcalls/openalgo](https://github.com/marketcalls/openalgo) | **AGPL-3.0** | `adbde8d4d550ba9b42158747ece3a2141a3147dc` |
| `reference/AgenticTrading/` | [Open-Finance-Lab/AgenticTrading](https://github.com/Open-Finance-Lab/AgenticTrading) | OpenMDW-1.0 | `43ab8e6ea09a5bd50bbbc6ec4fc5bad2a56ccf01` |
| `reference/InvestSkill/` | [yennanliu/InvestSkill](https://github.com/yennanliu/InvestSkill) | MIT | `22a285674ca2fdc9687eca90a62a0c94bbebefb2` |
| `reference/ai-trading-claude/` | [zubair-trabzada/ai-trading-claude](https://github.com/zubair-trabzada/ai-trading-claude) | MIT | `c6d7252211a72405cefaff3e62d27a032c58348c` |

## On the AGPL-3.0 copy

`reference/openalgo/` is licensed AGPL-3.0. Its network-use clause would oblige
this project to release its own source under AGPL **if** openalgo were linked
into it or derived from. Neither happens here, and neither is permitted:

- openalgo is **read** only, to understand the Indian broker landscape.
- If it is ever used at runtime it runs as a **separate self-hosted process**
  reached over HTTP, exactly like any third-party broker — arm's length, not a
  derivative work.
- No code is copied from it into `docs/`, `scripts/`, or any application code.

This rule is restated in `reference/MANIFEST.md` and must survive any refactor.

## Reproducing `reference/`

Every copy is pinned by commit SHA. `scripts/sync-reference.sh` re-clones all six
at those exact commits and strips each `.git` directory, so this workspace stays a
single self-contained tree:

```bash
./scripts/sync-reference.sh            # re-clone at the pinned SHAs
./scripts/sync-reference.sh --latest   # clone upstream HEAD, print new SHAs
```
