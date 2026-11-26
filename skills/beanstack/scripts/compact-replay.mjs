#!/usr/bin/env node
// 压缩阈值回放：读本机会话日志（~/.claude/projects/<项目>/**.jsonl），统计自动压缩的实测事件、费用构成与缓存失效重写、
// 压缩后的重读，再按不同触发点重放同一串真实调用，估算触发点对 token 费用的影响。换模型、换单价、换阈值时用同一把尺子重算。
//
// 用法：node compact-replay.mjs [--project <目录名片段>] [--days 14] [--root ~/.claude/projects] [--json]
//        [--as-model <模型 ID>] [--window <N>]
//   --project   默认取当前目录按 Claude Code 规则转成的目录名（与 usage-report.mjs 相同）。
//   --as-model  主会话按该模型的单价重算（B、D 两段），其余不变。子代理始终用日志里的真实模型。
//   --window    autoCompactWindow 的取值，默认读 ~/.claude/settings.json，读不到按 300000。当前触发点 = 窗口 x 0.9。
// 单价与档位来自 usage-report.mjs（tierOf、readMultOf），费用是相对值，不是订阅计费。
// 模型假设（simulate）：
//   1. 按日志里的真实调用序列重放上下文增长：每个请求让模拟上下文增加实测的增量（与上一请求的上下文差）。
//   2. 模拟上下文超过触发点时计一次摘要调用（按命中价读全部上下文 + 固定 8K 输出），再把上下文降到实测的压缩后中位数，
//      加上 C 段实测的每次压缩多带来的重读量。真实发生过的压缩：手动触发的在任何触发点下都保留；自动触发的在
//      触发点更高时视为没发生（扣掉它带来的重读）。
//   3. 压缩后首个请求按「仍命中缓存的前缀 + 其余重写」计价，前缀取实测中位数。
//   4. 日志里缓存失效（上下文 > 6 万且命中不足一半）的请求按整段重写计价；会话第一个请求按实测命中率计；
//      其余请求新增部分按写入价、其余按命中价。
//   回放真实压缩点时，模型与日志实测费用的偏差会打印出来，用来判断这把尺子准不准。
// 局限：只估 token 费用，不衡量摘要丢信息对质量的影响；重读只统计 Read 工具，不含 Bash 的 cat / grep；
// 压缩后上下文与前缀是全样本中位数，没有按会话区分。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { tierOf, readMultOf } from "./usage-report.mjs";

const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const pctl = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const K = (n) => `${Math.round(n / 1000)}K`;
const M = (n) => `${(n / 1e6).toFixed(1)}M`;
const P1 = (x) => `${(x * 100).toFixed(1)}%`;
const bucketOf = (n, edges, names) => { const i = edges.findIndex((e) => n < e); return names[i < 0 ? edges.length : i]; };

export const costOf = (e, asModel) => {
  const m = asModel || e.model;
  return tierOf(m, e.ctx) * (e.i + 1.25 * e.w5 + 2 * e.w1 + readMultOf(m) * e.r + 5 * e.o);
};

// 解析一个会话日志的文本：压缩边界、Read 调用、去重后的请求。
export function parseSession(text, side = false) {
  const events = [], byKey = new Map(), reads = new Map();
  let lastTs = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(d.timestamp || "");
    if (d.type === "system" && d.subtype === "compact_boundary" && d.compactMetadata) {
      const c = d.compactMetadata;
      events.push({ kind: "b", ts, trigger: c.trigger, pre: c.preTokens, post: c.postTokens, dur: c.durationMs, idleMin: lastTs ? (ts - (c.durationMs || 0) - lastTs) / 60000 : null });
      continue;
    }
    const m = d.message;
    if (!m || typeof m !== "object") continue;
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use" && b.name === "Read" && b.input?.file_path) {
          const ev = { kind: "read", path: b.input.file_path, size: 0 };
          reads.set(b.id, ev); events.push(ev);
        } else if (b.type === "tool_result" && reads.has(b.tool_use_id)) {
          const c = b.content;
          reads.get(b.tool_use_id).size = typeof c === "string" ? c.length : Array.isArray(c) ? c.reduce((s, x) => s + (x.type === "text" ? (x.text || "").length : 0), 0) : 0;
        }
      }
    }
    if (d.type !== "assistant" || !m.usage || m.model === "<synthetic>") continue;
    const key = `${d.requestId}|${m.id}`, u = m.usage, cc = u.cache_creation;
    if (byKey.has(key)) { const e = byKey.get(key); e.o = Math.max(e.o, u.output_tokens || 0); continue; }
    const w5 = cc ? cc.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
    const w1 = cc ? cc.ephemeral_1h_input_tokens || 0 : 0;
    const e = { kind: "q", ts, model: m.model, i: u.input_tokens || 0, r: u.cache_read_input_tokens || 0, w5, w1, o: u.output_tokens || 0 };
    e.ctx = e.i + e.r + w5 + w1;
    byKey.set(key, e); events.push(e); lastTs = ts;
  }
  return { side, events };
}

