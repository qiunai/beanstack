# 外部 CLI

外部模型通过技能目录下的 `scripts/dispatch.sh` 后台启动，用法写在脚本头注释里。实际执行的命令以脚本为准，`DISPATCH_DRY_RUN=1` 时只打印不启动。CLI 升级后参数会变：报参数错误先看该 CLI 的 `--help`，再修启动器和它的测试。

## 启动器约定

- `--model` 必填，从 `model-roster.md` 取；写 `cli-default` 时不向 CLI 传模型参数，由 CLI 自己的默认决定。`--effort` 只在要覆盖 CLI 配置时传。
- `--fast` 只用于 codex / codex-review（追加 `-c service_tier="priority"`）；其它通道的 fast 由模型 ID 决定，传 `--fast` 退出 2。启动行与 `--wait` 摘要会标 `fast=on`，账本 start/end 行有 `fast` 字段。
- 环境变量 `DISPATCH_OUT_DIR` 必填，指向会话 scratchpad 下的目录。
- codex / codex-review 默认不加 `--dangerously-bypass-hook-trust`（非交互时未信任的仓库钩子会被静默跳过）；要让本项目钩子生效，在自己的环境里显式设 `BEANSTACK_CODEX_TRUST_HOOKS=1`（如项目 `.claude/settings.json` 的 `env`），启动器不再按仓库里有没有某个文件来判断。
- 产物：`<任务名>.result.md`、`.stderr`、`.pid`、`.done`。`.done` 内容为 `exit=N`，识别出额度耗尽时加 `reason=quota`，容量不足或过载时加 `reason=capacity`（处理顺序见 `dispatch.md`「额度耗尽」）。
- 启动器立即返回。等待交给 harness 的后台任务通知，或一个有界的等待脚本等 `.done`，不让模型轮询。
- 派工用 `--wait`：启动器阻塞到 `.done` 出现，打印「完成」摘要并以 CLI 的退出码退出（`reason=quota` / `reason=capacity` 会单独打印一行）。把这条命令放进 harness 的后台命令，描述写「<任务> · <模型>/<档位>」，不再另写 until 轮询循环。
- 非零退出先看 `.stderr`；结果文件存在不代表成功。
- 重派前核对同名任务的 pid 和 `.done`，不覆盖还在跑的任务。
- 每路都有 wall-clock 超时（`--timeout`）。
- `scripts/channels.sh` 列出本机装了哪些 CLI、版本、查模型列表的命令；`--ledger` 汇总派工账本。

## 各通道注意事项

| 通道 | 注意 |
|---|---|
| codex | stdin 必须是 EOF；额度耗尽的报错只出现在 stderr；不传 `--effort` 时沿用 `~/.codex/config.toml` 的推理档 |
| codex-review | 固定审查整个分支（相对主干），不是增量；同时设置 `review_model`。主干不是 `origin/main` 时设 `BEANSTACK_BASE_REF` |
| grok | 不和 `-p` 同时用；多路派发时用 `--delay` 错开启动，避免服务端限流 |
| cursor | 用量看最后一条 result |
| devin | 无头模式下 `auto` 与 `accept-edits` 会静默拒绝需要确认的工具调用（`exit=0` 但一行没改，线索只在 `.stderr` 的 `rejected a tool call that requires confirmation`），所以启动器默认 `dangerous`；只读复核放在不含 `.git` 的源码副本目录；写代码的任务书写明不做 git 操作，收货时核对改动范围 |
| agy | `-p=` 必须带等号；每包 ≤10 张图 |
| claude-api | 用独立的 Anthropic API 额度跑无头 `claude -p`，和当前会话的订阅登录互不影响（密钥只 export 给这个子进程）。密钥文件默认 `~/.config/beanstack/claude-api.key`（`chmod 600`，可用 `BEANSTACK_API_KEY_FILE` 改）。和本会话共用 `~/.claude`、仓库规则、技能、子代理定义和钩子，但不带对话上下文，任务书要自包含。`--mode` 默认 `bypassPermissions`；`--budget` 是单任务花费上限（默认 5 美元），`.done` 和账本 end 行带 `cost_usd`。余额耗尽（`Credit balance is too low`）记 `reason=quota`，此后未完成的活改派订阅的原生子代理，不再派 `claude-api` |
| cloud | 本机为主时，把整块独立任务派到 Claude Code 云端会话（`claude --cloud`，在伪终端里执行），不占本机算力；`--model cli-default`（云端默认模型），不支持 `--fast`、`--budget`。派发前 HEAD 必须已推送到 origin（否则退出 2）。云端会话不能回消息，而且只能推平台分配给它的分支，平台还会给分支名加随机后缀（实测形如 `claude/dispatch-<任务名>-cscirz`）：派发时描述以 `dispatch-<任务名>` 开头，任务书末尾自动追加「交付写进 `.dispatch/<任务名>.result.md`，提交推送到你被分配的分支（以 `claude/dispatch-<任务名>` 开头，不同就用平台分配的），不开 PR 不合并」。`--wait` 在 `--timeout` 内每 30 秒用 `git ls-remote 'refs/heads/claude/dispatch-<任务名>*'` 按前缀查分支，只认派发前快照之后新出现的（同前缀旧分支不算，多于一个取第一个并列出全部），实际分支名写进 `<任务名>.branch`，取回到 `<任务名>.result.md`；任务名别互为前缀（如 `a` 与 `a2`），否则会误认对方的分支。超时退出 124（`.done` 为 `exit=124 reason=timeout`，会话链接在 `<任务名>.session`，去网页看）。云端没有本机凭据、仓库外资料和本机服务，任务书要自包含且只依赖仓库内容。收货后由协调器合并或删除该远端分支 |

## cloud 卸载任务书模板

协调器在本机、把耗算力的活卸载到云端时，任务书按下面三种写，每份都自包含。开头一律写：「只做核对与运行，不改产品代码；先 `git checkout <SHA>`（派发时已推送的提交），确认 `git rev-parse HEAD` 等于它；交付用中文」。

- **整包测试**：写明命令（项目的整包测试入口与 `--pkg`）；typecheck 这类单进程大内存的命令在任务书里显式给堆上限（项目规则写明数值）。交付：每条命令的退出码、通过与失败计数、失败用例名和断言原文摘录；环境失败（依赖、浏览器、网络）与测试失败分开写。
- **受影响范围视觉检查**：写明范围参数。交付：结论与失败格摘要；收据文件原样复制到 `.dispatch/<任务名>/` 随结果分支推送，协调器取回后按项目的导入方式放进收据目录。
- **验证位走用户路径**：写明需求条目（原话、要变什么、保持什么、验收画面）、入口与账号档位。交付：逐条判通过 / 不通过 / 云端测不了；证据页由云端会话用 Artifact 工具发布成私有页面，结果文件里写页面链接，协调器把页面链接作为证据记进对应的需求条目。要本机数据或凭据的条目判「云端测不了」，不造替身。

几路同时派时任务名互不为前缀；结论只对写明的 SHA 有效。
