# Nemotron reasoning=none 最小修复实施计划

> 本计划按 loop engineering 执行：每个任务遵循“失败测试 -> 最小实现 -> 验证 -> 提交”。必须按顺序完成，不把调查分支中的诊断框架带入本分支。

**目标：** 只为排行榜中的 Nemotron 显式关闭 OpenRouter reasoning，使模型稳定返回 ATL 可解析的交易 JSON，并通过相同真实行情窗口验证调用链可靠性。

**架构：** `leaderboard.json` 提供模型级 `reasoning_effort`；`LLMAgentStrategy` 将它传给 LLM provider 工厂；OpenRouter 客户端实例保存该覆盖值并在每次请求时注入 reasoning/thinking disabled。没有模型级配置时继续使用环境变量和现有默认值。

**技术栈：** Python 3.10+、Anthropic Python SDK、OpenRouter Anthropic Messages 兼容接口、pytest、Alpaca 小时行情。

**设计规格：** `docs/superpowers/specs/2026-07-19-nemotron-reasoning-none-fix-design.zh-CN.md`

## 全局约束

- 从 `fix/issue-148-nemotron-reasoning` 分支实施；该分支基于最新 `origin/main`。
- 不 cherry-pick `fix/issue-148-diagnostics` 的数据库、引擎或诊断表改动。
- 不修改提示词、交易规则、仓位管理、模拟成交或数据库结构。
- 不修改 CommonStack、Anthropic 或未配置 reasoning 的 OpenRouter 模型行为。
- 正常请求路径不得修改 `os.environ`。
- 单元测试不得进行真实网络请求。
- 真实实验不打印 API Key、完整回复或 reasoning 原文。
- 收益率不作为修复成功门槛；响应覆盖率和回退率才是本轮标准。
- 每个代码任务独立提交，便于仓库维护者审阅和回滚。

---

## Task 1：支持 OpenRouter 客户端实例级 reasoning 覆盖

**文件：**

- 修改：`dashboard/backend/infrastructure/llm/providers/openrouter.py`
- 修改：`dashboard/backend/infrastructure/llm/providers/__init__.py`
- 修改：`dashboard/backend/infrastructure/llm/backtest_harness.py`
- 修改：`dashboard/backend/tests/llm/test_providers.py`
- 修改：`dashboard/backend/tests/llm/test_backtest_harness.py`

**接口变化：**

```python
def make_llm_client(
    integration: Optional[str] = None,
    *,
    reasoning_effort: Optional[str] = None,
) -> Optional[Any]: ...
```

OpenRouter 内部对象增加同名可选参数；未传入时完全沿用环境变量和默认行为。

- [ ] **Step 1：写失败测试**

在 `test_providers.py` 覆盖：

- 环境变量为 `medium`、客户端实例为 `none` 时，请求仍注入 reasoning disabled 和 thinking disabled。
- 客户端实例没有覆盖值时，继续从环境变量读取 `medium`。
- provider 工厂只把 `reasoning_effort` 传给 OpenRouter，CommonStack 和 Anthropic 构造签名不变。
- 两个不同 OpenRouter 客户端可以分别使用 `none` 和 `medium`，证明没有共享全局状态。

在 `test_backtest_harness.py` 覆盖：

- harness 的 `make_llm_client` 将显式 `reasoning_effort` 原样转发给 provider 工厂。
- 旧调用只传 `integration` 时仍然有效。

- [ ] **Step 2：运行测试并确认失败**

```bash
pytest dashboard/backend/tests/llm/test_providers.py \
  dashboard/backend/tests/llm/test_backtest_harness.py -v
```

预期：FAIL，现有工厂和 OpenRouter 客户端不接受实例级 reasoning 参数。

- [ ] **Step 3：实现最小 reasoning 解析**

在 `openrouter.py` 中让现有 reasoning helper 接受可选覆盖值：

```python
def _reasoning_effort(override: Optional[str] = None) -> str: ...
def reasoning_extra_body(override: Optional[str] = None) -> Optional[dict]: ...
def anthropic_thinking_kwarg(override: Optional[str] = None) -> Optional[dict]: ...
```

解析优先级必须是：

```text
实例级覆盖值 > OPENROUTER_REASONING_EFFORT > provider 默认值
```

`_OpenRouterMessages` 保存覆盖值，并在 `create()` 时传给两个 helper。`OpenRouterClient` 和 `make_client` 只负责传递，不复制 reasoning 判断逻辑。

- [ ] **Step 4：扩展 provider 工厂和 harness**

`providers.make_llm_client` 解析 integration 后：

- OpenRouter：调用 `make_client(_Anthropic, reasoning_effort=...)`；
- 其他 provider：继续调用 `make_client(_Anthropic)`，不传 OpenRouter 专属参数。

`backtest_harness.make_llm_client` 只做薄转发，不加入 provider 判断。

- [ ] **Step 5：运行聚焦测试**

```bash
pytest dashboard/backend/tests/llm/test_providers.py \
  dashboard/backend/tests/llm/test_backtest_harness.py -v
```

预期：PASS。

- [ ] **Step 6：提交**

```bash
git add dashboard/backend/infrastructure/llm/providers/openrouter.py \
  dashboard/backend/infrastructure/llm/providers/__init__.py \
  dashboard/backend/infrastructure/llm/backtest_harness.py \
  dashboard/backend/tests/llm/test_providers.py \
  dashboard/backend/tests/llm/test_backtest_harness.py
git commit -m "fix(llm): support per-client OpenRouter reasoning"
```

---

## Task 2：只为 Nemotron 关闭 reasoning

**文件：**

