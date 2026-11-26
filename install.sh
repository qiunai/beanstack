#!/usr/bin/env bash
# beanstack 安装脚本：把技能软链到 Claude Code / Codex 的技能目录，并可把子代理与基线模板铺进项目。
# 脚本放在开源仓库根目录，旁边有 skills/ 与 templates/。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$SCRIPT_DIR/skills/beanstack"
TEMPLATES="$SCRIPT_DIR/templates"

DRY_RUN=0
FORCE=0
NO_SKILL=0
PROJECT_DIR=""

usage() {
  cat <<'EOF'
用法：install.sh [选项]

默认：把仓库内 skills/beanstack 软链到
  ~/.claude/skills/beanstack
  ~/.agents/skills/beanstack
目标已存在且不是指向本仓库的软链时，不覆盖，打印提示并跳过。

选项：
  --project <目录>  把 templates/agents/*.md 复制到 <目录>/.claude/agents/（同名文件不覆盖），
                    templates/AGENTS.md 复制到 <目录>/AGENTS.md（已存在则写成 AGENTS.beanstack-template.md）
  --no-skill        不做技能软链，只处理 --project
  --force           目标已存在时，先备份为 .bak.<时间戳> 再替换（只作用于技能软链）
  --dry-run         只打印要做什么，不写任何文件
  -h, --help        显示本帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project)
      [ $# -ge 2 ] || { echo "错误：--project 需要一个目录参数" >&2; exit 2; }
      PROJECT_DIR="$2"; shift 2 ;;
    --no-skill) NO_SKILL=1; shift ;;
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

# 真正落盘的动作都走这里；dry-run 只打印。
act() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "[dry-run] $*"
  else
    "$@"
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
  local f name dest
  for f in "$TEMPLATES"/agents/*.md; do
    name="$(basename "$f")"
    dest="$dir/.claude/agents/$name"
    if [ -e "$dest" ]; then
      say "跳过：$dest 已存在"
    else
      say "复制：$dest"
      act cp "$f" "$dest"
    fi
  done

  dest="$dir/AGENTS.md"
  if [ -e "$dest" ]; then
    dest="$dir/AGENTS.beanstack-template.md"
    if [ -e "$dest" ]; then
      say "跳过：$dest 已存在"
    else
      say "AGENTS.md 已存在，模板写到：${dest}（请手动合并）"
      act cp "$TEMPLATES/AGENTS.md" "$dest"
    fi
  else
    say "复制：$dest"
    act cp "$TEMPLATES/AGENTS.md" "$dest"
  fi

  if [ ! -e "$dir/CLAUDE.md" ] && [ ! -L "$dir/CLAUDE.md" ]; then
    say "提示：Claude Code 读 CLAUDE.md，建议在项目里执行：ln -s AGENTS.md CLAUDE.md"
  fi
  say "提示：填完 AGENTS.md 里的 TODO 占位后再开始使用。"
}

if [ "$NO_SKILL" -eq 0 ]; then
  if [ ! -d "$SKILL_SRC" ]; then
    echo "错误：找不到技能目录 $SKILL_SRC" >&2
    exit 1
  fi
  link_skill "$HOME/.claude/skills/beanstack"
  link_skill "$HOME/.agents/skills/beanstack"
fi

if [ -n "$PROJECT_DIR" ]; then
  install_project "$PROJECT_DIR"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry-run 结束，未写入任何文件。"
fi