export function loadSessions({ root, project, cut }) {
  const files = readdirSync(root).filter((d) => d.includes(project)).flatMap((d) => readdirSync(join(root, d), { recursive: true }).filter((e) => e.endsWith(".jsonl")).map((e) => join(root, d, e)));
  return files.filter((f) => statSync(f).mtimeMs > cut).map((f) => parseSession(readFileSync(f, "utf8"), f.includes("/subagents/"))).filter((s) => s.events.some((e) => e.kind === "q" && e.ts > cut));
}

// 压缩后第一个请求的上下文与命中量（全样本中位数），用作模拟里的压缩后大小与仍命中的前缀。
export function postCompactMedians(ss) {
  const nx = ss.flatMap((s) => s.events.flatMap((e, k) => (e.kind === "b" ? [s.events.slice(k + 1).find((x) => x.kind === "q")] : []))).filter(Boolean);
  return { P: med(nx.map((x) => x.ctx)), S: med(nx.map((x) => x.r)), n: nx.length };
}

// 按触发点 T 重放（replay:true 则按日志里真实的压缩点），返回 { cost, n(压缩次数), avgCtx, peak }。
export function simulate(ss, { cut = 0, T, replay = false, P, S, OUT = 8000, REREAD = 0, wpDefault = 2, asModel }) {
  let cost = 0, n = 0, ctxSum = 0, q = 0, peak = 0;
  for (const s of ss) {
    let sim = null, prev = null, pending = null, post = false;
    for (const e of s.events) {
      if (e.kind === "b") { pending = e; continue; }
      if (e.kind !== "q") continue;
      const mdl = asModel || e.model, rm = readMultOf(mdl), wtok = e.w5 + e.w1;
      const wp = wtok ? (1.25 * e.w5 + 2 * e.w1) / wtok : wpDefault;
      const inWin = e.ts > cut;
      let g = 0, first = false, compactNow = false, postCtx = P;
      if (sim === null) { sim = e.ctx; first = true; }
      else if (!pending) g = e.ctx - prev.ctx;
      if (pending) {
        if (replay || pending.trigger !== "auto") { compactNow = true; postCtx = e.ctx; }
        else sim = Math.max(P, sim - REREAD); // 这次真实压缩在模拟里没发生：扣掉它带来的重读
      }
      sim += g;
      if (!compactNow && !replay && T && sim > T) { compactNow = true; postCtx = P + REREAD; }
      if (compactNow) {
        if (inWin) { cost += tierOf(mdl, sim) * (rm * sim + 5 * OUT); n++; }
        sim = Math.max(postCtx, 20e3); post = true;
      }
      const p = tierOf(mdl, sim);
      const miss = !first && !pending && prev && e.ctx > 60e3 && e.r < 0.5 * e.ctx;
      let c;
      if (post) c = p * (rm * Math.min(S, sim) + wp * Math.max(0, sim - S) + 5 * e.o);
      else if (first) { const rf = e.ctx ? e.r / e.ctx : 0; c = p * (rm * sim * rf + wp * sim * (1 - rf) + 5 * e.o); }
      else if (miss) { const hit = e.r * (sim / e.ctx); c = p * (rm * hit + wp * (sim - hit) + 5 * e.o); }
      else { const nw = Math.min(sim, Math.max(g, 0, wtok + e.i)); c = p * (rm * (sim - nw) + wp * nw + 5 * e.o); }
      if (inWin) { cost += c; ctxSum += sim; q++; peak = Math.max(peak, sim); }
      prev = e; pending = null; post = false;
    }
  }
  return { cost, n, avgCtx: ctxSum / Math.max(1, q), peak };
}

