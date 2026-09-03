# Nemotron reasoning=none 最小修复设计

## 1. 背景

Issue #148 要求解释 Nemotron 通过 OpenRouter 接入排行榜后曲线明显偏差的原因，并给出小范围修复或下一步实验。调查在相同行情窗口、模型和交易配置下对 `reasoning=medium` 与 `reasoning=none` 进行了对照。

实际响应元数据表明，当前 OpenRouter 默认配置将 `medium` 映射为 2048 个 reasoning token，而 ATL 交易请求的默认总输出上限是 2000 token。四个真实行情决策点的首次响应均出现以下特征：

- `stop_reason=max_tokens`；
- `output_tokens=2000`；
- 只有 `thinking` 和 `redacted_thinking` 内容块；
- 没有可供 ATL 解析的交易 JSON。

因此系统会重复请求，最终进入关闭 reasoning 的救援调用、空动作或规则策略回退。当前排行榜曲线由模型决策和调用链回退共同形成，不能直接视为 Nemotron 交易能力的纯粹表现。

## 2. 目标

1. 只对排行榜中的 Nemotron 配置关闭 reasoning。
2. 让 Nemotron 稳定返回 ATL 期望的交易 JSON。
3. 保持其他 OpenRouter、CommonStack 和 Anthropic 模型的现有行为。
4. 保持提示词、交易规则、仓位管理、模拟成交和数据库结构不变。
5. 使用相同真实行情窗口复测调用覆盖率和完整回测曲线。

## 3. 非目标

- 不建设新的评估框架或诊断页面。
- 不把调查分支中的诊断数据库改动带入最终修复 PR。
- 不改变模型提示词或要求模型保证盈利。
- 不重写现有通用重试和规则回退机制。
- 不保存完整 prompt、模型回复、reasoning 原文或 API Key。
- 不以短样本收益率作为修复成功标准。

## 4. 分支策略

已有 `fix/issue-148-diagnostics` 分支保留为调查取证分支，不改写历史、不删除提交，也不作为最终小修复 PR 的来源。

最终修复从最新 `origin/main` 创建独立分支：

```text
origin/main
    └── fix/issue-148-nemotron-reasoning
```

该分支只包含模型级 reasoning 配置传递、必要测试和本设计文档。真实实验结果在 Issue #148 的短总结中报告，不通过新增数据库表进入产品代码。

## 5. 方案比较

### 方案 A：Nemotron 模型级 `reasoning=none`（采用）

在排行榜配置中为 Nemotron 增加显式 reasoning 字段，并通过策略和 OpenRouter 客户端传递。该方案已由真实行情对照验证，且不会改变其他模型。

### 方案 B：保留 `medium`，扩大输出上限

将总输出从 2000 增加到 4000 后，16 个决策点的空文本从 12 次降至 9 次，但仍有 33 次重试，平均延迟从约 47 秒上升到约 56 秒。该方案只能缓解，不能稳定解决。

### 方案 C：保留 `medium`，遇到截断后提前救援

检测 `max_tokens` 且无文本后立即关闭 reasoning 重试，可以减少浪费，但第一次调用仍然产生高延迟和无效 token。该方案可作为后续通用优化，不属于本次最小修复。

采用方案 A，因为它的修改范围最小，现有对照证据最强，并能直接恢复交易 JSON 覆盖率。

## 6. 架构

### 6.1 排行榜配置

Nemotron 条目增加模型级配置：

```json
{
  "id": "nemotron_3_nano_30b",
  "integration": "openrouter",
  "model_id": "nvidia/nemotron-3-nano-30b-a3b",
  "reasoning_effort": "none"
}
```

其他条目不增加该字段。

### 6.2 策略层

`LLMAgentStrategy` 从自身配置读取可选的 `reasoning_effort`，并在创建 LLM 客户端时传递该值。策略不直接修改 `os.environ`，避免并发回测之间共享全局状态。

### 6.3 Provider 工厂

LLM provider 工厂接受可选 `reasoning_effort`。只有解析后的 integration 为 `openrouter` 时才把该选项交给 OpenRouter provider；CommonStack 和 Anthropic 仍使用原来的构造路径。

