#!/usr/bin/env node
// PreToolUse(Bash) 确定性守卫钩子（Claude Code / Codex / Grok 共用）。
// 把「规则里写了但靠模型记忆」的底线变成硬拦截；其余一律放行，不做风格检查。
// 覆盖 3 类真实事故：
//   1. 不可逆 / 绕过门禁操作：直接 gh pr merge、--no-verify / 篡改 core.hooksPath、裸 git push --force、宽匹配 pkill/killall。
//   2. 吞掉测试退出码：测试或类型检查命令直接管道给 tail/head/grep（红了也报 0），未开 pipefail 且未读 PIPESTATUS。
//   3. 子代理纪律（仅在输入含非空 agent_id 时生效）：不再派代理、不跑整包全量测试、不手写长等待循环、前台超时 <= 290 秒。
// 协议：stdin 为钩子 JSON；exit 2 = 拒绝（stderr 回给模型）；exit 0 = 放行（含自身解析异常）。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const shortFlag = (args, letter) =>
  args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));

const base = (w) => String(w ?? "").replace(/\/+$/, "").split("/").pop();
const HOOKS_KEY = /^core\.hookspath$/i;
const RESERVED = new Set(["{", "}", "do", "then", "else", "elif", "if", "while", "until", "!"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g;
const PH = /\u0000(\d+)\u0000/g;
const SEP = /;|&&|(?<![<>&])&(?![>&])|\|\|?|\n|\$\(|`|\(|\)/;
const REDIRECT = /^(?:\d+|&)?(?:<<<|<<-?|>>|>\||>&|<&|<>|>|<)(.*)$/;
const ATTACHED_REDIRECT =
  /(?<![\s<>&])(?<!(?:^|\s)\d+)(?<!(?:^|[^\\])\\(?:\\\\)*)(&>>?|>>|>\||>&|<&|<<<|<<-?|<>|>|<)/g;

const badHooksAssign = (kv) => {
  const m = /^([^=]+)=(.*)$/.exec(kv);
  return (
    Boolean(m) &&
    HOOKS_KEY.test(m[1].trim()) &&
    m[2].trim().replace(/\/$/, "") !== ".githooks"
  );
};

// 去掉 heredoc 正文，避免把提交信息、文档正文或内联脚本当成真实命令拦截。
export function stripHeredocs(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let pending = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (pending.length) {
      const target = pending[0];
      const cmp = target.stripTabs ? line.replace(/^\t+/, "") : line;
      if (cmp === target.delim) pending.shift();
      continue;
    }
    let inSingle = false;
    let inDouble = false;
    let esc = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\" && !inSingle) {
        esc = true;
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (!inSingle && !inDouble && ch === "#") break;
      if (
        !inSingle &&
        !inDouble &&
        ch === "<" &&
        line[j + 1] === "<" &&
        line[j + 2] !== "<"
      ) {
        const rest = line.slice(j + 2);
        const m = /^(-?)\s*(?:'([^']+)'|"([^"]+)"|\\([^\s;&|<>()]+)|([^\s;&|<>()'"]+))/.exec(rest);
        if (m) {
          pending.push({
            stripTabs: m[1] === "-",
            delim: m[2] ?? m[3] ?? m[4] ?? m[5],
          });
          j += 1 + m[0].length;
        }
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function dropRedirects(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const m = REDIRECT.exec(raw[i]);
    if (m) {
      if (m[1] === "") i++;
      continue;
    }
    out.push(raw[i]);
  }
  return out;
}

function unquote(token) {
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  if (token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).replace(/\\(["\\$`\n])/g, "$1");
  }
  return token;
}

function parseSubcommands(command) {
  const cleaned = stripHeredocs(command);
  const quotes = [];
  const masked = cleaned.replace(QUOTED, (m) => {
    const id = quotes.length;
    quotes.push(m);
    return `\u0000${id}\u0000`;
  });
  const restoreRaw = (s) => s.replace(PH, (_, i) => quotes[Number(i)]);
  const restoreVal = (s) => s.replace(PH, (_, i) => unquote(quotes[Number(i)]));
  const stripVal = (s) => s.replace(PH, '""');

  const parts = masked.split(SEP);
  const list = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const expanded = trimmed.replace(ATTACHED_REDIRECT, " $1");
    const tokens = dropRedirects(expanded.split(/\s+/).filter(Boolean));
    const envs = {};
    let idx = 0;
    while (idx < tokens.length) {
      const t = tokens[idx];
      if (RESERVED.has(t)) {
        idx++;
        continue;
      }
      const envMatch = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
      if (envMatch) {
        envs[envMatch[1]] = restoreVal(envMatch[2]);
        idx++;
        continue;
      }
      break;
    }
    const slice = tokens.slice(idx);
    if (!slice.length) continue;
    const words = slice.map(stripVal);
    const values = slice.map(restoreVal);
    const gitConfigs = [];
    if (base(words[0]) === "git") {
      for (let i = 1; i < words.length; i++) {
        if (words[i] === "-c" && values[i + 1]) {
          gitConfigs.push(values[i + 1]);
          i++;
        } else if (words[i].startsWith("-c") && words[i].length > 2) {
          gitConfigs.push(values[i].slice(2));
        }
      }
    }
    list.push({
      words,
      values,
      envs,
      gitConfigs,
      quotedText: restoreRaw(trimmed),
    });
  }
  return list;
}