function statsA(ss, cut) {
  const bs = ss.flatMap((s) => s.events.filter((e) => e.kind === "b" && e.ts > cut));
  const byTrigger = {};
  for (const b of bs) (byTrigger[b.trigger] ||= []).push(b);
  const trig = Object.fromEntries(Object.entries(byTrigger).map(([t, a]) => {
    const pre = a.map((b) => b.pre), hist = Object.fromEntries(["<150K", "150-250K", "250-300K", "300-400K", ">400K"].map((k) => [k, 0]));
    for (const p of pre) hist[bucketOf(p, [150e3, 250e3, 300e3, 400e3], Object.keys(hist))]++;
    return [t, { n: a.length, preMed: med(pre), preP10: pctl(pre, 0.1), preP90: pctl(pre, 0.9), postMed: med(a.map((b) => b.post)), durMedSec: med(a.map((b) => b.dur)) / 1000, durTotalMin: a.reduce((s, b) => s + (b.dur || 0), 0) / 60000, hist }];
  }));
  const perSession = ss.map((s) => s.events.filter((e) => e.kind === "b").length).filter((n) => n > 0);
  const gapsQ = [], gapsMin = [], first = [];
  for (const s of ss) {
    let q = 0, lastTs = null;
    s.events.forEach((e, k) => {
      if (e.kind === "q") q++;
      if (e.kind !== "b") return;
      if (lastTs !== null) { gapsQ.push(q); gapsMin.push((e.ts - lastTs) / 60000); }
      q = 0; lastTs = e.ts;
      const nx = s.events.slice(k + 1).find((x) => x.kind === "q");
      if (nx) first.push(nx);
    });
  }
  return { files: ss.length, total: bs.length, idle30: bs.filter((b) => b.idleMin >= 30).length, trig, sessionsWithCompact: perSession.length, perSessionMed: med(perSession), perSessionMax: Math.max(0, ...perSession), sessions3: perSession.filter((n) => n >= 3).length, gapQMed: med(gapsQ), gapMinMed: med(gapsMin), gapMinP10: pctl(gapsMin, 0.1), firstCtx: med(first.map((x) => x.ctx)), firstRead: med(first.map((x) => x.r)), firstWrite: med(first.map((x) => x.w5 + x.w1)) };
}

function statsB(ss, cut, asModel) {
  const bucket = {}, parts = { read: 0, writeNew: 0, writeMiss: 0, output: 0 }, missByGap = { "<5分": 0, "5-60分": 0, ">60分": 0 };
  let total = 0, n = 0, missN = 0;
  for (const s of ss) {
    let prev = null, afterB = false, first = true;
    for (const e of s.events) {
      if (e.kind === "b") { afterB = true; continue; }
      if (e.kind !== "q") continue;
      if (e.ts > cut) {
        const c = costOf(e, asModel), mdl = asModel || e.model, p = tierOf(mdl, e.ctx);
        total += c; n++;
        const b = bucketOf(e.ctx, [100e3, 200e3, 300e3, 400e3], ["<100K", "100-200K", "200-300K", "300-400K", ">400K"]);
        (bucket[b] ||= { n: 0, c: 0 }); bucket[b].n++; bucket[b].c += c;
        const wcost = p * (1.25 * e.w5 + 2 * e.w1);
        parts.read += p * readMultOf(mdl) * e.r; parts.output += p * 5 * e.o;
        if (!first && !afterB && prev && e.ctx > 60e3 && e.r < 0.5 * e.ctx) {
          parts.writeMiss += wcost; missN++;
          const gap = (e.ts - prev.ts) / 60000;
          missByGap[gap < 5 ? "<5分" : gap < 60 ? "5-60分" : ">60分"] += wcost;
        } else parts.writeNew += wcost + p * e.i;
      }
      prev = e; afterB = false; first = false;
    }
  }
  return { n, total, bucket, parts, missN, missByGap };
}

