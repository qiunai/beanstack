#!/usr/bin/env node
// BeanStack 回合状态钩子（仅在 Claude Code 生效；其它工具如 Grok 读到配置时自动静默退出）。
// 搭配 BeanStack 技能与底部状态栏使用，解决 5 类真实痛点：
//   1. 每次发言自动提醒当前模式、按 BeanStack 推进并强制中文回复（UserPromptSubmit）
//   2. 压缩或恢复会话后，把推进契约、模式开关、活跃 OpenSpec 变更、派工账本与用户原话重新注入（SessionStart）
//   3. 协调器连续亲手改代码或首次改 UI 时提醒派子代理与设计规范（PostToolUse Edit/Write）
//   4. 实时把 Claude 原生子代理的 start/link/end 写入 dispatch-ledger.jsonl，供状态栏显示（PreToolUse/PostToolUse/SubagentStop）
//   5. 验证与收尾拦截：子代理遗留未关闭的 playwright-cli 浏览器会话或后台任务（SubagentStop）；主会话留手写 sleep 轮询（Stop）
//
// 用法：node round-state.mjs session-start|session-requests|prompt|post-edit|pre-agent|post-agent|post-agent-failure|permission-denied|subagent-stop|stop
// 状态目录：${BEANSTACK_STATE_DIR:-<git顶层>/.claude/state}
// 派工账本：${BEANSTACK_LEDGER:-<git顶层>/.claude/state/dispatch-ledger.jsonl}（与 dispatch.sh、状态栏共用）

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODE_LABEL = { default: "默认", balanced: "均衡", saver: "省 Claude" };
const SESSION_LIMIT = 4000;
const REQUESTS_LIMIT = 8000;
const PRODUCT_REMIND_AT = 3;
const STALE_BASE_COMMITS = 20;
const TRANSCRIPT_TAIL = 256 * 1024;
const SUBAGENT_BLOCK_KEEP = 200;
const WAIT_HINT_KEEP = 50;

const FALLBACK_CONTRACT = [
  "推进契约（兜底版）：",
  "0. 非简单任务第一条回复先按 beanstack align.md 对齐：复述目标与最小改动、补专业术语、写验收证据，只在停止条件处停下问。",
  "1. 探索 → OpenSpec 提案 → 行为改动先红测试 → 派子代理实现（只跑受影响测试）→ 独立验证位按原话取证 → 体验验收 → 冻结开 PR。",
  "2. UI 改动先读设计规范，加载 frontend-design + impeccable；新页面在 Claude 下优先用 Claude Design 出稿，交付前派独立验证位走用户路径。",
  "3. 调度模式由用户指定；默认派子代理执行、协调器只裁决和收货。",
  "4. 合并、发版、部署三件事各自等待用户明确授权，绝不私自执行。",
  "5. 给用户看的文字一律用中文。",
].join("\n");

// ---------- 基础工具 ----------

function isClaudeCode(env, input) {
  if (env.CLAUDECODE || env.CLAUDE_PROJECT_DIR || env.CLAUDE_CODE_ENTRYPOINT) return true;
  if (input && typeof input === "object" && (input.transcript_path || input.hook_event_name)) {
    return true;
  }
  return false;
}

