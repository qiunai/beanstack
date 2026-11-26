#!/bin/bash
# 外部模型 CLI 后台启动器（协调器使用；子代理不再派工）。
#
# 用法：
#   dispatch.sh <codex|codex-review|grok|devin|cursor|agy|claude-api|cloud> <任务名> <prompt文件> --model <ID> \
#     [--effort <档位>] [--delay <秒>] [--timeout <秒>] [--mode <权限模式>] [--workdir <目录>] [--budget <美元>] [--fast] [--wait] [--conversation <id>]
#
# 模型没有默认值：从技能的 references/model-roster.md 取 ID 显式传入，缺 --model 退出 2。
# --model cli-default：不向 CLI 传任何模型参数，由 CLI 自己的默认（最新版或本机配置）决定。
#   账本里的 model 写解析后的实际模型（状态栏据此显示）：codex / codex-review 读 ${CODEX_HOME:-~/.codex}/config.toml 顶层的
#   model 与 model_reasoning_effort（--effort 没传时 effort 也取它）；grok 写 grok-cli-default；解析不到写 cli-default。
#   账本另有 model_arg:"cli-default" 保留原始参数；传给 CLI 的参数不变。
# 环境：DISPATCH_OUT_DIR（必填，产物目录，放会话 scratchpad）。
#   BEANSTACK_BASE_REF：codex-review 的比较基线，默认 origin/main；主干不叫 origin/main 时设成自己的（如 origin/master）。
#   BEANSTACK_CODEX_TRUST_HOOKS=1：给 codex / codex-review 加 --dangerously-bypass-hook-trust（见下方说明），默认不加。
# 产物：<任务名>.result.md / .stderr / .pid / .done（内容 exit=N）；codex 另有 .events.jsonl。
# 本脚本默认立即返回；等待交给 harness 后台通知或有界等待脚本，不让模型轮询。
# --fast：只给 codex / codex-review，追加 -c service_tier="priority"（服务档，2 倍速、额度消耗更多）。
#   其它通道的 fast 由模型 ID 决定（如 grok-4.7-build-fast），传 --fast 退出 2。
# --wait：启动后阻塞到 .done 出现（总等待 <= timeout + delay + 60 秒，超时退出 124），打印一行摘要，
#   并以 .done 里的 exit 作为自己的退出码。把带 --wait 的整条命令放进 harness 的后台命令，
#   命令描述写「<任务> · <模型>/<档位>」，界面与完成通知就直接显示谁在干活。
# claude-api：用独立的 Anthropic API 额度起一个无头 `claude -p` 子进程，与当前会话的订阅登录互不影响。
#   密钥从 BEANSTACK_API_KEY_FILE（默认 ~/.config/beanstack/claude-api.key）读取，只在后台子 shell 里 export 给这一个子进程，
#   不进命令行参数、账本和 DRY_RUN 输出；同时去掉会话变量和订阅凭据变量，确保子进程走 API key。
#   --mode 默认 bypassPermissions（仓库钩子照常执行）；--budget 是单任务花费上限（--max-budget-usd，默认 5）。
#   产物多一个 .result.json（CLI 原始输出），.result.md 是其中的 result；.done 与账本 end 行带 cost_usd。
# cloud：把整块独立任务派到 Claude Code 云端会话（本机不占算力）。--model 照常必填，写 cli-default（云端会话默认模型）；
#   传模型 ID 也不会传给 CLI，只记账本。不支持 --fast / --budget。
#   派发前要求 HEAD 已在 origin 的某个分支上（云端从 origin 拿代码），否则退出 2。
#   传给 claude --cloud 的描述以 dispatch-<任务名> 开头（平台据此命名分支，并加随机后缀）；任务书末尾自动追加：把交付写进仓库根
#   .dispatch/<任务名>.result.md，提交并推送到会话被分配的分支（以 claude/dispatch-<任务名> 开头，不同就用平台分配的）；不开 PR、不合并、不改 main。
#   在伪终端里执行 claude --cloud（它要求交互终端；macOS 用 script -q <记录> 命令，Linux 用 script -q -c "命令" <记录>），
#   从记录里解析会话链接写 <任务名>.session（一行 URL）并打印「云端会话：<URL>」；解析不到链接时 .done 写 exit=1，.stderr 留记录内容。
#   不带 --wait：派发后立即返回，没有 .done（任务在云端跑）。云端会话不能回消息，结果靠它推送的分支带回。
#   --wait：在 --timeout 秒内每 30 秒（DISPATCH_CLOUD_POLL 可改，供测试）用 git ls-remote 'refs/heads/claude/dispatch-<任务名>*' 按前缀查分支
#     （派发前先记快照，已存在的同前缀旧分支不算；多于一个新分支取第一个并列出全部），实际分支名写到 <任务名>.branch 并打印，
#     fetch 后从该分支的 .dispatch/<任务名>.result.md 取出结果写到 <任务名>.result.md，.done 写 exit=0；没有结果文件写 exit=1；超时退出 124，
#     .done 写 exit=124 reason=timeout，会话链接仍可去网页看。这是启动器内部的有界等待，不是模型轮询。
#   收货后由协调器合并或删除远端分支。DISPATCH_SCRIPT_FLAVOR=bsd|util-linux 可覆盖伪终端写法（默认按 uname）。
# dispatch.sh --parse-cloud-session <记录文件>：去掉终端控制序列后打印会话链接，找不到退出 1（测试与排障用）。
# DISPATCH_DRY_RUN=1 时只打印将要执行的命令（供测试），不启动进程。
set -euo pipefail

