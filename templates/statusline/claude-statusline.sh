#!/bin/bash
# Claude Code 底部状态栏（本机执行，不耗 token；依赖 jq）。
# 一行灰色，按决策价值从左到右：
#   模型 · 档位 | 上下文 10 格进度条（│ 标出 autoCompactWindow 自动压缩线） | 订阅额度 5h/7d（≥50% 显示） | BeanStack 模式与开关 | 外部派工 | 子代理
# 读取：stdin 的 JSON；<git 顶层>/.claude/state/round.json 与 dispatch-ledger.jsonl（由 round-state.mjs 与 dispatch.sh 写入）。
# 安装方式：运行 install.sh --statusline，并在 ~/.claude/settings.json 加入：
#   "statusLine": { "type": "command", "command": "bash ~/.claude/statusline.sh", "refreshInterval": 5 },
#   "autoCompactWindow": 400000
command -v jq >/dev/null 2>&1 || exit 0
input=$(cat)
DIM=$'\033[2m'; RST=$'\033[0m'
SEP="${DIM}  ${RST}"
US=$'\x1f'

tok() {
  if [ "$1" -ge 1000000 ] && [ $(( $1 % 1000000 )) -eq 0 ]; then
    echo "$(( $1 / 1000000 ))M"
  else
    echo "$(( $1 / 1000 ))K"
  fi
}

