# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 [SemVer](https://semver.org/)。版本规则见 [ROADMAP.md](ROADMAP.md#版本规则--versioning)。

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