// 压缩后 80 次请求内重读此前读过的文件的量（只算 Read 工具，字符数 / 3 估 token），对照未压缩的长段从中点切开。
function statsC(ss) {
  const real = [], pseudo = [];
  const reads = (seg, limitQ) => { const out = []; let q = 0; for (const e of seg) { if (e.kind === "q") q++; if (limitQ && q > limitQ) break; if (e.kind === "read") out.push(e); } return out; };
  const sample = (beforeSeg, afterSeg) => {
    const before = new Set(reads(beforeSeg).map((e) => e.path)), after = reads(afterSeg, 80);
    if (!before.size) return null;
    const re = after.filter((e) => before.has(e.path));
    return { n: after.length, re: re.length, tok: re.reduce((x, e) => x + e.size, 0) / 3 };
  };
  for (const s of ss.filter((x) => !x.side)) {
    const segs = [[]];
    for (const e of s.events) { if (e.kind === "b") segs.push([]); else segs.at(-1).push(e); }
    for (let k = 1; k < segs.length; k++) { const r = sample(segs[k - 1], segs[k]); if (r) real.push(r); }
    for (const seg of segs) {
      const qs = seg.filter((e) => e.kind === "q").length;
      if (qs < 160) continue;
      let q = 0, mid = 0;
      for (let k = 0; k < seg.length; k++) { if (seg[k].kind === "q") q++; if (q >= qs / 2) { mid = k; break; } }
      const r = sample(seg.slice(0, mid), seg.slice(mid)); if (r) pseudo.push(r);
    }
  }
  const sum = (a) => ({ n: a.length, readMed: med(a.map((x) => x.n)), reMed: med(a.map((x) => x.re)), reMean: mean(a.map((x) => x.re)), tokMed: med(a.map((x) => x.tok)), tokMean: mean(a.map((x) => x.tok)) });
  return { after: sum(real), control: sum(pseudo), reread: Math.max(0, mean(real.map((x) => x.tok)) - mean(pseudo.map((x) => x.tok))) };
}

function statsD(ss, cut, { triggers, current, REREAD, asModel, wpDefault }) {
  const { P: P0, S: S0, n: nPost } = postCompactMedians(ss);
  const P = P0 || 80e3, S = S0 || 40e3;
  const base = { cut, P, S, OUT: 8000, REREAD, wpDefault, asModel };
  const real = ss.reduce((a, s) => a + s.events.filter((e) => e.kind === "q" && e.ts > cut).reduce((x, e) => x + costOf(e, asModel), 0), 0);
  const rep = simulate(ss, { ...base, replay: true, REREAD: 0 });
  const ref = simulate(ss, { ...base, T: current }).cost;
  const rows = [...new Set([...triggers, current])].sort((a, b) => a - b).map((T) => { const r = simulate(ss, { ...base, T }); return { T, ...r, vsCurrent: r.cost / ref - 1 }; });
  return { P, S, nPost, real, replayCost: rep.cost, replayN: rep.n, deviation: rep.cost / real - 1, REREAD, current, rows };
}

// 主会话里闲置 >= 60 分钟后的整段重写；若离开前先压缩，重写量从 ctx 降到压缩后大小。
function statsF(ss, cut, P) {
  const rows = [];
  let total = 0;
  for (const s of ss.filter((x) => !x.side)) {
    let prev = null, afterB = false;
    for (const e of s.events) {
      if (e.kind === "b") { afterB = true; continue; }
      if (e.kind !== "q") continue;
      if (e.ts > cut) total += costOf(e);
      if (prev && !afterB && e.ts > cut && e.ctx > 60e3 && e.r < 0.5 * e.ctx && (e.ts - prev.ts) / 60000 >= 60) rows.push({ ctx: e.ctx, gapH: (e.ts - prev.ts) / 3600e3, w: tierOf(e.model, e.ctx) * (1.25 * e.w5 + 2 * e.w1), model: e.model });
      prev = e; afterB = false;
    }
  }
  const by = { "<100K": [], "100-200K": [], "200-300K": [], ">300K": [] };
  for (const r of rows) by[bucketOf(r.ctx, [100e3, 200e3, 300e3], Object.keys(by))].push(r);
  let saved = 0;
  for (const r of rows) { const after = tierOf(r.model, r.ctx) * (readMultOf(r.model) * r.ctx + 5 * 8000 + 2 * Math.min(P, r.ctx)); if (after < r.w) saved += r.w - after; }
  return { n: rows.length, share: rows.reduce((s, r) => s + r.w, 0) / (total || 1), saved: saved / (total || 1), buckets: Object.fromEntries(Object.entries(by).map(([k, a]) => [k, { n: a.length, share: a.reduce((s, r) => s + r.w, 0) / (total || 1), gapHMed: med(a.map((r) => r.gapH)) }])) };
}

