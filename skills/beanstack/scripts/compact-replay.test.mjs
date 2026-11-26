// compact-replay 的纯函数测试：用合成会话，不读真实日志。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { costOf, currentTrigger, parseSession, report, simulate } from "./compact-replay.mjs";

const OPUS = "claude-opus-5-5";
const NOW = Date.parse("2026-11-09T12:00:00Z");
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${msg ?? ""} ${a} != ${b}`);

// 一个请求：上下文 ctx，其中命中 r，其余按 5 分钟写入；第一个请求 r = 0。
const q = (ctx, r, o = 500, model = OPUS, ts = NOW - 1000) => ({ kind: "q", ts, model, i: 0, r, w5: ctx - r, w1: 0, o, ctx });
const b = (trigger, ts = NOW - 900) => ({ kind: "b", ts, trigger, pre: 300e3, post: 20e3, dur: 60e3, idleMin: null });
// 从 start 起每个请求增长 step，命中上一请求的全部上下文。
function growing(start, step, n, extra = {}) {
  const events = [q(start, 0)];
  for (let k = 1; k < n; k++) { const prev = start + (k - 1) * step; events.push(q(prev + step, prev)); }
  return { side: false, events, ...extra };
}
const BASE = { P: 50e3, S: 20e3, OUT: 8000, REREAD: 0, wpDefault: 1.25 };

test("不压缩时模拟费用等于逐请求累加", () => {
  const s = growing(100e3, 10e3, 30);
  const actual = s.events.reduce((sum, e) => sum + costOf(e), 0);
  const r = simulate([s], { ...BASE, T: 0 });
  assert.equal(r.n, 0);
  near(r.cost, actual);
});

test("触发点越低压缩次数越多，高于峰值则不压缩", () => {
  const s = growing(100e3, 10e3, 60); // 峰值 690K
  const counts = [150e3, 250e3, 400e3, 800e3].map((T) => simulate([s], { ...BASE, T }).n);
  assert.ok(counts[0] > counts[1] && counts[1] > counts[2], JSON.stringify(counts));
  assert.equal(counts[3], 0);
});

test("一次压缩后的首个请求按前缀命中 + 其余重写计价", () => {
  const s = { side: false, events: [q(100e3, 0), q(130e3, 100e3)] };
  const p = 5, rm = 0.05;
  const first = p * (1.25 * 100e3 + 5 * 500);
  const summary = p * (rm * 130e3 + 5 * BASE.OUT);
  const afterCompact = p * (rm * BASE.S + 1.25 * (BASE.P - BASE.S) + 5 * 500);
  const r = simulate([s], { ...BASE, T: 120e3 });
  assert.equal(r.n, 1);
  near(r.cost, first + summary + afterCompact);
});

test("手动触发的真实压缩在任何触发点下都保留，自动触发的只在回放时保留", () => {
  const mk = (trigger) => ({ side: false, events: [q(100e3, 0), b(trigger), q(120e3, 100e3), q(130e3, 120e3)] });
  assert.equal(simulate([mk("manual")], { ...BASE, T: 900e3 }).n, 1);
  assert.equal(simulate([mk("manual")], { ...BASE, T: 900e3, replay: true }).n, 1);
  assert.equal(simulate([mk("auto")], { ...BASE, T: 900e3 }).n, 0);
  assert.equal(simulate([mk("auto")], { ...BASE, T: 900e3, replay: true }).n, 1);
});

test("--as-model 换单价后费用按档位比例变化", () => {
  const s = growing(100e3, 10e3, 40);
  const opus = simulate([s], { ...BASE, T: 250e3, asModel: OPUS });
  const sonnet = simulate([s], { ...BASE, T: 250e3, asModel: "claude-sonnet-5-5" });
  near(sonnet.cost / opus.cost, 2.5 / 5);
  assert.equal(sonnet.n, opus.n);
  near(costOf(s.events[3], "claude-sonnet-5-5") / costOf(s.events[3], OPUS), 0.5);
});

test("report：主会话与子代理分开，--as-model 只影响主会话", () => {
  const main = growing(100e3, 10e3, 40);
  const sub = growing(100e3, 10e3, 40, { side: true });
  const plain = report({ sessions: [main, sub], days: 14, now: NOW, window: "300000" });
  const alt = report({ sessions: [main, sub], days: 14, now: NOW, window: "300000", asModel: "claude-sonnet-5-5" });
  assert.equal(plain.current, 270e3);
  assert.equal(plain.main.B.n, 40);
  assert.equal(plain.sub.B.n, 40);
  assert.ok(plain.main.D.rows.some((x) => x.T === 270e3 && Math.abs(x.vsCurrent) < 1e-12));
  near(alt.main.B.total / plain.main.B.total, 0.5);
  near(alt.sub.B.total, plain.sub.B.total);
  near(alt.main.asModelRatio, 0.5);
});

test("parseSession：请求按 requestId + message.id 去重，识别压缩边界、闲置间隔与 Read 大小", () => {
  const usage = { input_tokens: 1, cache_read_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 }, output_tokens: 5 };
  const asst = (ts, extra = {}) => ({ type: "assistant", timestamp: ts, requestId: "r1", message: { id: "m1", model: OPUS, usage, ...extra } });
  const lines = [
    asst("2026-11-09T10:00:00Z", { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x.txt" } }] }),
    { type: "user", timestamp: "2026-11-09T10:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "abcdef" }] } },
    { ...asst("2026-11-09T10:00:02Z"), message: { id: "m1", model: OPUS, usage: { ...usage, output_tokens: 9 } } },
    { type: "system", subtype: "compact_boundary", timestamp: "2026-11-09T11:00:00Z", compactMetadata: { trigger: "auto", preTokens: 300000, postTokens: 20000, durationMs: 60000 } },
    "not json"
  ].map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
  const { events } = parseSession(lines.join("\n"), false);
  const qs = events.filter((e) => e.kind === "q");
  assert.equal(qs.length, 1);
  assert.deepEqual([qs[0].ctx, qs[0].o], [111, 9]);
  assert.equal(events.find((e) => e.kind === "read").size, 6);
  const boundary = events.find((e) => e.kind === "b");
  assert.equal(boundary.trigger, "auto");
  near(boundary.idleMin, 59, "边界 11:00 减去 1 分钟摘要耗时，距上一个请求（10:00:00，重复块不更新）59 分钟");
});

test("currentTrigger：窗口 x 0.9；读不到按 270K；--window 优先于 settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "compact-replay-"));
  try {
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ autoCompactWindow: 200000 }));
    near(currentTrigger("", settings), 180e3);
    near(currentTrigger("300000", settings), 270e3);
    assert.equal(currentTrigger("", join(dir, "missing.json")), 270e3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