function git(project, args) {
  try {
    return execFileSync("git", args, {
      cwd: project,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function resolveProject(input) {
  const candidate =
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof input?.cwd === "string" && input.cwd) ||
    process.cwd();
  const top = git(candidate, ["rev-parse", "--show-toplevel"]);
  return top || candidate;
}

function stateDir(project) {
  return process.env.BEANSTACK_STATE_DIR || join(project, ".claude", "state");
}

function stateFile(project) {
  return join(stateDir(project), "round.json");
}

function ledgerFile(project) {
  return process.env.BEANSTACK_LEDGER || join(stateDir(project), "dispatch-ledger.jsonl");
}

function requestsFile(project, sessionId) {
  const safe = String(sessionId || "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return join(stateDir(project), "requests", `${safe}.jsonl`);
}

function defaultState(branch = "") {
  return {
    branch,
    roundStart: new Date().toISOString(),
    mode: "default",
    modeExplicit: false,
    gptFast: false,
    grokFast: true,
    astraAllowed: false,
    astraExplicit: false,
    geminiAllowed: false,
    productFiles: [],
    productReminded: false,
    uiTouched: false,
    uiReminded: false,
    subagentEdits: 0,
    subagentBlocks: {},
    waitHinted: [],
  };
}

function loadState(project) {
  const file = stateFile(project);
  const branch = git(project, ["rev-parse", "--abbrev-ref", "HEAD"]) || "";
  if (!existsSync(file)) return defaultState(branch);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return defaultState(branch);
    const merged = { ...defaultState(branch), ...parsed };
    // 切换分支时保留用户的模式与通道偏好，但重置本轮计数与提醒状态。
    if (branch && merged.branch && merged.branch !== branch) {
      return {
        ...defaultState(branch),
        mode: merged.mode,
        modeExplicit: false,
        gptFast: merged.gptFast,
        grokFast: merged.grokFast,
        astraAllowed: merged.astraAllowed,
        astraExplicit: merged.astraExplicit,
        geminiAllowed: merged.geminiAllowed,
      };
    }
    return merged;
  } catch {
    return defaultState(branch);
  }
}

function saveState(project, state) {
  const dir = stateDir(project);
  mkdirSync(dir, { recursive: true });
  const target = stateFile(project);
  const tmp = join(dir, `.round.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, target);
}

function appendLedger(project, row) {
  const file = ledgerFile(project);
  mkdirSync(resolve(file, ".."), { recursive: true });
  appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function emitContext(hookEventName, additionalContext) {
  emit({ hookSpecificOutput: { hookEventName, additionalContext } });
}

// ---------- 模式与通道开关识别 ----------

const SYSTEM_NOTICE =
  /<task-notification|\[SYSTEM NOTIFICATION|<system-reminder|<local-command|<agent-message/i;
const NEGATION =
  /不要|不用|不能|不是|不想|不切|不改|不进|别|勿|禁止|没有|无需|并非|停用|停掉|不再|删掉|删除|去掉|移除|废弃|取消|关掉|关闭|弃用|下线|卸载/;
const UNSURE = /[?？]|吗|什么|是否|要不要|是不是|能不能|可不可以|哪个|怎么/;
const DESCRIBE =
  /如果|假如|要是|若|的话|一旦|时候|时(?!间)|模式下|模式里|模式中|默认|删掉|删除|去掉|移除|取消|废弃|那段|这段|文档|规则|说明|写成|写的|代码|脚本|逻辑|dispatch|roster|\.md/i;

const SWITCH_VERB = "(?:切换到|切换成|切回|切到|改用|改成|换回|换成|换到|进入|回到|使用|用)";
const GAP = "[^，。,;；：:！!？?\\n的于在下里中把将对]{0,4}?";
const PHRASE = "(?<!负载)(均衡|省\\s*claude|省\\s*token|默认)\\s*模式(?!下|时|里|中|的|那|这)";
const VERB_MODE = new RegExp(`${SWITCH_VERB}${GAP}${PHRASE}`, "gi");
const BARE_MODE = /^(?:请|就|先)?(均衡|省\s*claude|省\s*token)\s*模式(?:吧|啊|哦|了)?$/i;
const QUALIFIED_DEFAULT =
  /(?:调度|派工)\s*默认\s*模式(?!下|时|里|中|的|那|这)|默认\s*(?:调度|派工)\s*模式(?!下|时|里|中|的|那|这)/;

function keyToMode(key) {
  const k = key.replace(/\s+/g, "").toLowerCase();
  if (k === "均衡") return "balanced";
  if (k === "默认") return "default";
  return "saver";
}

export function detectMode(text) {
  if (typeof text !== "string" || !text || SYSTEM_NOTICE.test(text)) return null;
  let mode = null;
  for (const rawClause of text.split(/[，。,;；：:！!\n]/)) {
    const clause = rawClause.trim();
    if (!clause || NEGATION.test(clause) || UNSURE.test(clause)) continue;
    const bare = BARE_MODE.exec(clause);
    if (bare) {
      mode = keyToMode(bare[1]);
      continue;
    }
    if (QUALIFIED_DEFAULT.test(clause)) {
      mode = "default";
      continue;
    }
    for (const m of clause.matchAll(VERB_MODE)) {
      mode = keyToMode(m[1]);
    }
  }
  return mode;
}

const ON_VERBS = "(?:可以用|可以使用|可以开|允许使用|允许用|允许|开启|打开|启用|使用|用|开)";
const OFF_VERBS = "(?:不用|不要用|别用|不使用|不开|不要开|别开|关掉|关闭|禁用|停用)";

export function detectSwitches(text) {
  const out = {};
  if (typeof text !== "string" || !text || SYSTEM_NOTICE.test(text)) return out;
  for (const rawClause of text.split(/[，。,;；：:！!\n]/)) {
    const clause = rawClause.trim();
    if (!clause || UNSURE.test(clause) || DESCRIBE.test(clause)) continue;

    // GPT fast
    if (new RegExp(`${OFF_VERBS}.{0,12}(?:gpt|codex|sol)\\s*fast|(?:gpt|codex|sol).{0,6}${OFF_VERBS}.{0,6}fast`, "i").test(clause)) {
      out.gptFast = false;
    } else if (!NEGATION.test(clause) && new RegExp(`${ON_VERBS}.{0,12}(?:gpt|codex|sol)\\s*fast|(?:gpt|codex|sol).{0,6}${ON_VERBS}.{0,6}fast`, "i").test(clause)) {
      out.gptFast = true;
    }

    // Grok fast
    if (new RegExp(`${OFF_VERBS}.{0,10}grok\\s*fast|grok.{0,6}${OFF_VERBS}.{0,6}fast`, "i").test(clause)) {
      out.grokFast = false;
    } else if (!NEGATION.test(clause) && new RegExp(`${ON_VERBS}.{0,10}grok\\s*fast|grok.{0,6}${ON_VERBS}.{0,6}fast`, "i").test(clause)) {
      out.grokFast = true;
    }

    // Astra
    if (new RegExp(`${OFF_VERBS}.{0,8}astra|astra.{0,6}${OFF_VERBS}`, "i").test(clause)) {
      out.astraAllowed = false;
      out.astraExplicit = true;
    } else if (!NEGATION.test(clause) && new RegExp(`${ON_VERBS}.{0,8}astra|astra.{0,6}${ON_VERBS}`, "i").test(clause)) {
      out.astraAllowed = true;
      out.astraExplicit = true;
    }

    // Gemini
    if (new RegExp(`${OFF_VERBS}.{0,8}gemini|gemini.{0,6}${OFF_VERBS}`, "i").test(clause)) {
      out.geminiAllowed = false;
    } else if (!NEGATION.test(clause) && new RegExp(`${ON_VERBS}.{0,8}gemini|gemini.{0,6}${ON_VERBS}`, "i").test(clause)) {
      out.geminiAllowed = true;
    }
  }
  return out;
}

function formatFlags(state) {
  const parts = [];
  const label = MODE_LABEL[state.mode] || MODE_LABEL.default;
  const spec = state.modeExplicit ? "用户指定" : state.mode === "default" ? "未指定" : "沿用";
  parts.push(`模式：${label}（${spec}）`);
  if (state.mode === "balanced" && state.gptFast) parts.push("GPT fast：开");
  if (state.grokFast === false) parts.push("Grok fast：关");
  if (state.astraExplicit) parts.push(`Astra：${state.astraAllowed ? "开" : "关"}`);
  if (state.geminiAllowed) parts.push("Gemini：可用");
  return parts.join("｜");
}

// ---------- 上下文与路径判定 ----------

function readContract(project) {
  const markerRe = /<!--\s*beanstack:contract\s*-->([\s\S]*?)<!--\s*\/beanstack:contract\s*-->/;
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const fp = join(project, name);
    if (!existsSync(fp)) continue;
    try {
      const content = readFileSync(fp, "utf8");
      const m = markerRe.exec(content);
      if (m && m[1].trim()) return m[1].trim();
    } catch {
      // ignore
    }
  }
  return FALLBACK_CONTRACT;
}

function activeOpenSpecChanges(project) {
  const dir = join(project, "openspec", "changes");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "archive" && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function readLedgerSince(project, since) {
  const file = ledgerFile(project);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split("\n").slice(-500);
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const row = JSON.parse(l);
        if (!since || (row.ts && row.ts >= since)) out.push(row);
      } catch {
        // skip bad row
      }
    }
    return out;
  } catch {
    return [];
  }
}

function staleBaseNotice(project) {
  const out = git(project, ["rev-list", "--count", "HEAD..origin/main"]);
  const n = Number(out);
  if (!Number.isFinite(n) || n < STALE_BASE_COMMITS) return null;
  return `当前分支落后 origin/main ${n} 个提交：开工前先同步主干，避免子代理照过时代码写测试。`;
}

function relPath(project, file) {
  if (typeof file !== "string" || !file) return null;
  const abs = isAbsolute(file) ? file : resolve(project, file);
  const rel = relative(project, abs).split("\\").join("/");
  return rel.startsWith("..") ? null : rel;
}

const UI_PATH_RE = /\.(tsx|jsx|vue|svelte|css|scss|less|html|swift|kt)$/i;
const CODE_PATH_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|vue|svelte|css|scss|sql)$/i;
const TEST_PATH_RE = /(?:^|\/)(?:__tests__|tests?|spec)\/|\.(test|spec)\.[^/]+$/i;

function readTailLines(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const size = statSync(filePath).size;
    const text = readFileSync(filePath, "utf8");
    return (size > TRANSCRIPT_TAIL ? text.slice(-TRANSCRIPT_TAIL) : text).split("\n");
  } catch {
    return [];
  }
}

function parseRow(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ---------- 各事件处理器 ----------

function onSessionStart(project, input) {
  const state = loadState(project);
  if (!existsSync(stateFile(project))) saveState(project, state);
  const stale = input.source === "compact" ? null : staleBaseNotice(project);

  if (input.source !== "compact" && input.source !== "resume") {
    if (stale) emitContext("SessionStart", `[BeanStack] ${stale}`);
    return;
  }

  const changes = activeOpenSpecChanges(project);
  const ledger = readLedgerSince(project, state.roundStart);
  const ends = ledger.filter((r) => r.event === "end");
  const statusLines = [
    "[BeanStack 回合状态]（压缩或恢复后重新注入）",
    `- ${formatFlags(state)}`,
    `- 活跃 OpenSpec 变更：${changes.length ? changes.join("、") : "无"}`,
    `- 本轮改过 UI：${state.uiTouched ? "是（需读设计规范、frontend-design + impeccable，交付前派独立验证位 bs-verify）" : "否"}`,
    `- 本轮已完成派工数：${ends.length}`,
    ...(stale ? [`- ${stale}`] : []),
    "按 beanstack 推进，给用户看的文字一律用中文。",
  ].join("\n");

  const contract = readContract(project);
  const room = Math.max(0, SESSION_LIMIT - statusLines.length - 4);
  const trimmedContract =
    contract.length > room ? `${contract.slice(0, Math.max(0, room - 1))}…` : contract;
  emitContext("SessionStart", `${trimmedContract}\n\n${statusLines}`.slice(0, SESSION_LIMIT));
}

function onSessionRequests(project, input) {
  if (input.source !== "compact" && input.source !== "resume") return;
  const fp = requestsFile(project, input.session_id);
  if (!existsSync(fp)) return;
  try {
    const rows = readFileSync(fp, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(parseRow)
      .filter((r) => r && typeof r.text === "string");
    if (!rows.length) return;
    const recent = rows.slice(-15);
    const body = recent.map((r, idx) => `${idx + 1}. ${r.text}`).join("\n");
    const msg = `[BeanStack 用户原始需求记录（压缩后还原，以原话为准）]\n${body}`;
    emitContext("SessionStart", msg.slice(0, REQUESTS_LIMIT));
  } catch {
    // ignore
  }
}

function onPrompt(project, input) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt || SYSTEM_NOTICE.test(prompt)) return;

  const state = loadState(project);
  const detectedMode = detectMode(prompt);
  if (detectedMode) {
    state.mode = detectedMode;
    state.modeExplicit = true;
  }
  const switches = detectSwitches(prompt);
  Object.assign(state, switches);
  saveState(project, state);

  // 保存用户原话，防止上下文压缩后遗忘细节。
  try {
    const fp = requestsFile(project, input.session_id);
    mkdirSync(resolve(fp, ".."), { recursive: true });
    appendFileSync(
      fp,
      JSON.stringify({ ts: new Date().toISOString(), text: prompt.slice(0, 1500) }) + "\n",
      "utf8",
    );
  } catch {
    // ignore
  }

  emitContext(
    "UserPromptSubmit",
    `[BeanStack] ${formatFlags(state)}｜非简单任务按 beanstack 推进（对齐→探索/提案→先红测试→派子代理→独立验证→交付）；给用户看的文字用中文。`,
  );
}

function onPostEdit(project, input) {
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const rel = relPath(project, ti.file_path ?? ti.notebook_path ?? ti.path);
  if (!rel) return;

  const isUi = UI_PATH_RE.test(rel) && !TEST_PATH_RE.test(rel);
  const isProduct = CODE_PATH_RE.test(rel) && !TEST_PATH_RE.test(rel);
  const state = loadState(project);
  const notes = [];

  if (input.agent_id) {
    state.subagentEdits = (state.subagentEdits || 0) + 1;
    if (isUi) state.uiTouched = true;
    saveState(project, state);
    return;
  }

  if (isProduct && !state.productFiles.includes(rel)) {
    state.productFiles.push(rel);
  }
  if (!state.productReminded && state.productFiles.length >= PRODUCT_REMIND_AT) {
    const ledger = readLedgerSince(project, state.roundStart);
    const hasDispatched = ledger.some((r) => r.event === "start");
    if (!hasDispatched) {
      state.productReminded = true;
      notes.push(
        "协调器已连续直接修改多个产品文件。按 beanstack，范围明确的实现应派子代理执行，协调器保留上下文做裁决与收货（一句话改动可忽略）。",
      );
    }
  }
  if (isUi) {
    state.uiTouched = true;
    if (!state.uiReminded) {
      state.uiReminded = true;
      notes.push(
        "UI 改动提醒：先读项目设计规范（DESIGN.md），加载 frontend-design + impeccable；新页面/整页改版在 Claude 下优先用 Claude Design 定稿；交付前派独立验证位（bs-verify）走真实用户路径。",
      );
    }
  }
  saveState(project, state);
  if (notes.length) emitContext("PostToolUse", `[BeanStack] ${notes.join("\n")}`);
}

function extractAgentMeta(input) {
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const tr = input.tool_response && typeof input.tool_response === "object" ? input.tool_response : {};
  const role = ti.subagent_type || input.agent_type || "agent";
  const model = ti.model || "inherit";
  const effort = ti.effort || null;
  const tool_use_id = input.tool_use_id || "";
  const agent_id = input.agent_id || tr.agentId || tr.agent_id || "";
  const background = ti.run_in_background === true || tr.isAsync === true;
  return { role, model, effort, tool_use_id, agent_id, background, session_id: input.session_id || "" };
}

function onPreAgent(project, input) {
  const meta = extractAgentMeta(input);
  appendLedger(project, {
    ts: new Date().toISOString(),
    source: "claude-agent",
    event: "start",
    role: meta.role,
    model: meta.model,
    effort: meta.effort,
    tool_use_id: meta.tool_use_id,
    session_id: meta.session_id,
  });
}

function onPostAgent(project, input) {
  const meta = extractAgentMeta(input);
  if (meta.background && meta.tool_use_id && meta.agent_id) {
    appendLedger(project, {
      ts: new Date().toISOString(),
      source: "claude-agent",
      event: "link",
      tool_use_id: meta.tool_use_id,
      agent_id: meta.agent_id,
      role: meta.role,
    });
    return;
  }
  appendLedger(project, {
    ts: new Date().toISOString(),
    source: "claude-agent",
    event: "end",
    tool_use_id: meta.tool_use_id,
    agent_id: meta.agent_id,
    role: meta.role,
    model: meta.model,
    effort: meta.effort,
  });
}

function onAgentAbort(project, input) {
  const meta = extractAgentMeta(input);
  appendLedger(project, {
    ts: new Date().toISOString(),
    source: "claude-agent",
    event: "end",
    tool_use_id: meta.tool_use_id,
    agent_id: meta.agent_id,
    role: meta.role,
    aborted: true,
  });
}

// 检查子代理是否遗留了未关闭的 playwright-cli 浏览器会话。
function hasUnclosedPlaywright(transcriptPath) {
  const lines = readTailLines(transcriptPath);
  let opened = 0;
  let closed = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    const row = parseRow(l);
    const content = row?.message?.content;
    if (row?.type !== "assistant" || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_use" || b.name !== "Bash") continue;
      const cmd = String(b.input?.command ?? "");
      if (/\bplaywright-cli\b[\s\S]*\bopen\b/.test(cmd)) opened++;
      if (/\bplaywright-cli\b[\s\S]*\b(?:close|close-all)\b/.test(cmd)) closed++;
    }
  }
  return opened > closed;
}

function onSubagentStop(project, input) {
  const agentId = input.agent_id || "";
  const role = input.agent_type || "agent";
  const transcript = input.agent_transcript_path || input.transcript_path || "";

  if (agentId && hasUnclosedPlaywright(transcript)) {
    const state = loadState(project);
    const blocks = state.subagentBlocks || {};
    const key = `${agentId}:playwright`;
    if (!blocks[key]) {
      blocks[key] = true;
      state.subagentBlocks = Object.fromEntries(
        Object.entries(blocks).slice(-SUBAGENT_BLOCK_KEEP),
      );
      saveState(project, state);
      emit({
        decision: "block",
        reason:
          "[BeanStack 子代理收尾拦截] 检测到你在本次验证中打开了 playwright-cli 浏览器会话但未关闭：请先执行 `playwright-cli close`（或 `close-all`）清理后再交付。",
      });
      return;
    }
  }

  if (agentId) {
    appendLedger(project, {
      ts: new Date().toISOString(),
      source: "claude-agent",
      event: "end",
      agent_id: agentId,
      role,
    });
  }
}

const HANDWRITTEN_WAIT = [/\b(?:while|until)\b[\s\S]*\bsleep\b/, /(?:^|[\s/'"])wait-[\w.-]*\.sh\b/];

function findHandwrittenWaits(transcriptPath) {
  const lines = readTailLines(transcriptPath);
  const ids = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const row = parseRow(lines[i]);
    const content = row?.message?.content;
    if (row?.type === "user") {
      if (typeof content === "string" || (Array.isArray(content) && !content.some((b) => b?.type === "tool_result"))) {
        break;
      }
      continue;
    }
    if (row?.type !== "assistant" || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_use" || b.name !== "Bash" || b.input?.run_in_background !== true) {
        continue;
      }
      const cmd = String(b.input?.command ?? "");
      if (HANDWRITTEN_WAIT.some((re) => re.test(cmd)) && b.id) ids.push(b.id);
    }
  }
  return ids;
}

function onStop(project, input) {
  if (input.stop_hook_active === true) return;
  const state = loadState(project);
  const hinted = Array.isArray(state.waitHinted) ? state.waitHinted : [];
  const waits = findHandwrittenWaits(input.transcript_path).filter((id) => !hinted.includes(id));
  if (!waits.length) return;
  state.waitHinted = [...hinted, ...waits].slice(-WAIT_HINT_KEEP);
  saveState(project, state);
  emit({
    decision: "block",
    reason:
      "[BeanStack 回合末检查] 本回合在后台起了手写等待（while/until + sleep 或 wait-*.sh）：它只认终态，卡住时不会唤醒会话。请改用有界等待或直接等后台任务通知，不再需要的手写等待请停掉。",
  });
}

const HANDLERS = {
  "session-start": onSessionStart,
  "session-requests": onSessionRequests,
  prompt: onPrompt,
  "post-edit": onPostEdit,
  "pre-agent": onPreAgent,
  "post-agent": onPostAgent,
  "post-agent-failure": onAgentAbort,
  "permission-denied": onAgentAbort,
  "subagent-stop": onSubagentStop,
  stop: onStop,
};

function main() {
  try {
    const handler = HANDLERS[process.argv[2]];
    if (!handler) return;
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    if (!isClaudeCode(process.env, input)) return;
    const project = resolveProject(input);
    handler(project, input);
  } catch {
    // 钩子异常一律放行，不阻塞用户。
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
