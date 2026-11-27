#!/bin/bash
# 用户级状态栏指路桩（安装到 ~/.claude/statusline.sh）：
# 优先执行当前仓库的 scripts/statusline/claude-statusline.sh；仓库里没有时执行 ~/.claude/statusline.fallback.sh。
input=$(cat)
dir=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty' 2>/dev/null)
top=""
[ -n "$dir" ] && top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
target="$HOME/.claude/statusline.fallback.sh"
if [ -n "$top" ] && [ -f "$top/scripts/statusline/claude-statusline.sh" ]; then
  target="$top/scripts/statusline/claude-statusline.sh"
fi
[ -f "$target" ] && printf '%s' "$input" | bash "$target"
