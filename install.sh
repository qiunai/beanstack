#!/usr/bin/env bash
# beanstack 安装脚本：把技能软链到 Claude Code / Codex 的技能目录，并可把子代理、钩子套件、基线模板与状态栏铺进项目或用户目录。
# 脚本放在开源仓库根目录，旁边有 skills/ 与 templates/。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$SCRIPT_DIR/skills/beanstack"
TEMPLATES="$SCRIPT_DIR/templates"

DRY_RUN=0
FORCE=0
NO_SKILL=0
NO_HOOKS=0
INSTALL_STATUSLINE=0
PROJECT_DIR=""

usage() {
  cat <<'EOF'
用法：install.sh [选项]

默认：把仓库内 skills/beanstack 软链到
  ~/.claude/skills/beanstack
  ~/.agents/skills/beanstack
目标已存在且不是指向本仓库的软链时，不覆盖，打印提示并跳过。

选项：
  --project <目录>  安装项目级模板：
                      - templates/agents/*.md -> <目录>/.claude/agents/（不覆盖）
                      - templates/hooks/* -> <目录>/.claude/hooks/（不覆盖，可用 --no-hooks 跳过）
                      - templates/claude-settings.json -> <目录>/.claude/settings.json（已存在则写 .beanstack-template.json）
                      - templates/codex-hooks.json -> <目录>/.codex/hooks.json（已存在则写 .beanstack-template.json）
                      - templates/statusline/claude-statusline.sh -> <目录>/scripts/statusline/claude-statusline.sh
                      - templates/AGENTS.md -> <目录>/AGENTS.md（已存在则写 AGENTS.beanstack-template.md）
  --statusline      安装用户级 Claude Code 底部状态栏（~/.claude/statusline.sh 与 ~/.claude/statusline.fallback.sh）
  --no-skill        不做技能软链
  --no-hooks        配合 --project 使用，跳过钩子与 settings 模板
  --force           目标已存在时，先备份为 .bak.<时间戳> 再替换（作用于技能软链与 --statusline）
  --dry-run         只打印要做什么，不写任何文件
  -h, --help        显示本帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project)
      [ $# -ge 2 ] || { echo "错误：--project 需要一个目录参数" >&2; exit 2; }
      PROJECT_DIR="$2"; shift 2 ;;
    --statusline) INSTALL_STATUSLINE=1; shift ;;
    --no-skill) NO_SKILL=1; shift ;;
    --no-hooks) NO_HOOKS=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "错误：未知参数 $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "${HOME:-}" ]; then
  echo "错误：HOME 未设置" >&2
  exit 1
fi

say() { printf '%s\n' "$*"; }

act() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] $*"
  else
    "$@"
  fi
}

copy_if_missing() {
  local src="$1" dest="$2"
  if [ -e "$dest" ]; then
    say "跳过：$dest 已存在"
  else
    say "复制：$dest"
    act cp "$src" "$dest"
  fi
}

copy_or_template() {
  local src="$1" dest="$2" fallback="$3"
  if [ -e "$dest" ]; then
    if [ -e "$fallback" ]; then
      say "跳过：$fallback 已存在"
    else
      say "$dest 已存在，模板写到：$fallback（请手动合并）"
      act cp "$src" "$fallback"
    fi
  else
    say "复制：$dest"
    act cp "$src" "$dest"
  fi
}

link_skill() {
  local target="$1"
  local parent
  parent="$(dirname "$target")"

  if [ -L "$target" ] && [ "$(readlink "$target")" = "$SKILL_SRC" ]; then
    say "已就绪：$target 已指向本仓库，跳过"
    return 0
  fi

  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ "$FORCE" -eq 1 ]; then
      local backup
      backup="$target.bak.$(date +%Y%m%d%H%M%S)"
      say "备份：$target -> $backup"
      act mv "$target" "$backup"
    else
      say "跳过：$target 已存在且不是指向本仓库的软链（加 --force 备份后替换）"
      return 0
    fi
  fi

  act mkdir -p "$parent"
  say "软链：$target -> $SKILL_SRC"
  act ln -s "$SKILL_SRC" "$target"
}

install_user_statusline() {
  local src_stub="$TEMPLATES/statusline/user-statusline-stub.sh"
  local src_main="$TEMPLATES/statusline/claude-statusline.sh"
  if [ ! -f "$src_stub" ] || [ ! -f "$src_main" ]; then
    echo "错误：找不到 $TEMPLATES/statusline 下的状态栏脚本" >&2
    exit 1
  fi
  act mkdir -p "$HOME/.claude"

  local pair src dest backup
  for pair in "$src_stub:$HOME/.claude/statusline.sh" "$src_main:$HOME/.claude/statusline.fallback.sh"; do
    src="${pair%%:*}"
    dest="${pair#*:}"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      if [ "$FORCE" -eq 1 ]; then
        backup="$dest.bak.$(date +%Y%m%d%H%M%S)"
        say "备份：$dest -> $backup"
        act mv "$dest" "$backup"
      else
        say "跳过：$dest 已存在（加 --force 备份后替换）"
        continue
      fi
    fi
    say "安装状态栏：$dest"
    act cp "$src" "$dest"
    act chmod +x "$dest"
  done

  say "提示：在 ~/.claude/settings.json 中加入以下配置即可启用底部状态栏与 400K 自动压缩线（需本机安装 jq）："
  say '  "statusLine": { "type": "command", "command": "bash ~/.claude/statusline.sh", "refreshInterval": 5 },'
  say '  "autoCompactWindow": 400000'
}

install_project() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    echo "错误：项目目录不存在：$dir" >&2
    exit 1
  fi
  if [ ! -d "$TEMPLATES/agents" ] || [ ! -f "$TEMPLATES/AGENTS.md" ]; then
    echo "错误：找不到 $TEMPLATES 下的 agents/ 或 AGENTS.md" >&2
    exit 1
  fi

  act mkdir -p "$dir/.claude/agents"
  local f name
  for f in "$TEMPLATES"/agents/*.md; do
    name="$(basename "$f")"
    copy_if_missing "$f" "$dir/.claude/agents/$name"
  done

  if [ "$NO_HOOKS" -eq 0 ] && [ -d "$TEMPLATES/hooks" ]; then
    act mkdir -p "$dir/.claude/hooks"
    for f in "$TEMPLATES"/hooks/bash-guard.mjs "$TEMPLATES"/hooks/round-state.mjs "$TEMPLATES"/hooks/compact-instructions.md; do
      [ -f "$f" ] || continue
      name="$(basename "$f")"
      copy_if_missing "$f" "$dir/.claude/hooks/$name"
    done
    if [ -f "$TEMPLATES/claude-settings.json" ]; then
      copy_or_template \
        "$TEMPLATES/claude-settings.json" \
        "$dir/.claude/settings.json" \
        "$dir/.claude/settings.beanstack-template.json"
    fi
    if [ -f "$TEMPLATES/codex-hooks.json" ]; then
      act mkdir -p "$dir/.codex"
      copy_or_template \
        "$TEMPLATES/codex-hooks.json" \
        "$dir/.codex/hooks.json" \
        "$dir/.codex/hooks.beanstack-template.json"
    fi
    if [ -f "$TEMPLATES/statusline/claude-statusline.sh" ]; then
      act mkdir -p "$dir/scripts/statusline"
      if [ ! -e "$dir/scripts/statusline/claude-statusline.sh" ]; then
        say "复制：$dir/scripts/statusline/claude-statusline.sh"
        act cp "$TEMPLATES/statusline/claude-statusline.sh" "$dir/scripts/statusline/claude-statusline.sh"
        act chmod +x "$dir/scripts/statusline/claude-statusline.sh"
      else
        say "跳过：$dir/scripts/statusline/claude-statusline.sh 已存在"
      fi
    fi
  fi

  copy_or_template \
    "$TEMPLATES/AGENTS.md" \
    "$dir/AGENTS.md" \
    "$dir/AGENTS.beanstack-template.md"

  if [ ! -e "$dir/CLAUDE.md" ] && [ ! -L "$dir/CLAUDE.md" ]; then
    say "提示：Claude Code 读 CLAUDE.md，建议在项目里执行：ln -s AGENTS.md CLAUDE.md"
  fi
  say "提示：建议把 .claude/state/ 加入 .gitignore，并填完 AGENTS.md 里的 TODO 占位。"
}

if [ "$NO_SKILL" -eq 0 ]; then
  if [ ! -d "$SKILL_SRC" ]; then
    echo "错误：找不到技能目录 $SKILL_SRC" >&2
    exit 1
  fi
  link_skill "$HOME/.claude/skills/beanstack"
  link_skill "$HOME/.agents/skills/beanstack"
fi

if [ "$INSTALL_STATUSLINE" -eq 1 ]; then
  install_user_statusline
fi

if [ -n "$PROJECT_DIR" ]; then
  install_project "$PROJECT_DIR"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry-run 结束，未写入任何文件。"
fi