# 整个脚本包在 { } 里：bash 先读完整个块再执行。--wait 会挂几十分钟，期间脚本文件被改，
# 不包的话正在运行的那份会读到改了一半的内容（实测报 unexpected EOF）。
{
usage() {
  echo "usage: dispatch.sh <codex|codex-review|grok|devin|cursor|agy|claude-api|cloud> <name> <prompt-file> --model <id> [--effort e] [--delay s] [--timeout s] [--mode m] [--workdir d] [--budget usd] [--fast] [--wait]" >&2
  exit 2
}

# 伪终端记录里夹着终端控制序列（CSI、OSC 含超链接、回车）：先去掉再匹配链接。
parse_cloud_session() { # <记录文件>
  [[ -f "${1:-}" ]] || return 1
  local url
  url="$(perl -pe 's/\e\[[0-9;?]*[ -\/]*[\@-~]//g; s/\e\][^\a\e]*(?:\a|\e\\)//g; s/\r//g; s/\e//g' "$1" 2>/dev/null \
    | grep -aoE 'https://claude\.ai/code/session_[A-Za-z0-9_]+[^[:space:]]*' | head -n 1 || true)"
  [[ -n "$url" ]] || return 1
  printf '%s\n' "$url"
}
if [[ "${1:-}" == --parse-cloud-session ]]; then
  parse_cloud_session "${2:-}"; exit $?
fi

[[ $# -ge 3 ]] || usage
kind="$1"; name="$2"; prompt="$3"; shift 3
model=""; effort=""; delay=0; timeout=3000; mode=""; workdir="$PWD"; wait_done=0; fast=0; budget=""
conversation=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) model="${2:-}"; shift 2 ;;
    --effort) effort="${2:-}"; shift 2 ;;
    --delay) delay="${2:-}"; shift 2 ;;
    --timeout) timeout="${2:-}"; shift 2 ;;
    --mode) mode="${2:-}"; shift 2 ;;
    --workdir) workdir="${2:-}"; shift 2 ;;
    --budget) budget="${2:-}"; shift 2 ;;
    --fast) fast=1; shift ;;
    --wait) wait_done=1; shift ;;
    --conversation) conversation="${2:-}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[[ -n "$model" ]] || { echo "--model is required (read references/model-roster.md of the beanstack skill; use cli-default for the CLI's own default)" >&2; exit 2; }
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "name must match [A-Za-z0-9._-]+" >&2; exit 2; }
[[ -f "$prompt" ]] || { echo "prompt file missing: $prompt" >&2; exit 2; }
[[ "$delay" =~ ^[0-9]+$ && "$timeout" =~ ^[0-9]+$ ]] || { echo "delay/timeout must be integers" >&2; exit 2; }
out="${DISPATCH_OUT_DIR:-}"
[[ -n "$out" ]] || { echo "set DISPATCH_OUT_DIR to the session scratchpad" >&2; exit 2; }
if [[ -n "$budget" && "$kind" != claude-api ]]; then echo "--budget 只用于 claude-api" >&2; exit 2; fi
api_key_file=""
if [[ "$kind" == claude-api ]]; then
  budget="${budget:-5}"
  [[ "$budget" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "--budget must be a dollar amount" >&2; exit 2; }
  api_key_file="${BEANSTACK_API_KEY_FILE:-${HOME:-}/.config/beanstack/claude-api.key}"
  if [[ ! -s "$api_key_file" || -z "$(tr -d '[:space:]' < "$api_key_file")" ]]; then
    echo "claude-api 需要 API key：把 key 写进 ${api_key_file}（chmod 600），或用 BEANSTACK_API_KEY_FILE 指定" >&2; exit 2
  fi
fi

# 账本里的模型与档位：cli-default 时写解析后的实际值（只影响账本，不影响传给 CLI 的参数）。
ledger_model="$model"; ledger_effort="$effort"; model_arg=""
toml_top() { # <文件> <键>：只读第一个 [段] 之前的顶层字符串值
  awk -v k="$2" '/^[[:space:]]*\[/ {exit} $0 ~ "^[[:space:]]*" k "[[:space:]]*=" {sub(/^[^=]*=[[:space:]]*/, ""); sub(/[[:space:]]*#.*$/, ""); gsub(/^"|"$/, ""); print; exit}' "$1" 2>/dev/null || true
}
if [[ "$model" == cli-default ]]; then
  model_arg=cli-default
  case "$kind" in
    codex|codex-review)
      cfg="${CODEX_HOME:-${HOME:-}/.codex}/config.toml"
      if [[ -f "$cfg" ]]; then
        resolved_model="$(toml_top "$cfg" model)"
        [[ -z "$resolved_model" ]] || ledger_model="$resolved_model"
        [[ -n "$effort" ]] || ledger_effort="$(toml_top "$cfg" model_reasoning_effort)"
      fi ;;
    grok) ledger_model=grok-cli-default ;;
  esac