// ---------- 1. 通用底线规则（协调器与子代理均生效） ----------

const GENERAL_RULES = [
  {
    // 禁止直接合并 PR，确保走项目的授权与门禁核对流程。
    test: ({ words, values }) => {
      if (base(words[0]) !== "gh") return false;
      if (words[1] === "pr" && words[2] === "merge") return true;
      if (words[1] !== "api" || !values.some((v) => /\/pulls\/\d+\/merge\/?$/.test(v))) {
        return false;
      }
      const writes = values.some(
        (v, i) =>
          (/^(-X|--method)$/.test(v) && /^put$/i.test(values[i + 1] ?? "")) ||
          /^(-XPUT|--method=put)$/i.test(v),
      );
      return writes || values.some((v) => /^(-f|-F|--field|--raw-field)$/.test(v));
    },
    reason:
      "不直接用 `gh pr merge` 或 `gh api .../merge` 合并 PR：合并需要用户明确授权并核对门禁全绿，请走项目规定的合并流程。",
  },
  {
    // 禁止绕过 git hooks。
    test: ({ words, values, envs, gitConfigs }) => {
      const envHooks =
        Object.entries(envs).some(([k, v]) => /^GIT_CONFIG_KEY_\d+$/.test(k) && HOOKS_KEY.test(v)) ||
        /hookspath/i.test(envs.GIT_CONFIG_PARAMETERS ?? "");
      if (base(words[0]) !== "git") return false;
      if (envHooks || gitConfigs.some(badHooksAssign)) return true;
      if (words.includes("--no-verify") || (words[1] === "commit" && shortFlag(words.slice(2), "n"))) {
        return true;
      }
      if (words[1] === "config") {
        const args = values.slice(2);
        const k = args.findIndex((a) => HOOKS_KEY.test(a));
        if (k < 0) return false;
        if (
          args[0] === "unset" ||
          args.some((a) => /^(--unset|--unset-all|--remove-section)$/.test(a))
        ) {
          return true;
        }
        const value = args[k + 1];
        return value !== undefined && value.replace(/\/$/, "") !== ".githooks";
      }
      return false;
    },
    reason: "不绕过 git hooks：不用 `--no-verify` / `git commit -n`，不篡改 `core.hooksPath`。hook 报错请修根因。",
  },
  {
    // 禁止裸 force push；允许 --force-with-lease。
    test: ({ words }) => {
      if (base(words[0]) !== "git" || words[1] !== "push") return false;
      const args = words.slice(2);
      if (args.some((a) => a.startsWith("--force-with-lease"))) return false;
      return (
        args.includes("--force") ||
        shortFlag(args, "f") ||
        args.some((a) => a.startsWith("+"))
      );
    },
    reason:
      "不用裸 `git push --force` / `-f` 或 `+refspec` 改写远端历史；自己的分支确需改写时用 `--force-with-lease`。",
  },
  {
    // 禁止宽匹配 pkill / killall，避免误杀其他会话或用户的 dev server。
    test: ({ words, values }) => {
      const cmd = base(words[0]);
      if (cmd !== "pkill" && cmd !== "killall") return false;
      const args = values.slice(1).filter((a) => !a.startsWith("-"));
      if (!args.length) return true;
      const pattern = args.join(" ");
      // 如果带了当前工作目录路径或特定端口/PID 特征则放行；裸进程名（node/next/vite/python/chrome/playwright）拦截。
      const broad = /^(node|next|vite|vitest|jest|python|python3|ruby|go|java|cargo|bun|deno|chrome|chromium|playwright|claude|codex|grok|sh|bash|zsh)$/i;
      if (broad.test(pattern.trim())) return true;
      return !/[/.:]/.test(pattern);
    },
    reason:
      "不用宽匹配 `pkill` / `killall`（会误杀用户的 dev server 或其它并行会话）：只按记录的 PID（`kill <pid>`）关闭自己启动的进程。",
  },
];

// ---------- 2. 防止管道吞掉测试退出码 ----------

