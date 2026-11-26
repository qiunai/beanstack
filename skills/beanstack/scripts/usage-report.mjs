#!/usr/bin/env node
// Claude Code 额度画像：读本机会话日志（~/.claude/projects/<项目>/**.jsonl），按主会话 / 子代理角色 / 模型
// 汇总相对费用，列出长跑子代理和执行类子代理上下文的来源。用来在调整工作流前后用同一把尺子对比。
//
// 用法：node usage-report.mjs [--project <目录名片段>] [--days 14] [--until 0] [--root ~/.claude/projects] [--json]
//   --project 默认取当前目录绝对路径按 Claude Code 规则转成的目录名（非字母数字换成 -）的仓库根部分。
//   --until N 不算最近 N 天。改动前后对比：改动在 2 天前生效，就跑 `--days 2` 和 `--days 14 --until 2`，看日均与各角色每调用费用。
// 费用是按 API 列表价比例算的相对值（不是订阅计费）：输入 1、输出 5、5 分钟缓存写 1.25、1 小时写 2、
// 命中 0.1（Opus 5.5 / Sonnet 5.5 为 0.05，Fable / Mythos 为 0.025）；模型档 Haiku 1、Sonnet 3、Opus 5、Fable 10，
// 5.5 代按新标价折算：Sonnet 5.5 为 2.5，Haiku 5.5 提示不超过 10 万 token 时 0.125、超过后 0.625（贵 5 倍）。
// 起步上下文 = 一次运行第一个请求的上下文大小（系统提示、工具定义、规则文件、任务书），之后每次调用都要重读它。
// 同一请求在日志里按内容块重复出现，按 requestId + message.id 去重。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

export function tierOf(model = "", ctx = 0) {
  if (model.includes("opus")) return 5;
  if (model.includes("sonnet")) return /sonnet-5-5/.test(model) ? 2.5 : 3;
  if (model.includes("haiku")) return /haiku-5-5/.test(model) ? (ctx > 100000 ? 0.625 : 0.125) : 1;
  if (model.includes("fable")) return 10;
  return 0;
}
export function readMultOf(model = "") {
  if (/fable|mythos/.test(model)) return 0.025;
  if (/(opus|sonnet)-5-5/.test(model)) return 0.05;
  return 0.1;
}

export function requestCost(model, u) {
  const cc = u.cache_creation;
  const w5 = cc ? cc.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
  const w1 = cc ? cc.ephemeral_1h_input_tokens || 0 : 0;
  const r = u.cache_read_input_tokens || 0;
  const i = u.input_tokens || 0;
  const o = u.output_tokens || 0;
  const p = tierOf(model, i + w5 + w1 + r);
  const parts = { input: p * i, write: p * (1.25 * w5 + 2 * w1), read: p * readMultOf(model) * r, output: p * 5 * o };
  return { cost: parts.input + parts.write + parts.read + parts.output, ctx: i + w5 + w1 + r, parts };
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    const st = statSync(f);
    if (st.isDirectory()) walk(f, out);
    else if (e.endsWith(".jsonl")) out.push({ f, mtime: st.mtimeMs });
  }
  return out;
}

function classifyBash(cmd) {
  if (/vitest|node --test|\b(p?npm|yarn) (run )?test|\bpytest\b/.test(cmd)) return "Bash:test";
  if (/typecheck|\btsc\b|lint|build/.test(cmd)) return "Bash:check/build";
  if (/\b(grep|rg|find)\b/.test(cmd)) return "Bash:search";
  if (/\b(cat|head|tail)\b|sed -n/.test(cmd)) return "Bash:read";
  return "Bash:other";
}