fi

# m_flag <flag>：显式模型时输出 "<flag> <model>"，cli-default 时什么都不输出。
m_args=()
m_flag() { m_args=(); [[ "$model" == cli-default ]] || m_args=("$1" "$model"); }

# 没传 --effort 就不带任何推理档参数，让 CLI 用自己的配置（如 ~/.codex/config.toml）。
effort_args=()
[[ -z "$effort" ]] || effort_args=(-c "model_reasoning_effort=\"$effort\"")

# --fast 只对 codex 系有意义（服务档）；其它通道的 fast 写在模型 ID 里。
fast_args=()
if [[ $fast -eq 1 ]]; then
  case "$kind" in
    codex|codex-review) fast_args=(-c 'service_tier="priority"') ;;
    cloud) echo "--fast 不支持 cloud：云端会话用自己的默认模型与服务档" >&2; exit 2 ;;
    *) echo "--fast 只用于 codex / codex-review；$kind 的 fast 由模型 ID 决定，请改用对应的 fast 模型 ID（见 model-roster.md）" >&2; exit 2 ;;
  esac
fi

cmd=()
stdout_file="$out/$name.result.md"
# codex exec 默认要求逐条信任钩子（仓库 .codex/hooks.json 与用户级配置），非交互模式下没信任的钩子被静默跳过，
# 仓库里的守卫钩子就不生效。--dangerously-bypass-hook-trust 让本次调用执行该仓库和用户级的全部已启用钩子，
# 等于替人确认了信任；任何仓库都能放一个文件冒充「受信」，所以不靠仓库内容判断，只在调用方显式设
# BEANSTACK_CODEX_TRUST_HOOKS=1（如写进自己项目 .claude/settings.json 的 env）时才加，默认不加。
hook_trust_args=()
[[ "${BEANSTACK_CODEX_TRUST_HOOKS:-}" != 1 ]] || hook_trust_args=(--dangerously-bypass-hook-trust)
case "$kind" in
  codex)
    m_flag -m
    cmd=(codex exec ${m_args[@]+"${m_args[@]}"} ${effort_args[@]+"${effort_args[@]}"} ${fast_args[@]+"${fast_args[@]}"} ${hook_trust_args[@]+"${hook_trust_args[@]}"} --sandbox workspace-write --json
      -o "$out/$name.result.md" "$(cat "$prompt")")
    stdout_file="$out/$name.events.jsonl" ;;
  codex-review)
    m_flag -m
    review_args=()
    [[ "$model" == cli-default ]] || review_args=(-c "review_model=\"$model\"")
    cmd=(codex exec ${m_args[@]+"${m_args[@]}"} ${effort_args[@]+"${effort_args[@]}"} ${fast_args[@]+"${fast_args[@]}"} ${hook_trust_args[@]+"${hook_trust_args[@]}"} ${review_args[@]+"${review_args[@]}"}
      -c "developer_instructions=$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8")))' "$prompt")"
      --sandbox read-only --json -o "$out/$name.result.md" review --base "${BEANSTACK_BASE_REF:-origin/main}")
    stdout_file="$out/$name.events.jsonl" ;;
  grok)
    m_flag -m
    cmd=(grok --prompt-file "$prompt" ${m_args[@]+"${m_args[@]}"} --always-approve --output-format plain)
    [[ -n "$effort" ]] && cmd+=(--reasoning-effort "$effort") ;;
  devin)
    # 无头模式下 accept-edits/auto 会静默拒绝需确认的工具调用（exit=0 但零改动），默认 dangerous。
    m_flag --model
    cmd=(devin --respect-workspace-trust false ${m_args[@]+"${m_args[@]}"} --permission-mode "${mode:-dangerous}" --prompt-file "$prompt" -p) ;;
  cursor)
    m_flag --model
    cmd=(agent -p --output-format json ${m_args[@]+"${m_args[@]}"} --trust --force --workspace "$workdir" "$(cat "$prompt")") ;;
  claude-api)
    m_flag --model
    cmd=(claude -p ${m_args[@]+"${m_args[@]}"} --output-format json --permission-mode "${mode:-bypassPermissions}" --max-budget-usd "$budget")
    [[ -n "$effort" ]] && cmd+=(--effort "$effort")
    cmd+=("$(cat "$prompt")")
    stdout_file="$out/$name.result.json" ;;
  cloud)
    # 云端会话不能回消息：交付靠它推送的分支带回，任务书末尾固定追加这条约定。
    cloud_prefix="claude/dispatch-$name"
    cloud_rec="$out/$name.cloud-record.txt"
    # 描述以 dispatch-<任务名> 开头，平台据此给云端会话的分支命名（并加随机后缀）。
    cloud_prompt="dispatch-$name