# 重置时间在 jq 内按本地时区格式化，macOS 与 Linux 一致。
IFS="$US" read -r model effort used size dir p5 r5at p7 r7at < <(printf '%s' "$input" | jq -r '
  def reset: if type == "number" then (if . - now > 72000 then strflocaltime("%m/%d %H:%M") else strflocaltime("%H:%M") end) else "" end;
  [ (.model.display_name // "?"), (.effort.level // ""),
    ((.context_window.current_usage // {}) | ((.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)) | tostring),
    (.context_window.context_window_size // (if ((.model.id // "") + (.model.display_name // "") | test("haiku"; "i")) then 200000 else 1000000 end) | tostring),
    (.workspace.current_dir // .cwd // ""),
    (.rate_limits.five_hour.used_percentage // "" | if . == "" then "" else floor | tostring end), (.rate_limits.five_hour.resets_at | reset),
    (.rate_limits.seven_day.used_percentage // "" | if . == "" then "" else floor | tostring end), (.rate_limits.seven_day.resets_at | reset)
  ] | join("\u001f")' 2>/dev/null)
compact=$(jq -r '.autoCompactWindow // empty' ~/.claude/settings.json 2>/dev/null)
model=$(printf '%s' "${model:-?}" | sed -E 's/ *\([^)]*context\)//')
seg_model="${DIM}${model}${effort:+ · $effort}${RST}"

[ -n "$used" ] || used=0
[ -n "$size" ] || size=1000000
mark=0
if [ -n "$compact" ] && [ "$compact" -lt "$size" ] 2>/dev/null; then
  mark=$(( (compact * 10 + size / 2) / size ))
fi
filled=$(( (used * 10 + size / 2) / size ))
[ "$filled" -gt 10 ] && filled=10
bar=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  if [ "$i" -le "$filled" ]; then bar="${bar}▰"; else bar="${bar}▱"; fi
  [ "$i" -eq "$mark" ] && bar="${bar}│"
done
seg_ctx="${DIM}${bar} $(tok "$used")/$(tok "$size")${RST}"

rate_seg() {
  local p="$2" r="$3" extra=""
  [ -n "$p" ] && [ "$p" -ge 50 ] || return
  [ "$p" -ge 80 ] && [ -n "$r" ] && extra=" 至${r}"
  printf '%s%s %s%%%s%s' "$DIM" "$1" "$p" "$extra" "$RST"
}
r5=$(rate_seg 5h "$p5" "$r5at")
r7=$(rate_seg 7d "$p7" "$r7at")
seg_rate="${r5}${r5:+${r7:+${DIM} · ${RST}}}${r7}"

out="${seg_model}${SEP}${seg_ctx}"
[ -n "$seg_rate" ] && out="${out}${SEP}${seg_rate}"

top=$([ -n "$dir" ] && git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
state="$top/.claude/state/round.json"
if [ -n "$top" ] && { [ -f "$state" ] || [ -f "$top/.claude/hooks/round-state.mjs" ]; }; then
  mode=default; gpt=false; grok=on; astra=null; gemini=false
  if [ -f "$state" ]; then
    IFS=$'\t' read -r mode gpt grok astra gemini < <(jq -r '[(.mode // "default"), ((.gptFast // false) | tostring), (if .grokFast == false then "off" else "on" end), (if .astraAllowed == true then "true" elif (.astraAllowed == false and .astraExplicit == true) then "false" else "null" end), (if .geminiAllowed == true then "true" else "false" end)] | @tsv' "$state" 2>/dev/null)
  fi
  [ -n "$mode" ] || mode=default
  [ -n "$gpt" ] || gpt=false
  [ -n "$grok" ] || grok=on
  case "$astra" in true | false) ;; *) astra=null ;; esac
  [ "$gemini" = true ] || gemini=false
  case "$mode" in
    balanced) label="均衡" ;;
    saver) label="省 Claude" ;;
    *) label="默认" ;;
  esac
  [ "$mode" = balanced ] && [ "$gpt" = true ] && label="${label} · GPT fast"
  [ "$grok" = off ] && label="${label} · Grok 非 fast"
  [ "$mode" = balanced ] && [ "$gemini" = true ] && label="${label} · Gemini"
  case "$mode" in balanced|saver) astra_default=true ;; *) astra_default=false ;; esac
  [ "$astra" = null ] && astra=$astra_default
  if [ "$astra" != "$astra_default" ]; then
    [ "$astra" = true ] && label="${label} · Astra" || label="${label} · 无 Astra"
  fi
  out="${out}${SEP}${DIM}模式 ${label}${RST}"

  ledger="$top/.claude/state/dispatch-ledger.jsonl"
  if [ -f "$ledger" ]; then
    IFS="$US" read -r running subs < <(tail -n 3000 "$ledger" | grep -E '"source":"(claude-agent|dispatch)"' | jq -rs '
      (now - 5400 | todate)[0:19] as $cut
      | def name: (if ((.model // "") | IN("", "cli-default", "inherit")) then "默认模型" else .model end) + (if .effort then "/" + .effort else "" end);
      def merge: group_by(.) | map(if length > 1 then "\(.[0])×\(length)" else .[0] end) | join("、");
      ([.[] | select(.source == "dispatch")]
        | group_by(.channel + "/" + .task) | map(last)
        | map(select(.event == "start" and ((.ts // "")[0:19] > $cut)))
        | map(name + (if .fast == true then " fast" else "" end)) | merge) as $ext
      | ([.[] | select(.source == "claude-agent")] as $c
        | (reduce ($c[] | select(.event == "end")) as $e ({tu: {}, ag: {}};
            (if ($e.tool_use_id // "") != "" then .tu[$e.tool_use_id] = true else . end)
            | (if ($e.agent_id // "") != "" then .ag[$e.agent_id] = true else . end))) as $ended
        | (reduce ($c[] | select(.event == "link" and (.tool_use_id // "") != "" and (.agent_id // "") != "")) as $l ({}; .[$l.tool_use_id] = $l.agent_id)) as $link
        | $c
        | map(select(.event == "start"
            and ((.tool_use_id // "") != "" or (.agent_id // "") != "")
            and ((.ts // "")[0:19] > $cut)
            and ((.tool_use_id // "") as $t | ($t == "") or ($ended.tu[$t] | not))
            and ((.agent_id // $link[.tool_use_id // ""] // "") as $a | ($a == "") or ($ended.ag[$a] | not))))
        | map(name) | merge) as $sub
      | [$ext, $sub] | join("\u001f")' 2>/dev/null)
    [ -n "$running" ] && out="${out}${SEP}${DIM}外部 ${running}${RST}"
    [ -n "$subs" ] && out="${out}${SEP}${DIM}子代理 ${subs}${RST}"
  fi
fi

printf '%s' "$out"