export function currentTrigger(windowArg, settingsPath = join(homedir(), ".claude/settings.json")) {
  let w = Number(windowArg) || 0;
  if (!w) { try { w = Number(JSON.parse(readFileSync(settingsPath, "utf8")).autoCompactWindow) || 0; } catch {} }
  return w ? w * 0.9 : 270e3;
}

export function report({ sessions, days, now = Date.now(), asModel, window: windowArg, settingsPath }) {
  const cut = now - days * 86400e3, current = currentTrigger(windowArg, settingsPath);
  const triggers = [170e3, 220e3, 270e3, 370e3, 470e3];
  const out = { days, current, asModel: asModel || null };
  const main = sessions.filter((s) => !s.side), sub = sessions.filter((s) => s.side);
  const c = statsC(sessions);
  out.main = { A: statsA(main, cut), B: statsB(main, cut, asModel), C: c, D: statsD(main, cut, { triggers, current, REREAD: c.reread, asModel, wpDefault: 2 }) };
  out.sub = { A: statsA(sub, cut), B: statsB(sub, cut), D: statsD(sub, cut, { triggers, current, REREAD: c.reread, wpDefault: 1.25 }) };
  out.main.F = statsF(sessions, cut, out.main.D.P);
  if (asModel) { const o = { cut, P: out.main.D.P, S: out.main.D.S, REREAD: c.reread, wpDefault: 2, T: current }; out.main.asModelRatio = simulate(main, { ...o, asModel }).cost / simulate(main, o).cost; }
  return out;
}