- 修改：`dashboard/config/leaderboard.json`
- 修改：`dashboard/backend/domain/leaderboard/strategies/llm_agent.py`
- 修改：`dashboard/backend/tests/domain/leaderboard/test_strategies_move.py`

- [ ] **Step 1：写失败测试**

在 `test_strategies_move.py` 增加：

- `LLMAgentStrategy` 从配置读取 `reasoning_effort`。
- `_make_client()` 把 `integration="openrouter"` 和 `reasoning_effort="none"` 一起传给 canonical client factory。
- 未配置 `reasoning_effort` 时传递 `None`，保持旧条目行为。
- 读取 `leaderboard.json` 后，只有 `nemotron_3_nano_30b` 条目包含 `reasoning_effort="none"`。

测试使用 monkeypatch/fake client，不进行真实网络请求。

- [ ] **Step 2：运行测试并确认失败**

```bash
pytest dashboard/backend/tests/domain/leaderboard/test_strategies_move.py -v
```

预期：FAIL，策略尚未读取或传递模型级 reasoning 配置。

- [ ] **Step 3：实现策略传递**

在构造函数中读取：

```python
self.reasoning_effort = self.config.get("reasoning_effort")
```

创建客户端时调用：

```python
make_llm_client(
    self.integration,
    reasoning_effort=self.reasoning_effort,
)
```

不得在策略中修改环境变量，不得对模型 ID 做硬编码判断。

- [ ] **Step 4：配置 Nemotron**

只在 `nemotron_3_nano_30b` 条目增加：

```json
"reasoning_effort": "none"
```

其他排行榜条目保持业务配置不变。

- [ ] **Step 5：运行策略和 provider 回归测试**

```bash
pytest dashboard/backend/tests/domain/leaderboard/test_strategies_move.py \
  dashboard/backend/tests/llm/test_providers.py \
  dashboard/backend/tests/llm/test_backtest_harness.py -v
```

预期：PASS。

- [ ] **Step 6：提交**

```bash
git add dashboard/config/leaderboard.json \
  dashboard/backend/domain/leaderboard/strategies/llm_agent.py \
  dashboard/backend/tests/domain/leaderboard/test_strategies_move.py
git commit -m "fix(leaderboard): disable reasoning for Nemotron"
```

---

## Task 3：回归验证和真实行情复测

**代码文件：** 无新增产品代码。仅运行测试和只读/内存实验。

空文本、重试和响应结束原因使用临时的进程内 wrapper 采集并在命令结束后丢弃；不得为复测引入诊断表、修改产品数据库或提交实验脚本。

- [ ] **Step 1：运行相关测试组**

```bash
pytest dashboard/backend/tests/llm \
  dashboard/backend/tests/domain/leaderboard \
  dashboard/backend/tests/backtesting/test_canonical_consumers.py -v
```

预期：PASS。

- [ ] **Step 2：运行完整 backend 测试**

```bash
pytest dashboard/backend/tests -q
```

若仓库基线中存在与本修复无关的失败，必须在未修改的 `origin/main` 上复现后单独报告，不顺带修复。

- [ ] **Step 3：运行相同前 16 个真实决策点**

固定：

- 日期：2026-04-15 至 2026-05-15；
- 数据：Alpaca DJIA 30 小时线；
- 模型：`nvidia/nemotron-3-nano-30b-a3b`；
- integration：OpenRouter；
- 模式：`safe_trading`；
- 初始资金和资产集合不变；
- 只在内存中计算，不发布排行榜结果。

记录：决策点、API 调用数、有效决策、空文本、重试、解析失败、回退、平均延迟、模拟成交数。

预期：

- `no_text_steps=0`；
- `total_retries=0`；
- 有效决策覆盖率不低于 95%；
- API 调用数基本等于决策点数。

- [ ] **Step 4：运行完整 154 点真实窗口**

沿用 Step 3 的固定条件，只扩大到完整窗口。不得使用 `--allow-fallback` 发布失败曲线；本步骤仍不写排行榜数据库。

预期：

- 生成完整投资曲线和模拟成交；
- 有效决策覆盖率不低于 95%；
- 空文本和重试保持为 0；
- 收益率、Sharpe 和最大回撤仅记录，不作为通过条件。

- [ ] **Step 5：检查分支范围**

```bash
git diff --check
git diff --stat origin/main...HEAD
git status --short --branch
```

确认最终分支只包含本设计文档、实施计划、模型级 reasoning 传递、Nemotron 配置和聚焦测试。

---

## Task 4：准备 Issue #148 短总结

**外部状态变更：** 在用户确认文本后，才向 GitHub Issue #148 发布评论或创建 PR。

- [ ] **Step 1：生成英文总结草稿**

严格对应 Issue 的 Expected Outcome：

1. What was checked；
2. What problem was found；
3. Evidence supporting the conclusion；
4. Recommended fix and post-fix experiment results。

- [ ] **Step 2：向用户展示草稿**

评论必须清楚区分：

- 原曲线受调用链回退污染；
- 修复后调用链是否稳定；
- 修复后收益属于模型真实决策观察值，不保证优于其他模型。

- [ ] **Step 3：用户授权后再发布**

不得自动关闭 Issue，不使用 `Closes #148`。需要 PR 时使用 `Refs #148`，并保持 PR 改动范围与本计划一致。

---

## 最终完成检查

- [ ] 设计文档与计划文档已提交。
- [ ] 两个代码任务均按 TDD 完成并独立提交。
- [ ] 聚焦测试和完整 backend 测试已运行。
- [ ] 16 点和完整窗口的真实数据复测满足可靠性标准。
- [ ] 分支没有诊断数据库、前端或无关重构。
- [ ] Issue 英文总结已由用户审阅。
- [ ] 用户明确授权后才执行 GitHub 评论、push 或 PR 操作。