### 6.4 OpenRouter 客户端

OpenRouter 消息代理保存客户端实例级 reasoning 覆盖值。每次 `messages.create` 时按以下优先级解析：

```text
模型配置 reasoning_effort
        ↓ 未配置
OPENROUTER_REASONING_EFFORT 环境变量
        ↓ 未配置
OpenRouter provider 默认值
```

当解析值为 `none` 时，现有请求载荷保持一致地注入：

```json
{
  "reasoning": {
    "effort": "none",
    "enabled": false,
    "exclude": true
  }
}
```

同时使用 Anthropic 兼容参数：

```json
{
  "thinking": {
    "type": "disabled"
  }
}
```

## 7. 数据流

```text
leaderboard.json
  reasoning_effort=none
        ↓
LLMAgentStrategy
        ↓
make_llm_client(openrouter, reasoning_effort=none)
        ↓
OpenRouterClient 实例级配置
        ↓
Nemotron 直接输出交易 JSON
        ↓
现有解析、动作过滤和模拟成交
        ↓
现有回测曲线与排行榜存储
```

除 reasoning 请求参数外，数据流中的业务逻辑保持不变。

## 8. 错误处理与兼容性

- 模型条目没有 `reasoning_effort`：继续使用环境变量或 provider 默认值。
- Nemotron 使用 `none` 后仍无文本：沿用现有重试和最终回退机制。
- OpenRouter API 异常：沿用现有规则策略回退。
- 返回无效 JSON：沿用现有解析失败和空动作行为。
- 非 OpenRouter integration：不接收 OpenRouter reasoning 覆盖值，行为不变。
- 旧配置文件：字段可选，无需迁移。
- 并发运行：正常请求路径不修改全局环境变量。

本次不修改现有救援调用对环境变量的临时操作；消除该全局状态属于独立的通用可靠性改进，避免扩大 Issue #148 的修复范围。

## 9. 测试设计

### 9.1 单元测试

1. Nemotron 配置包含 `reasoning_effort=none`。
2. `LLMAgentStrategy` 将模型级 reasoning 配置传给客户端工厂。
3. 模型级 `none` 的优先级高于环境变量中的 `medium`。
4. OpenRouter 请求包含 reasoning disabled 和 thinking disabled 参数。
5. 未提供模型级配置时仍沿用环境变量和原默认行为。
6. CommonStack 与 Anthropic 客户端构造行为不变。
7. 现有 provider、leaderboard 和回测测试继续通过。

### 9.2 真实行情复测

固定以下条件：

- 模型：`nvidia/nemotron-3-nano-30b-a3b`；
- integration：OpenRouter；
- 行情：Alpaca DJIA 30 小时线；
- 日期：2026-04-15 至 2026-05-15；
- 初始资金、资产集合和交易模式保持不变。

先跑相同前 16 个决策点，再跑完整 154 个决策点。

## 10. 完成标准

- `no_text_steps=0`；
- `total_retries=0`；
- 有效模型决策覆盖率不低于 95%；
- API 调用次数基本等于决策点数量；
- 生成完整模拟成交记录和回测曲线；
- 不因调用链失败发布规则策略冒充的 Nemotron 曲线；
- 不泄露密钥、完整回复或 reasoning 原文；
- 单元测试和相关回归测试通过。

收益率和排行榜名次只作为修复后的观察结果，不是完成门槛。调用链稳定后，才能继续判断 Nemotron 的真实交易决策质量。

## 11. Issue #148 交付内容

完成复测后，在 Issue #148 提交简短英文总结，包含：

1. 检查了模型 ID、reasoning 配置、响应块、解析、回退和模拟成交链路。
2. 发现 `medium=2048` reasoning 预算与 `max_tokens=2000` 总输出上限冲突。
3. 展示 `stop_reason=max_tokens`、满 2000 输出 token、无 text 块和修复前后重试数字。
4. 说明原曲线包含回退影响，不能单独归因于模型交易能力。
5. 推荐 Nemotron 排行榜配置使用 `reasoning=none`，并附完整窗口复测结果。