export function analyze({ root, project, days, until = 0, now = Date.now() }) {
  const cut = now - days * 86400e3;
  const end = now - until * 86400e3;
  const dirs = readdirSync(root).filter((d) => d.includes(project));
  const files = dirs.flatMap((d) => walk(join(root, d))).filter((x) => x.mtime > cut);
  const roles = {};
  const runs = [];
  const toolChars = {};
  let total = 0;
  let compactions = 0;
  const seen = new Set();
  for (const { f } of files) {
    const side = f.includes("/subagents/");
    let role = "main";
    if (side) {
      const meta = f.replace(/\.jsonl$/, ".meta.json");
      let type = "?";
      if (existsSync(meta)) {
        try { type = JSON.parse(readFileSync(meta, "utf8")).agentType || "?"; } catch {}
      }
      role = `sub:${type}`;
    }
    const run = { role, calls: 0, cost: 0, peak: 0, first: 0 };
    const pending = {};
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.isCompactSummary) compactions++;
      const m = d.message;
      if (!m || typeof m !== "object") continue;
      if (side && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "tool_use") pending[b.id] = b.name === "Bash" ? classifyBash(b.input?.command || "") : b.name;
          else if (b.type === "tool_result") {
            const name = pending[b.tool_use_id] || "?";
            const c = b.content;
            const n = typeof c === "string" ? c.length
              : Array.isArray(c) ? c.reduce((s, x) => s + (x.type === "text" ? (x.text || "").length : 0), 0) : 0;
            toolChars[name] = (toolChars[name] || 0) + n;
          }
        }
      }
      if (d.type !== "assistant" || !m.usage || m.model === "<synthetic>") continue;
      const ts = Date.parse(d.timestamp || "");
      if (ts && (ts < cut || ts > end)) continue;
      const key = `${d.requestId}|${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { cost, ctx, parts } = requestCost(m.model, m.usage);
      const r = (roles[role] ||= { calls: 0, cost: 0, longCtxCost: 0, parts: { input: 0, write: 0, read: 0, output: 0 } });
      r.calls++; r.cost += cost; if (ctx > 200000) r.longCtxCost += cost;
      for (const k of Object.keys(parts)) r.parts[k] += parts[k];
      if (!run.calls) run.first = ctx;
      run.calls++; run.cost += cost; run.peak = Math.max(run.peak, ctx);
      total += cost;
    }
    if (run.calls) runs.push(run);
  }
  return { files: files.length, total, roles, runs, toolChars, compactions };
}

function pct(x) { return `${(x * 100).toFixed(1)}%`; }

function main(argv) {
  const arg = (k, def) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : def; };
  const root = arg("--root", join(homedir(), ".claude/projects"));
  const cwdKey = process.cwd().replace(/[^A-Za-z0-9]/g, "-").replace(/--claude-worktrees-.*$/, "");
  const project = arg("--project", cwdKey);
  const days = Number(arg("--days", "14"));
  const until = Number(arg("--until", "0"));
  const res = analyze({ root, project, days, until });
  if (argv.includes("--json")) { console.log(JSON.stringify(res)); return; }
  const { total } = res;
  if (!total) { console.log(`近 ${days} 天没有匹配「${project}」的用量记录`); return; }
  const span = days - until;
  console.log(`${until ? `${days} 天前到 ${until} 天前` : `近 ${days} 天`}，${res.files} 个日志，自动压缩 ${res.compactions} 次，日均相对费用 ${(total / span / 1e6).toFixed(0)}M`);
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  console.log("\n角色            份额    调用数   每调用费用  上下文>20万的费用  读缓存/写缓存/输出  起步上下文中位");
  for (const [k, v] of Object.entries(res.roles).sort((a, b) => b[1].cost - a[1].cost)) {
    const first = median(res.runs.filter((r) => r.role === k).map((r) => r.first));
    const mix = ["read", "write", "output"].map((p) => (100 * v.parts[p] / v.cost).toFixed(0)).join("/");
    console.log(`${k.padEnd(16)}${pct(v.cost / total).padStart(6)}  ${String(v.calls).padStart(7)}   ${(v.cost / v.calls / 1e3).toFixed(0).padStart(6)}K   ${pct(v.longCtxCost / total).padStart(8)}          ${mix.padStart(9)}%       ${(first / 1e3).toFixed(0).padStart(4)}K`);
  }
  console.log("\n子代理单次运行（按角色）：中位调用数 / 150 次以上的运行数 / 它们占该角色费用");
  const byRole = {};
  for (const r of res.runs) if (r.role !== "main") (byRole[r.role] ||= []).push(r);
  for (const [k, rs] of Object.entries(byRole)) {
    const calls = rs.map((r) => r.calls).sort((a, b) => a - b);
    const big = rs.filter((r) => r.calls >= 150);
    const sum = (a) => a.reduce((s, r) => s + r.cost, 0);
    console.log(`${k.padEnd(16)}n=${rs.length}  中位 ${calls[calls.length >> 1]}  ≥150 次 ${big.length}  ${pct(sum(big) / (sum(rs) || 1))}`);
  }
  const tc = Object.entries(res.toolChars).sort((a, b) => b[1] - a[1]);
  const tcTotal = tc.reduce((s, [, v]) => s + v, 0) || 1;
  console.log("\n子代理工具输出进上下文的占比（前 8）");
  for (const [k, v] of tc.slice(0, 8)) console.log(`${k.padEnd(20)}${pct(v / tcTotal)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
