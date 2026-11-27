# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [SemVer](https://semver.org/)。版本规则见 [ROADMAP.md](ROADMAP.md#版本规则--versioning)。

## [0.2.0] - 2026-11-26

开源配套钩子套件、底部状态栏参考、Claude Design 设计工作法与完整模型实测明细表。

### Added
- `templates/hooks/bash-guard.mjs`（含单测）：PreToolUse(Bash) 确定性守卫（Claude Code / Codex / Grok 共用），拦截直接合并 PR、绕过 git hooks、裸 force push、宽匹配 pkill、管道吞测试退出码，以及子代理专属纪律（不再派代理、不跑全量测试、不手写 sleep 轮询、前台超时 ≤ 290 秒）。
- `templates/hooks/round-state.mjs`（含单测）：Claude Code 全生命周期钩子，自动识别调度模式与通道开关、每次发言提醒按 BeanStack 推进并强制中文输出、落盘用户原话并在压缩/恢复后重注入契约与状态、实时写入子代理派工账本、收尾拦截未关闭的 `playwright-cli` 会话与手写 sleep 等待。
- `templates/hooks/compact-instructions.md`：PreCompact 压缩保真清单。
- `templates/claude-settings.json` 与 `templates/codex-hooks.json`：项目级钩子注册、`"language": "chinese"` 强制中文与 `SLASH_COMMAND_TOOL_CHAR_BUDGET=4000` 模板。
- `templates/statusline/`：Claude Code 底部状态栏脚本（`claude-statusline.sh` 与用户级指路桩 `user-statusline-stub.sh`），实时显示模型档位、10 格上下文与自动压缩线、订阅额度、BeanStack 模式及在途子代理。
- `install.sh` 新增项目级钩子/配置模板安装与 `--statusline` / `--no-hooks` 选项。

### Changed
- `skills/beanstack/SKILL.md`、`references/dispatch.md` 与中英文 README：补充 Claude 宿主下的 **Claude Design** 原型定稿 + `DESIGN.md` token 1:1 还原规范。
- `docs/model-eval.md`：补全原 10 题逐项实测表（含 3D、动效、前端、并发、支付、审查、看图、长文、文案）、人工 UI 盲评表、Gemini 4 Neon / Hydrogen / Orchestrator 轮与 Haiku 5.5 成本拐点表（评测框架代码仍暂留 v0.3）。

## [0.1.0] - 2026-11-26

首个公开版本，内容从上游生产仓库里实际在用的 BeanStack 导出。

### Added
- `skills/beanstack`：工作流技能本体。包括任务分流、开工对齐、探索、提案、先红测试、派工、收货、体验验收、冻结、PR，以及合并、发版、部署的授权规则。
- 11 份 reference：对齐、架构裁决、工程原则、验证与 TDD、形式化验证、派工、任务书开头、模型清单、外部 CLI、进度汇报、讲解。
- `scripts/dispatch.sh`：外部通道启动器，支持 codex、codex-review、grok、cursor、devin、agy、claude-api、cloud。带派工账本，识别额度耗尽和容量不足。
- `scripts/channels.sh`：检测本机 CLI 和版本，汇总派工账本。
- `scripts/usage-report.mjs`、`compact-replay.mjs`：从本机会话日志统计额度构成，回放不同自动压缩阈值下的费用。
- `templates/agents/`：6 个子代理定义（scout、exec、core、design、review、verify）。
- `templates/AGENTS.md`：项目基线模板。
- `install.sh`：安装用户级技能和项目模板。
- `docs/model-eval.md`：6 轮评测摘要。
