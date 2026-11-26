// 运行：node --test .agents/skills/beanstack/scripts/usage-report.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyze, requestCost, readMultOf, tierOf } from "./usage-report.mjs";

const now = Date.parse("2026-11-07T00:00:00Z");
const ts = "2026-11-06T00:00:00Z";
const asst = (req, model, usage, content = []) =>
  JSON.stringify({ type: "assistant", requestId: req, timestamp: ts, message: { id: `m${req}`, model, usage, content } });

test("缓存命中价按模型取倍率", () => {
  assert.equal(readMultOf("claude-opus-5-5"), 0.05);
  assert.equal(readMultOf("claude-fable-5-1"), 0.025);
  assert.equal(readMultOf("claude-fable-5-2"), 0.025);
  assert.equal(readMultOf("claude-haiku-5-5"), 0.1);
  const { cost, ctx } = requestCost("claude-haiku-4-5", {
    input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 2,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
  });
  assert.equal(ctx, 1110);
  assert.equal(cost, 10 + 125 + 100 + 10);
});

test("5.5 代按新标价折算，Haiku 5.5 过 10 万 token 贵 5 倍", () => {
  assert.equal(tierOf("claude-sonnet-5-5"), 2.5);
  assert.equal(tierOf("claude-sonnet-5"), 3);
  assert.equal(tierOf("claude-haiku-5-5", 100000), 0.125);
  assert.equal(tierOf("claude-haiku-5-5", 100001), 0.625);
  assert.equal(tierOf("claude-fable-5-2"), 10);
  const small = requestCost("claude-haiku-5-5", { input_tokens: 1000, output_tokens: 0 });
  const big = requestCost("claude-haiku-5-5", { input_tokens: 1000, cache_read_input_tokens: 150000, output_tokens: 0 });
  assert.equal(small.cost, 125);
  assert.equal(big.parts.input, 625);
});

test("主会话与子代理分开汇总，重复内容块只算一次，统计工具输出", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-report-"));
  const proj = join(root, "-x-demo-proj");
  mkdirSync(join(proj, "s1", "subagents"), { recursive: true });
  const u = { input_tokens: 0, cache_read_input_tokens: 250000, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
  writeFileSync(join(proj, "s1.jsonl"), [asst("a", "claude-opus-5-5", u), asst("a", "claude-opus-5-5", u), JSON.stringify({ isCompactSummary: true })].join("\n"));
  const toolUse = { type: "tool_use", id: "t1", name: "Read", input: {} };
  writeFileSync(join(proj, "s1", "subagents", "agent-1.jsonl"), [
    asst("b", "claude-haiku-5-5", { input_tokens: 100, output_tokens: 0 }, [toolUse]),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(50) }] } }),
  ].join("\n"));
  writeFileSync(join(proj, "s1", "subagents", "agent-1.meta.json"), JSON.stringify({ agentType: "scout" }));
  const res = analyze({ root, project: "demo-proj", days: 14, now });
  assert.equal(res.roles.main.calls, 1);
  assert.equal(res.roles.main.longCtxCost, res.roles.main.cost);
  assert.equal(res.roles["sub:scout"].calls, 1);
  assert.equal(res.toolChars.Read, 50);
  assert.equal(res.compactions, 1);
  assert.equal(res.runs.filter((r) => r.role !== "main").length, 1);
  assert.equal(res.runs.find((r) => r.role === "main").first, 250000);
  assert.equal(res.roles.main.parts.read, res.roles.main.cost);
});

test("--until 不算最近几天", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-report-"));
  const proj = join(root, "-x-demo-proj");
  mkdirSync(proj, { recursive: true });
  const u = { input_tokens: 100, output_tokens: 0 };
  writeFileSync(join(proj, "s1.jsonl"), asst("a", "claude-opus-5-5", u));
  assert.equal(analyze({ root, project: "demo-proj", days: 14, now }).roles.main.calls, 1);
  assert.equal(analyze({ root, project: "demo-proj", days: 14, until: 2, now }).roles.main, undefined);
});
