# Roadmap

BeanStack 的上游在一个真实的生产仓库里。那边每轮开发后的复盘会改技能，改动定期导出到这里。下面的计划按「对使用者价值 ÷ 维护成本」排序。

BeanStack's upstream lives in a production repository. Retrospectives there keep changing the skill, and changes are exported here periodically. The plan below is ordered by value to users divided by maintenance cost.

## 版本规则 / Versioning

| 变化 | 版本 |
|---|---|
| 模型清单换代、路由表调整、新增 reference 或脚本参数 | MINOR（0.x → 0.x+1） |
| 措辞、错别字、链接、不改变行为的修订 | PATCH |
| 目录结构、安装方式、模板字段、清单格式不兼容 | 1.0 之前记 MINOR 并在 CHANGELOG 标 **Breaking**；1.0 之后记 MAJOR |

每次发版在 [CHANGELOG.md](CHANGELOG.md) 写 Added / Changed / Removed，模型清单换代要附评测依据。

## v0.2 — 可用性与配套钩子 / Usability & Companion Hooks

- [x] 确定性守卫钩子（`templates/hooks/bash-guard.mjs`）：防绕过门禁、防吞退出码与子代理纪律（Claude / Codex / Grok 共用）
- [x] 回合状态与模式切换钩子（`templates/hooks/round-state.mjs`）：识别「默认 / 均衡 / 省 Claude」与通道开关、落盘用户原始需求、压缩后重注入推进契约、写派工账本、拦截未关验证浏览器与手写 sleep 轮询
- [x] 压缩保真清单（`templates/hooks/compact-instructions.md`）与项目 settings 模板（强制中文 + 技能清单字符预算）
- [x] Claude Code 底部状态栏参考脚本（`templates/statusline/`）与 `install.sh --statusline`
- [x] 前端设计规范补充 Claude Design 原型定稿工作法 + 6 轮模型评测明细表（`docs/model-eval.md`）
- [ ] 英文版技能（`skills/beanstack-en/`），与中文版同源维护
- [ ] 独立需求核对表 CLI 工具（条目的增改、放行、证据登记）
- [ ] `channels.sh --suggest-mode`：按本机检测到的通道建议用哪种模式

## v0.3 — 可复现的评测 / Reproducible evals

- [ ] 开源评测框架：题卡格式、`verify-card`（证明基线红、参考绿）、判卷器、异厂评委、盲评画廊生成
- [ ] 一套不依赖我们业务的公开题集（并发、资金、UI、动效、审查、长文）
- [ ] 新通道：DeepSeek、OpenCode 等，按同一套题定档后再进路由表

## v0.4 — 分发 / Distribution

- [ ] 打包成 Claude Code 插件，一条命令安装技能、子代理和钩子
- [ ] Codex 侧角色定义生成器（从 `templates/agents/` 生成）

## v1.0 — 稳定 / Stable

- [ ] 模型清单与路由表改成结构化数据（JSON / YAML）加生成的 Markdown，格式承诺向后兼容
- [ ] 文档站：按场景（独立开发者、小团队、只有 Claude 订阅）给推荐配置

## 不做 / Non-goals

- 不做 IDE 插件、不做 GUI。BeanStack 是给代理读的工作流，不是一个应用。
- 模型推荐要有评测或长期实战依据；只凭经验的定位在清单里标明「经验判断」。