function print(r) {
  const log = console.log;
  for (const [name, side] of [["主会话", r.main], ["子代理", r.sub]]) {
    const a = side.A;
    log(`\n== A. 压缩事件（${name}，近 ${r.days} 天）：${a.files} 个日志，${a.total} 次 ==`);
    for (const [t, v] of Object.entries(a.trig)) log(`  ${t}: ${v.n} 次；触发前 token 中位 ${K(v.preMed)}（P10 ${K(v.preP10)} / P90 ${K(v.preP90)}）；摘要后 ${K(v.postMed)}；耗时中位 ${Math.round(v.durMedSec)} 秒，合计 ${Math.round(v.durTotalMin)} 分钟\n     触发点分布 ${JSON.stringify(v.hist)}`);
    log(`  其中距上一个请求 ≥30 分钟的 ${a.idle30} 次（疑似闲置压缩）\n  有压缩的会话 ${a.sessionsWithCompact} 个，每会话压缩次数中位 ${a.perSessionMed}、最多 ${a.perSessionMax}；≥3 次的会话 ${a.sessions3} 个`);
    log(`  相邻两次压缩之间：请求数中位 ${a.gapQMed}，间隔中位 ${Math.round(a.gapMinMed)} 分钟（P10 ${Math.round(a.gapMinP10)} 分钟）\n  压缩后第一个请求：上下文中位 ${K(a.firstCtx)}，其中命中缓存 ${K(a.firstRead)}、新写入 ${K(a.firstWrite)}`);
  }
  for (const [name, side, asModel] of [["主会话", r.main, r.asModel], ["子代理", r.sub, null]]) {
    const b = side.B, t = b.total || 1;
    log(`\n== B. 费用构成（${name}${asModel ? `，按 ${asModel} 单价` : ""}）：${b.n} 次请求，合计 ${M(b.total)} ==`);
    for (const k of ["<100K", "100-200K", "200-300K", "300-400K", ">400K"]) if (b.bucket[k]) log(`  上下文 ${k}: 请求 ${(b.bucket[k].n / b.n * 100).toFixed(0)}%，费用 ${(b.bucket[k].c / t * 100).toFixed(0)}%`);
    const pc = (x) => (x / t * 100).toFixed(0);
    log(`  读缓存 ${pc(b.parts.read)}%｜新内容写入 ${pc(b.parts.writeNew)}%｜缓存失效整段重写 ${pc(b.parts.writeMiss)}%（${b.missN} 次）｜输出 ${pc(b.parts.output)}%\n  失效重写按距上一请求的间隔：${Object.entries(b.missByGap).map(([k, v]) => `${k} ${(v / t * 100).toFixed(1)}%`).join("，")}`);
  }
  const c = r.main.C, row = (n, v) => `  ${n}: 样本 ${v.n}；之后 80 次请求内 Read 中位 ${v.readMed} 次，其中重读此前读过的文件中位 ${v.reMed} 次（均值 ${v.reMean.toFixed(1)}），重读量中位 ${K(v.tokMed)}、均值 ${K(v.tokMean)} token`;
  log(`\n== C. 压缩后重读（主会话，只算 Read 工具）==\n${row("压缩之后", c.after)}\n${row("对照（未压缩的长段从中点切）", c.control)}`);
  log(`  估算每次压缩多带来的重读 ≈ ${K(c.reread)} token（未计 Bash cat/grep 的重读）`);
  for (const [name, side, asModel] of [["主会话", r.main, r.asModel], ["子代理", r.sub, null]]) {
    const d = side.D;
    log(`\n== D. 触发点模拟（${name}${asModel ? `，按 ${asModel} 单价` : ""}）：压缩后上下文取实测中位 ${K(d.P)}（其中仍命中缓存 ${K(d.S)}，样本 ${d.nPost}），摘要输出按 8K，每次压缩额外重读 ${K(d.REREAD)} ==\n  日志实际费用 ${M(d.real)}（不含摘要调用）；模型按真实压缩点回放 ${M(d.replayCost)}（含摘要调用，${d.replayN} 次压缩）→ 模型与实测偏差 ${(d.deviation * 100).toFixed(1)}%`);
    for (const x of d.rows) log(`  触发点 ${K(x.T)}${x.T === d.current ? "（当前）" : ""}: 费用 ${M(x.cost)}，压缩 ${x.n} 次，平均上下文 ${K(x.avgCtx)}，峰值 ${K(x.peak)}，相对当前触发点 ${x.vsCurrent >= 0 ? "+" : ""}${(x.vsCurrent * 100).toFixed(1)}%`);
  }
  if (r.main.asModelRatio) log(`\n按 ${r.asModel} 单价重算，当前触发点下主会话费用是日志里实际模型的 ${r.main.asModelRatio.toFixed(2)} 倍`);
  const f = r.main.F;
  log(`\n== F. 主会话闲置 ≥60 分钟后的整段重写：${f.n} 次，占主会话费用 ${P1(f.share)} ==`);
  for (const [k, v] of Object.entries(f.buckets)) log(`  上下文 ${k}: ${v.n} 次，费用占比 ${P1(v.share)}，闲置时长中位 ${v.gapHMed.toFixed(1)} 小时`);
  log(`  若离开前先压缩（或闲置压缩阈值覆盖到这些会话）：可省约 ${P1(f.saved)} 的主会话费用（未计之后每次请求少读的部分）`);
}

function main(argv) {
  const arg = (k, def) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : def; };
  const root = arg("--root", join(homedir(), ".claude/projects"));
  const project = arg("--project", process.cwd().replace(/[^A-Za-z0-9]/g, "-").replace(/--claude-worktrees-.*$/, ""));
  const days = Number(arg("--days", "14"));
  const sessions = loadSessions({ root, project, cut: Date.now() - days * 86400e3 });
  if (!sessions.length) { console.log(`近 ${days} 天没有匹配「${project}」的用量记录`); return; }
  const res = report({ sessions, days, asModel: arg("--as-model", ""), window: arg("--window", "") });
  if (argv.includes("--json")) console.log(JSON.stringify(res)); else print(res);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