const PIPE_REASON =
  "测试或检查命令直接管道给 tail/head/grep 会吞掉退出码（红了也报 0）：请改成 `<命令> > 日志 2>&1; echo exit=$?` 再读日志，或在前面加 `set -o pipefail`。";

const TEST_CMD_RE =
  /^(vitest|jest|pytest|mocha|ava|playwright|tsc|eslint|biome|mypy|ruff|golangci-lint|phpunit|rspec)$/;
const TEST_RUNNER_SCRIPTS = /^(test|test:.*|typecheck|typecheck:.*|check|check:.*|lint|lint:.*|verify|verify:.*|build|build:.*)$/;
const SWALLOW_CMDS = new Set(["tail", "head", "grep", "egrep", "fgrep", "rg", "awk", "sed", "cut", "wc"]);

function isTestLikeCmd(words) {
  if (!words.length) return false;
  const c = base(words[0]);
  if (TEST_CMD_RE.test(c)) return true;
  if (c === "node" && words.includes("--test")) return true;
  if (c === "go" && words[1] === "test") return true;
  if (c === "cargo" && (words[1] === "test" || words[1] === "check" || words[1] === "clippy")) return true;
  if (["pnpm", "npm", "yarn", "bun"].includes(c)) {
    const rest = words.slice(1).filter((w) => !w.startsWith("-"));
    const script = rest[0] === "run" ? rest[1] : rest[0];
    if (script && TEST_RUNNER_SCRIPTS.test(script)) return true;
  }
  return false;
}

function setPipefailEffect(words) {
  if (words[0] !== "set") return null;
  let effect = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "-o" && words[i + 1] === "pipefail") {
      effect = true;
      i++;
    } else if (w === "+o" && words[i + 1] === "pipefail") {
      effect = false;
      i++;
    } else if (/^-[a-zA-Z]*o$/.test(w) && words[i + 1] === "pipefail") {
      effect = true;
      i++;
    }
  }
  return effect;
}

