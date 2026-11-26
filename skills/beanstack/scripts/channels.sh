#!/bin/bash
# 本机通道自检：列出技能 references/model-roster.md 里各外部通道的 CLI 是否安装、版本、配置文件、查模型列表的命令。
# 只读：不调用模型、不改配置。CLI 在不等于模型可用；首次真实调用的结果另行记录。
# 用法：channels.sh [--list-models]   加 --list-models 时顺带执行各 CLI 的模型列表命令（可能联网）。
#       channels.sh --ledger [文件] [--all | --since <ISO 时间|today>]   汇总派工账本（默认 BEANSTACK_LEDGER 或 <仓库顶层>/.claude/state/dispatch-ledger.jsonl）。
#         默认只统计本轮（round.json 的 roundStart 之后；round.json 在 BEANSTACK_STATE_DIR，未设则与账本同目录）；
#         roundStart 缺失或早于 2020 年视为无效，忽略并统计全部。--all 统计全部；--since 手动指定起点（today = 本地当天零点），不能与 --all 同用。
set -uo pipefail

if [[ "${1:-}" == "--ledger" ]]; then
  shift
  f=""; all=0; since_arg=""; has_since=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all) all=1 ;;
      --since=*) has_since=1; since_arg="${1#--since=}" ;;
      --since)
        has_since=1
        if [[ $# -lt 2 || "$2" == --* ]]; then echo "--since 需要一个值：ISO 时间或 today" >&2; exit 2; fi
        since_arg="$2"; shift ;;
      *) f="$1" ;;
    esac
    shift
  done
  if [[ $all == 1 && $has_since == 1 ]]; then echo "--all 与 --since 不能同用" >&2; exit 2; fi
  [[ -n "$f" ]] || f="${BEANSTACK_LEDGER:-}"
  if [[ -z "$f" ]]; then
    top="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
    f="${top:-.}/.claude/state/dispatch-ledger.jsonl"
  fi
  [[ -f "$f" ]] || { echo "账本不存在：$f" >&2; exit 1; }
  # 默认只统计本轮：从账本同目录 round.json 的 roundStart 起；--all 统计全部。
  round_file=""
  if [[ $all == 0 && $has_since == 0 ]]; then
    if [[ -n "${BEANSTACK_STATE_DIR:-}" ]]; then
      case "$BEANSTACK_STATE_DIR" in
        /*) round_file="$BEANSTACK_STATE_DIR/round.json" ;;
        *) round_file="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || echo .)/$BEANSTACK_STATE_DIR/round.json" ;;
      esac
    else
      round_file="$(dirname "$f")/round.json"
    fi
  fi
  exec node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
let since = null, scope = "全部";
const sinceArg = process.argv[3];
if (sinceArg) {
  const t = sinceArg === "today" ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : Date.parse(sinceArg);
  if (Number.isNaN(t)) { console.error("--since 无法解析：" + sinceArg + "（用 ISO 时间如 2026-10-01T08:00:00Z，或 today）"); process.exit(2); }
  since = t;
  scope = "自 " + new Date(t).toISOString() + "（--since）";
} else if (process.argv[2]) {
  let rs;
  try { rs = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).roundStart; } catch {}
  const t = typeof rs === "string" ? Date.parse(rs) : NaN;
  if (t >= Date.parse("2020-01-01T00:00:00Z")) { since = t; scope = "本轮（自 " + new Date(t).toISOString() + "）"; }
  else if (rs !== undefined) scope = "全部（round.json 的 roundStart 无效，已忽略；可用 --since 指定起点）";
}
console.log("统计范围：" + scope);
const groups = new Map(); let bad = 0, quota = 0;
for (const l of lines) {
  let r; try { r = JSON.parse(l); } catch { bad++; continue; }
  if (!r || typeof r !== "object") { bad++; continue; }
  if (since !== null && typeof r.ts === "string" && Date.parse(r.ts) < since) continue;
  if (r.event === "end") { if (r.reason === "quota") quota++; continue; }
  if (r.event !== "start") { bad++; continue; }
  const who = r.source === "dispatch" ? r.channel : r.role;
  const key = [r.source ?? "?", who ?? "?", r.model ?? "?", r.effort ?? "-"].join("\t");
  groups.set(key, (groups.get(key) ?? 0) + 1);
}
const wd = (s) => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
const rows = [["来源", "角色/通道", "模型", "档位", "次数"], ...[...groups].sort().map(([k, n]) => [...k.split("\t"), String(n)])];
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => wd(r[i]))));
for (const r of rows) console.log(r.map((c, i) => c + " ".repeat(w[i] - wd(c))).join("  ").trimEnd());
console.log("\n额度耗尽 " + quota);
console.log("跳过坏行 " + bad);
' "$f" "$round_file" "$since_arg"
fi

list_models=0
[[ "${1:-}" == "--list-models" ]] && list_models=1

# 通道｜CLI｜版本参数｜模型列表命令｜本机配置
rows=(
  "codex|codex|--version|cat ~/.codex/models_cache.json|~/.codex/config.toml"
  "grok|grok|--version|grok models|~/.grok/"
  "devin|devin|--version|devin models list|待核实"
  "cursor|agent|--version|agent --list-models|~/.cursor/"
  "agy|agy|--version|agy models|待核实"
)

printf '%-8s %-6s %-28s %-30s %s\n' 通道 状态 版本 模型列表命令 本机配置
for row in "${rows[@]}"; do
  IFS='|' read -r channel bin vflag lscmd conf <<<"$row"
  if command -v "$bin" >/dev/null 2>&1; then
    ver="$("$bin" "$vflag" 2>/dev/null | head -1 | cut -c1-28)"
    state="有"
  else
    ver="-"; state="缺"
  fi
  if [[ "$conf" != 待核实 ]]; then
    conf_path="${conf/#\~/$HOME}"
    [[ -e "$conf_path" ]] || conf="$conf（不存在）"
  fi
  printf '%-8s %-6s %-28s %-30s %s\n' "$channel" "$state" "${ver:--}" "$lscmd" "$conf"
done

local_roster="$HOME/.agents/model-roster.local.md"
echo
if [[ -f "$local_roster" ]]; then echo "本机覆盖：$local_roster"; else echo "本机覆盖：无（需要时创建 ~/.agents/model-roster.local.md）"; fi

if [[ $list_models == 1 ]]; then
  for row in "${rows[@]}"; do
    IFS='|' read -r channel bin _ lscmd _ <<<"$row"
    command -v "$bin" >/dev/null 2>&1 || continue
    echo; echo "== $channel: $lscmd"
    bash -c "$lscmd" 2>&1 | head -40
  done
fi