$(cat "$prompt")

---

## 云端交付要求（启动器自动追加）

- 完成后把交付（结论、改动文件、命令与退出码、真实阻塞）写进仓库根 \`.dispatch/$name.result.md\`，提交并推送到你这个会话被分配的分支（分支名以 \`$cloud_prefix\` 开头；如果平台给你的分支名不同，就用平台分配的）。
- 不开 PR，不合并，不改 main。"
    cloud_flavor="${DISPATCH_SCRIPT_FLAVOR:-}"
    [[ -n "$cloud_flavor" ]] || { if [[ "$(uname)" == Darwin ]]; then cloud_flavor=bsd; else cloud_flavor=util-linux; fi; }
    case "$cloud_flavor" in
      bsd) cmd=(script -q "$cloud_rec" claude --cloud "$cloud_prompt") ;;
      util-linux) cmd=(script -q -c "$(printf '%q ' claude --cloud "$cloud_prompt")" "$cloud_rec") ;;
      *) echo "DISPATCH_SCRIPT_FLAVOR 只能是 bsd 或 util-linux" >&2; exit 2 ;;
    esac ;;
  agy)
    m_flag --model
    # 打印超时跟 --timeout 走（比外层 alarm 早 60 秒，留出写 .done 的时间）；写死 30m 会把长任务截成半截。
    agy_print_timeout=$(( timeout > 120 ? timeout - 60 : timeout ))
    cmd=(agy --output-format json ${m_args[@]+"${m_args[@]}"} --dangerously-skip-permissions --print-timeout "${agy_print_timeout}s")
    [[ -z "$conversation" ]] || cmd+=(--conversation "$conversation")
    cmd+=("-p=$(cat "$prompt")") ;;
  *)
    echo "unknown channel: $kind" >&2; exit 2 ;;
esac

# 外部 CLI 不继承 CLAUDECODE：grok、agent、devin、agy 等会把它透给自己的子进程，误触发项目里的 Claude Code 钩子。
unset_args=(-u CLAUDECODE)
# claude-api 的子进程要像新开的终端：去掉本会话的标识变量，去掉会盖过 API key 的订阅凭据变量。
[[ "$kind" != claude-api ]] || for v in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION \
  CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SESSION_ATTENDED \
  CLAUDE_CODE_ENTRYPOINT CLAUDE_PID CLAUDE_EFFORT; do unset_args+=(-u "$v"); done
cmd=(env "${unset_args[@]}" "${cmd[@]}")

if [[ "${DISPATCH_DRY_RUN:-}" == 1 ]]; then
  printf '%s\n' "${cmd[@]}"
  [[ "$kind" != cloud ]] || printf '%s\n' "git -C $workdir ls-remote origin refs/heads/${cloud_prefix}*"
  exit 0
fi

if [[ "$kind" == cloud ]]; then
  # 云端从 origin 拿代码：HEAD 不在任何远端分支上，云端会话看不到这次提交。
  cloud_head="$(git -C "$workdir" rev-parse --verify -q HEAD 2>/dev/null || true)"
  if [[ -z "$cloud_head" || -z "$(git -C "$workdir" branch -r --contains "$cloud_head" 2>/dev/null || true)" ]]; then
    echo "cloud 要求 HEAD 已在 origin 的某个分支上：先推送当前分支再派发（workdir=${workdir}）" >&2; exit 2
  fi
fi

mkdir -p "$out"
# .done 一律先写同目录临时文件再 mv：rename 在同一文件系统上是原子的，--wait 与测试一看到 .done 就读，
# 不会读到空文件（高负载下实测过：空串 -> 退出码解析失败按 1、reason=quota 丢失）。
write_done() { # <内容，不含换行>
  local tmp="$out/$name.done.tmp.$$"
  printf '%s\n' "$1" > "$tmp" && mv -f "$tmp" "$out/$name.done"
}
if [[ -f "$out/$name.pid" && ! -f "$out/$name.done" ]] && kill -0 "$(cat "$out/$name.pid")" 2>/dev/null; then
  echo "task $name is still running (pid $(cat "$out/$name.pid")); pick another name" >&2
  exit 2
fi
rm -f "$out/$name.done" "$out/$name.done".tmp.*

# 失败原因分类（只在退出码非 0 时做）：先 quota，再 capacity，都不中则无 reason。
# 只扫「错误文本」：.stderr，以及 codex 事件流里 type 为 error / turn.failed 的事件。
# 不扫 .result.md、command_execution、agent_message：复核者 cat 源码或日志时，里面的样例文字会被误判（真实事故：额度样例文字使 at capacity 被判成 quota）。
# 真实样例：codex 的 "You've hit your usage limit" 与 usage_limit_reached 来自任务书给出的报错样例；"Selected model is at capacity" 来自真实事件流。
# 推测：grok / 其他通道没有拿到真实报错；quota 正则只保留明确的限额措辞（不再匹配孤立的 quota / rate limit 字样），仍可能漏报或偶发误报，误报只会让协调器多换一次通道。
quota_re() {
  case "$1" in
    codex|codex-review) echo "usage[ _]limit|hit your usage|usage_limit_reached|insufficient_quota|exceeded your (current )?quota" ;;
    # API 余额耗尽：Anthropic 返回 "Credit balance is too low"（无头 claude 写在结果 JSON 的 is_error 文本里）。
    claude-api) echo "credit balance( is)? too low|rate[ _-]?limit(ed| exceeded| reached)|too many requests|(^|[^0-9])429([^0-9]|$)" ;;
    *) echo "rate[ _-]?limit(ed| exceeded| reached)|too many requests|usage[ _]limit|insufficient[ _]quota|(exceeded|exhausted|out of|hit)( your| the| current)* quota|quota (exceeded|exhausted|reached)|(^|[^0-9])429([^0-9]|$)|resource[ _]exhausted" ;;
  esac
}
capacity_re='at capacity|overloaded|server is busy|temporarily unavailable|service unavailable|(^|[^0-9])(503|529)([^0-9]|$)'

# 输出供分类用的错误文本：.stderr；codex 通道再加事件流里 error / turn.failed 事件的 message。
# 事件流逐行解析，坏行跳过；node 不可用或解析整体失败时只剩 .stderr，不退回扫全文。
error_text() { # <kind> <out> <name>
  cat "$2/$3.stderr" 2>/dev/null || true
  case "$1" in
    codex|codex-review)
      [[ -f "$2/$3.events.jsonl" ]] && node -e '
        const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
        for (const l of lines) {
          let e; try { e = JSON.parse(l); } catch { continue; }
          if (!e || (e.type !== "error" && e.type !== "turn.failed")) continue;
          const m = e.message ?? e.error?.message ?? (typeof e.error === "string" ? e.error : "");
          if (typeof m === "string" && m) console.log(m);
        }' "$2/$3.events.jsonl" 2>/dev/null || true ;;
    claude-api)
      [[ -f "$2/$3.result.json" ]] && node -e '
        try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          if (r && r.is_error && typeof r.result === "string") console.log(r.result); } catch {}' "$2/$3.result.json" 2>/dev/null || true ;;
  esac
}

# 账本：BEANSTACK_LEDGER，否则 <git 顶层>/.claude/state/dispatch-ledger.jsonl，取不到顶层时落到产物目录。
ledger="${BEANSTACK_LEDGER:-}"
if [[ -z "$ledger" ]]; then
  top="$(git -C "$workdir" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$top" ]]; then ledger="$top/.claude/state/dispatch-ledger.jsonl"; else ledger="$out/dispatch-ledger.jsonl"; fi
fi
mkdir -p "$(dirname "$ledger")"

json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
fast_json=false
[[ $fast -eq 0 ]] || fast_json=true
effort_json=null
[[ -z "$ledger_effort" ]] || effort_json="\"$(json_str "$ledger_effort")\""
model_arg_json=""
[[ -z "$model_arg" ]] || model_arg_json=",\"model_arg\":\"$(json_str "$model_arg")\""
ledger_row() { # <event> <exit|null> <reason|null> [cost_usd]
  local reason_json=null cost_json=""
  [[ "$3" == null ]] || reason_json="\"$3\""
  [[ -z "${4:-}" ]] || cost_json=",\"cost_usd\":$4"
  printf '{"ts":"%s","source":"dispatch","event":"%s","channel":"%s","task":"%s","model":"%s","effort":%s,"fast":%s,"exit":%s,"reason":%s%s%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$kind" "$name" "$(json_str "$ledger_model")" "$effort_json" "$fast_json" "$2" "$reason_json" "$model_arg_json" "$cost_json" >> "$ledger"
}

ledger_row start null null

if [[ "$kind" == cloud ]]; then
  rm -f "$out/$name.session" "$out/$name.branch" "$out/$name.result.md" "$cloud_rec"
  # 平台会给云端会话的分支名加随机后缀，所以按前缀找；派发前先记下已有的同前缀分支，只认之后新出现的。
  cloud_remote_branches() {
    git -C "$workdir" ls-remote origin "refs/heads/${cloud_prefix}*" 2>/dev/null | awk '{sub(/^refs\/heads\//, "", $2); print $2}' | sort || true
  }
  cloud_old="$(cloud_remote_branches)"
  cloud_new_branches() {
    local b
    while IFS= read -r b; do
      [[ -n "$b" ]] || continue
      grep -qxF -- "$b" <<<"$cloud_old" || printf '%s\n' "$b"
    done <<<"$(cloud_remote_branches)"
  }
  sleep "$delay"
  # claude --cloud 建好会话就返回，120 秒还没返回按失败处理。
  (cd "$workdir" && perl -e 'alarm shift; exec @ARGV' 120 "${cmd[@]}" </dev/null >/dev/null 2>&1) || true
  cloud_url="$(parse_cloud_session "$cloud_rec" || true)"
  if [[ -z "$cloud_url" ]]; then
    { cat "$cloud_rec" 2>/dev/null || echo "claude --cloud 没有产生记录文件"; } > "$out/$name.stderr"
    echo "[dispatch] cloud $name 派发失败：记录里没有会话链接，见 $out/$name.stderr" >&2
    ledger_row end 1 null
    write_done "exit=1"
    exit 1
  fi
  printf '%s\n' "$cloud_url" > "$out/$name.session"
  echo "云端会话：$cloud_url"
  if [[ $wait_done -eq 0 ]]; then
    echo "[dispatch] cloud $name 已派发，结果会推送到 origin 上以 ${cloud_prefix} 开头的新分支（平台会加随机后缀）。没带 --wait，不会自动取回：用 git ls-remote origin 'refs/heads/${cloud_prefix}*' 找到分支，git fetch 后 git show FETCH_HEAD:.dispatch/$name.result.md"
    exit 0
  fi
  echo "$$" > "$out/$name.pid"
  poll="${DISPATCH_CLOUD_POLL:-30}"
  deadline=$(( SECONDS + timeout ))
  until cloud_found_all="$(cloud_new_branches)"; [[ -n "$cloud_found_all" ]]; do
    remaining=$(( deadline - SECONDS ))
    if (( remaining <= 0 )); then
      echo "[dispatch] cloud $name 等待超过 --timeout ${timeout}s，前缀 ${cloud_prefix} 的新分支还没出现；会话仍在云端跑，去网页看：$cloud_url" >&2
      ledger_row end 124 timeout
      write_done "exit=124 reason=timeout"
      exit 124
    fi
    sleep $(( remaining < poll ? remaining : poll ))
  done
  cloud_branch="$(head -n 1 <<<"$cloud_found_all")"
  printf '%s\n' "$cloud_branch" > "$out/$name.branch"
  echo "云端分支：$cloud_branch"
  [[ "$(wc -l <<<"$cloud_found_all")" -le 1 ]] || echo "[dispatch] cloud $name 出现了多个新分支，取第一个；全部：$(tr '\n' ' ' <<<"$cloud_found_all")"
  code=0
  if git -C "$workdir" fetch -q origin "$cloud_branch" 2>"$out/$name.stderr" \
    && git -C "$workdir" show "FETCH_HEAD:.dispatch/$name.result.md" > "$out/$name.result.md" 2>>"$out/$name.stderr"; then
    echo "[dispatch] cloud $name 完成：exit=0 结果：$out/$name.result.md 分支：origin/$cloud_branch 会话：$cloud_url"
  else
    rm -f "$out/$name.result.md"
    echo "[dispatch] cloud $name 分支已出现但取不到 .dispatch/$name.result.md（见 $out/$name.stderr）；会话：$cloud_url" >&2
    code=1
  fi
  ledger_row end "$code" null
  write_done "exit=$code"
  exit "$code"
fi

# 整个后台子 shell 与调用方的 stdout/stderr/stdin 断开，调用方接管道（| tail）时启动器也能立刻返回；
# 内部命令自己的重定向保持不变。
(
  # 被信号终止时也要留下 .done，等待方才不会永远挂着。
  trap 'rc=$?; [[ -f "$out/$name.done" ]] || write_done "exit=$rc"' EXIT
  status=0
  sleep "$delay"
  cd "$workdir"
  [[ -z "$api_key_file" ]] || export ANTHROPIC_API_KEY="$(tr -d '[:space:]' < "$api_key_file")"
  perl -e 'alarm shift; exec @ARGV' "$timeout" "${cmd[@]}" </dev/null > "$stdout_file" 2> "$out/$name.stderr" || status=$?
  unset ANTHROPIC_API_KEY
  cost=""
  if [[ "$kind" == claude-api ]]; then
    # 从 CLI 的 JSON 输出取正文与花费；解析失败时 result.md 为空、不记花费。
    cost="$(node -e '
      const fs = require("fs");
      let r = {}; try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
      fs.writeFileSync(process.argv[2], typeof r.result === "string" ? r.result + "\n" : "");
      if (typeof r.total_cost_usd === "number") process.stdout.write(String(r.total_cost_usd));' "$stdout_file" "$out/$name.result.md" 2>/dev/null || true)"
  fi
  cost_note=""
  [[ -z "$cost" ]] || cost_note=" cost_usd=$cost"
  reason=""
  if [[ $status -ne 0 ]]; then
    err="$(error_text "$kind" "$out" "$name")"
    if grep -qiE -- "$(quota_re "$kind")" <<<"$err"; then reason=quota
    elif grep -qiE -- "$capacity_re" <<<"$err"; then reason=capacity; fi
  fi
  if [[ -n "$reason" ]]; then
    ledger_row end "$status" "$reason" "$cost"
    write_done "exit=$status reason=$reason$cost_note"
  else
    ledger_row end "$status" null "$cost"
    write_done "exit=$status$cost_note"
  fi
) </dev/null >/dev/null 2>&1 &

echo "$!" > "$out/$name.pid"
eff_label="${effort:-cli-default}"
[[ $fast -eq 0 ]] || eff_label="$eff_label fast=on"
echo "[dispatch] $kind $name model=$model effort=$eff_label pid=$(cat "$out/$name.pid") delay=${delay}s timeout=${timeout}s -> $out/$name.{result.md,stderr,done}"

[[ $wait_done -eq 1 ]] || exit 0

# --wait：轮询 .done，要求存在且非空（写入端已是原子 mv，这里再防一道）。DISPATCH_WAIT_GRACE 仅供测试缩短宽限。
grace="${DISPATCH_WAIT_GRACE:-60}"
deadline=$(( SECONDS + timeout + delay + grace ))
until [[ -s "$out/$name.done" ]]; do
  if (( SECONDS >= deadline )); then
    echo "[dispatch] $kind $name model=$model effort=$eff_label 等待超时：超过 --timeout ${timeout}s + 宽限 ${grace}s 仍无 .done，任务可能卡住（pid $(cat "$out/$name.pid")）" >&2
    exit 124
  fi
  sleep 0.5
done
done_text="$(cat "$out/$name.done")"
echo "[dispatch] $kind $name model=$model effort=$eff_label 完成：$done_text 结果：$out/$name.result.md"
[[ "$done_text" != *reason=quota* ]] || echo "reason=quota"
[[ "$done_text" != *reason=capacity* ]] || echo "reason=capacity"
code="${done_text#exit=}"; code="${code%% *}"
[[ "$code" =~ ^[0-9]+$ ]] || code=1
exit "$code"
}
