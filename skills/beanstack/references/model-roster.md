# 模型清单

唯一写模型 ID 的地方，定档依据在项目的模型评测文档。Claude 子代理写别名，外部通道写当前 ID（以 `scripts/channels.sh --list-models` 为准）。用户点名新版本就改对应行。本机专属事实写 `~/.agents/model-roster.local.md`。启动失败要记录，不声称已调用。

## 1. 角色（Claude 原生子代理）

按「一次做对」选，拿不准 Sonnet high 能否胜任就派 Opus medium。

| 角色 | 定义 | 模型 | 档位 | 做什么 |
|---|---|---|---|---|
| 协调器 | 用户会话 | 常规 Opus medium；大重构、长时间无人值守用 Fable（经验判断） | 会话设置 | 只在阶段之间换 |
| 侦察 | 侦察定义 | `haiku` | `high` | 只读检索、读长文、日志归纳、云端调研；拿不准覆盖为 `sonnet` |
| 执行 | 执行定义 | `sonnet`（小实现、文案初稿覆盖为 `haiku`） | `high` | 规格写清的后端、脚本、测试、小修、前端精准微调 |
| 核心执行 | 核心执行定义 | `opus` | `medium` | 前端；跨模块或要取舍的实现；money、auth、迁移、部署 |
| 设计 | 设计定义 | `opus` | `medium` | 设计简报、规范审查、翻任务书 |
| 复核 | 复核定义 | `opus` | `medium` | 常规与高风险复核 |
| 视觉验收 | 复核定义 | `sonnet` | `medium` | 新页面、整体改版逐路由查规范 |
| 路径验证 | 验证定义 | `sonnet` | `high` | 按用户原话走用户路径 |
| 顾问 | 复核定义 | `fable`（不可用时 `opus`） | `medium` | 关键决策一次性问询 |

- 阶梯：Haiku high → Sonnet high → Opus medium → `fable`（最后一级是经验判断）。不用 Sonnet medium 写代码。先诊断再升级，带上失败证据；已在 high 的换更大模型，不加到 xhigh。
- 覆盖定义时 `model`、`effort` 都写（只传 `model: opus` 会得到 Opus high）。多想少想靠档位，不靠提示词。
- Haiku 的调研结论要核实，侦察题拆窄（单路 10 万 token 内）。
- Sonnet high、Sol 做前端只做规格已定的精准执行，不改字号、间距、组件档位。

## 2. 外部通道

| 通道 | 用途 | 模型 ID | 档位 | 本机需要 |
|---|---|---|---|---|
| Codex（Sol） | 并发、状态机、资金类后端；精确实现；异系复核 | `gpt-6.2-sol` | `xhigh` | `codex` CLI |
| Codex（Astra） | 均衡、省 Claude 下的前端设计、方案、审查；3D 强（经验判断） | `gpt-6.2-astra` | `xhigh` | 同上，额度约 Sol 的 5 倍 |
| Codex 内置子代理 | Codex 做协调器时的子代理，含路径验证 | `gpt-6.2-sol` | `xhigh` | 显式传模型与档位 |
| Grok | 互联网与 X 检索；规格明确的后端；审查第二意见；额度兜底复核 | `grok-4.7-build-fast` | `xhigh` | `grok` CLI；偏慢 |
| Cursor 里的 Grok | 官方 Grok 额度用尽后 | `grok-4.7-xhigh-fast` | 含在 ID 里 | `agent` CLI |
| Claude API | 用户当次说「用 API」时分担额度 | 别名或完整 ID | 显式 `--effort` | `claude` CLI + 密钥，设 `--budget` |
| Gemini Neon | 「Gemini：可用」时前端设计（high）、精准执行（medium） | `gemini-4-neon-high` / `gemini-4-neon-medium` | 含在 ID 里 | `agy` CLI |
| Gemini Hydrogen | 「Gemini：可用」时后端脚本（high）、路径验证（medium） | `gemini-4-hydrogen-high` / `gemini-4-hydrogen-medium` | 含在 ID 里 | 同上 |
| Gemini Argon / Flash | Neon 不可用时回退 / 最后备用只读 | `gemini-4-argon-high` / `gemini-3.8-flash-high` | 含在 ID 里 | 同上 |

- 只在用户点名时用：Cursor 里的其它模型、Devin、agy 里的 Claude、Gemini Carbon、GPT Terra、Luna。
- GPT：默认模式只用 Sol；均衡、省 Claude 下要设计感的派 Astra。用户说「用 / 不用 Astra」以用户为准。Sol 会往仓库写报告，任务书要禁止。外部模型不当协调器；做不好换 Claude，不一路加档。
- Fast（读回合注入）：GPT 用户明确允许才加 `--fast`；Grok 默认 fast，用户说不用时改 `grok-4.7`（Cursor 里 `grok-4.7-xhigh`）；Claude fast 要账号开了额外用量。

## 3. 优先级与额度兜底

- Grok 官方 CLI → Cursor；GPT 走官方 Codex CLI；不走第三方封装。看图交 Claude。
- GPT 或 Claude 额度不够：复核改派 Grok。均衡模式 GPT 用光：后端脚本交 Grok，前端精准执行交 Neon medium，Astra 的活回到 Opus medium。Grok 也不够：只读交 Gemini Flash。

## 4. 路由表

| 任务 | 默认 | 均衡 | 省 Claude |
|---|---|---|---|
| 前端方案、页面、动效 | Opus medium | Opus medium 与 Astra 分担 | Astra |
| 前端精准执行 | Sonnet high | Sol | Sol |
| 跨模块方案设计 | Opus medium | Opus medium 或 Astra | Astra |
| 关键后端（money、auth、迁移、部署） | Opus medium | Opus medium 或 Sol | Sol，协调器读 diff 实测 |
| 并发、状态机、资金类 | Opus medium + Sol 复核 | Sol + Opus medium 复核 | Sol + Astra 或 Grok 复核 |
| 小实现 | Haiku high | Haiku high 或 Sol | Sol |
| 稍需思考的后端、脚本 | Sonnet high | Sol 与 Sonnet high，Grok 可接 | Sol，Grok 可接 |
| 文案 | Haiku high 初稿 | 同左 | Sol |
| 侦察、批量只读 | Haiku high（可多路） | 同左 | 同左，不够时 Grok |
| 互联网调研 | 本机 Grok + Haiku high；云端 Haiku high | 同左 | Grok |
| 路径验证 | Sonnet high | 同左；Gemini 可用时 Hydrogen medium | Grok，不够时 Sonnet high |
| 常规复核 | Opus medium + Haiku high | 同左 | Astra 或 Grok + Haiku high |
| 高风险异系复核 | Opus medium + Sol | Opus medium + Sol 或 Astra | Astra + Grok + 协调器 |

Gemini 可用时只在均衡模式改派：前端设计 Neon high，精准执行 Neon medium，后端脚本 Hydrogen high，路径验证 Hydrogen medium；并发、资金、文案、看图、复核和方案取舍不派 Gemini。