export function swallowsTestExitCode(command) {
  const cleaned = stripHeredocs(command);
  const masked = cleaned.replace(QUOTED, '""');
  const chains = masked.split(/;|&&|\|\||\n/);
  let pipefail = false;
  for (let i = 0; i < chains.length; i++) {
    const seg = chains[i].trim();
    if (!seg) continue;
    const stages = seg.split(/(?<!\|)\|(?!\|)/).map((s) => s.trim()).filter(Boolean);
    if (stages.length === 1) {
      const eff = setPipefailEffect(stages[0].split(/\s+/));
      if (eff !== null) pipefail = eff;
      continue;
    }
    if (pipefail) continue;
    const firstWords = stages[0].replace(ATTACHED_REDIRECT, " $1").split(/\s+/).filter(Boolean);
    const lastWords = stages[stages.length - 1].split(/\s+/).filter(Boolean);
    if (isTestLikeCmd(firstWords) && SWALLOW_CMDS.has(base(lastWords[0]))) {
      const next = chains[i + 1] ?? "";
      if (!/\$\{PIPESTATUS\[/.test(next)) return true;
    }
  }
  return false;
}

// ---------- 3. 子代理纪律（仅 agent_id 非空时生效） ----------

const SPAWN_REASON =
  "子代理不再派代理（不用 `claude -p`、`codex exec`、`grok`、`agy`、`devin`、`dispatch.sh` 等）：需要别的模型或第二意见时写进交付，由协调器派。";

const WRAPPER_VALUE_FLAGS = {
  nohup: new Set(),
  time: new Set(["-f", "-o"]),
  nice: new Set(["-n", "--adjustment"]),
  caffeinate: new Set(["-t", "-w"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-k", "-s", "--kill-after", "--signal"]),
};

function stripWrappers(values) {
  let v = values.slice();
  while (v.length) {
    const c = base(v[0]);
    if (RESERVED.has(v[0]) || /^\w+=/.test(v[0]) || ["sudo", "env", "command", "exec"].includes(c)) {
      v = v.slice(1);
      continue;
    }
    if (c in WRAPPER_VALUE_FLAGS) {
      const valFlags = WRAPPER_VALUE_FLAGS[c];
      let i = 1;
      while (i < v.length && v[i].startsWith("-")) {
        i += valFlags.has(v[i]) ? 2 : 1;
      }
      if (c === "timeout" && i < v.length && /^\d+[smhd]?$/.test(v[i])) i++;
      v = v.slice(i);
      continue;
    }
    if (c === "npx" || (["pnpm", "yarn", "bun"].includes(c) && ["exec", "dlx", "x"].includes(v[1]))) {
      let i = c === "npx" ? 1 : 2;
      while (i < v.length && v[i].startsWith("-")) i++;
      v = v.slice(i);
      continue;
    }
    break;
  }
  return v;
}

const INFO_FLAGS = new Set(["-v", "-V", "--version", "-h", "--help"]);
const onlyInfo = (args) => args.length > 0 && args.every((a) => INFO_FLAGS.has(a));

function isAgentSpawn(values) {
  const v = stripWrappers(values);
  if (!v.length) return false;
  const c = base(v[0]);
  const args = v.slice(1);
  if (onlyInfo(args)) return false;
  if (c === "dispatch.sh") return true;
  if (SHELLS.has(c) && args.some((a) => base(a) === "dispatch.sh")) return true;
  if (c === "claude" && args.some((a) => a === "-p" || a === "--print" || a.startsWith("--print=") || a === "--cloud")) {
    return true;
  }
  if (c === "codex" && args[0] === "exec") return true;
  if (c === "grok" && args.some((a) => a === "--prompt-file" || a === "-p" || a === "--always-approve")) {
    return true;
  }
  if (c === "agy" && args.some((a) => a === "-p" || a.startsWith("-p="))) return true;
  if (c === "devin" && args.some((a) => a === "-p" || a === "--prompt-file")) return true;
  return false;
}

function hasTargetedTestArg(args) {
  const filtered = args.filter((a) => a !== "--" && a !== "run");
  return filtered.some(
    (a) =>
      a === "-t" ||
      a === "-k" ||
      a === "--test-name-pattern" ||
      a === "--affected" ||
      a === "--changed" ||
      a === "--related" ||
      (!a.startsWith("-") && (/[/.]/.test(a) || /\.(test|spec)\./.test(a))),
  );
}

function isFullSuiteTest(values) {
  const v = stripWrappers(values);
  if (!v.length) return null;
  const c = base(v[0]);
  const args = v.slice(1);
  if (onlyInfo(args)) return null;
  if (c === "vitest" || c === "jest" || c === "pytest") {
    return hasTargetedTestArg(args) ? null : `${c} 全量测试`;
  }
  if (c === "cargo" && args[0] === "test") {
    return args.slice(1).some((a) => !a.startsWith("-")) ? null : "cargo test 全量测试";
  }
  if (c === "go" && args[0] === "test") {
    return args.some((a) => a === "./..." || a === "all") ? "go test ./..." : null;
  }
  if (["pnpm", "npm", "yarn", "bun"].includes(c)) {
    let i = 1;
    while (i < v.length && v[i].startsWith("-")) {
      if (["--filter", "-F", "-C", "--dir", "--prefix", "--cwd"].includes(v[i])) i += 2;
      else i += 1;
    }
    const rest = v.slice(i);
    const script = rest[0] === "run" || rest[0] === "run-script" ? rest[1] : rest[0];
    const sargs = rest[0] === "run" || rest[0] === "run-script" ? rest.slice(2) : rest.slice(1);
    if (script === "test" || script === "test:all" || script === "test:ci") {
      return hasTargetedTestArg(sargs) ? null : `${c} ${script} 全量测试`;
    }
  }
  return null;
}

const HANDWRITTEN_WAIT_RE = /\b(?:while|until)\b[\s\S]*\bsleep\b/;

export function evaluateBashGuard(input) {
  if (!input || typeof input !== "object") return null;
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const command = typeof ti.command === "string" ? ti.command : "";
  if (!command.trim()) return null;

  const isSubagent = typeof input.agent_id === "string" && input.agent_id.trim() !== "";
  const cmds = parseSubcommands(command);

  for (const sub of cmds) {
    for (const rule of GENERAL_RULES) {
      if (rule.test(sub)) return rule.reason;
    }
  }

  if (swallowsTestExitCode(command)) return PIPE_REASON;

  if (isSubagent) {
    if (ti.run_in_background !== true && typeof ti.timeout === "number" && ti.timeout > 290_000) {
      return "子代理前台命令超时不得超过 290 秒（提示缓存 5 分钟过期）：耗时更长的命令请转后台或交回协调器。";
    }
    if (HANDWRITTEN_WAIT_RE.test(stripHeredocs(command))) {
      return "子代理不手写 `while/until ... sleep` 长等待循环：请改用有界等待或直接交付给协调器处理。";
    }
    for (const sub of cmds) {
      if (isAgentSpawn(sub.values)) return SPAWN_REASON;
      const full = isFullSuiteTest(sub.values);
      if (full) {
        return `子代理不跑整包全量测试（检测到 ${full}）：只跑与改动直接相关的定向测试文件，全量验证交协调器或 CI。`;
      }
    }
  }

  return null;
}

function main() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const reason = evaluateBashGuard(input);
    if (reason) {
      process.stderr.write(`[BeanStack bash-guard] ${reason}\n`);
      process.exitCode = 2;
    }
  } catch {
    // 钩子自身出错一律放行，避免阻塞用户。
    process.exitCode = 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
